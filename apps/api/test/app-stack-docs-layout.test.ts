import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_BUILT_IN_TEMPLATES, APP_DATABASE_TEMPLATE_CATEGORY } from "@hosting-panel/contracts";

const root = resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const between = (text: string, from: string, to?: string) => {
  const start = text.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  const end = to === undefined ? -1 : text.indexOf(to, start + from.length);
  return text.slice(start, end < 0 ? undefined : end);
};

const digestsOf = (templates: readonly (typeof APP_BUILT_IN_TEMPLATES)[number][]) => [
  ...new Set(templates.flatMap((t) => [...t.source.matchAll(/sha256:[0-9a-f]{64}/g)].map((m) => m[0]))),
];
// The seeds of the first format are recorded in ADR-0035, the one of the extended format in ADR-0036;
// the databases came with ADR-0039, which names their images itself.
const isExtended = (t: (typeof APP_BUILT_IN_TEMPLATES)[number]) => t.source.startsWith("x-hp-stack:\n  schemaVersion: 2\n");
const isDatabase = (t: (typeof APP_BUILT_IN_TEMPLATES)[number]) => t.category === APP_DATABASE_TEMPLATE_CATEGORY;
const digests = digestsOf(APP_BUILT_IN_TEMPLATES.filter((t) => !isExtended(t) && !isDatabase(t)));
const extendedDigests = digestsOf(APP_BUILT_IN_TEMPLATES.filter(isExtended));
const databaseDigests = digestsOf(APP_BUILT_IN_TEMPLATES.filter(isDatabase));
const scripts = [
  "accept-app-stack-engine.mjs",
  "accept-app-stack-http-cache.mjs",
  "accept-app-stack-worker-storage.mjs",
  "accept-app-stack-wordpress.mjs",
  "accept-app-routing-options.mjs",
  "accept-app-stack-databases.mjs",
];

describe("hcp-spec-005 docs and acceptance scripts", () => {
  it("ADR-0042 (tasks of applications) names the migration, the feature and guard files that exist", () => {
    const adrs = readdirSync(join(root, "docs/architecture/adr")).filter((f) => /^0042-.*\.md$/.test(f));
    expect(adrs).toEqual(["0042-application-scheduled-tasks.md"]);
    const adr = read(`docs/architecture/adr/${adrs[0]!}`);
    for (const s of ["PROPOSTO", "0031_app_stack_tasks.sql", "x-hp-tasks", "app-tasks", "stack.task", "Come è stato costruito", "Che cosa è provato", "Non provato", "Punti aperti"]) {
      expect(adr, s).toContain(s);
    }
    const harness = read("HARNESS.md");
    const rule = harness.split("\n").find((line) => line.includes("`ADR-0042`; guarded by"));
    expect(rule, "the HARNESS rule on tasks").toBeDefined();
    const guards = [...rule!.matchAll(/`((?:packages|apps|infra)\/[^`]+)`/g)].map((m) => m[1]!);
    expect(guards).toHaveLength(5);
    for (const file of guards) expect(existsSync(join(root, file)), file).toBe(true);
    expect(harness).toContain("0031_app_stack_tasks.sql");
    const runbook = read("docs/runbooks/application-stacks.md");
    for (const s of ["## 4a. Tasks of an application (ADR-0042)", "x-hp-tasks", "app_stack_task_runs", "app-tasks", "infra/linux/accept-app-tasks.mjs"]) {
      expect(runbook, s).toContain(s);
    }
    const er = read("docs/architecture/diagrams/domain-er-and-boundaries.md");
    for (const s of ["app_stack_task_schedules", "app_stack_task_runs", "0031_app_stack_tasks.sql", "trg_app_stacks_forget_tasks"]) expect(er, s).toContain(s);
    expect(read("README.md")).toContain("ADR-0042");
    expect(read("docs/api/openapi.yaml")).toContain("/v1/organizations/{orgId}/app-stacks/{stackId}/tasks/{taskKey}/runs:");
  });

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

  it("ADR-0036 records the extended format and the images of its built-in template", () => {
    const adrs = readdirSync(join(root, "docs/architecture/adr")).filter((f) => /^0036-.*\.md$/.test(f));
    expect(adrs).toHaveLength(1);
    const file = `docs/architecture/adr/${adrs[0]!}`;
    const adr = read(file);
    for (const h of ["Stato", "Data", "Riferimento"]) expect(adr, h).toMatch(new RegExp(`^- \\*\\*${h}:\\*\\* `, "m"));
    expect(extendedDigests).toHaveLength(2);
    for (const s of ["HCP-STACK/v2", "ADR-0035", "atpl_wordpress_mariadb", ...extendedDigests]) expect(adr, s).toContain(s);
    expect(extendedDigests.filter((d) => digests.includes(d))).toEqual([]);
    const paths = new Set([...adr.matchAll(/`((?:apps|packages|infra|docs|\.github)\/[^`\s]+)`/g)].map((m) => m[1]!.replace(/:[\d,-]+$/, "")));
    expect([...paths], file).toContain("infra/linux/accept-app-stack-wordpress.mjs");
    for (const p of paths) expect(existsSync(join(root, p)), `${file}: ${p}`).toBe(true);
  });

  it("ADR-0039 names the image of every built-in database and cites existing paths", () => {
    const file = "docs/architecture/adr/0039-application-databases.md";
    const adr = read(file);
    for (const h of ["Stato", "Data", "Riferimento", "Migrazioni"]) expect(adr, h).toMatch(new RegExp(`^- \\*\\*${h}:\\*\\* `, "m"));
    const paths = new Set([...adr.matchAll(/`((?:apps|packages|infra|docs|\.github)\/[^`\s]+)`/g)].map((m) => m[1]!.replace(/:[\d,-]+$/, "")));
    for (const p of paths) expect(existsSync(join(root, p)), `${file}: ${p}`).toBe(true);
    expect(databaseDigests.length).toBeGreaterThanOrEqual(3);
    for (const s of ["0028_app_stack_links.sql", "APP_IMAGE_ALLOWLIST", "D12", ...databaseDigests]) expect(adr, s).toContain(s);
    // The second versions of the database templates (the first stays as history): what they change is written down.
    for (const s of ["atv_mariadb_2", "--tmpdir=/var/lib/mysql", "atv_valkey_2", "256 MB", "512 MB", "atv_postgresql_2", "PGDATA", "/var/lib/postgresql/18/docker"]) expect(adr, s).toContain(s);
  });

  it("README, HARNESS, runbook, ER diagram and the brain files name the feature", () => {
    const readme = read("README.md");
    for (const s of ["ADR-0035", "app-stacks", "docs/runbooks/application-stacks.md", "docs/security/hcp-spec-005-acceptance-report.md"]) {
      expect(readme, s).toContain(s);
    }
    expect(readme).not.toContain("HCP-SPEC-005");
    const table = between(readme, "## 2. Stato di Implementazione", "## 3. Mappa del Monorepo").split("\n").filter((l) => l.startsWith("|"));
    // The catalog and the stacks are on for linux-systemd (ADR-0036 §2.10); public ports and Git builds ship nowhere.
    const flags = { applicationTemplatesAvailable: true, applicationStacksAvailable: true, stackPublicPortsAvailable: false, gitBuildsAvailable: false };
    for (const [flag, on] of Object.entries(flags)) {
      const rows = table.filter((l) => l.includes(flag));
      expect(rows, flag).toHaveLength(1);
      expect(rows[0], flag).toContain(`\`${flag}: ${on}\``);
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
      ],
      "accept-app-stack-wordpress.mjs": [
        "gate-self-test", "preflight", "snapshot-before", "plan-compiles-from-seed", "refused-before-docker",
        "deploy-creates-exact-set", "container-standard-profile", "secrets-reach-only-their-component", "network-shape",
        "no-control-plane-reach", "route-published-after-health", "wordpress-installs", "logs-mask-environment-secrets",
        "data-survives-stop-and-start", "idempotent-reapply", "upgrade-keeps-data", "recovery-reads-only",
        "remove-keeps-volumes", "destroy-data-removes-volume", "host-nft-metadata-drop-on-stack-net", "gate-clean", "nothing-left",
        // The steps of the `--imported` run (the draft the Compose importer writes).
        "compose-imports-to-draft", "plan-compiles-from-draft", "registry-lookup-reads-only"
      ],
      // ADR-0039: the built-in databases and the private link between a database and an application.
      "accept-app-stack-databases.mjs": [
        "gate-self-test", "preflight", "snapshot-before", "plans-compile-from-seeds", "applications-deploy",
        "mariadb-starts-hardened", "postgresql-starts-hardened", "valkey-starts-hardened", "data-survives-restart",
        "mariadb-earlier-version-upgrades", "valkey-earlier-version-upgrades", "postgresql-earlier-version-upgrades", "unlinked-application-cannot-reach", "link-reaches-by-alias", "link-idempotent", "two-applications-stay-apart",
        "link-follows-a-replaced-database", "application-removal-detaches-running-database",
        "stopped-database-survives-application-removal", "stale-attachment-repaired", "refuses-foreign-targets",
        "detach-removes-reachability", "remove-everything", "host-nft-metadata-drop-on-stack-net", "gate-clean", "nothing-left"
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
      // Only the scripts that run a throwaway proxy hold an any-host line (the rewrite of its loopback HostIp).
      if (!name.includes("http-cache") && !name.includes("wordpress")) expect(anyHost, file).toEqual([]);
      if (name.includes("databases")) {
        // Private networks only, and no image download: a live panel on the machine attaches its proxy to every edge network.
        for (const s of ["body.Internal === true", 'body.Labels?.[ROLE_LABEL] === "app_internal"', 'return deny("image change")']) {
          expect(script, `${file} ${s}`).toContain(s);
        }
        expect(script, file).not.toContain("appStackEdgeNetworkName");
      }
      // A script that carries secrets has its gate refuse them anywhere but the environment of an own container.
      if (name.includes("wordpress")) for (const s of ['deny("secret in the address")', 'deny("secret outside Env")']) expect(script, `${file} ${s}`).toContain(s);
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

describe("ADR-0038 docs and the application backups check", () => {
  it("ADR-0038 has its header and cites existing paths", () => {
    const adrs = readdirSync(join(root, "docs/architecture/adr")).filter((f) => /^0038-.*\.md$/.test(f));
    expect(adrs).toHaveLength(1);
    const file = `docs/architecture/adr/${adrs[0]!}`;
    const adr = read(file);
    for (const h of ["Stato", "Data", "Riferimento", "Migrazioni"]) expect(adr, h).toMatch(new RegExp(`^- \\*\\*${h}:\\*\\* `, "m"));
    expect(adr).toMatch(/^- \*\*Stato:\*\* `(?:PROPOSTO|APPROVATO)`/m);
    const paths = new Set([...adr.matchAll(/`((?:apps|packages|infra|docs|\.github)\/[^`\s]+)`/g)].map((m) => m[1]!.replace(/:[\d,-]+$/, "")));
    expect(paths.size, file).toBeGreaterThanOrEqual(10);
    for (const p of paths) expect(existsSync(join(root, p)), `${file}: ${p}`).toBe(true);
    for (const s of ["ADR-0035", "0027_app_stack_backups.sql", "app-stack-backups", "accept-app-stack-backups.mjs", "K12"]) expect(adr, s).toContain(s);
    // The two sections filled at the end of the work are filled.
    expect(adr).not.toMatch(/ompilato a lavoro finito/);
    // The decision it replaces points here.
    const stacks = read("docs/architecture/adr/0035-application-stacks.md");
    expect(stacks).toContain(file);
    expect(stacks.split("\n").filter((l) => l.startsWith("| D6 |")).join("\n")).toContain("`ADR-0038`");
  });

  it("README, HARNESS, runbooks, ER diagram and the decisions name the backups", () => {
    const readme = read("README.md");
    for (const s of ["ADR-0038", "docs/architecture/adr/0038-application-backups.md", "app-stack-backups"]) expect(readme, s).toContain(s);
    expect(readme).not.toContain("nessun backup degli stack");
    const harness = read("HARNESS.md");
    for (const s of ["ADR-0038", "0027_app_stack_backups.sql", "accept-app-stack-backups.mjs"]) expect(harness, s).toContain(s);
    // The guards the forbidden action names are files of this repository.
    const rule = harness.split("\n").filter((l) => l.includes("`ADR-0038`; guarded by"));
    expect(rule).toHaveLength(1);
    const guards = [...rule[0]!.matchAll(/`((?:apps|packages|infra)\/[^`\s]+)`/g)].map((m) => m[1]!);
    expect(guards.length).toBeGreaterThanOrEqual(4);
    for (const p of guards) expect(existsSync(join(root, p)), `HARNESS: ${p}`).toBe(true);
    const runbook = read("docs/runbooks/application-stacks.md");
    // Its number moves when another procedure lands before it; its title does not.
    expect(runbook).toMatch(/^## \d+\. Backup and restore of an application$/m);
    for (const s of ["ADR-0038", "app-stack-backups", "accept-app-stack-backups.mjs", "app_stack_backups"]) expect(runbook, s).toContain(s);
    expect(runbook).not.toContain("**Stack data is in no backup.**");
    // No procedure tells the operator to read a snapshot id out of the database.
    for (const line of runbook.split("\n").filter((l) => l.includes("psql"))) expect(line).not.toContain("snapshot_id");
    expect(read("docs/runbooks/tls-and-backup-targets.md")).toContain("app-stack-backups");
    const er = read("docs/architecture/diagrams/domain-er-and-boundaries.md");
    for (const s of ["0027_app_stack_backups.sql", "app_stack_backups", "app_stack_backup_copies", "ck_app_stack_backup_copies_snapshot"]) {
      expect(er, s).toContain(s);
    }
    expect(read(".agents/brain/decisions.md")).toContain("ADR-0038");
  });

  it("the application backups check is registered and machine-safe", () => {
    const file = "infra/linux/accept-app-stack-backups.mjs";
    const script = read(file);
    for (const s of ["DockerEngineSocketAdapter", "hp_swarmtest_", "swarmtest_"]) expect(script, `${file} ${s}`).toContain(s);
    // It builds its own plan: a seed template would bring an address, and with it an edge network.
    for (const s of ["compileAppStackPlan", "APP_BUILT_IN_TEMPLATES"]) expect(script, `${file} ${s}`).not.toContain(s);
    const steps = [
      "preflight", "gate-self-test", "snapshot-before", "local-target-init", "deploy-and-seed", "application-reads-its-data",
      "refused-while-running", "stop-application", "refused-for-another-customer-or-a-missing-volume", "backup-copies-every-volume",
      "job-hardening", "repository-is-ciphertext-under-own-folder", "snapshot-holds-both-volumes", "same-job-id-answers-the-same-job",
      "damage-data", "restore-brings-data-back", "restore-job-hardening", "application-starts-and-reads-restored-data",
      "forget-removes-the-snapshot", "forget-on-missing-repository-is-done", "no-secret-anywhere", "foreign-untouched", "gate-clean"
    ];
    for (const step of steps) expect(script, step).toContain(`step("${step}"`);
    expect(script).toContain('"PASS nothing-left"');
    expect(script, file).not.toMatch(/shell:\s*true|(?<![.\w])exec\(|execSync|spawnSync/);
    expect(script, file).not.toMatch(/["'`]hp_(?:ingress_proxy|ingress_net|mariadb|phpmyadmin)["'`]/);
    expect(script, file).not.toMatch(/["'](?:prune|system|pull)["']/);
    expect(script, file).not.toMatch(/:latest\b/);
    // Nothing is published, and nothing it creates by hand carries a label: a live executor adopts what it finds labelled.
    expect(script, file).not.toMatch(/["']-p["']|["']--publish["']/);
    expect(script, file).not.toContain("0.0.0.0");
    expect(script, file).not.toMatch(/["']--label(?:=[^"']*)?["']/);
    expect([...script.matchAll(/\b(1[0-9]{4})\b/g)].map((m) => Number(m[1])).filter((p) => p >= 10000 && p < 16000), file).toEqual([]);
    // The gate forwards only what it recognises: its judge ends in a denial.
    expect(between(script, "function judge(", "\n}\n").trimEnd(), file).toMatch(/\n {2}return deny\("[^"]+"\);$/);
    expect(script, file).toMatch(/console\.log\(`RESULT \$\{/);
    expect(script, file).toMatch(/nothing was created \(this script never pulls\)/);
    expect(script, file).toMatch(/skipped \(not counted in n\/m\)/);
  });
});
