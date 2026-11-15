import type { SiteJobRequest } from "@hosting-panel/executor-contracts";
import { describe, expect, it } from "vitest";
import { InMemoryDockerSimulatorAdapter, SIMULATED_WORDPRESS_STATE } from "../src/simulator-adapter.js";

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
});
