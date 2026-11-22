import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_BUILT_IN_TEMPLATES } from "@hosting-panel/contracts";

const root = resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const between = (text: string, from: string, to?: string) => {
  const start = text.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  const end = to === undefined ? -1 : text.indexOf(to, start + from.length);
  return text.slice(start, end < 0 ? undefined : end);
};

const digests = [...new Set(APP_BUILT_IN_TEMPLATES.flatMap((t) => [...t.source.matchAll(/sha256:[0-9a-f]{64}/g)].map((m) => m[0])))];
const scripts = [
  "accept-app-stack-engine.mjs",
  "accept-app-stack-http-cache.mjs",
  "accept-app-stack-worker-storage.mjs",
  "accept-app-routing-options.mjs",
];

describe("hcp-spec-005 docs and acceptance scripts", () => {
  it("ADR-0035 is approved and cites existing paths", () => {
    const adrs = readdirSync(join(root, "docs/architecture/adr")).filter((f) => /^0035-.*\.md$/.test(f));
    expect(adrs).toHaveLength(1);
    const file = `docs/architecture/adr/${adrs[0]!}`;
    const adr = read(file);
    for (const h of ["Stato", "Data", "Riferimento", "Migrazioni"]) expect(adr, h).toMatch(new RegExp(`^- \\*\\*${h}:\\*\\* `, "m"));
    expect(adr).toMatch(/^- \*\*Stato:\*\* `APPROVATO`/m);
    const paths = new Set([...adr.matchAll(/`((?:apps|packages|infra|docs|\.github)\/[^`\s]+)`/g)].map((m) => m[1]!.replace(/:[\d,-]+$/, "")));
    expect(paths.size, file).toBeGreaterThanOrEqual(15);
    for (const p of paths) expect(existsSync(join(root, p)), `${file}: ${p}`).toBe(true);
    for (const s of ["app-stacks", "0025_app_stacks.sql", "APP_IMAGE_ALLOWLIST", "HCP-STACK/v1", "D12", ...digests]) expect(adr, s).toContain(s);
    expect(digests.length).toBeGreaterThanOrEqual(3);
  });

  it("README, HARNESS, runbook, ER diagram and the brain files name the feature", () => {
    const readme = read("README.md");
    for (const s of ["ADR-0035", "app-stacks", "docs/runbooks/application-stacks.md", "docs/security/hcp-spec-005-acceptance-report.md"]) {
      expect(readme, s).toContain(s);
    }
    expect(readme).not.toContain("HCP-SPEC-005");
    const table = between(readme, "## 2. Stato di Implementazione", "## 3. Mappa del Monorepo").split("\n").filter((l) => l.startsWith("|"));
    for (const flag of ["applicationTemplatesAvailable", "applicationStacksAvailable", "stackPublicPortsAvailable", "gitBuildsAvailable"]) {
      const rows = table.filter((l) => l.includes(flag));
      expect(rows, flag).toHaveLength(1);
      expect(rows[0], flag).toContain(`\`${flag}: false\``);
    }
    const harness = read("HARNESS.md");
    const runbook = read("docs/runbooks/application-stacks.md");
    for (const s of ["ADR-0035", "0025_app_stacks.sql"]) expect(harness, s).toContain(s);
    for (const s of scripts) {
      expect(harness, `HARNESS ${s}`).toContain(s);
      expect(runbook, `runbook ${s}`).toContain(s);
    }
    for (let n = 1; n <= 7; n++) expect(runbook, `runbook heading ${n}.`).toMatch(new RegExp(`^## ${n}\\. `, "m"));
    const er = read("docs/architecture/diagrams/domain-er-and-boundaries.md");
    for (const s of ["0025_app_stacks.sql", "app_stack_domains"]) expect(er, s).toContain(s);
    for (const file of [".agents/brain/state.md", ".agents/brain/decisions.md"]) {
      for (const s of ["ADR-0035", "assumed by this run"]) expect(read(file), `${file} ${s}`).toContain(s);
    }
  });

  it("the acceptance report has one row per A1..A20 and B1..B6", () => {
    const report = read("docs/security/hcp-spec-005-acceptance-report.md");
    expect(report).toContain("| ID | Criterion | Verdict | Evidence | Run type | Commit | Notes |");
    const ids = [...Array.from({ length: 20 }, (_, i) => `A${i + 1}`), ...Array.from({ length: 6 }, (_, i) => `B${i + 1}`)];
    const rows = report
      .split("\n")
      .filter((line) => line.trimStart().startsWith("|"))
      .map((line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()))
      .filter((cells) => /^[AB]\d{1,2}$/.test(cells[0] ?? ""));
    const verdict = /^(PASS|FAIL|SKIPPED \(.+\)|PENDING \(owner: .+\)|BLOCKED \(BLOCKED\.md #\d+\))$/;
    for (const id of ids) {
      const mine = rows.filter((cells) => cells[0] === id);
      expect(mine.length, `acceptance report rows for ${id}`).toBe(1);
      const cells = mine[0]!;
      const v = cells[2] ?? "";
      expect(v, `${id} verdict`).toMatch(verdict);
      if (v === "PASS") {
        expect(cells[3] ?? "", `${id} command`).toMatch(/corepack pnpm exec vitest run \S|node infra\/linux\/\S/);
        expect(cells[5] ?? "", `${id} SHA`).toMatch(/\b[0-9a-f]{7,40}\b/);
      }
    }
    expect(rows.length, "acceptance report has no extra id rows").toBe(ids.length);
    const paths = new Set([...report.matchAll(/(?<![\w/.-])((?:apps|packages|infra|docs|\.github)\/[\w./-]*[\w/])/g)].map((m) => m[1]!));
    for (const p of paths) expect(existsSync(join(root, p)), `report: ${p}`).toBe(true);
    for (const d of digests) expect(report, d).toContain(d);
  });

  it("hcp-spec-005 acceptance scripts are registered and machine-safe", () => {
    const steps: Record<string, string[]> = {
      "accept-app-stack-http-cache.mjs": [
        "preflight", "snapshot-before", "plan-compiles-from-seed", "refused-before-docker", "deploy-creates-exact-set",
        "container-hardening", "health-and-dns", "network-shape", "no-control-plane-reach", "no-cross-stack",
        "route-published-after-health", "route-change-no-proxy-recreate", "health-reports-unhealthy", "idempotent-reapply",
        "upgrade-changes-only-changed-component", "recovery-reads-only", "remove-leaves-no-orphans",
        "host-nft-metadata-drop-on-stack-net", "gate-clean", "nothing-left"
      ],
      "accept-app-stack-worker-storage.mjs": [
        "preflight", "snapshot-before", "plan-compiles-from-seed", "refused-before-docker", "deploy-creates-exact-set",
        "container-hardening", "worker-writes-storage", "network-shape", "idempotent-reapply", "data-survives-upgrade-and-rollback",
        "pull-failure-consistent", "network-failure-consistent", "health-timeout-consistent", "recovery-reads-only",
        "remove-keeps-volumes", "destroy-data-removes-volume", "host-nft-metadata-drop-on-stack-net", "gate-clean", "nothing-left"
      ]
    };
    const harness = read("HARNESS.md");
    for (const [name, names] of Object.entries(steps)) {
      const file = `infra/linux/${name}`;
      const script = read(file);
      for (const s of ["DockerEngineSocketAdapter", "compileAppStackPlan", "APP_BUILT_IN_TEMPLATES", "hp_swarmtest_stk_", "swarmtest_",
        "HP_ACCEPT_ROOT_CASES"]) expect(script, `${file} ${s}`).toContain(s);
      for (const step of names) expect(script, `${file} ${step}`).toContain(`"${step}"`);
      expect(script, file).not.toMatch(/shell:\s*true|(?<![.\w])exec\(|execSync|spawnSync/);
      expect(script, file).not.toMatch(/["'`]hp_(?:ingress_proxy|ingress_net|mariadb|phpmyadmin)["'`]/);
      expect(script, file).not.toMatch(/["'](?:prune|system|pull)["']/);
      expect(script, file).not.toMatch(/:latest\b/);
      expect(script, file).not.toMatch(/["']-p["']|["']--publish["']/);
      const anyHost = script.split("\n").filter((l) => l.includes("0.0.0.0"));
      if (name.includes("worker-storage")) expect(anyHost, file).toEqual([]);
      for (const line of anyHost) expect(line, file).toContain("HostIp");
      expect([...script.matchAll(/\b(1[0-9]{4})\b/g)].map((m) => Number(m[1])).filter((p) => p >= 10000 && p < 16000), file).toEqual([]);
      // The gate forwards only what it recognises: its judge ends in a denial.
      expect(between(script, "function judge(", "\n}\n").trimEnd(), file).toMatch(/\n {2}return deny\("[^"]+"\);$/);
      expect(script, file).toMatch(/console\.log\(`RESULT \$\{/);
      expect(script, file).toMatch(/skipped \(not counted in n\/m\)/);
      expect(harness, name).toContain(name);
    }
  });
});

describe("ADR-0037 docs and the routing options check", () => {
  it("ADR-0037 has its header and cites existing paths", () => {
    const adrs = readdirSync(join(root, "docs/architecture/adr")).filter((f) => /^0037-.*\.md$/.test(f));
    expect(adrs).toHaveLength(1);
    const file = `docs/architecture/adr/${adrs[0]!}`;
    const adr = read(file);
    for (const h of ["Stato", "Data", "Riferimento", "Migrazioni"]) expect(adr, h).toMatch(new RegExp(`^- \\*\\*${h}:\\*\\* `, "m"));
    expect(adr).toMatch(/^- \*\*Stato:\*\* `(?:PROPOSTO|APPROVATO)`/m);
    const paths = new Set([...adr.matchAll(/`((?:apps|packages|infra|docs|\.github)\/[^`\s]+)`/g)].map((m) => m[1]!.replace(/:[\d,-]+$/, "")));
    expect(paths.size, file).toBeGreaterThanOrEqual(10);
    for (const p of paths) expect(existsSync(join(root, p)), `${file}: ${p}`).toBe(true);
    for (const s of ["ADR-0035", "0026_app_routing_options.sql", "app-routing-options", "accept-app-routing-options.mjs", "R12"]) expect(adr, s).toContain(s);
  });

  it("README, HARNESS, runbook, ER diagram and the decisions name the options", () => {
    const readme = read("README.md");
    for (const s of ["ADR-0037", "docs/architecture/adr/0037-application-routing-options.md", "app-routing-options"]) expect(readme, s).toContain(s);
    const harness = read("HARNESS.md");
    for (const s of ["ADR-0037", "0026_app_routing_options.sql", "accept-app-routing-options.mjs"]) expect(harness, s).toContain(s);
    // The guards the forbidden action names are files of this repository.
    const rule = harness.split("\n").filter((l) => l.includes("`ADR-0037`; guarded by"));
    expect(rule).toHaveLength(1);
    const guards = [...rule[0]!.matchAll(/`((?:apps|packages|infra)\/[^`\s]+)`/g)].map((m) => m[1]!);
    expect(guards.length).toBeGreaterThanOrEqual(4);
    for (const p of guards) expect(existsSync(join(root, p)), `HARNESS: ${p}`).toBe(true);
    const runbook = read("docs/runbooks/application-stacks.md");
    expect(runbook).toMatch(/^## 10\. Routing options of an address$/m);
    for (const s of ["ADR-0037", "app-routing-options", "accept-app-routing-options.mjs"]) expect(runbook, s).toContain(s);
    // No procedure tells the operator to read the password verifier out of the database.
    for (const line of runbook.split("\n").filter((l) => l.includes("psql"))) expect(line).not.toContain("access_password_hash");
    const er = read("docs/architecture/diagrams/domain-er-and-boundaries.md");
    for (const s of ["0026_app_routing_options.sql", "redirect_to_domain_id", "path_routes"]) expect(er, s).toContain(s);
    expect(read(".agents/brain/decisions.md")).toContain("ADR-0037");
  });

  it("the routing options check is registered and machine-safe", () => {
    const file = "infra/linux/accept-app-routing-options.mjs";
    const script = read(file);
    for (const s of ["TraefikIngressFileManager", "writeAppStackRoutes", "buildIngressProxyContainerPayload", "buildTraefikStaticYaml", "apr1Verifier",
      "APP_BUILT_IN_TEMPLATES", "hp_swarmtest_rt_", "swarmtest_"]) expect(script, `${file} ${s}`).toContain(s);
    for (const step of ["preflight", "snapshot-before", "backends-up", "test-network-is-ours-only"]) expect(script, step).toContain(`step("${step}"`);
    for (const step of ["route-file", "addresses-serve", "compression", "password", "paths", "redirect", "change-without-restart", "proxy-log",
      "plain-http-only-redirects", "certificate-pending"]) expect(script, step).toContain(`step(\`\${p}${step}\``);
    for (const step of ["foreign-containers-untouched", "nothing-left"]) expect(script, step).toContain(`"PASS ${step}"`);
    expect(script, file).not.toMatch(/shell:\s*true|(?<![.\w])exec\(|execSync|spawnSync/);
    expect(script, file).not.toMatch(/["'`]hp_(?:ingress_proxy|ingress_net|mariadb|phpmyadmin)["'`]/);
    expect(script, file).not.toMatch(/["'](?:prune|system|pull)["']/);
    expect(script, file).not.toMatch(/:latest\b/);
    // The throw-away proxy is the only thing published, and only on loopback.
    const published = script.split("\n").filter((l) => /["']-p["']|["']--publish["']/.test(l));
    expect(published.map((l) => l.trim())).toEqual(['"-p", `${HOST}:${String(PORT.http)}:80`, "-p", `${HOST}:${String(PORT.https)}:443`,']);
    expect(script).toContain('const HOST = "127.0.0.1";');
    expect(script).not.toContain("0.0.0.0");
    // Nothing it creates carries a label: a live executor adopts what it finds labelled.
    expect(script, file).not.toMatch(/["']--label(?:=[^"']*)?["']/);
    expect([...script.matchAll(/\b(1[0-9]{4})\b/g)].map((m) => Number(m[1])).filter((p) => p >= 10000 && p < 16000), file).toEqual([]);
    expect(script, file).toMatch(/console\.log\(`RESULT \$\{/);
    expect(script, file).toMatch(/nothing was created \(this script never pulls\)/);
  });
});
