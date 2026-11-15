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
import { SIMULATED_WORDPRESS_STATE } from "../src/simulator-adapter.js";

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
