import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, stat, symlink, utimes, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issueCert } from "../../api/test/fixtures/tls-certgen.js";
import {
  ManualTlsStore,
  ManualTlsStoreError,
  type ManualTlsStoreErrorReason,
} from "../src/manual-tls-store.js";

const V1 = `ctv_${"1".repeat(32)}`;
const V2 = `ctv_${"2".repeat(32)}`;
const V3 = `ctv_${"3".repeat(32)}`;

const fp = (pem: string): string => {
  // sha256 of the leaf DER = the colon-free lowercase fingerprint256
  const b64 = pem.replace(/-----[A-Z ]+-----|\s/g, "");
  return createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
};

function material(dns: readonly string[], cn?: string | null) {
  const cert = issueCert({ dns, ...(cn === undefined ? {} : { cn }) });
  return { fullchainPem: cert.pem, keyPem: cert.keyPem, fingerprintSha256: fp(cert.pem), cert };
}

interface Rig {
  root: string;
  dir: string;
  statePath: string;
  manifestPath: string;
  manifestWrites: (string | null)[];
  store: ManualTlsStore;
  make(extra?: Partial<ConstructorParameters<typeof ManualTlsStore>[0]>): ManualTlsStore;
}

let rig: Rig;
const roots: string[] = [];

async function newRig(): Promise<Rig> {
  const root = await mkdtemp(path.join(os.tmpdir(), "manual-tls-store-"));
  roots.push(root);
  const dyn = path.join(root, "dynamic");
  const dir = path.join(dyn, "manual-certs");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const statePath = path.join(root, "manual-tls-state.json");
  const manifestPath = path.join(dyn, "hp-manual-certificates.yml");
  const manifestWrites: (string | null)[] = [];
  const writeManifest = async (content: string | null): Promise<void> => {
    manifestWrites.push(content);
    if (content === null) await rm(manifestPath, { force: true });
    else await writeFile(manifestPath, content, { mode: 0o644 });
  };
  const make = (extra = {}): ManualTlsStore =>
    new ManualTlsStore({ dir, statePath, writeManifest, gcGraceMs: 0, ...extra });
  return { root, dir, statePath, manifestPath, manifestWrites, store: make(), make };
}

beforeEach(async () => {
  rig = await newRig();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const reasonOf = async (work: Promise<unknown>): Promise<{ reason: ManualTlsStoreErrorReason; ids: readonly string[] }> => {
  try {
    await work;
  } catch (err) {
    expect(err).toBeInstanceOf(ManualTlsStoreError);
    return { reason: (err as ManualTlsStoreError).reason, ids: (err as ManualTlsStoreError).versionIds };
  }
  throw new Error("expected a ManualTlsStoreError");
};

const put = (id: string, m: ReturnType<typeof material>, store = rig.store) =>
  store.putVersion({ versionId: id, fullchainPem: m.fullchainPem, keyPem: m.keyPem, fingerprintSha256: m.fingerprintSha256 });

describe("putVersion", () => {
  it("writes an immutable 0700 dir with 0400 files owned by the executor and leaves no stage dir", async () => {
    const m = material(["shop.example.test"]);
    expect(await put(V1, m)).toEqual({ versionId: V1, written: true });
    const dirInfo = await stat(path.join(rig.dir, V1));
    expect(dirInfo.mode & 0o777).toBe(0o700);
    expect(dirInfo.uid).toBe(process.getuid!());
    for (const file of ["fullchain.pem", "privkey.pem"]) {
      const info = await stat(path.join(rig.dir, V1, file));
      expect(info.mode & 0o777).toBe(0o400);
      expect(info.uid).toBe(process.getuid!());
    }
    expect(await readFile(path.join(rig.dir, V1, "fullchain.pem"), "utf8")).toBe(m.fullchainPem);
    expect(await readdir(rig.dir)).toEqual([V1]);
  });

  it("is idempotent for the same material and conflicts for other material", async () => {
    const m = material(["shop.example.test"]);
    await put(V1, m);
    const inode = (await stat(path.join(rig.dir, V1, "privkey.pem"))).ino;
    expect(await put(V1, m)).toEqual({ versionId: V1, written: false });
    expect((await stat(path.join(rig.dir, V1, "privkey.pem"))).ino).toBe(inode);

    const other = material(["shop.example.test"]);
    expect(await reasonOf(put(V1, other))).toEqual({ reason: "TLS_VERSION_CONFLICT", ids: [V1] });
    // same certificate with another key file is a conflict too
    const swapped = { ...m, keyPem: material(["x.example.test"]).keyPem };
    expect((await reasonOf(put(V1, swapped))).reason).toBe("TLS_MATERIAL_INVALID");
    expect(await readFile(path.join(rig.dir, V1, "fullchain.pem"), "utf8")).toBe(m.fullchainPem);
    expect(await readdir(rig.dir)).toEqual([V1]);
  });

  it("rejects a fingerprint or key mismatch before touching the disk", async () => {
    const m = material(["shop.example.test"]);
    const wrongFp = { ...m, fingerprintSha256: "a".repeat(64) };
    expect((await reasonOf(put(V1, wrongFp))).reason).toBe("TLS_MATERIAL_INVALID");
    const wrongKey = { ...m, keyPem: material(["other.example.test"]).keyPem };
    expect((await reasonOf(put(V1, wrongKey))).reason).toBe("TLS_MATERIAL_INVALID");
    expect((await reasonOf(put(V1, { ...m, keyPem: "not a key" }))).reason).toBe("TLS_MATERIAL_INVALID");
    expect((await reasonOf(put("ctv_nope", m))).reason).toBe("TLS_MATERIAL_INVALID");
    expect(await readdir(rig.dir)).toEqual([]);
  });

  it("never puts PEM material in an error message", async () => {
    const m = material(["shop.example.test"]);
    const err = await put(V1, { ...m, fingerprintSha256: "b".repeat(64) }).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toMatch(/BEGIN|PRIVATE/);
  });

  it("refuses a symlinked store directory", async () => {
    const target = path.join(rig.root, "elsewhere");
    await mkdir(target, { mode: 0o700 });
    await rm(rig.dir, { recursive: true });
    await symlink(target, rig.dir);
    expect((await reasonOf(put(V1, material(["a.example.test"])))).reason).toBe("TLS_STORE_UNSAFE");
    expect(await readdir(target)).toEqual([]);
  });

  it("refuses a store directory open to group or others", async () => {
    await chmod(rig.dir, 0o755);
    expect((await reasonOf(put(V1, material(["a.example.test"])))).reason).toBe("TLS_STORE_UNSAFE");
  });

  it("refuses a symlink planted at the version path", async () => {
    const target = path.join(rig.root, "victim");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, path.join(rig.dir, V1));
    expect((await reasonOf(put(V1, material(["a.example.test"])))).reason).toBe("TLS_STORE_UNSAFE");
    expect(await readdir(target)).toEqual([]);
  });

  it("refuses a symlink planted at the stage path and does not write through it", async () => {
    const target = path.join(rig.root, "victim");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, path.join(rig.dir, `.stage-${V1}-aaaaaa`));
    const store = rig.make({ randomSuffix: () => "aaaaaa" });
    expect((await reasonOf(put(V1, material(["a.example.test"]), store))).reason).toBe("TLS_STORE_UNSAFE");
    expect(await readdir(target)).toEqual([]);
    expect((await lstat(path.join(rig.dir, `.stage-${V1}-aaaaaa`))).isSymbolicLink()).toBe(true);
  });

  it("replaces an own version directory that no longer verifies", async () => {
    const m = material(["shop.example.test"]);
    await put(V1, m);
    await chmod(path.join(rig.dir, V1, "privkey.pem"), 0o644); // e.g. a restore that loosened modes
    expect(await put(V1, m)).toEqual({ versionId: V1, written: true });
    expect((await stat(path.join(rig.dir, V1, "privkey.pem"))).mode & 0o777).toBe(0o400);
  });
});

describe("manifest rendering", () => {
  it("is sorted, file refs only, stable, and null when empty", () => {
    const store = rig.make({ mountDir: "/etc/traefik/dynamic/" });
    expect(store.renderManifest([])).toBeNull();
    const text = store.renderManifest([V2, V1, V2])!;
    expect(text).toBe(
      [
        "# Managed by hp-docker-executor — DO NOT EDIT",
        "tls:",
        "  certificates:",
        `    - certFile: "/etc/traefik/dynamic/manual-certs/${V1}/fullchain.pem"`,
        `      keyFile: "/etc/traefik/dynamic/manual-certs/${V1}/privkey.pem"`,
        `    - certFile: "/etc/traefik/dynamic/manual-certs/${V2}/fullchain.pem"`,
        `      keyFile: "/etc/traefik/dynamic/manual-certs/${V2}/privkey.pem"`,
        "",
      ].join("\n"),
    );
    expect(store.renderManifest([V1, V2])).toBe(text);
    expect(text).not.toMatch(/BEGIN/);
  });
});

describe("publishFiles", () => {
  const entry = (id: string, hosts: string[]) => ({ versionId: id, assignedHosts: hosts });

  it("persists state (0600, unverified) then the manifest, and bumps the generation", async () => {
    await put(V1, material(["shop.example.test"]));
    expect(await rig.store.publishFiles(0, [entry(V1, ["Shop.Example.Test"])])).toEqual({ generation: 1, replayed: false });
    const state = await rig.store.readState();
    expect(state).toMatchObject({
      schema: 1,
      generation: 1,
      verified: false,
      lastVerified: null,
      current: { entries: [{ versionId: V1, assignedHosts: ["shop.example.test"] }] },
    });
    expect((await stat(rig.statePath)).mode & 0o777).toBe(0o600);
    expect(rig.manifestWrites).toEqual([rig.store.renderManifest([V1])]);
    expect(await readFile(rig.manifestPath, "utf8")).toContain(`/manual-certs/${V1}/fullchain.pem`);
  });

  it("answers a stale baseGeneration with TLS_MANIFEST_CONFLICT and writes nothing", async () => {
    await put(V1, material(["a.example.test"]));
    await put(V2, material(["b.example.test"]));
    await rig.store.publishFiles(0, [entry(V1, ["a.example.test"])]);
    const writes = rig.manifestWrites.length;
    expect((await reasonOf(rig.store.publishFiles(0, [entry(V2, ["b.example.test"])]))).reason).toBe("TLS_MANIFEST_CONFLICT");
    expect((await reasonOf(rig.store.publishFiles(5, [entry(V2, ["b.example.test"])]))).reason).toBe("TLS_MANIFEST_CONFLICT");
    expect(rig.manifestWrites).toHaveLength(writes);
    expect((await rig.store.readState())?.generation).toBe(1);
  });

  it("treats the same base and set after a crash as an idempotent replay", async () => {
    await put(V1, material(["a.example.test"]));
    await rig.store.publishFiles(0, [entry(V1, ["a.example.test"])]);
    const before = await readFile(rig.statePath, "utf8");
    expect(await rig.store.publishFiles(0, [entry(V1, ["a.example.test"])])).toEqual({ generation: 1, replayed: true });
    expect(await readFile(rig.statePath, "utf8")).toBe(before);
    // a different set on the same base is a conflict, not a replay
    await put(V2, material(["b.example.test"]));
    expect((await reasonOf(rig.store.publishFiles(0, [entry(V2, ["b.example.test"])]))).reason).toBe("TLS_MANIFEST_CONFLICT");
  });

  it("lists missing versions and writes nothing", async () => {
    await put(V1, material(["a.example.test"]));
    const err = await reasonOf(rig.store.publishFiles(0, [entry(V1, ["a.example.test"]), entry(V3, ["c.example.test"])]));
    expect(err).toEqual({ reason: "TLS_VERSION_MISSING", ids: [V3] });
    expect(await rig.store.readState()).toBeNull();
    expect(rig.manifestWrites).toEqual([]);
  });

  it("refuses duplicate ids and bad ids", async () => {
    await put(V1, material(["a.example.test"]));
    expect((await reasonOf(rig.store.publishFiles(0, [entry(V1, ["a.example.test"]), entry(V1, ["b.example.test"])]))).reason).toBe(
      "TLS_MATERIAL_INVALID",
    );
    expect((await reasonOf(rig.store.publishFiles(0, [entry("nope", ["a.example.test"])]))).reason).toBe("TLS_MATERIAL_INVALID");
  });

  it("serialises concurrent publishes on the same base: one wins, one conflicts", async () => {
    await put(V1, material(["a.example.test"]));
    await put(V2, material(["b.example.test"]));
    const results = await Promise.allSettled([
      rig.store.publishFiles(0, [entry(V1, ["a.example.test"])]),
      rig.store.publishFiles(0, [entry(V2, ["b.example.test"])]),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  });
});

describe("markVerified and revertToLastVerified", () => {
  const entry = (id: string, hosts: string[]) => ({ versionId: id, assignedHosts: hosts });

  it("markVerified records the set as last verified; a wrong generation conflicts", async () => {
    await put(V1, material(["a.example.test"]));
    await rig.store.publishFiles(0, [entry(V1, ["a.example.test"])]);
    expect((await reasonOf(rig.store.markVerified(7))).reason).toBe("TLS_MANIFEST_CONFLICT");
    const state = await rig.store.markVerified(1);
    expect(state).toMatchObject({ verified: true, lastVerified: { generation: 1, entries: [{ versionId: V1 }] } });
  });

  it("reverts to the last verified set, keeping the generation, and rewrites the manifest", async () => {
    await put(V1, material(["a.example.test"]));
    await put(V2, material(["b.example.test"]));
    await rig.store.publishFiles(0, [entry(V1, ["a.example.test"])]);
    await rig.store.markVerified(1);
    await rig.store.publishFiles(1, [entry(V1, ["a.example.test"]), entry(V2, ["b.example.test"])]);
    expect(await readFile(rig.manifestPath, "utf8")).toContain(V2);

    const state = await rig.store.revertToLastVerified();
    expect(state).toMatchObject({ generation: 2, verified: true, current: { entries: [{ versionId: V1 }] } });
    const manifest = await readFile(rig.manifestPath, "utf8");
    expect(manifest).toContain(V1);
    expect(manifest).not.toContain(V2);
  });

  it("reverts to an empty set (manifest removed) when nothing was ever verified", async () => {
    await put(V1, material(["a.example.test"]));
    await rig.store.publishFiles(0, [entry(V1, ["a.example.test"])]);
    const state = await rig.store.revertToLastVerified();
    expect(state).toMatchObject({ generation: 1, verified: true, current: { entries: [] } });
    expect(rig.manifestWrites.at(-1)).toBeNull();
    await expect(stat(rig.manifestPath)).rejects.toThrow();
  });
});

describe("recoverAtStart", () => {
  const entry = (id: string, hosts: string[]) => ({ versionId: id, assignedHosts: hosts });

  it("re-renders the manifest from state after a crash between state and manifest", async () => {
    await put(V1, material(["a.example.test"]));
    const crashing = rig.make({
      writeManifest: async () => {
        throw new Error("crash");
      },
    });
    await expect(crashing.publishFiles(0, [entry(V1, ["a.example.test"])])).rejects.toThrow("crash");
    expect((await rig.store.readState())?.generation).toBe(1); // state landed
    await expect(stat(rig.manifestPath)).rejects.toThrow(); // manifest did not

    // The unverified current is never rendered at start (nothing verified before it => no manifest); the replay does.
    expect(await rig.store.recoverAtStart()).toEqual({ recovered: true, generation: 1, missing: [] });
    await expect(stat(rig.manifestPath)).rejects.toThrow();
    // the replaying API call then finds the same set at base+1
    expect(await rig.store.publishFiles(0, [entry(V1, ["a.example.test"])])).toEqual({ generation: 1, replayed: true });
    expect(await readFile(rig.manifestPath, "utf8")).toBe(rig.store.renderManifest([V1]));
  });

  it("renders the last verified set, not the unverified current, when the manifest write failed after the state write", async () => {
    await put(V1, material(["a.example.test"]));
    await put(V2, material(["b.example.test"]));
    await rig.store.publishFiles(0, [entry(V1, ["a.example.test"])]);
    await rig.store.markVerified(1);
    const crashing = rig.make({ writeManifest: async () => { throw new Error("crash"); } });
    await expect(crashing.publishFiles(1, [entry(V2, ["b.example.test"])])).rejects.toThrow("crash");
    expect(await rig.store.recoverAtStart()).toEqual({ recovered: true, generation: 2, missing: [] });
    expect(await readFile(rig.manifestPath, "utf8")).toBe(rig.store.renderManifest([V1]));
  });

  it("leaves the manifest untouched when there is no state file", async () => {
    await writeFile(rig.manifestPath, "# written by an older release\n");
    expect(await rig.store.recoverAtStart()).toEqual({ recovered: false, generation: 0, missing: [] });
    expect(rig.manifestWrites).toEqual([]);
    expect(await readFile(rig.manifestPath, "utf8")).toBe("# written by an older release\n");
  });

  it("leaves versions whose files are gone out of the manifest and reports them", async () => {
    await put(V1, material(["a.example.test"]));
    await put(V2, material(["b.example.test"]));
    await rig.store.publishFiles(0, [entry(V1, ["a.example.test"]), entry(V2, ["b.example.test"])]);
    await rig.store.markVerified(1);
    await rm(path.join(rig.dir, V2), { recursive: true });
    const result = await rig.store.recoverAtStart();
    expect(result).toEqual({ recovered: true, generation: 1, missing: [V2] });
    const manifest = await readFile(rig.manifestPath, "utf8");
    expect(manifest).toContain(V1);
    expect(manifest).not.toContain(V2);
  });

  it("refuses a corrupt state file instead of guessing", async () => {
    await writeFile(rig.statePath, "{not json", { mode: 0o600 });
    expect((await reasonOf(rig.store.recoverAtStart())).reason).toBe("TLS_STATE_INVALID");
    expect(rig.manifestWrites).toEqual([]);
  });
});

describe("inventory", () => {
  it("lists versions with fingerprint, notAfter and Traefik names, without any PEM", async () => {
    const m = material(["shop.example.test", "www.shop.example.test"]);
    await put(V1, m);
    await put(V2, material(["gone.example.test"]));
    await rig.store.publishFiles(0, [{ versionId: V1, assignedHosts: ["shop.example.test"] }]);
    await rm(path.join(rig.dir, V2), { recursive: true });

    const inv = await rig.store.inventory();
    expect(inv.generation).toBe(1);
    expect(inv.verified).toBe(false);
    expect(inv.versions).toEqual([
      {
        versionId: V1,
        fingerprintSha256: m.fingerprintSha256,
        notAfter: m.cert.x509.validTo ? new Date(m.cert.x509.validTo).toISOString() : "",
        names: ["shop.example.test", "www.shop.example.test"],
      },
    ]);
    expect(inv.entries).toEqual([{ versionId: V1, assignedHosts: ["shop.example.test"] }]);
    expect(inv.missing).toEqual([]);
    expect(JSON.stringify(inv)).not.toMatch(/BEGIN|PRIVATE/);
  });

  it("reports referenced-but-absent versions as missing and starts at generation 0 without state", async () => {
    expect(await rig.store.inventory()).toEqual({ generation: 0, verified: true, versions: [], entries: [], missing: [] });
    const m = material(["a.example.test"]);
    await put(V1, m);
    await rig.store.publishFiles(0, [{ versionId: V1, assignedHosts: ["a.example.test"] }]);
    await rm(path.join(rig.dir, V1), { recursive: true });
    expect((await rig.store.inventory()).missing).toEqual([V1]);
  });

  it("does not list a version whose key was swapped for another certificate's", async () => {
    await put(V1, material(["a.example.test"]));
    const keyFile = path.join(rig.dir, V1, "privkey.pem");
    await chmod(keyFile, 0o600);
    await writeFile(keyFile, material(["b.example.test"]).keyPem);
    await chmod(keyFile, 0o400);
    expect((await rig.store.inventory()).versions).toEqual([]);
  });
});

describe("gc", () => {
  const entry = (id: string, hosts: string[]) => ({ versionId: id, assignedHosts: hosts });

  async function publishVerified(id: string, host: string, base: number): Promise<void> {
    await rig.store.publishFiles(base, [entry(id, [host])]);
    await rig.store.markVerified(base + 1);
  }

  it("keeps current ∪ lastVerified and removes the rest", async () => {
    await put(V1, material(["a.example.test"]));
    await put(V2, material(["b.example.test"]));
    await put(V3, material(["c.example.test"]));
    await publishVerified(V1, "a.example.test", 0); // lastVerified = V1
    await rig.store.publishFiles(1, [entry(V2, ["b.example.test"])]); // current = V2, unverified
    await rig.store.markVerified(2); // lastVerified = V2 now; V1 is an orphan
    expect(await rig.store.gc(2)).toEqual({ removed: [V1, V3].sort() });
    expect(await readdir(rig.dir)).toEqual([V2]);
  });

  it("keeps the last verified set while the current one is unverified", async () => {
    await put(V1, material(["a.example.test"]));
    await put(V2, material(["b.example.test"]));
    await put(V3, material(["c.example.test"]));
    await publishVerified(V1, "a.example.test", 0);
    await rig.store.publishFiles(1, [entry(V2, ["b.example.test"])]);
    // verified:false => nothing is collected
    expect(await rig.store.gc(2)).toEqual({ removed: [] });
    expect((await readdir(rig.dir)).sort()).toEqual([V1, V2, V3]);
  });

  it("answers a stale generation with TLS_MANIFEST_CONFLICT", async () => {
    await put(V1, material(["a.example.test"]));
    await publishVerified(V1, "a.example.test", 0);
    expect((await reasonOf(rig.store.gc(0))).reason).toBe("TLS_MANIFEST_CONFLICT");
  });

  it("collects nothing but stale stage dirs when no state exists", async () => {
    await put(V1, material(["a.example.test"]));
    const stale = path.join(rig.dir, `.stage-${V2}-abc123`);
    const fresh = path.join(rig.dir, `.stage-${V3}-abc123`);
    await mkdir(stale, { mode: 0o700 });
    await mkdir(fresh, { mode: 0o700 });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, old, old);
    expect(await rig.store.gc(0)).toEqual({ removed: [] });
    expect((await readdir(rig.dir)).sort()).toEqual([`.stage-${V3}-abc123`, V1]);
  });

  it("removes stale stage dirs (older than 1 h) even while unverified, keeps fresh ones", async () => {
    await put(V1, material(["a.example.test"]));
    await rig.store.publishFiles(0, [entry(V1, ["a.example.test"])]);
    const stale = path.join(rig.dir, `.stage-${V2}-abc123`);
    const fresh = path.join(rig.dir, `.stage-${V3}-abc123`);
    await mkdir(stale, { mode: 0o700 });
    await mkdir(fresh, { mode: 0o700 });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, old, old);
    await rig.store.gc(1);
    expect((await readdir(rig.dir)).sort()).toEqual([`.stage-${V3}-abc123`, V1]);
  });

  it("never follows a symlink and ignores foreign entries", async () => {
    await put(V1, material(["a.example.test"]));
    await publishVerified(V1, "a.example.test", 0);
    const victim = path.join(rig.root, "victim");
    await mkdir(victim, { mode: 0o700 });
    await writeFile(path.join(victim, "keep"), "x");
    await symlink(victim, path.join(rig.dir, V2));
    await writeFile(path.join(rig.dir, "notes.txt"), "mine");
    expect(await rig.store.gc(1)).toEqual({ removed: [] });
    expect(await readFile(path.join(victim, "keep"), "utf8")).toBe("x");
    expect((await lstat(path.join(rig.dir, V2))).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(rig.dir, "notes.txt"), "utf8")).toBe("mine");
  });

  it("keeps a freshly put version inside the grace window", async () => {
    const store = rig.make({ gcGraceMs: 5 * 60 * 1000 });
    await put(V1, material(["a.example.test"]), store);
    await put(V2, material(["b.example.test"]), store);
    await store.publishFiles(0, [entry(V1, ["a.example.test"])]);
    await store.markVerified(1);
    expect(await store.gc(1)).toEqual({ removed: [] });
    expect((await readdir(rig.dir)).sort()).toEqual([V1, V2]);
  });
});
