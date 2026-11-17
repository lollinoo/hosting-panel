import http from "node:http";
import {
  WORDPRESS_RESET_CLIENT_WAIT_MS,
  type IpcSigningKey,
  type IpcVerificationKey,
} from "@hosting-panel/contracts";
import type { SiteJobRequest, SiteJobResult } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerExecutorIpcServer,
  InMemoryDockerSimulatorAdapter,
  SignedDockerExecutorIpcClient,
} from "../src/index.js";
import { SITE_JOB_TIMEOUT_MS } from "../src/client.js";
import { SIMULATED_IMPORT_LOAD_RESULT, SIMULATED_WORDPRESS_STATE } from "../src/simulator-adapter.js";

const HMAC_SECRET = "0123456789abcdef0123456789abcdef-site-jobs-ipc-key";
const SIGNING_KEY: IpcSigningKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: HMAC_SECRET };
const VERIFICATION_KEY: IpcVerificationKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: HMAC_SECRET };
const ADMIN_PW = "sentinel-Pass-123456";

const cleanupTasks: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanupTasks.length > 0) await cleanupTasks.pop()?.();
});

async function setup() {
  const simulator = new InMemoryDockerSimulatorAdapter();
  const server = new DockerExecutorIpcServer({
    executor: simulator,
    keyring: { "hmac-v1": VERIFICATION_KEY },
    transport: "loopback-test",
  });
  cleanupTasks.push(() => server.stop());
  const bound = await server.start();
  const client = new SignedDockerExecutorIpcClient({ signingKey: SIGNING_KEY, transport: "loopback-test", port: bound.port });
  return { simulator, client };
}

const job = (kind: SiteJobRequest["kind"], params: Record<string, string> = {}): SiteJobRequest => ({
  jobId: "job_wp_ipc_1",
  kind,
  siteId: "site_a",
  organizationId: "org_a",
  serviceInstanceId: "svc_a",
  params: { phpVersion: "8.4", ...params },
  ...(kind === "wordpress.reset-password" ? { resolvedSecrets: { HP_ADMIN_PASSWORD: ADMIN_PW } } : {}),
});

describe("WordPress site jobs over IPC", () => {
  it("result travels to the caller for inspect and update", async () => {
    const { client } = await setup();
    const inspect = await client.runSiteJob(job("wordpress.inspect"));
    expect(inspect).toEqual({ jobId: "job_wp_ipc_1", exitCode: 0, outputTail: "", result: SIMULATED_WORDPRESS_STATE });
    const update = await client.runSiteJob(job("wordpress.update", { target: "plugin:classic-editor" }));
    expect(update.result).toEqual({
      items: [{ type: "plugin", name: "classic-editor", oldVersion: "1.6.0", newVersion: "1.7.0", status: "updated" }],
    });
    const reset = await client.runSiteJob(job("wordpress.reset-password", { userId: "1" }));
    expect(reset).toEqual({ jobId: "job_wp_ipc_1", exitCode: 0, outputTail: "" });
  });

  it("the client drops a result that does not fit the schema of the kind", async () => {
    const { simulator, client } = await setup();
    const bad: Array<[SiteJobRequest, unknown]> = [
      [job("wordpress.inspect"), { ...SIMULATED_WORDPRESS_STATE, extra: 1 }],
      [job("wordpress.inspect"), { items: [] }],
      [job("wordpress.update", { target: "all" }), SIMULATED_WORDPRESS_STATE],
      [job("wordpress.settle"), { items: [] }],
      [job("wordpress.inspect"), { ...SIMULATED_WORDPRESS_STATE, plugins: [{ ...SIMULATED_WORDPRESS_STATE.plugins[0], name: "a‮b" }] }],
    ];
    for (const [req, result] of bad) {
      vi.spyOn(simulator, "runSiteJob").mockResolvedValueOnce({
        jobId: req.jobId,
        exitCode: 0,
        outputTail: "",
        result,
      } as unknown as SiteJobResult);
      const res = await client.runSiteJob(req);
      expect(res).toEqual({ jobId: req.jobId, exitCode: 0, outputTail: "" });
    }
  });

  it("the reset waits 75 s, the other kinds the shipped 510 s", async () => {
    const { client } = await setup();
    const timeouts: Array<number | undefined> = [];
    vi.spyOn(http, "request").mockImplementation(((opts: http.RequestOptions) => {
      timeouts.push(opts.timeout);
      throw new Error("stop");
    }) as never);
    await client.runSiteJob(job("wordpress.reset-password", { userId: "1" })).catch(() => undefined);
    await client.runSiteJob(job("wordpress.inspect")).catch(() => undefined);
    await client.runSiteJob(job("wordpress.settle")).catch(() => undefined);
    expect(WORDPRESS_RESET_CLIENT_WAIT_MS).toBe(75_000);
    expect(timeouts).toEqual([75_000, SITE_JOB_TIMEOUT_MS, 510_000]);
  });
});

// QA (cycle 8): the import kinds over signed IPC.
describe("import job kinds over IPC", () => {
  const ID = "0123456789abcdef0123456789abcdef";
  const SECRET = { HP_IMPORT_DB_PASSWORD: "7a".repeat(32) };
  const load = (): SiteJobRequest => ({ jobId: "job_qa_load", kind: "db.import-load", siteId: "site_a", organizationId: "org_a", serviceInstanceId: "svc_a", params: { importId: ID }, resolvedSecrets: SECRET });
  const dbImport = (step: string): SiteJobRequest => ({
    jobId: `job_qa_${step}`,
    kind: "db.import",
    siteId: "site_a",
    organizationId: "org_a",
    params: { step, importId: ID },
    ...(step === "prepare" ? { resolvedSecrets: SECRET } : {}),
  });
  const finalize = (): SiteJobRequest => ({
    jobId: "job_qa_fin",
    kind: "wordpress.import-finalize",
    siteId: "site_a",
    organizationId: "org_a",
    serviceInstanceId: "svc_a",
    params: { phpVersion: "8.4", tablePrefix: "wp_", siteUrl: "http://wp-a.example.test", previousUrl: "http://old.example.test" },
  });

  it("the three kinds and every step arrive intact on the far side and their answer survives the envelope", async () => {
    const { simulator, client } = await setup();
    const reqs = [...["prepare", "switch", "undo", "finish"].map(dbImport), load(), finalize()];
    for (const r of reqs) {
      const res = await client.runSiteJob(r);
      expect(res, r.jobId).toEqual({ jobId: r.jobId, exitCode: 0, outputTail: "", ...(r.kind === "db.import-load" ? { result: SIMULATED_IMPORT_LOAD_RESULT } : {}) });
    }
    // What the executor received is what the caller sent, secret included, and nothing else.
    expect(simulator.jobs).toEqual(reqs);

    simulator.failNextJob("db.import-load", 61, "ERROR 1044 at line 631", '{"line":631,"errorNumber":1044}\n');
    expect(await client.runSiteJob(load())).toEqual({ jobId: "job_qa_load", exitCode: 61, outputTail: "ERROR 1044 at line 631", result: { line: 631, errorNumber: 1044 } });
  });

  it("the client drops a forged load answer that came through the envelope", async () => {
    const { simulator, client } = await setup();
    for (const result of [
      SIMULATED_WORDPRESS_STATE,
      { ...SIMULATED_IMPORT_LOAD_RESULT, extra: 1 },
      { ...SIMULATED_IMPORT_LOAD_RESULT, prefix: "a;b" },
      { ...SIMULATED_IMPORT_LOAD_RESULT, oldUrl: "http://old.example.test/x" },
      { line: -1, errorNumber: 1044 },
      { line: 1, errorNumber: 0 },
      "{\"line\":1,\"errorNumber\":1044}",
    ]) {
      vi.spyOn(simulator, "runSiteJob").mockResolvedValueOnce({ jobId: "job_qa_load", exitCode: 0, outputTail: "", result } as unknown as SiteJobResult);
      expect(await client.runSiteJob(load()), JSON.stringify(result).slice(0, 40)).toEqual({ jobId: "job_qa_load", exitCode: 0, outputTail: "" });
    }
    // A finalize never carries an answer, even a well-formed load answer.
    vi.spyOn(simulator, "runSiteJob").mockResolvedValueOnce({ jobId: "job_qa_fin", exitCode: 0, outputTail: "", result: SIMULATED_IMPORT_LOAD_RESULT } as unknown as SiteJobResult);
    expect(await client.runSiteJob(finalize())).toEqual({ jobId: "job_qa_fin", exitCode: 0, outputTail: "" });
  });

  it("a kind outside the list and a params key outside the kind's list are refused on the server side", async () => {
    const { simulator, client } = await setup();
    const spy = vi.spyOn(simulator, "runSiteJob");
    await expect(client.runSiteJob({ ...dbImport("switch"), kind: "db.import-cleanup" as SiteJobRequest["kind"] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // The kind is refused by the IPC schema before the executor is even called.
    expect(spy).not.toHaveBeenCalled();
    for (const r of [
      { ...dbImport("switch"), params: { step: "switch", importId: ID, prefix: "wp_0123456789ab" } },
      { ...load(), params: { importId: ID, image: "alpine:3" } },
      { ...finalize(), params: { ...finalize().params, prefix: "wp_" } },
    ] as SiteJobRequest[]) {
      await expect(client.runSiteJob(r), JSON.stringify(r.params)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(simulator.jobs).toEqual([]);
    // The control: the same client gets a good request through.
    await expect(client.runSiteJob(dbImport("switch"))).resolves.toMatchObject({ exitCode: 0 });
  });
});
