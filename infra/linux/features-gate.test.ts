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
const M25 = "0025_app_stacks.sql";
const M26 = "0026_app_routing_options.sql";
const M27 = "0027_app_stack_backups.sql";
const ALL = ["manual-tls", "backup-targets", "site-templates", "app-stacks", "app-format-v2", "app-routing-options", "app-stack-backups"];
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
      APPLIED: (opts.applied ?? [M21, M22, M24, M25, M26, M27]).join("\n"),
      IN_USE: (opts.inUse ?? []).join(" "),
      FAIL_ON: opts.failOn ?? ""
    }
  });
  const file = (n: string) => readFileSync(join(d, n), "utf8");
  return { code: r.status, out: r.stdout, err: r.stderr, calls: file("calls.log"), pgpw: file("pgpw.log") };
}

describe("panel_features_in_use", () => {
  it("prints the in-use features; the password only in PGPASSWORD and ON_ERROR_STOP set", () => {
    const r = run({ inUse: ALL });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe("manual-tls\nbackup-targets\nsite-templates\napp-stacks\napp-format-v2\napp-routing-options\napp-stack-backups\n");
    expect(r.calls.split("\n").filter(Boolean)).toHaveLength(8);
    for (const c of r.calls.split("\n").filter(Boolean)) {
      expect(c).toMatch(/^-X -qtA -v ON_ERROR_STOP=1 -h 127\.0\.0\.1 -U hosting_panel -d hosting_panel -c /);
    }
    expect(r.calls + r.err).not.toContain(PW);
    expect(new Set(r.pgpw.split("\n").filter(Boolean))).toEqual(new Set([PW]));
  });

  it("prints only the features that are in use", () => {
    expect(run({ inUse: ["backup-targets"] }).out).toBe("backup-targets\n");
    expect(run({ inUse: ["site-templates"] }).out).toBe("site-templates\n");
    expect(run({ inUse: ["app-stacks"] }).out).toBe("app-stacks\n");
    expect(run({ inUse: ["app-format-v2"] }).out).toBe("app-format-v2\n");
    expect(run({ inUse: ["app-routing-options"] }).out).toBe("app-routing-options\n");
    // the two names share a prefix: each predicate answers for its own name only
    expect(run({ inUse: ["app-stack-backups"] }).out).toBe("app-stack-backups\n");
    expect(run({ inUse: [] }).out).toBe("");
  });

  it("asks the predicates the lead pinned: manual domains, live non-legacy targets, sites off the built-in template version", () => {
    const { calls } = run({});
    expect(calls).toContain("domains where cert_mode = 'manual'");
    expect(calls).toContain("backup_targets where not legacy_settings and archived_at is null");
    expect(calls).toContain("sites where template_version_id is not null and template_version_id <> 'stv_wordpress_1'");
    expect(calls).toContain("app_stacks where deleted_at is null");
    // ADR-0037: a redirect, a password or a path counts; compression alone does not.
    expect(calls).toContain(
      "app_stack_domains where redirect_to_domain_id is not null or access_username is not null or path_routes <> '[]'::jsonb",
    );
    expect(calls).not.toContain("compression");
    // every backup counts, whatever its status and also when its application is gone (ADR-0038 K10)
    expect(calls).toContain("select 'app-stack-backups' where exists (select 1 from public.app_stack_backups)");
  });

  it("asks the extended application format of the stacks that are not deleted: their template version, then their revisions", () => {
    const { calls } = run({});
    expect(calls).toContain("select 'app-format-v2' where exists (select 1 from public.app_stacks s where s.deleted_at is null and (");
    expect(calls).toContain("public.app_template_versions v where v.id = s.template_version_id and v.spec_version >= 2");
    expect(calls).toContain("public.app_stack_revisions r where r.stack_id = s.id and r.plan->>'schemaVersion' <> '1'");
  });

  it("a migration that is not recorded means the feature is not asked and not in use", () => {
    const all = ALL;
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
    const only25 = run({ applied: [M25], inUse: all });
    // Both application gates read tables of the same migration.
    expect(only25.out).toBe("app-stacks\napp-format-v2\n");
    expect(only25.calls.split("\n").filter(Boolean)).toHaveLength(3);
    const only26 = run({ applied: [M26], inUse: all });
    expect(only26.out).toBe("app-routing-options\n");
    expect(only26.calls.split("\n").filter(Boolean)).toHaveLength(2);
    const only27 = run({ applied: [M27], inUse: all });
    expect(only27.out).toBe("app-stack-backups\n");
    expect(only27.calls.split("\n").filter(Boolean)).toHaveLength(2);
    const without25 = run({ applied: [M21, M22, M24], inUse: all });
    expect(without25.out).toBe("manual-tls\nbackup-targets\nsite-templates\n");
    // The release before the routing options: its stacks are asked about, the options it never had are not.
    const before26 = run({ applied: [M21, M22, M24, M25], inUse: all });
    expect(before26.out).toBe("manual-tls\nbackup-targets\nsite-templates\napp-stacks\napp-format-v2\n");
    expect(before26.calls).not.toContain("app_stack_domains");
    // a panel that never ran 0027 is not asked about a table it does not have
    const before27 = run({ applied: [M21, M22, M24, M25, M26], inUse: all });
    expect(before27.out).toBe("manual-tls\nbackup-targets\nsite-templates\napp-stacks\napp-format-v2\napp-routing-options\n");
    expect(before27.calls).not.toContain("'app-stack-backups'");
    expect(before27.calls.split("\n").filter(Boolean)).toHaveLength(7);
  });

  it("fails closed: a psql error or a URL that is not the local panel database is non-zero", () => {
    expect(run({ failOn: "schema_migrations" }).code).not.toBe(0);
    expect(run({ failOn: "cert_mode", inUse: ["manual-tls"] }).code).not.toBe(0);
    expect(run({ failOn: "backup_targets" }).code).not.toBe(0);
    expect(run({ failOn: "template_version_id", inUse: ["site-templates"] }).code).not.toBe(0);
    expect(run({ failOn: "app_stacks where", inUse: ["app-stacks"] }).code).not.toBe(0);
    expect(run({ failOn: "spec_version", inUse: ["app-format-v2"] }).code).not.toBe(0);
    expect(run({ failOn: "app_stack_domains where", inUse: ["app-routing-options"] }).code).not.toBe(0);
    expect(run({ failOn: "app_stack_backups", inUse: ["app-stack-backups"] }).code).not.toBe(0);
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
    expect(parse(`${json}\n`).trim()).toBe("manual-tls backup-targets site-templates app-stacks app-format-v2 app-routing-options app-stack-backups");
  });
  it("is empty when the key is absent or empty", () => {
    expect(parse(`${JSON.stringify({ version: "1.0.0" }, null, 2)}\n`)).toBe("");
    expect(parse(`${JSON.stringify({ version: "1.0.0", features: "" }, null, 2)}\n`).trim()).toBe("");
  });
});
