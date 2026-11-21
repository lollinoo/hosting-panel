import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM script without type declarations
import { RELEASE_FEATURES } from "../release/build-release.mjs";

const COMMON = resolve(__dirname, "lib/common.sh");
const PW = "0123456789abcdef".repeat(4);
const M21 = "0021_manual_tls_certificates.sql";
const M22 = "0022_backup_targets_and_copies.sql";
const M24 = "0024_site_templates.sql";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** PATH-stubbed psql: the migrations query answers `applied`, the predicates answer `inUse` by feature name. */
function run(opts: { applied?: string[]; inUse?: string[]; failOn?: string; url?: string }) {
  const d = mkdtempSync(join(tmpdir(), "hp-features-"));
  dirs.push(d);
  const bin = join(d, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "psql"),
    `#!/usr/bin/env bash
echo "$*" >> "$D/calls.log"; echo "\${PGPASSWORD-}" >> "$D/pgpw.log"
q="\${@: -1}"
[[ -z "\${FAIL_ON:-}" || "$q" != *"$FAIL_ON"* ]] || { echo 'boom' >&2; exit 2; }
if [[ "$q" == *schema_migrations* ]]; then printf '%s' "$APPLIED"; exit 0; fi
for f in $IN_USE; do [[ "$q" == *"'$f'"* ]] && echo "$f"; done
exit 0
`,
    { mode: 0o755 }
  );
  const env = join(d, "api.env");
  writeFileSync(env, `DATABASE_URL=${opts.url ?? `postgresql://hosting_panel:${PW}@127.0.0.1:5432/hosting_panel`}\n`);
  for (const f of ["calls.log", "pgpw.log"]) writeFileSync(join(d, f), "");
  const r = spawnSync("bash", ["-c", `source "${COMMON}"; set -euo pipefail; panel_features_in_use "${env}"`], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      D: d,
      APPLIED: (opts.applied ?? [M21, M22, M24]).join("\n"),
      IN_USE: (opts.inUse ?? []).join(" "),
      FAIL_ON: opts.failOn ?? ""
    }
  });
  const file = (n: string) => readFileSync(join(d, n), "utf8");
  return { code: r.status, out: r.stdout, err: r.stderr, calls: file("calls.log"), pgpw: file("pgpw.log") };
}

describe("panel_features_in_use", () => {
  it("prints the in-use features; the password only in PGPASSWORD and ON_ERROR_STOP set", () => {
    const r = run({ inUse: ["manual-tls", "backup-targets", "site-templates"] });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe("manual-tls\nbackup-targets\nsite-templates\n");
    expect(r.calls.split("\n").filter(Boolean)).toHaveLength(4);
    for (const c of r.calls.split("\n").filter(Boolean)) {
      expect(c).toMatch(/^-X -qtA -v ON_ERROR_STOP=1 -h 127\.0\.0\.1 -U hosting_panel -d hosting_panel -c /);
    }
    expect(r.calls + r.err).not.toContain(PW);
    expect(new Set(r.pgpw.split("\n").filter(Boolean))).toEqual(new Set([PW]));
  });

  it("prints only the features that are in use", () => {
    expect(run({ inUse: ["backup-targets"] }).out).toBe("backup-targets\n");
    expect(run({ inUse: ["site-templates"] }).out).toBe("site-templates\n");
    expect(run({ inUse: [] }).out).toBe("");
  });

  it("asks the predicates the lead pinned: manual domains, live non-legacy targets, sites off the built-in template version", () => {
    const { calls } = run({});
    expect(calls).toContain("domains where cert_mode = 'manual'");
    expect(calls).toContain("backup_targets where not legacy_settings and archived_at is null");
    expect(calls).toContain("sites where template_version_id is not null and template_version_id <> 'stv_wordpress_1'");
  });

  it("a migration that is not recorded means the feature is not asked and not in use", () => {
    const all = ["manual-tls", "backup-targets", "site-templates"];
    const r = run({ applied: [], inUse: all });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe("");
    expect(r.calls.split("\n").filter(Boolean)).toHaveLength(1);
    const only21 = run({ applied: [M21], inUse: all });
    expect(only21.out).toBe("manual-tls\n");
    expect(only21.calls.split("\n").filter(Boolean)).toHaveLength(2);
    const only24 = run({ applied: [M24], inUse: all });
    expect(only24.out).toBe("site-templates\n");
    expect(only24.calls.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("fails closed: a psql error or a URL that is not the local panel database is non-zero", () => {
    expect(run({ failOn: "schema_migrations" }).code).not.toBe(0);
    expect(run({ failOn: "cert_mode", inUse: ["manual-tls"] }).code).not.toBe(0);
    expect(run({ failOn: "backup_targets" }).code).not.toBe(0);
    expect(run({ failOn: "template_version_id", inUse: ["site-templates"] }).code).not.toBe(0);
    const bad = run({ url: `postgresql://hosting_panel:${PW}@db.example.com:5432/hosting_panel` });
    expect(bad.code).not.toBe(0);
    expect(bad.calls).toBe("");
  });
});

describe("release_features", () => {
  const parse = (json: string) => {
    const r = spawnSync("bash", ["-c", `source "${COMMON}"; release_features`], { encoding: "utf8", input: json });
    return r.stdout;
  };
  it("reads the features line build-release.mjs writes", () => {
    const json = JSON.stringify({ version: "1.0.0", node: "26.13.1", features: RELEASE_FEATURES.join(" ") }, null, 2);
    expect(parse(`${json}\n`).trim()).toBe("manual-tls backup-targets site-templates");
  });
  it("is empty when the key is absent or empty", () => {
    expect(parse(`${JSON.stringify({ version: "1.0.0" }, null, 2)}\n`)).toBe("");
    expect(parse(`${JSON.stringify({ version: "1.0.0", features: "" }, null, 2)}\n`).trim()).toBe("");
  });
});
