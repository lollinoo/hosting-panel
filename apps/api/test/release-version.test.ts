import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PANEL_CHECK_MAX_BYTES, PANEL_RELEASE_LATEST_URL } from "@hosting-panel/contracts";
import { afterAll, describe, expect, it, vi } from "vitest";
import { checkPanelRelease, installedPanelVersion, readReleaseVersion, versionGt } from "../src/updates/release-version.js";

describe("installed panel version", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hp-release-version-"));
  const file = (name: string, body: string) => {
    const p = path.join(dir, name);
    writeFileSync(p, body);
    return p;
  };
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads x.y.z from a good RELEASE.json", () => {
    expect(readReleaseVersion(file("good.json", JSON.stringify({ version: "1.4.2", node: "26.13.1" })))).toBe("1.4.2");
  });

  it("is null for a file that is not JSON", () => {
    expect(readReleaseVersion(file("bad.json", "{not json"))).toBeNull();
  });

  it("is null for a version that is not x.y.z", () => {
    for (const version of ["v1.4.2", "1.4", "1.4.2-rc1", 142, null]) {
      expect(readReleaseVersion(file("semver.json", JSON.stringify({ version })))).toBeNull();
    }
    expect(readReleaseVersion(file("array.json", "[]"))).toBeNull();
  });

  it("is null for a missing file", () => {
    expect(readReleaseVersion(path.join(dir, "missing.json"))).toBeNull();
  });

  it("is null in the source tree, which has no RELEASE.json, and stays the same value", () => {
    expect(installedPanelVersion()).toBeNull();
    expect(installedPanelVersion()).toBeNull();
  });
});

describe("versionGt, the vectors of release.sh version_gt", () => {
  it("compares x.y.z numerically and is false unless both sides are x.y.z", () => {
    const cases: Array<[string, string, boolean]> = [
      ["1.0.1", "1.0.0", true], ["1.0.0", "1.0.1", false], ["1.0.0", "1.0.0", false],
      ["1.10.0", "1.9.9", true], ["2.0.0", "1.99.99", true], ["0.0.10", "0.0.9", true],
      ["1.02.0", "1.1.0", true], ["v1.0.1", "1.0.0", false], ["1.0.1", "", false], ["1.0", "0.9.9", false],
    ];
    for (const [a, b, want] of cases) expect([a, b, versionGt(a, b)]).toEqual([a, b, want]);
  });
});

describe("checkPanelRelease with an injected fetch", () => {
  const answer = (status: number, body: unknown) => async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

  it("sends one GET to the release URL with redirect error, a time-out and only Accept and User-Agent", async () => {
    const fetchFn = vi.fn(answer(200, { tag_name: "v1.5.0" }));
    await expect(checkPanelRelease("1.4.2", fetchFn as unknown as typeof fetch)).resolves.toEqual({ state: "newer", latestVersion: "1.5.0" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(PANEL_RELEASE_LATEST_URL);
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.method ?? "GET").toBe("GET");
    expect(init.body).toBeUndefined();
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual(["accept", "user-agent"]);
    expect(JSON.stringify(init.headers)).not.toMatch(/@|example|admin|\d+\.\d+\.\d+/);
  });

  it("parses the tag: same or older is up_to_date, an unknown installed version is newer", async () => {
    const run = (installed: string | null, tag: unknown) => checkPanelRelease(installed, answer(200, { tag_name: tag }) as unknown as typeof fetch);
    await expect(run("1.5.0", "v1.5.0")).resolves.toEqual({ state: "up_to_date", latestVersion: "1.5.0" });
    await expect(run("1.6.0", "v1.5.0")).resolves.toEqual({ state: "up_to_date", latestVersion: "1.5.0" });
    await expect(run(null, "v1.5.0")).resolves.toEqual({ state: "newer", latestVersion: "1.5.0" });
    for (const tag of ["1.5.0", "v1.5", "v1.5.0-rc1", " v1.5.0", 150, null]) {
      await expect(run("1.4.2", tag)).resolves.toEqual({ state: "failed", latestVersion: null });
    }
  });

  it("404 is no_release; 500, bad JSON, a thrown fetch or a time-out are failed", async () => {
    const run = (f: unknown) => checkPanelRelease("1.4.2", f as typeof fetch);
    await expect(run(answer(404, { message: "Not Found" }))).resolves.toEqual({ state: "no_release", latestVersion: null });
    await expect(run(answer(500, { tag_name: "v9.9.9" }))).resolves.toEqual({ state: "failed", latestVersion: null });
    await expect(run(answer(200, "{not json"))).resolves.toEqual({ state: "failed", latestVersion: null });
    await expect(run(async () => { throw new TypeError("fetch failed"); })).resolves.toEqual({ state: "failed", latestVersion: null });
    await expect(run(async () => { throw new DOMException("timed out", "TimeoutError"); })).resolves.toEqual({ state: "failed", latestVersion: null });
  });

  it("a body over the cap is failed, read no further than the cap", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(32);
    const body = new ReadableStream<Uint8Array>({
      pull(c) { pulled += chunk.length; if (pulled > 8 * PANEL_CHECK_MAX_BYTES) c.close(); else c.enqueue(chunk); },
    });
    await expect(checkPanelRelease("1.4.2", (async () => new Response(body, { status: 200 })) as typeof fetch))
      .resolves.toEqual({ state: "failed", latestVersion: null });
    expect(pulled).toBeLessThan(2 * PANEL_CHECK_MAX_BYTES);
  });

  it("the real fetch with these options refuses a redirect from a local server", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/to") { res.end(JSON.stringify({ tag_name: "v9.9.9" })); return; }
      res.writeHead(302, { location: "/to" }).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const local = ((_url: string, init: RequestInit) => fetch(`http://127.0.0.1:${String(port)}/from`, init)) as typeof fetch;
      await expect(checkPanelRelease("1.4.2", local)).resolves.toEqual({ state: "failed", latestVersion: null });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
