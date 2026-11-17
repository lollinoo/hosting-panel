import type { SiteJobRequest } from "@hosting-panel/executor-contracts";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DockerEngineSocketAdapter } from "../src/index.js";
import { InMemoryDockerSimulatorAdapter, SIMULATED_IMPORT_LOAD_RESULT, SIMULATED_WORDPRESS_STATE } from "../src/simulator-adapter.js";

const ADMIN_PW = "sentinel-Pass-123456";

function job(kind: SiteJobRequest["kind"], params: Record<string, string> = {}, siteId = "site_a"): SiteJobRequest {
  return {
    jobId: `job_${kind.replace(/[^a-z]/g, "_")}`,
    kind,
    siteId,
    organizationId: "org_a",
    serviceInstanceId: "svc_a",
    params: { phpVersion: "8.4", ...params },
    ...(kind === "wordpress.reset-password" ? { resolvedSecrets: { HP_ADMIN_PASSWORD: ADMIN_PW } } : {}),
  };
}

describe("simulated WordPress jobs", () => {
  it("inspect returns the fixed state", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    const res = await sim.runSiteJob(job("wordpress.inspect"));
    expect(res.exitCode).toBe(0);
    expect(res.result).toEqual(SIMULATED_WORDPRESS_STATE);
    expect(SIMULATED_WORDPRESS_STATE).toEqual({
      coreVersion: "7.1.4",
      coreUpdate: null,
      updatesKnown: true,
      plugins: [
        { name: "akismet", title: "Akismet Anti-spam", status: "inactive", version: "5.7.2", updateVersion: null },
        { name: "classic-editor", title: "Classic Editor", status: "active", version: "1.6.0", updateVersion: "1.7.0" },
      ],
      themes: [
        { name: "twentytwentyfive", title: "Twenty Twenty-Five", status: "active", version: "1.5", updateVersion: null },
      ],
      administrators: [{ id: 1, login: "admin" }],
    });
  });

  it("offline: updates unknown, no update versions, and an update exits 30", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    sim.wordpressOnline = false;
    const res = await sim.runSiteJob(job("wordpress.inspect"));
    expect(res.exitCode).toBe(0);
    const state = res.result as typeof SIMULATED_WORDPRESS_STATE;
    expect(state.updatesKnown).toBe(false);
    expect(state.coreUpdate).toBeNull();
    expect([...state.plugins, ...state.themes].every((i) => i.updateVersion === null)).toBe(true);
    const upd = await sim.runSiteJob(job("wordpress.update", { target: "all" }));
    expect(upd).toMatchObject({ exitCode: 30 });
    expect(upd.result).toBeUndefined();
  });

  it("an update changes the stored state and returns the items; an unknown name exits 31", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    const upd = await sim.runSiteJob(job("wordpress.update", { target: "plugin:classic-editor" }));
    expect(upd.exitCode).toBe(0);
    expect(upd.result).toEqual({
      items: [{ type: "plugin", name: "classic-editor", oldVersion: "1.6.0", newVersion: "1.7.0", status: "updated" }],
    });
    const after = (await sim.runSiteJob(job("wordpress.inspect"))).result as typeof SIMULATED_WORDPRESS_STATE;
    expect(after.plugins.find((p) => p.name === "classic-editor")).toMatchObject({ version: "1.7.0", updateVersion: null });
    expect(sim.wordpressSites.get("site_a")).toEqual(after);
    expect((await sim.runSiteJob(job("wordpress.update", { target: "all" }))).result).toEqual({ items: [] });
    expect(await sim.runSiteJob(job("wordpress.update", { target: "plugin:missing" }))).toMatchObject({ exitCode: 31 });
    expect(await sim.runSiteJob(job("wordpress.update", { target: "theme:missing" }))).toMatchObject({ exitCode: 31 });
    // Another site still has the fixture.
    const other = await sim.runSiteJob(job("wordpress.inspect", {}, "site_b"));
    expect(other.result).toEqual(SIMULATED_WORDPRESS_STATE);
  });

  it("reset exits 40 for a non-administrator, settle exits 0, neither returns a result", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    expect(await sim.runSiteJob(job("wordpress.reset-password", { userId: "2" }))).toMatchObject({ exitCode: 40 });
    const ok = await sim.runSiteJob(job("wordpress.reset-password", { userId: "1" }));
    expect(ok.exitCode).toBe(0);
    expect(ok.result).toBeUndefined();
    expect(JSON.stringify(ok)).not.toContain(ADMIN_PW);
    const settle = await sim.runSiteJob(job("wordpress.settle"));
    expect(settle).toEqual({ jobId: "job_wordpress_settle", exitCode: 0, outputTail: "" });
  });

  it("refuses requests exactly like the real adapter", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    await expect(sim.runSiteJob(job("wordpress.update", { target: "plugin:-x" }))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(sim.runSiteJob(job("wordpress.reset-password", { userId: "01" }))).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("failNextJob's raw stdout goes through the same parser", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    const valid = `${JSON.stringify({ ...SIMULATED_WORDPRESS_STATE, coreVersion: "7.0.0" })}\n`;
    sim.failNextJob("wordpress.inspect", 0, "tail", valid);
    const res = await sim.runSiteJob(job("wordpress.inspect"));
    expect(res).toMatchObject({ exitCode: 0, outputTail: "tail" });
    expect((res.result as typeof SIMULATED_WORDPRESS_STATE).coreVersion).toBe("7.0.0");

    sim.failNextJob("wordpress.inspect", 0, "", `${JSON.stringify({ ...SIMULATED_WORDPRESS_STATE, extra: 1 })}\n`);
    expect((await sim.runSiteJob(job("wordpress.inspect"))).result).toBeUndefined();
    sim.failNextJob("wordpress.update", 32, "", "not json");
    const failed = await sim.runSiteJob(job("wordpress.update", { target: "all" }));
    expect(failed).toMatchObject({ exitCode: 32 });
    expect(failed.result).toBeUndefined();
    sim.failNextJob("wordpress.inspect", 23);
    const noStdout = await sim.runSiteJob(job("wordpress.inspect"));
    expect(noStdout.exitCode).toBe(23);
    expect("result" in noStdout).toBe(false);
  });

  it("import kinds: the load answers the fixed result, its failure line travels, a forged answer is dropped", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    const importId = "0123456789abcdef0123456789abcdef";
    const secret = { HP_IMPORT_DB_PASSWORD: "b".repeat(64) };
    const load: SiteJobRequest = { ...job("db.import-load"), params: { importId }, resolvedSecrets: secret };
    const ok = await sim.runSiteJob(load);
    expect(ok).toEqual({ jobId: load.jobId, exitCode: 0, outputTail: "", result: { prefix: "wp_", oldUrl: "http://old.example.test", tables: 12 } });
    expect(SIMULATED_IMPORT_LOAD_RESULT).toEqual({ prefix: "wp_", oldUrl: "http://old.example.test", tables: 12 });

    sim.failNextJob("db.import-load", 61, "", '{"line":631,"errorNumber":1044}\n');
    expect(await sim.runSiteJob(load)).toMatchObject({ exitCode: 61, result: { line: 631, errorNumber: 1044 } });
    sim.failNextJob("db.import-load", 0, "", '{"prefix":"a;b","oldUrl":"http://old.example.test","tables":12}\n');
    const forged = await sim.runSiteJob(load);
    expect(forged).toEqual({ jobId: load.jobId, exitCode: 0, outputTail: "" });

    for (const step of ["prepare", "switch", "undo", "finish"]) {
      const res = await sim.runSiteJob({ ...job("db.import"), serviceInstanceId: undefined, params: { step, importId } });
      expect(res).toEqual({ jobId: "job_db_import", exitCode: 0, outputTail: "" });
    }
    const fin = await sim.runSiteJob(
      job("wordpress.import-finalize", { tablePrefix: "wp_", siteUrl: "http://wp-a.example.test", previousUrl: "http://old.example.test" }),
    );
    expect(fin).toEqual({ jobId: "job_wordpress_import_finalize", exitCode: 0, outputTail: "" });
  });

  it("import kinds are refused exactly like the real adapter", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    const importId = "0123456789abcdef0123456789abcdef";
    for (const params of [{ step: "drop", importId }, { step: "switch", importId: importId.toUpperCase() }, { step: "switch", importId, prefix: "wp_x" }] as Record<string, string>[]) {
      await expect(sim.runSiteJob({ ...job("db.import"), params })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    await expect(sim.runSiteJob({ ...job("db.import-load"), params: { importId } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(sim.jobs).toEqual([]);
  });
  // QA (cycle 8) additions.
  const QA_ID = "0123456789abcdef0123456789abcdef";
  const QA_SECRET = { HP_IMPORT_DB_PASSWORD: "5e".repeat(32) };
  const qaLoad = (): SiteJobRequest => ({ ...job("db.import-load"), params: { importId: QA_ID }, resolvedSecrets: QA_SECRET });

  it("QA: the load's exit 61 reaches the caller with its line and its tail exactly as given", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    const tail = "ERROR 1044 (42000) at line 631: Access denied";
    sim.failNextJob("db.import-load", 61, tail, '{"line":631,"errorNumber":1044}\n');
    expect(await sim.runSiteJob(qaLoad())).toEqual({ jobId: "job_db_import_load", exitCode: 61, outputTail: tail, result: { line: 631, errorNumber: 1044 } });
    sim.failNextJob("db.import-load", 61, tail, '{"line":12,"errorNumber":null}\n');
    expect(await sim.runSiteJob(qaLoad())).toMatchObject({ exitCode: 61, result: { line: 12, errorNumber: null } });
    // The queued failure is used once; the next run answers the fixed result again.
    expect(await sim.runSiteJob(qaLoad())).toMatchObject({ exitCode: 0, result: SIMULATED_IMPORT_LOAD_RESULT });
  });

  it("QA: a forged load answer (not JSON, extra key, another kind's answer, two lines) is dropped", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    const good = JSON.stringify(SIMULATED_IMPORT_LOAD_RESULT);
    for (const stdout of [
      "not json\n",
      `${JSON.stringify({ ...SIMULATED_IMPORT_LOAD_RESULT, dbName: "x" })}\n`,
      `${JSON.stringify(SIMULATED_WORDPRESS_STATE)}\n`,
      `${good}\n${good}\n`,
      `${JSON.stringify({ line: 1, errorNumber: 0 })}\n`,
    ]) {
      sim.failNextJob("db.import-load", 0, "", stdout);
      const res = await sim.runSiteJob(qaLoad());
      expect(res, stdout.slice(0, 30)).toEqual({ jobId: "job_db_import_load", exitCode: 0, outputTail: "" });
    }
    // The control: the same path keeps a good answer.
    sim.failNextJob("db.import-load", 0, "", `${good}\n`);
    expect((await sim.runSiteJob(qaLoad())).result).toEqual(SIMULATED_IMPORT_LOAD_RESULT);
  });

  it("QA: a bad step and a param prefix answer VALIDATION_ERROR in the simulator and in the real adapter alike", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hp-qa-sim-"));
    try {
      const sim = new InMemoryDockerSimulatorAdapter();
      const real = new DockerEngineSocketAdapter({
        dockerSocketPath: path.join(dir, "no-docker.sock"),
        secretsRootDir: path.join(dir, "secrets"),
        ingressRootDir: path.join(dir, "ingress"),
        pullMissingImages: false,
        sharedDbRootKeyFile: path.join(dir, "root.key"),
      });
      const bad: SiteJobRequest[] = [
        { ...job("db.import"), serviceInstanceId: undefined, params: { step: "rollback", importId: QA_ID } },
        { ...job("db.import"), serviceInstanceId: undefined, params: { step: "Switch", importId: QA_ID } },
        { ...job("db.import"), serviceInstanceId: undefined, params: { step: "switch", importId: QA_ID, prefix: "wp_0123456789ab" } },
        { ...qaLoad(), params: { importId: QA_ID, prefix: "wp_0123456789ab" } },
        job("wordpress.import-finalize", { tablePrefix: "wp_", siteUrl: "http://wp-a.example.test", previousUrl: "http://old.example.test", prefix: "wp_" }),
      ];
      for (const r of bad) {
        const fromSim = await sim.runSiteJob(r).then(() => "resolved", (e: { code?: string }) => e.code);
        const fromReal = await real.runSiteJob(r).then(() => "resolved", (e: { code?: string }) => e.code);
        expect([fromSim, fromReal], JSON.stringify(r.params)).toEqual(["VALIDATION_ERROR", "VALIDATION_ERROR"]);
      }
      expect(sim.jobs).toEqual([]);
      // The control: a good request gets past validation in the real adapter and fails only at the absent engine.
      const control = await real.runSiteJob({ ...job("db.import"), serviceInstanceId: undefined, params: { step: "switch", importId: QA_ID } }).then(
        () => "resolved",
        (e: { code?: string }) => e.code,
      );
      expect(control).not.toBe("VALIDATION_ERROR");
      expect(control).not.toBe("resolved");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
