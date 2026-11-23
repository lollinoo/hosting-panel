// QA2 adversarial tests for the executor side of manual TLS (HCP-SPEC-004 M2): planted symlinks and files, wrong
// modes/owners, concurrency, crash windows (TLS-09), GC safety, manifest soundness, PEM leakage, the cold-path guard,
// IPC bounds and "no YAML below dynamic/manual-certs". Everything runs in a temp dir; Docker is a fake HTTP socket.
import { X509Certificate, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createSecureContext, createServer as createTlsServer, type SecureContext, type Server as TlsServer } from "node:tls";
import { signIpcRequest, type IpcSigningKey, type IpcVerificationKey } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueCert } from "../../api/test/fixtures/tls-certgen.js";
import { DockerEngineSocketAdapter, DockerExecutorIpcServer, InMemoryDockerSimulatorAdapter } from "../src/index.js";
import { ManualTlsStore, ManualTlsStoreError } from "../src/manual-tls-store.js";

// Passthrough fs with a switch that makes the lstat/open of paths ending in `suffix` fail with EIO (a transient error).
const fault = vi.hoisted(() => ({ suffix: null as string | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const eio = () => Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
  const hit = (p: unknown): boolean => fault.suffix !== null && String(p).endsWith(fault.suffix);
  return {
    ...real,
    lstat: ((p: Parameters<typeof real.lstat>[0], ...rest: unknown[]) =>
      hit(p) ? Promise.reject(eio()) : (real.lstat as (...a: unknown[]) => unknown)(p, ...rest)) as typeof real.lstat,
    open: ((p: Parameters<typeof real.open>[0], ...rest: unknown[]) =>
      hit(p) ? Promise.reject(eio()) : (real.open as (...a: unknown[]) => unknown)(p, ...rest)) as typeof real.open,
  };
});

const V = (n: number): string => `ctv_${n.toString(16).padStart(32, "0")}`;
const CANARY = "PEM-CANARY-7d41b0e2";
const MOUNT = "/etc/traefik/dynamic";
const isRoot = process.getuid?.() === 0;

const fingerprintOf = (pem: string): string => new X509Certificate(pem).fingerprint256.replaceAll(":", "").toLowerCase();

function material(dns: readonly string[]) {
  const cert = issueCert({ dns });
  return { fullchainPem: cert.pem, keyPem: cert.keyPem, fingerprintSha256: fingerprintOf(cert.pem) };
}
type Material = ReturnType<typeof material>;

const roots: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const exists = (p: string): Promise<boolean> => lstat(p).then(() => true, () => false);

async function walk(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    const info = await lstat(path.join(dir, name));
    out.push(rel);
    if (info.isDirectory()) out.push(...(await walk(path.join(dir, name), rel)));
  }
  return out;
}

// -- store rig ---------------------------------------------------------------------------------------------------------

interface Rig {
  root: string;
  dyn: string;
  dir: string;
  statePath: string;
  manifestPath: string;
  writes: (string | null)[];
  failManifest(times: number): void;
  store: ManualTlsStore;
  make(extra?: Partial<ConstructorParameters<typeof ManualTlsStore>[0]>): ManualTlsStore;
}

async function newRig(): Promise<Rig> {
  const root = await mkdtemp(path.join(os.tmpdir(), "manual-tls-adv-"));
  roots.push(root);
  const dyn = path.join(root, "dynamic");
  const dir = path.join(dyn, "manual-certs");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const statePath = path.join(root, "manual-tls-state.json");
  const manifestPath = path.join(dyn, "hp-manual-certificates.yml");
  const writes: (string | null)[] = [];
  let failures = 0;
  const writeManifest = async (content: string | null): Promise<void> => {
    if (failures > 0) {
      failures -= 1;
      throw new Error("disk full");
    }
    writes.push(content);
    if (content === null) await rm(manifestPath, { force: true });
    else await writeFile(manifestPath, content, { mode: 0o644 });
  };
  const readManifest = (): Promise<string | null> => readFile(manifestPath, "utf8").catch(() => null);
  const make = (extra = {}): ManualTlsStore =>
    new ManualTlsStore({ dir, statePath, writeManifest, readManifest, gcGraceMs: 0, ...extra });
  return {
    root,
    dyn,
    dir,
    statePath,
    manifestPath,
    writes,
    failManifest: (n) => {
      failures = n;
    },
    store: make(),
    make,
  };
}

const put = (id: string, m: Material, store: ManualTlsStore) =>
  store.putVersion({ versionId: id, fullchainPem: m.fullchainPem, keyPem: m.keyPem, fingerprintSha256: m.fingerprintSha256 });

const reasonOf = async (work: Promise<unknown>): Promise<ManualTlsStoreError> => {
  try {
    await work;
  } catch (err) {
    expect(err).toBeInstanceOf(ManualTlsStoreError);
    return err as ManualTlsStoreError;
  }
  throw new Error("expected a ManualTlsStoreError");
};

const entry = (id: string, hosts: string[] = ["a.test"]) => ({ versionId: id, assignedHosts: hosts });

/** Every file the manifest references exists as a regular 0400 file. Returns the referenced ids. */
async function expectManifestSound(r: Rig): Promise<string[]> {
  const text = await readFile(r.manifestPath, "utf8").catch(() => null);
  if (text === null) return [];
  const refs = [...text.matchAll(/(?:certFile|keyFile): "([^"]+)"/g)].map((m) => m[1]!);
  for (const ref of refs) {
    expect(ref.startsWith(`${MOUNT}/manual-certs/`), ref).toBe(true);
    const info = await lstat(path.join(r.dyn, ref.slice(MOUNT.length + 1))).catch(() => null);
    expect(info, `manifest references a missing file: ${ref}`).not.toBeNull();
    expect(info!.isFile() && (info!.mode & 0o777) === 0o400, ref).toBe(true);
  }
  return [...new Set(refs.map((ref) => /(ctv_[0-9a-f]{32})/.exec(ref)![1]!))].sort();
}

/** A verified published set: put + publish + markVerified. */
async function publishVerified(r: Rig, ids: string[], base: number, store = r.store): Promise<void> {
  for (const id of ids) await put(id, material([`${id.slice(-4)}.test`]), store).catch(() => undefined);
  await store.publishFiles(base, ids.map((id) => entry(id)));
  await store.markVerified(base + 1);
}

// -- planted symlinks and files ----------------------------------------------------------------------------------------

describe("planted symlinks and files", () => {
  async function symlinkedStore() {
    const r = await newRig();
    const outside = path.join(r.root, "outside");
    await mkdir(outside, { mode: 0o700 });
    await chmod(outside, 0o700);
    const foreign = new ManualTlsStore({ dir: outside, statePath: path.join(r.root, "other-state.json"), writeManifest: async () => undefined, gcGraceMs: 0 });
    await put(V(9), material(["victim.test"]), foreign);
    await publishVerified(r, [V(1)], 0);
    await rm(r.dir, { recursive: true });
    await symlink(outside, r.dir);
    return { r, outside };
  }

  it("a symlink at manual-certs: put refuses and writes nothing into the target", async () => {
    const { r, outside } = await symlinkedStore();
    expect((await reasonOf(put(V(2), material(["b.test"]), r.store))).reason).toBe("TLS_STORE_UNSAFE");
    expect(await readdir(outside)).toEqual([V(9)]);
  });

  // Fixed: gc() and inventory() run the same store-dir check as putVersion on every operation.
  it("a symlink at manual-certs: gc does not delete through it", async () => {
    const { r, outside } = await symlinkedStore();
    await r.store.gc(1).catch(() => undefined);
    expect(await exists(path.join(outside, V(9)))).toBe(true);
  });

  it("a symlink at manual-certs: inventory does not list what is behind it", async () => {
    const { r } = await symlinkedStore();
    const inventory = await r.store.inventory().catch(() => null);
    expect(inventory?.versions.map((v) => v.versionId) ?? []).not.toContain(V(9));
  });

  it("a symlink at a version dir is never trusted, followed or deleted through: put refuses, publish says missing, recovery drops it", async () => {
    const r = await newRig();
    const m = material(["a.test"]);
    await publishVerified(r, [V(1)], 0);
    const real = path.join(r.root, "elsewhere");
    await mkdir(real, { mode: 0o700 });
    const copy = new ManualTlsStore({ dir: real, statePath: path.join(r.root, "o.json"), writeManifest: async () => undefined });
    await put(V(1), m, copy);
    await rm(path.join(r.dir, V(1)), { recursive: true });
    await symlink(path.join(real, V(1)), path.join(r.dir, V(1)));
    const before = r.writes.length;

    expect((await reasonOf(put(V(1), m, r.store))).reason).toBe("TLS_STORE_UNSAFE");
    const missing = await reasonOf(r.store.publishFiles(1, [entry(V(1))]));
    expect([missing.reason, missing.versionIds]).toEqual(["TLS_VERSION_MISSING", [V(1)]]);
    expect(r.writes.length).toBe(before); // nothing written for a refused publish
    expect((await r.store.inventory()).versions).toEqual([]);

    const recovered = await r.store.recoverAtStart();
    expect(recovered.missing).toEqual([V(1)]);
    expect(await expectManifestSound(r)).toEqual([]);
    await r.store.gc(1);
    expect((await lstat(path.join(r.dir, V(1)))).isSymbolicLink()).toBe(true); // kept, not followed
    expect(await readdir(path.join(real, V(1)))).toEqual(["fullchain.pem", "privkey.pem"]);
  });

  it("a symlink at a PEM file is not read; a re-put replaces the link, never the file behind it", async () => {
    const r = await newRig();
    const m = material(["a.test"]);
    await put(V(1), m, r.store);
    await r.store.publishFiles(0, [entry(V(1))]);
    const target = path.join(r.root, "decoy.pem");
    await writeFile(target, m.keyPem, { mode: 0o400 });
    const keyFile = path.join(r.dir, V(1), "privkey.pem");
    await rm(keyFile, { force: true });
    await symlink(target, keyFile);

    expect((await reasonOf(r.store.publishFiles(1, [entry(V(1))]))).reason).toBe("TLS_VERSION_MISSING");
    expect((await r.store.inventory()).versions).toEqual([]);

    // Healing: the broken own directory is replaced, the link is removed, the target is not rewritten.
    expect((await put(V(1), m, r.store)).written).toBe(true);
    expect((await lstat(keyFile)).isSymbolicLink()).toBe(false);
    expect((await stat(keyFile)).mode & 0o777).toBe(0o400);
    expect(await readFile(target, "utf8")).toBe(m.keyPem);
    expect((await r.store.inventory()).versions.map((v) => v.versionId)).toEqual([V(1)]);
  });

  it("a symlinked PEM file to a world-readable file elsewhere is not exposed by inventory", async () => {
    const r = await newRig();
    const m = material(["a.test"]);
    await put(V(1), m, r.store);
    const secret = path.join(r.root, "secret.txt");
    await writeFile(secret, `${CANARY}\n`, { mode: 0o400 });
    const chainFile = path.join(r.dir, V(1), "fullchain.pem");
    await rm(chainFile);
    await symlink(secret, chainFile);
    const inventory = await r.store.inventory();
    expect(JSON.stringify(inventory)).not.toContain(CANARY);
    expect(inventory.versions).toEqual([]);
  });

  it("a version dir pre-existing as a regular file: put refuses without touching it, publish says missing, gc and inventory ignore it", async () => {
    const r = await newRig();
    const planted = path.join(r.dir, V(1));
    await writeFile(planted, `${CANARY}\n`, { mode: 0o600 });
    expect((await reasonOf(put(V(1), material(["a.test"]), r.store))).reason).toBe("TLS_STORE_UNSAFE");
    expect(await readFile(planted, "utf8")).toBe(`${CANARY}\n`);
    expect((await reasonOf(r.store.publishFiles(0, [entry(V(1))]))).reason).toBe("TLS_VERSION_MISSING");
    expect((await r.store.inventory()).versions).toEqual([]);
    await publishVerified(r, [V(2)], 0);
    expect((await r.store.gc(1)).removed).toEqual([]);
    expect(await readFile(planted, "utf8")).toBe(`${CANARY}\n`);
    expect((await readdir(r.dir)).filter((n) => n.startsWith(".stage-"))).toEqual([]);
  });

  it("a stale stage entry that is a symlink or a file is not followed and not removed by gc", async () => {
    const r = await newRig();
    const victim = path.join(r.root, "victim");
    await mkdir(victim, { mode: 0o700 });
    await writeFile(path.join(victim, "keep.txt"), "x");
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await symlink(victim, path.join(r.dir, `.stage-${V(3)}-aaaaaa`));
    await writeFile(path.join(r.dir, `.stage-${V(3)}-bbbbbb`), "x");
    await publishVerified(r, [V(1)], 0);
    await utimes(path.join(r.dir, `.stage-${V(3)}-bbbbbb`), old, old);
    await r.store.gc(1);
    expect(await readFile(path.join(victim, "keep.txt"), "utf8")).toBe("x");
    expect(await exists(path.join(r.dir, `.stage-${V(3)}-aaaaaa`))).toBe(true);
    expect(await exists(path.join(r.dir, `.stage-${V(3)}-bbbbbb`))).toBe(true);
  });

  it("ids that could escape the store or name a config file are refused before anything is created", async () => {
    const r = await newRig();
    const m = material(["a.test"]);
    const ids = [
      "../ctv_00000000000000000000000000000001",
      `${V(1)}/../${V(2)}`,
      `${V(1)}\n`,
      `${V(1)}.yml`,
      "ctv_" + "A".repeat(32),
      "ctv_" + "0".repeat(31),
      "",
      "..",
      "site_x",
    ];
    for (const id of ids) {
      expect((await reasonOf(put(id, m, r.store))).reason, JSON.stringify(id)).toBe("TLS_MATERIAL_INVALID");
      expect((await reasonOf(r.store.publishFiles(0, [entry(id)]))).reason, JSON.stringify(id)).toBe("TLS_MATERIAL_INVALID");
    }
    expect(await walk(r.root)).toEqual(["dynamic", "dynamic/manual-certs"]);
  });
});

// -- modes and owners --------------------------------------------------------------------------------------------------

describe("wrong mode or owner", () => {
  it.each([0o755, 0o750, 0o770, 0o705, 0o701, 0o710])("store dir mode %o is refused and nothing is written", async (mode) => {
    const r = await newRig();
    await chmod(r.dir, mode);
    expect((await reasonOf(put(V(1), material(["a.test"]), r.store))).reason).toBe("TLS_STORE_UNSAFE");
    expect(await readdir(r.dir)).toEqual([]);
    expect(await exists(r.statePath)).toBe(false);
  });

  it("a store dir owned by another uid is refused", async () => {
    const r = await newRig();
    const other = r.make({ uid: (process.getuid?.() ?? 1000) + 1 });
    expect((await reasonOf(put(V(1), material(["a.test"]), other))).reason).toBe("TLS_STORE_UNSAFE");
    expect(await readdir(r.dir)).toEqual([]);
  });

  it("an existing version is invisible to an executor running as another uid, and a put is refused", async () => {
    const r = await newRig();
    await publishVerified(r, [V(1)], 0);
    const other = r.make({ uid: (process.getuid?.() ?? 1000) + 1 });
    expect((await reasonOf(other.inventory())).reason).toBe("TLS_STORE_UNSAFE"); // the dir check runs on every operation
    expect((await reasonOf(other.publishFiles(1, [entry(V(1))]))).reason).toBe("TLS_STORE_UNSAFE");
    expect((await other.gc(1).catch(() => ({ removed: [] }))).removed).toEqual([]);
    expect(await exists(path.join(r.dir, V(1)))).toBe(true);
  });

  it.each([0o600, 0o440, 0o444, 0o200, 0o700])("a PEM file with mode %o is not trusted as a stored version", async (mode) => {
    const r = await newRig();
    await publishVerified(r, [V(1)], 0);
    await chmod(path.join(r.dir, V(1), "privkey.pem"), mode);
    expect((await r.store.inventory()).versions).toEqual([]);
    expect((await reasonOf(r.store.publishFiles(1, [entry(V(1))]))).reason).toBe("TLS_VERSION_MISSING");
  });

  it("a truncated, empty, swapped-key or oversized stored file is not trusted", async () => {
    const r = await newRig();
    const a = material(["a.test"]);
    const b = material(["b.test"]);
    for (const [id, damage] of [
      [V(1), async (d: string) => { await chmod(path.join(d, "fullchain.pem"), 0o600); await writeFile(path.join(d, "fullchain.pem"), ""); await chmod(path.join(d, "fullchain.pem"), 0o400); }],
      [V(2), async (d: string) => { await chmod(path.join(d, "privkey.pem"), 0o600); await writeFile(path.join(d, "privkey.pem"), b.keyPem); await chmod(path.join(d, "privkey.pem"), 0o400); }],
      [V(3), async (d: string) => { await chmod(path.join(d, "fullchain.pem"), 0o600); await writeFile(path.join(d, "fullchain.pem"), a.fullchainPem + "#".repeat(700 * 1024)); await chmod(path.join(d, "fullchain.pem"), 0o400); }],
    ] as const) {
      await put(id, a, r.store);
      await damage(path.join(r.dir, id));
    }
    expect((await r.store.inventory()).versions).toEqual([]);
    const missing = await reasonOf(r.store.publishFiles(0, [entry(V(1)), entry(V(2)), entry(V(3))]));
    expect([missing.reason, missing.versionIds]).toEqual(["TLS_VERSION_MISSING", [V(1), V(2), V(3)]]);
  });

  // Fixed: readVersion() enforces the version dir's 0700 mode (design D1) next to the type and owner.
  it("a version dir that is open to everyone (0777) is not trusted either", async () => {
    const r = await newRig();
    await publishVerified(r, [V(1)], 0);
    await chmod(path.join(r.dir, V(1)), 0o777);
    expect((await r.store.inventory()).versions).toEqual([]);
  });

  it("the state file as a symlink fails closed: no publish, no manifest write, the link target untouched", async () => {
    const r = await newRig();
    await publishVerified(r, [V(1)], 0);
    const decoy = path.join(r.root, "decoy-state.json");
    const bytes = await readFile(r.statePath);
    await writeFile(decoy, bytes);
    await rm(r.statePath);
    await symlink(decoy, r.statePath);
    const writes = r.writes.length;
    await put(V(2), material(["b.test"]), r.store);
    expect((await reasonOf(r.store.publishFiles(1, [entry(V(2))]))).reason).toBe("TLS_STATE_INVALID");
    expect((await reasonOf(r.store.gc(1))).reason).toBe("TLS_STATE_INVALID");
    expect((await reasonOf(r.store.recoverAtStart())).reason).toBe("TLS_STATE_INVALID");
    expect(r.writes.length).toBe(writes);
    expect(await readFile(decoy)).toEqual(bytes);
    expect(await exists(path.join(r.dir, V(1)))).toBe(true);
  });

  it.each([
    ["truncated", '{"schema":1,"generation":'],
    ["wrong schema", JSON.stringify({ schema: 2, generation: 1, current: { entries: [] }, verified: true, lastVerified: null, updatedAt: "x" })],
    ["negative generation", JSON.stringify({ schema: 1, generation: -1, current: { entries: [] }, verified: true, lastVerified: null, updatedAt: "x" })],
    ["fractional generation", JSON.stringify({ schema: 1, generation: 1.5, current: { entries: [] }, verified: true, lastVerified: null, updatedAt: "x" })],
    ["traversal id", JSON.stringify({ schema: 1, generation: 1, current: { entries: [{ versionId: "../../etc", assignedHosts: [] }] }, verified: true, lastVerified: null, updatedAt: "x" })],
    ["missing lastVerified", JSON.stringify({ schema: 1, generation: 1, current: { entries: [] }, verified: true, updatedAt: "x" })],
    ["array", "[]"],
    ["null", "null"],
  ])("a corrupt state file (%s) stops publish and gc and is never overwritten or guessed", async (_name, body) => {
    const r = await newRig();
    await publishVerified(r, [V(1)], 0);
    await put(V(2), material(["b.test"]), r.store);
    await writeFile(r.statePath, body);
    const writes = r.writes.length;
    expect((await reasonOf(r.store.publishFiles(1, [entry(V(2))]))).reason).toBe("TLS_STATE_INVALID");
    expect((await reasonOf(r.store.gc(1))).reason).toBe("TLS_STATE_INVALID");
    expect((await reasonOf(r.store.markVerified(1))).reason).toBe("TLS_STATE_INVALID");
    expect((await reasonOf(r.store.revertToLastVerified())).reason).toBe("TLS_STATE_INVALID");
    expect(await readFile(r.statePath, "utf8")).toBe(body);
    expect(r.writes.length).toBe(writes);
    expect((await readdir(r.dir)).sort()).toEqual([V(1), V(2)]);
  });

  it("the material size limit is exact: 614400 bytes are kept, one more is refused with no dir left", async () => {
    const r = await newRig();
    const m = material(["a.test"]);
    const pad = (bytes: number): string => {
      const base = m.fullchainPem.endsWith("\n") ? m.fullchainPem : `${m.fullchainPem}\n`;
      return base + "#".repeat(bytes - Buffer.byteLength(base) - 1) + "\n";
    };
    const max = pad(600 * 1024);
    expect(Buffer.byteLength(max)).toBe(600 * 1024);
    expect((await put(V(1), { ...m, fullchainPem: max }, r.store)).written).toBe(true);
    expect((await r.store.inventory()).versions.map((v) => v.versionId)).toEqual([V(1)]);
    const over = pad(600 * 1024 + 1);
    expect((await reasonOf(put(V(2), { ...m, fullchainPem: over }, r.store))).reason).toBe("TLS_MATERIAL_INVALID");
    expect((await reasonOf(put(V(3), { ...m, keyPem: m.keyPem + "#".repeat(600 * 1024) }, r.store))).reason).toBe("TLS_MATERIAL_INVALID");
    expect((await readdir(r.dir)).sort()).toEqual([V(1)]);
  });
});

// -- concurrency -------------------------------------------------------------------------------------------------------

describe("concurrency", () => {
  it("eight concurrent publishes on the same base: exactly one wins, state and manifest are the winner's", async () => {
    const r = await newRig();
    const ids = Array.from({ length: 8 }, (_, i) => V(i + 1));
    for (const id of ids) await put(id, material([`h${id.slice(-2)}.test`]), r.store);
    const results = await Promise.allSettled(ids.map((id) => r.store.publishFiles(0, [entry(id)])));
    const won = results.flatMap((res, i) => (res.status === "fulfilled" ? [i] : []));
    expect(won).toHaveLength(1);
    for (const res of results) {
      if (res.status === "rejected") expect((res.reason as ManualTlsStoreError).reason).toBe("TLS_MANIFEST_CONFLICT");
    }
    const state = await r.store.readState();
    expect(state).toMatchObject({ generation: 1, verified: false });
    expect(state!.current.entries.map((e) => e.versionId)).toEqual([ids[won[0]!]]);
    expect(r.writes).toEqual([r.store.renderManifest([ids[won[0]!]!])]);
    expect(await expectManifestSound(r)).toEqual([ids[won[0]!]]);
  });

  it("two identical concurrent publishes are one write and one replay", async () => {
    const r = await newRig();
    await put(V(1), material(["a.test"]), r.store);
    const [a, b] = await Promise.all([r.store.publishFiles(0, [entry(V(1))]), r.store.publishFiles(0, [entry(V(1))])]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a.generation).toBe(1);
    expect(b.generation).toBe(1);
    expect((await r.store.readState())?.generation).toBe(1);
  });

  it("a chain of concurrent publishes at 0,1,2,3 in any arrival order keeps a single linear history", async () => {
    const r = await newRig();
    const ids = [V(1), V(2), V(3), V(4)];
    for (const id of ids) await put(id, material([`h${id.slice(-2)}.test`]), r.store);
    const calls = [3, 1, 0, 2].map((base) => r.store.publishFiles(base, [entry(ids[base]!)]).then(() => base, () => -1));
    const settled = await Promise.all(calls);
    // Arrival order is 3,1,0,2: only base 0 matches generation 0; then 3,1,2 are stale or become valid in turn.
    const state = await r.store.readState();
    expect(state!.generation).toBe(settled.filter((x) => x >= 0).length);
    expect(r.writes).toHaveLength(state!.generation);
    expect(settled).toContain(0);
  });

  it("concurrent puts of the same id and material from two executors: both succeed, one writes, no stage dir is left", async () => {
    const r = await newRig();
    const m = material(["a.test"]);
    const results = await Promise.all([put(V(1), m, r.make()), put(V(1), m, r.make()), put(V(1), m, r.make())]);
    expect(results.filter((x) => x.written)).toHaveLength(1);
    expect((await readdir(r.dir)).sort()).toEqual([V(1)]);
  });

  it("concurrent puts of one id with different material: one wins, the other is a conflict, the winner's bytes stay", async () => {
    const r = await newRig();
    const a = material(["a.test"]);
    const b = material(["b.test"]);
    const results = await Promise.allSettled([put(V(1), a, r.make()), put(V(1), b, r.make())]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect((lost.reason as ManualTlsStoreError).reason).toBe("TLS_VERSION_CONFLICT");
    const winner = results[0]!.status === "fulfilled" ? a : b;
    expect((await r.store.inventory()).versions.map((v) => v.fingerprintSha256)).toEqual([winner.fingerprintSha256]);
    expect((await readdir(r.dir)).sort()).toEqual([V(1)]);
  });

  it("gc racing a publish never leaves a published version deleted, in either arrival order", async () => {
    for (const gcFirst of [true, false]) {
      const r = await newRig();
      await publishVerified(r, [V(1)], 0);
      await put(V(2), material(["b.test"]), r.store); // old, unreferenced: collectable (grace 0)
      const publish = () => r.store.publishFiles(1, [entry(V(2))]).then(() => "ok" as const, (e: ManualTlsStoreError) => e.reason);
      const collect = () => r.store.gc(1).then(() => "ok" as const, (e: ManualTlsStoreError) => e.reason);
      const [p, g] = gcFirst ? (await Promise.all([collect(), publish()])).reverse() : await Promise.all([publish(), collect()]);
      const state = await r.store.readState();
      if (p === "ok") {
        expect(state!.current.entries.map((e) => e.versionId)).toEqual([V(2)]);
        expect(await exists(path.join(r.dir, V(2))), `gcFirst=${String(gcFirst)} gc=${String(g)}`).toBe(true);
        expect(await expectManifestSound(r)).toEqual([V(2)]);
      } else {
        expect(["TLS_VERSION_MISSING", "TLS_MANIFEST_CONFLICT"]).toContain(p);
      }
    }
  });
});

// -- crash windows (TLS-09) --------------------------------------------------------------------------------------------

describe("crash windows", () => {
  it("crash after the files, before any state: a new executor changes nothing, and gc never collects the orphan with no state", async () => {
    const r = await newRig();
    await put(V(1), material(["a.test"]), r.store);
    const fresh = r.make({ now: () => new Date(Date.now() + 30 * 24 * 3600 * 1000) });
    expect(await fresh.recoverAtStart()).toEqual({ recovered: false, generation: 0, missing: [] });
    expect(r.writes).toEqual([]);
    expect(await exists(r.manifestPath)).toBe(false);
    expect((await fresh.gc(0)).removed).toEqual([]);
    expect(await exists(path.join(r.dir, V(1)))).toBe(true);
  });

  it("crash between state and manifest on the first publish: the old manifest stays valid, recovery and a replay both complete it", async () => {
    const r = await newRig();
    await publishVerified(r, [V(1)], 0);
    const previous = await readFile(r.manifestPath, "utf8");
    await put(V(2), material(["b.test"]), r.store);
    r.failManifest(1);
    await expect(r.store.publishFiles(1, [entry(V(2))])).rejects.toThrow("disk full");
    expect(await readFile(r.manifestPath, "utf8")).toBe(previous);
    expect(await expectManifestSound(r)).toEqual([V(1)]);
    expect(await r.store.readState()).toMatchObject({ generation: 2, verified: false });

    const restarted = r.make();
    expect(await restarted.recoverAtStart()).toEqual({ recovered: true, generation: 2, missing: [] });
    expect(await expectManifestSound(r)).toEqual([V(1)]); // the unverified current is never rendered without a probe

    // The caller that crashed retries the same publish: an idempotent replay, generation unchanged.
    r.failManifest(1);
    await expect(r.store.publishFiles(1, [entry(V(2))])).rejects.toThrow("disk full");
    expect(await r.store.publishFiles(1, [entry(V(2))])).toEqual({ generation: 2, replayed: true });
    expect(await expectManifestSound(r)).toEqual([V(2)]);
    expect((await r.store.readState())?.generation).toBe(2);
  });

  it("crash after the manifest, before markVerified: recovery renders the last verified set, nothing is collected, revert still reaches the last verified set", async () => {
    const r = await newRig();
    await publishVerified(r, [V(1)], 0);
    await put(V(2), material(["b.test"]), r.store);
    await r.store.publishFiles(1, [entry(V(2))]); // ... crash here: never marked verified
    const restarted = r.make();
    await restarted.recoverAtStart();
    expect(await expectManifestSound(r)).toEqual([V(1)]);
    expect((await restarted.gc(2)).removed).toEqual([]); // verified:false => nothing collected
    expect((await readdir(r.dir)).sort()).toEqual([V(1), V(2)]);
    await restarted.revertToLastVerified();
    expect(await expectManifestSound(r)).toEqual([V(1)]);
    expect(await restarted.readState()).toMatchObject({ generation: 2, verified: true });
  });

  it("crash between state and manifest on a revert: recovery puts the manifest back to the verified set", async () => {
    const r = await newRig();
    await publishVerified(r, [V(1)], 0);
    await put(V(2), material(["b.test"]), r.store);
    await r.store.publishFiles(1, [entry(V(2))]);
    r.failManifest(1);
    await expect(r.store.revertToLastVerified()).rejects.toThrow("disk full");
    expect(await expectManifestSound(r)).toEqual([V(2)]); // stale but every file still exists
    await r.make().recoverAtStart();
    expect(await expectManifestSound(r)).toEqual([V(1)]);
  });

  it("a stray state temp file from a crashed write is ignored and the previous state stays authoritative", async () => {
    const r = await newRig();
    await publishVerified(r, [V(1)], 0);
    await writeFile(path.join(r.root, ".manual-tls-state.json.deadbeef0000.tmp"), '{"schema":1,"generation":99');
    expect(await r.make().readState()).toMatchObject({ generation: 1, verified: true });
    await put(V(2), material(["b.test"]), r.store);
    expect(await r.store.publishFiles(1, [entry(V(2))])).toMatchObject({ generation: 2 });
  });

  it("recovery with versions that vanished leaves them out and never writes a manifest that points at a missing file", async () => {
    const r = await newRig();
    await publishVerified(r, [V(1), V(2), V(3)], 0);
    await rm(path.join(r.dir, V(2)), { recursive: true });
    const recovered = await r.make().recoverAtStart();
    expect(recovered.missing).toEqual([V(2)]);
    expect(await expectManifestSound(r)).toEqual([V(1), V(3)]);
  });

  it("a publish with one missing version among many writes neither state nor manifest", async () => {
    const r = await newRig();
    await publishVerified(r, [V(1)], 0);
    const state = await readFile(r.statePath, "utf8");
    const manifest = await readFile(r.manifestPath, "utf8");
    await put(V(2), material(["b.test"]), r.store);
    const missing = await reasonOf(r.store.publishFiles(1, [entry(V(1)), entry(V(2)), entry(V(7)), entry(V(8))]));
    expect([missing.reason, missing.versionIds]).toEqual(["TLS_VERSION_MISSING", [V(7), V(8)]]);
    expect(await readFile(r.statePath, "utf8")).toBe(state);
    expect(await readFile(r.manifestPath, "utf8")).toBe(manifest);
  });
});

// -- the manifest never references a missing file ----------------------------------------------------------------------

describe("manifest soundness", () => {
  it("manifest text depends on the version ids only: host names and generation never reach the YAML", async () => {
    const r = await newRig();
    await put(V(1), material(["a.test"]), r.store);
    await r.store.publishFiles(0, [entry(V(1), ['a.test"\nhttp:\n  routers: {}', "x: !!binary"])]);
    const text = await readFile(r.manifestPath, "utf8");
    expect(text).toBe(r.store.renderManifest([V(1)]));
    expect(text).not.toContain("routers");
    expect(text).not.toContain("binary");
    expect(text.match(/\n/g)).toHaveLength(5);
  });

  // Fixed: revertToLastVerified() keeps only the verified versions whose files still exist.
  it("a revert never writes a manifest that references a version whose files vanished", async () => {
    const r = await newRig();
    await publishVerified(r, [V(1)], 0);
    await put(V(2), material(["b.test"]), r.store);
    await r.store.publishFiles(1, [entry(V(2))]); // unverified, last verified = {V1}
    await rm(path.join(r.dir, V(1)), { recursive: true }); // operator error or disk damage
    await r.store.revertToLastVerified().catch(() => undefined);
    expect(await expectManifestSound(r)).not.toContain(V(1));
  });

  it("a transient I/O error on a verified version fails the revert and changes nothing (EIO is not 'missing')", async () => {
    const r = await newRig();
    await publishVerified(r, [V(1), V(3)], 0);
    await put(V(2), material(["b.test"]), r.store);
    await r.store.publishFiles(1, [entry(V(2))]);
    const before = await readFile(r.statePath, "utf8");
    const manifest = await readFile(r.manifestPath, "utf8");
    for (const suffix of [V(3), `${V(3)}/fullchain.pem`]) {
      fault.suffix = suffix;
      try {
        await expect(r.store.revertToLastVerified()).rejects.toMatchObject({ code: "EIO" });
        await expect(r.store.recoverAtStart()).rejects.toMatchObject({ code: "EIO" });
      } finally {
        fault.suffix = null;
      }
      expect(await readFile(r.statePath, "utf8")).toBe(before);
      expect(await readFile(r.manifestPath, "utf8")).toBe(manifest);
    }
    await r.store.revertToLastVerified(); // the error went away: both verified entries are back
    expect((await r.store.readState())?.lastVerified?.entries.map((e) => e.versionId)).toEqual([V(1), V(3)]);
  });

  // Fixed: gc() also keeps every version the manifest on disk still lists.
  it("gc after a failed revert manifest write does not delete a version the manifest on disk still lists", async () => {
    const r = await newRig();
    await publishVerified(r, [V(1)], 0);
    await put(V(2), material(["b.test"]), r.store);
    await r.store.publishFiles(1, [entry(V(2))]);
    r.failManifest(1);
    await expect(r.store.revertToLastVerified()).rejects.toThrow("disk full"); // state => {V1}, manifest still => {V2}
    await r.store.gc(2).catch(() => undefined);
    expect(await expectManifestSound(r)).toEqual([V(2)]);
    expect(await exists(path.join(r.dir, V(2)))).toBe(true);
  });

  it("random publish / revert / verify / recover / gc / vanish sequences never leave a manifest pointing at a missing file", async () => {
    let seed = 20260721;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 6; round += 1) {
      const r = await newRig();
      const ids = [V(1), V(2), V(3), V(4)];
      for (const id of ids) await put(id, material([`h${id.slice(-2)}.test`]), r.store);
      for (let step = 0; step < 25; step += 1) {
        const state = await r.store.readState();
        const generation = state?.generation ?? 0;
        const pick = ids.filter(() => rand(2) === 0);
        const op = rand(6);
        try {
          if (op === 0) await r.store.publishFiles(generation, pick.map((id) => entry(id)));
          else if (op === 1) await r.store.markVerified(generation);
          else if (op === 2) await r.store.revertToLastVerified();
          else if (op === 3) await r.make().recoverAtStart();
          else if (op === 4) await r.store.gc(generation);
          else await rm(path.join(r.dir, ids[rand(4)]!), { recursive: true, force: true });
        } catch {
          // refusals are fine; the invariant is about what is on disk afterwards
        }
        // Only a vanished version can make a manifest stale, and only the operation that did it may leave it so.
        if (op !== 5) await expectManifestSound(r);
      }
    }
  });
});

// -- GC ----------------------------------------------------------------------------------------------------------------

describe("gc safety", () => {
  const age = async (dir: string, ms: number, now: Date): Promise<void> => {
    const t = new Date(now.getTime() - ms);
    await utimes(dir, t, t);
  };

  it("never removes a version younger than the grace window, removes older unreferenced ones", async () => {
    const r = await newRig();
    const now = new Date("2026-07-21T12:00:00Z");
    const store = r.make({ now: () => now, gcGraceMs: 60_000 });
    await publishVerified(r, [V(1)], 0, store);
    for (const id of [V(2), V(3), V(4)]) await put(id, material([`h${id.slice(-2)}.test`]), store);
    await age(path.join(r.dir, V(2)), 59_000, now);
    await age(path.join(r.dir, V(3)), 61_000, now);
    await age(path.join(r.dir, V(4)), -3_600_000, now); // clock skew: an mtime in the future
    expect((await store.gc(1)).removed).toEqual([V(3)]);
    expect((await readdir(r.dir)).sort()).toEqual([V(1), V(2), V(4)]);
  });

  it("never removes a version in current or lastVerified, however old, and keeps the whole store while unverified", async () => {
    const r = await newRig();
    const now = new Date("2026-07-21T12:00:00Z");
    const store = r.make({ now: () => now, gcGraceMs: 1000 });
    await publishVerified(r, [V(1)], 0, store);
    for (const id of [V(2), V(3)]) await put(id, material([`h${id.slice(-2)}.test`]), store);
    await store.publishFiles(1, [entry(V(2))]); // current {V2} unverified, lastVerified {V1}
    for (const id of [V(1), V(2), V(3)]) await age(path.join(r.dir, id), 10 * 86_400_000, now);
    expect((await store.gc(2)).removed).toEqual([]);
    await store.markVerified(2); // lastVerified = current = {V2}: V1 is now collectable, V3 never was referenced
    expect((await store.gc(2)).removed).toEqual([V(1), V(3)]);
    expect((await readdir(r.dir)).sort()).toEqual([V(2)]);
    await store.revertToLastVerified();
    expect(await expectManifestSound(r)).toEqual([V(2)]);
  });

  it("a stale generation removes nothing at all", async () => {
    const r = await newRig();
    await publishVerified(r, [V(1)], 0);
    await put(V(2), material(["b.test"]), r.store);
    for (const generation of [0, 2, 99]) expect((await reasonOf(r.store.gc(generation))).reason).toBe("TLS_MANIFEST_CONFLICT");
    expect((await readdir(r.dir)).sort()).toEqual([V(1), V(2)]);
  });

  it("ignores near-miss names, and does not treat a case variant of a referenced id as that id", async () => {
    const r = await newRig();
    await publishVerified(r, [V(1)], 0);
    const odd = ["CTV_" + "1".repeat(32), "ctv_" + "1".repeat(31), `${V(1)}.bak`, ".stage", "stage-x", "notes.txt"];
    for (const name of odd) await mkdir(path.join(r.dir, name), { mode: 0o700 }).catch(() => undefined);
    expect((await r.store.gc(1)).removed).toEqual([]);
    expect((await readdir(r.dir)).sort()).toEqual([...odd, V(1)].sort());
  });

  it("a fresh stage dir (a put in flight) survives gc; an hour-old one is collected", async () => {
    const r = await newRig();
    await publishVerified(r, [V(1)], 0);
    const fresh = path.join(r.dir, `.stage-${V(2)}-aaaaaa`);
    const stale = path.join(r.dir, `.stage-${V(3)}-bbbbbb`);
    await mkdir(fresh, { mode: 0o700 });
    await mkdir(stale, { mode: 0o700 });
    const old = new Date(Date.now() - 61 * 60 * 1000);
    await utimes(stale, old, old);
    await r.store.gc(1);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(stale)).toBe(false);
  });
});

// -- no PEM in errors --------------------------------------------------------------------------------------------------

describe("no PEM or key material leaves through errors", () => {
  const serialise = (err: unknown): string => {
    const e = err as Error & Record<string, unknown>;
    return [e.message, e.stack, JSON.stringify(e, Object.getOwnPropertyNames(e))].join("\n");
  };
  const fragments = (m: Material): string[] => [
    ...m.keyPem.split("\n").filter((l) => l.length > 20 && !l.startsWith("-----")),
    ...m.fullchainPem.split("\n").filter((l) => l.length > 20 && !l.startsWith("-----")),
    "PRIVATE KEY",
    "BEGIN CERTIFICATE",
  ];

  it("every refusal in putVersion is free of the material and leaves nothing on disk", async () => {
    const r = await newRig();
    const a = material(["a.test"]);
    const b = material(["b.test"]);
    const wrap = (label: string) => `-----BEGIN CERTIFICATE-----\n${Buffer.from(label).toString("base64")}\n-----END CERTIFICATE-----\n`;
    const cases: [string, Parameters<typeof put>[1]][] = [
      ["key of another certificate", { ...a, keyPem: b.keyPem }],
      ["fingerprint of another certificate", { ...a, fingerprintSha256: b.fingerprintSha256 }],
      ["garbage chain with a canary", { ...a, fullchainPem: wrap(CANARY), fingerprintSha256: "0".repeat(64) }],
      ["garbage key with a canary", { ...a, keyPem: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(CANARY).toString("base64")}\n-----END PRIVATE KEY-----\n` }],
      ["canary text instead of PEM", { ...a, fullchainPem: CANARY, keyPem: CANARY }],
      ["canary in a fingerprint", { ...a, fingerprintSha256: CANARY }],
      ["leading comment with a canary and the wrong key", { ...a, fullchainPem: `# ${CANARY}\n${a.fullchainPem}`, keyPem: b.keyPem }],
    ];
    for (const [name, input] of cases) {
      let caught: unknown;
      try {
        await put(V(1), input, r.store);
      } catch (err) {
        caught = err;
      }
      expect(caught, name).toBeInstanceOf(ManualTlsStoreError);
      const text = serialise(caught);
      for (const needle of [CANARY, Buffer.from(CANARY).toString("base64"), ...fragments(a), ...fragments(b), r.root]) {
        expect(text, `${name}: ${needle.slice(0, 30)}`).not.toContain(needle);
      }
    }
    expect(await readdir(r.dir)).toEqual([]);
  });

  it("a conflicting re-put and a version conflict do not echo either set of material or the store path", async () => {
    const r = await newRig();
    const a = material(["a.test"]);
    const b = material(["a.test"]);
    await put(V(1), a, r.store);
    const err = await reasonOf(put(V(1), b, r.store));
    expect(err.reason).toBe("TLS_VERSION_CONFLICT");
    const text = serialise(err);
    for (const needle of [...fragments(a), ...fragments(b), r.root]) expect(text).not.toContain(needle);
  });

  it("no file in the tree contains a canary that was only ever in refused requests", async () => {
    const r = await newRig();
    const a = material(["a.test"]);
    await put(V(1), { ...a, fullchainPem: `# ${CANARY}\n${a.fullchainPem}`, keyPem: material(["z.test"]).keyPem }, r.store).catch(() => undefined);
    for (const rel of await walk(r.root)) {
      const info = await lstat(path.join(r.root, rel));
      if (info.isFile()) expect(await readFile(path.join(r.root, rel), "utf8"), rel).not.toContain(CANARY);
    }
  });
});

// -- adapter and IPC rigs ----------------------------------------------------------------------------------------------

const SECRET = "0123456789abcdef0123456789abcdef-manual-tls-adv";
const SIGNING_KEY: IpcSigningKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: SECRET };
const VERIFICATION_KEY: IpcVerificationKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: SECRET };
const ROUTE = "/v1/ingress/manual-tls";

async function serve(executor: ConstructorParameters<typeof DockerExecutorIpcServer>[0]["executor"]) {
  const server = new DockerExecutorIpcServer({ executor, keyring: { "hmac-v1": VERIFICATION_KEY }, transport: "loopback-test" });
  cleanup.push(() => server.stop());
  const bound = await server.start();
  const raw = async (body: unknown, signed = true) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const headers = signed
      ? signIpcRequest({ method: "POST", pathWithQuery: ROUTE, body: text, key: SIGNING_KEY, nonce: randomBytes(8).toString("hex") })
      : {};
    const res = await fetch(`http://127.0.0.1:${String(bound.port)}${ROUTE}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: text,
    });
    return { status: res.status, text: await res.text() };
  };
  return { raw };
}

interface AdapterRig {
  root: string;
  ingress: string;
  adapter: DockerEngineSocketAdapter;
  docker: string[];
  startStatuses: number[];
  acmePath: string;
  serveHost(host: string, cert?: { pem: string; keyPem: string }): void;
}

async function adapterRig(options: { panelHostname?: string } = {}): Promise<AdapterRig> {
  const root = await mkdtemp(path.join(os.tmpdir(), "manual-tls-adv-adapter-"));
  roots.push(root);
  const ingress = path.join(root, "ingress");
  await mkdir(path.join(ingress, "dynamic", "manual-certs"), { recursive: true, mode: 0o700 });
  await chmod(path.join(ingress, "dynamic", "manual-certs"), 0o700);
  await mkdir(path.join(ingress, "acme"), { recursive: true });

  const docker: string[] = [];
  const startStatuses: number[] = [];
  const dockerServer = http.createServer((req, res) => {
    const route = (req.url ?? "").replace(/^\/v\d+\.\d+/, "");
    docker.push(`${req.method ?? ""} ${route}`);
    const send = (status: number, body = ""): void => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    };
    if (req.method === "GET" && route === "/containers/hp_ingress_proxy/json") {
      return send(200, JSON.stringify({ Id: "proxy1", State: { Running: true }, NetworkSettings: { Networks: { hp_ingress_net: { IPAddress: "127.0.0.1" } } } }));
    }
    if (req.method === "POST" && route.startsWith("/containers/hp_ingress_proxy/stop")) return send(204);
    if (req.method === "POST" && route === "/containers/hp_ingress_proxy/start") return send(startStatuses.shift() ?? 204);
    return send(404, "{}");
  });
  const dockerSocketPath = path.join(root, "docker.sock");
  await new Promise<void>((r) => dockerServer.listen(dockerSocketPath, r));
  cleanup.push(() => new Promise((r) => dockerServer.close(() => r())));

  const contexts = new Map<string, SecureContext>();
  const defaultCert = issueCert({ dns: ["default.test"] });
  const tls: TlsServer = createTlsServer(
    { SNICallback: (name, cb) => cb(null, contexts.get(name) ?? createSecureContext({ cert: defaultCert.pem, key: defaultCert.keyPem })) },
    (socket) => {
      socket.on("error", () => undefined);
      socket.end();
    },
  );
  await new Promise<void>((r) => tls.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise((r) => tls.close(() => r())));

  const adapter = new DockerEngineSocketAdapter({
    dockerSocketPath,
    ingressRootDir: ingress,
    ingressHttpsPort: (tls.address() as AddressInfo).port,
    pullMissingImages: false,
    manualTlsProbe: { deadlineMs: 800, intervalMs: 20 },
    ...(options.panelHostname
      ? { panel: { hostname: options.panelHostname, ipv4: "192.0.2.1", acmeEmail: null, acmeStaging: false, acmeCaServer: null, acmeCaCertFile: null, upstreamPort: 3000 } }
      : {}),
  });
  return {
    root,
    ingress,
    adapter,
    docker,
    startStatuses,
    acmePath: path.join(ingress, "acme", "acme.json"),
    serveHost: (host, cert) => {
      if (cert) contexts.set(host, createSecureContext({ cert: cert.pem, key: cert.keyPem }));
      else contexts.delete(host);
    },
  };
}

const putReq = (id: string, m: Material) => ({ action: "putVersion" as const, versionId: id, ...m });
type PublishRequest = Extract<Parameters<DockerEngineSocketAdapter["manualTls"]>[0], { action: "publish" }>;
// evictAcme is `unknown` so the tests can send values the schema must refuse.
const publishReq = (baseGeneration: number, entries: { versionId: string; assignedHosts: string[] }[], expectHosts: { hostname: string; fingerprintSha256: string }[] = [], evictAcme?: unknown): PublishRequest =>
  ({ action: "publish", baseGeneration, entries, expect: expectHosts, ...(evictAcme === undefined ? {} : { evictAcme }) }) as unknown as PublishRequest;

const acmeStoreOf = (...leaves: { main: string; pem: string }[]): string =>
  JSON.stringify({
    le: {
      Account: { Email: "ops@example.test" },
      Certificates: leaves.map((l) => ({ domain: { main: l.main }, certificate: Buffer.from(l.pem).toString("base64"), key: "KEY", Store: "default" })),
    },
  });

const stops = (r: AdapterRig): string[] => r.docker.filter((c) => c.includes("/stop") || c.includes("/start") || c.includes("/restart") || c.includes("/kill"));

// -- the cold path needs evictAcme -------------------------------------------------------------------------------------

describe("the cold path is never taken without evictAcme", () => {
  async function tie() {
    const r = await adapterRig();
    const acmeLeaf = issueCert({ dns: ["shop.test"] });
    const acmeBytes = acmeStoreOf({ main: "shop.test", pem: acmeLeaf.pem });
    await writeFile(r.acmePath, acmeBytes, { mode: 0o600 });
    const m = material(["shop.test"]);
    await r.adapter.manualTls(putReq(V(1), m));
    r.serveHost("shop.test", { pem: m.fullchainPem, keyPem: m.keyPem });
    return { r, m, acmeBytes };
  }
  const untouched = async (r: AdapterRig, acmeBytes: string): Promise<void> => {
    expect(stops(r)).toEqual([]);
    expect(await readFile(r.acmePath, "utf8")).toBe(acmeBytes);
    expect((await readdir(path.join(r.ingress, "acme"))).sort()).toEqual(["acme.json"]); // no backup copy
    expect(await exists(path.join(r.ingress, "manual-tls-state.json"))).toBe(false);
    expect(await exists(path.join(r.ingress, "dynamic", "hp-manual-certificates.yml"))).toBe(false);
  };

  it.each([[undefined], [false]])("evictAcme=%s with an ACME tie: refused, proxy untouched, acme.json byte-identical, no state", async (flag) => {
    const { r, m, acmeBytes } = await tie();
    const out = await r.adapter.manualTls(publishReq(0, [entry(V(1), ["shop.test"])], [{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }], flag));
    expect(out).toMatchObject({ outcome: "acme_eviction_required", generation: 0, evicted: [] });
    await untouched(r, acmeBytes);
  });

  it.each([["true"], [1], [null], ["yes"], [[]], [{}]])("evictAcme=%j (not a boolean) is a validation error and the proxy is untouched", async (flag) => {
    const { r, m, acmeBytes } = await tie();
    await expect(r.adapter.manualTls(publishReq(0, [entry(V(1), ["shop.test"])], [{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }], flag))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await untouched(r, acmeBytes);
  });

  it("evictAcme on any other action is refused by the strict schema", async () => {
    const { r, m } = await tie();
    for (const body of [
      { ...putReq(V(2), m), evictAcme: true },
      { action: "gc", baseGeneration: 0, evictAcme: true },
      { action: "inventory", evictAcme: true },
      { action: "probe", hostnames: ["shop.test"], evictAcme: true },
    ]) {
      await expect(r.adapter.manualTls(body as never), JSON.stringify(body).slice(0, 40)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(stops(r)).toEqual([]);
  });

  it("evictAcme=true with a stale base generation or a missing version fails before the proxy is stopped", async () => {
    const { r, acmeBytes } = await tie();
    await expect(r.adapter.manualTls(publishReq(5, [entry(V(1), ["shop.test"])], [], true))).rejects.toMatchObject({ reason: "TLS_MANIFEST_CONFLICT" });
    await expect(r.adapter.manualTls(publishReq(0, [entry(V(7), ["shop.test"])], [], true))).rejects.toMatchObject({ reason: "TLS_VERSION_MISSING" });
    await untouched(r, acmeBytes);
  });

  it("evictAcme=true cannot override a hard refusal (captures_host, manual_overlap): the proxy is never stopped", async () => {
    const r = await adapterRig({ panelHostname: "panel.example.test" });
    const wild = material(["*.example.test"]);
    await r.adapter.manualTls(putReq(V(1), wild));
    const out = await r.adapter.manualTls(publishReq(0, [entry(V(1), ["a.example.test"])], [], true));
    expect(out.outcome).toBe("captures_host");
    expect(stops(r)).toEqual([]);
    expect(await exists(path.join(r.ingress, "manual-tls-state.json"))).toBe(false);
  });

  it("an eviction that is not needed stays on the hot path: ACME entries for other hosts are not touched even with evictAcme=true", async () => {
    const r = await adapterRig();
    const other = issueCert({ dns: ["other.test"] });
    const bytes = acmeStoreOf({ main: "other.test", pem: other.pem });
    await writeFile(r.acmePath, bytes, { mode: 0o600 });
    const m = material(["shop.test"]);
    r.serveHost("shop.test", { pem: m.fullchainPem, keyPem: m.keyPem });
    await r.adapter.manualTls(putReq(V(1), m));
    const out = await r.adapter.manualTls(publishReq(0, [entry(V(1), ["shop.test"])], [{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }], true));
    expect(out).toMatchObject({ outcome: "served", evicted: [] });
    expect(stops(r)).toEqual([]);
    expect(await readFile(r.acmePath, "utf8")).toBe(bytes);
  });
});

// -- nothing but PEM below manual-certs --------------------------------------------------------------------------------

describe("no YAML below dynamic/manual-certs", () => {
  const allowed = /^(ctv_[0-9a-f]{32}|ctv_[0-9a-f]{32}\/(fullchain|privkey)\.pem)$/;

  it("after put, hot publish, revert, recovery and gc only <id>/{fullchain,privkey}.pem exist there", async () => {
    const r = await adapterRig();
    const a = material(["a.test"]);
    const b = material(["b.test"]);
    r.serveHost("a.test", { pem: a.fullchainPem, keyPem: a.keyPem });
    await r.adapter.manualTls(putReq(V(1), a));
    await r.adapter.manualTls(putReq(V(2), b));
    await r.adapter.manualTls(publishReq(0, [entry(V(1), ["a.test"])], [{ hostname: "a.test", fingerprintSha256: a.fingerprintSha256 }]));
    // b is not served by the stand-in proxy: reverted
    expect(await r.adapter.manualTls(publishReq(1, [entry(V(1), ["a.test"]), entry(V(2), ["b.test"])], [{ hostname: "b.test", fingerprintSha256: b.fingerprintSha256 }]))).toMatchObject({ outcome: "not_served_reverted" });
    await r.adapter.manualTls({ action: "gc", baseGeneration: 2 });
    await r.adapter.manualTls({ action: "inventory" });
    const dir = path.join(r.ingress, "dynamic", "manual-certs");
    const tree = await walk(dir);
    expect(tree.length).toBeGreaterThan(0);
    for (const rel of tree) expect(rel, rel).toMatch(allowed);
    expect(tree.some((rel) => /\.(ya?ml|toml|tmpl|json)$/i.test(rel))).toBe(false);
    // the only config file written next to the site routes is the manifest, one level up
    expect((await readdir(path.join(r.ingress, "dynamic"))).filter((n) => /\.(ya?ml|toml|tmpl)$/i.test(n))).toEqual(["hp-manual-certificates.yml"]);
  });

  it("the cold path adds nothing but PEM there either", async () => {
    const r = await adapterRig();
    const acmeLeaf = issueCert({ dns: ["shop.test"] });
    await writeFile(r.acmePath, acmeStoreOf({ main: "shop.test", pem: acmeLeaf.pem }), { mode: 0o600 });
    const m = material(["shop.test"]);
    r.serveHost("shop.test", { pem: m.fullchainPem, keyPem: m.keyPem });
    await r.adapter.manualTls(putReq(V(1), m));
    const out = await r.adapter.manualTls(publishReq(0, [entry(V(1), ["shop.test"])], [{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }], true));
    expect(out.outcome).toBe("served");
    expect(stops(r).length).toBeGreaterThan(0); // the cold path really ran
    for (const rel of await walk(path.join(r.ingress, "dynamic", "manual-certs"))) expect(rel, rel).toMatch(allowed);
    expect((await readdir(path.join(r.ingress, "acme"))).filter((n) => n !== "acme.json").every((n) => n.startsWith("acme.json."))).toBe(true);
  });

  it("YAML-looking text inside a certificate body is stored as .pem bytes only", async () => {
    const r = await adapterRig();
    const a = material(["a.test"]);
    const hostile = `tls:\n  certificates:\n    - certFile: /etc/passwd\nhttp:\n  routers:\n    x: {rule: "Host(\`evil.test\`)"}\n${a.fullchainPem}`;
    await r.adapter.manualTls(putReq(V(1), { ...a, fullchainPem: hostile }));
    const dir = path.join(r.ingress, "dynamic", "manual-certs");
    expect((await walk(dir)).sort()).toEqual([V(1), `${V(1)}/fullchain.pem`, `${V(1)}/privkey.pem`].sort());
    expect(await readdir(path.join(r.ingress, "dynamic"))).toEqual(["manual-certs"]);
  });
});

// -- IPC and adapter error bodies ---------------------------------------------------------------------------------------

describe("IPC bounds and error bodies", () => {
  const base = (): Record<string, unknown> => ({ action: "publish", baseGeneration: 0, entries: [], expect: [] });
  const hosts = (n: number): string[] => Array.from({ length: n }, (_, i) => `h${i.toString()}.test`);

  it("array bounds are exact: 500 entries / 64 hosts / 200 expectations / 200 probe hosts pass the schema, one more is a 400", async () => {
    const { raw } = await serve(new InMemoryDockerSimulatorAdapter());
    const entries = (n: number) => Array.from({ length: n }, (_, i) => entry(V(i + 1), ["a.test"]));
    const expectFor = (n: number) => hosts(n).map((hostname) => ({ hostname }));
    const ok: unknown[] = [
      { ...base(), entries: entries(500) },
      { ...base(), entries: [entry(V(1), hosts(64))] },
      { ...base(), expect: expectFor(200) },
      { action: "probe", hostnames: hosts(200) },
    ];
    const tooMany: unknown[] = [
      { ...base(), entries: entries(501) },
      { ...base(), entries: [entry(V(1), hosts(65))] },
      { ...base(), expect: expectFor(201) },
      { action: "probe", hostnames: hosts(201) },
    ];
    for (const body of ok) expect((await raw(body)).status, JSON.stringify(body).slice(0, 60)).not.toBe(400);
    for (const body of tooMany) {
      const res = await raw(body);
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(JSON.parse(res.text).error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("a body over the 1 MiB transport limit is refused and the server keeps serving; the refusal quotes nothing from it", async () => {
    const { raw } = await serve(new InMemoryDockerSimulatorAdapter());
    const m = material(["a.test"]);
    const huge = JSON.stringify({ ...putReq(V(1), m), fullchainPem: `${CANARY}${"x".repeat(1_048_576)}` });
    expect(Buffer.byteLength(huge)).toBeGreaterThan(1_048_576);
    const res = await raw(huge);
    expect(res.status).toBe(400);
    expect(res.text).not.toContain(CANARY);
    expect(res.text).not.toContain("BEGIN");
    const next = await raw({ action: "inventory" });
    expect(next.status).toBe(200);
  });

  it("a 1 MiB body of pathological JSON (deep nesting, huge numbers, duplicate keys) is a 400, not a crash", async () => {
    const { raw } = await serve(new InMemoryDockerSimulatorAdapter());
    const bodies = [
      "[".repeat(400_000) + "]".repeat(400_000),
      `{"action":"gc","baseGeneration":${"9".repeat(500_000)}}`,
      `{"action":"gc","baseGeneration":0,"action":"inventory","baseGeneration":-1}`,
      `{"action":"gc","baseGeneration":1e999}`,
      `{"__proto__":{"action":"inventory"},"action":"inventory","constructor":1}`,
    ];
    for (const body of bodies) {
      const res = await raw(body);
      expect([res.status, body.slice(0, 20)]).toEqual([400, body.slice(0, 20)]);
    }
    expect((await raw({ action: "inventory" })).status).toBe(200);
  });

  it("a signed put with bad material over the real adapter returns a stable code and no PEM, key bytes or host path", async () => {
    const r = await adapterRig();
    const { raw } = await serve(r.adapter);
    const a = material(["a.test"]);
    const b = material(["b.test"]);
    const bodies = [
      { ...putReq(V(1), a), keyPem: b.keyPem },
      { ...putReq(V(1), a), fingerprintSha256: b.fingerprintSha256 },
      { ...putReq(V(1), a), fullchainPem: `# ${CANARY}\n${a.fullchainPem}`, keyPem: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(CANARY).toString("base64")}\n-----END PRIVATE KEY-----\n` },
      { ...putReq(V(1), a), fullchainPem: CANARY },
    ];
    for (const body of bodies) {
      const res = await raw(body);
      expect(res.status).toBe(422);
      expect(JSON.parse(res.text).error.code).toBe("CERTIFICATE_INVALID");
      for (const needle of [CANARY, Buffer.from(CANARY).toString("base64"), "BEGIN", "PRIVATE", r.root, ...a.keyPem.split("\n").filter((l) => l.length > 20 && !l.startsWith("-")), ...b.keyPem.split("\n").filter((l) => l.length > 20 && !l.startsWith("-"))]) {
        expect(res.text, needle.slice(0, 30)).not.toContain(needle);
      }
    }
    expect(await readdir(path.join(r.ingress, "dynamic", "manual-certs"))).toEqual([]);
  });

  it("an unexpected filesystem failure during a put (store dir not writable) leaks neither the host path nor the PEM", async () => {
    if (isRoot) return;
    const r = await adapterRig();
    const { raw } = await serve(r.adapter);
    const dir = path.join(r.ingress, "dynamic", "manual-certs");
    await chmod(dir, 0o500);
    cleanup.push(() => chmod(dir, 0o700));
    const a = material(["a.test"]);
    const res = await raw({ ...putReq(V(1), a), fullchainPem: `# ${CANARY}\n${a.fullchainPem}` });
    expect(res.status).toBeGreaterThanOrEqual(400);
    for (const needle of [CANARY, r.root, "EACCES", "BEGIN", ...a.keyPem.split("\n").filter((l) => l.length > 20 && !l.startsWith("-"))]) {
      expect(res.text, needle.slice(0, 30)).not.toContain(needle);
    }
  });

  it("a store problem on publish (state file is garbage) is reported without the file's content or path", async () => {
    const r = await adapterRig();
    const { raw } = await serve(r.adapter);
    await writeFile(path.join(r.ingress, "manual-tls-state.json"), `${CANARY} not json ${r.root}`);
    const res = await raw(publishReq(0, [entry(V(1))]));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).not.toContain(CANARY);
    expect(res.text).not.toContain(r.root);
    expect((await stat(path.join(r.ingress, "manual-tls-state.json"))).isFile()).toBe(true);
  });
});
