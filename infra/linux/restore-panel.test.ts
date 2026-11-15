import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "restore-panel.sh");
// Sentinels only: no real key ever appears in this file.
const AKID = "AKIDSENTINEL0000RESTORE";
const SECRET = "secret-sentinel-restore-0000";
const MASTER = "ab".repeat(32);
const PGPW = "0123456789abcdef".repeat(4);
const DATABASE_URL = `postgresql://hosting_panel:${PGPW}@127.0.0.1:5432/hosting_panel`;
const TARGET = ["--endpoint", "https://s3.example.test", "--region", "eu-test-1", "--bucket", "bkt", "--prefix", "hp/old"];
const ARGS = [...TARGET, "--yes"];
const COPY_TIME = "2026-11-14T02:00:00.000Z";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Every stub but runuser logs "<user> <name> <args>[ [M]]" (M: the marker exists) and its environment. */
const PREAMBLE = `#!/usr/bin/env bash
m=""; [[ -e "$HP_ROOT/var/lib/hosting-panel/panel-restore.pending" ]] && m=" [M]"
printf '%s %s %s%s\\n' "\${STUB_USER:-root}" "$(basename "$0")" "$*" "$m" >> "$STUB_DIR/calls.log"
env >> "$STUB_DIR/env.log"
[[ -n "\${PGPASSWORD+x}" ]] && printf '%s=%s\\n' "$(basename "$0")" "$PGPASSWORD" >> "$STUB_DIR/pgpw.log"
fail() { [[ ",\${STUB_FAIL:-}," == *",$1,"* ]] && exit 1; return 0; }
`;
const STUBS: Record<string, string> = {
  // runuser -u <user> -- <cmd> ...: run the command as "<user>"; /usr/bin/node is the fetch stub.
  runuser: `[[ "$1" == -u && "$3" == -- ]] || exit 99; u="$2"; shift 3
c="$1"; shift; [[ "$c" == /usr/bin/node ]] && c="$STUB_DIR/bin/node"
STUB_USER="$u" exec "$c" "$@"`,
  node: `printf '%s\\n' "$@" > "$STUB_DIR/fetch.argv"; env > "$STUB_DIR/fetch.env"; cat > "$STUB_DIR/fetch.stdin"
printf 'PGDMP-stub' > "$HP_PANEL_DUMP_DIR/restore.pgdump"; printf '%s' "\${STUB_KEY:-${MASTER}}" > "$HP_PANEL_DUMP_DIR/restore.key"
[[ -n "\${STUB_FETCH_RC:-}" ]] && { echo "panel-fetch: stub" >&2; exit "$STUB_FETCH_RC"; }; echo '{"snapshotId":"s","time":"${COPY_TIME}"}'`,
  install: `fail install; cp -- "\${@: -2:1}" "\${@: -1}"`,
  systemctl: `fail "$1"; exit 0`,
  health: `exit 0`,
  psql: `if [[ "$*" == *"count(*)"* ]]; then fail count; echo "\${STUB_SITES:-0}"; else cat > "$STUB_DIR/psql.stdin"; fail psql; fi`,
  pg_restore: `if [[ "$*" == *--data-only* ]]; then
  echo 'COPY public.schema_migrations (filename, applied_at) FROM stdin;'
  IFS=, read -ra ms <<<"\${STUB_MIGRATIONS:-0001_a.sql,0002_b.sql}"; for x in "\${ms[@]}"; do printf '%s\\t2026-11-15\\n' "$x"; done
  echo '\\.'
else cat > /dev/null; fail pg_restore; fi`,
  dropdb: `fail dropdb`,
  createdb: `fail createdb`,
  "hp-accounts": `fail hp-accounts`,
};

function fixture() {
  const d = mkdtempSync(join(tmpdir(), "hp-restore-panel-"));
  dirs.push(d);
  const root = join(d, "root");
  const bin = join(d, "bin");
  const pg = join(d, "pg");
  const rel = join(root, "opt/hosting-panel/current");
  for (const p of [bin, pg, join(root, "etc/hosting-panel"), join(root, "var/lib/hosting-panel/panel-dump"), join(root, "usr/local/sbin"), join(rel, "packages/database/dist/migrations"), join(rel, "infra/linux")]) {
    mkdirSync(p, { recursive: true });
  }
  writeFileSync(join(root, "etc/hosting-panel/backup.key"), "cd".repeat(32));
  writeFileSync(join(root, "etc/hosting-panel/executor.env"), "HP_PANEL_HOSTNAME=panel.example.test\nHP_PANEL_IPV4=192.0.2.10\n");
  writeFileSync(join(root, "etc/hosting-panel/api.env"), `NODE_ENV=production\nDATABASE_URL=${DATABASE_URL}\n`);
  for (const m of ["0001_a.sql", "0002_b.sql"]) writeFileSync(join(rel, "packages/database/dist/migrations", m), "");
  writeFileSync(join(rel, "infra/linux/hp-restore-panel.sql"), "-- the shared SQL file\n");
  writeFileSync(join(d, "calls.log"), "");
  writeFileSync(join(d, "pgpw.log"), "");
  const stub = (dir: string, name: string) =>
    writeFileSync(join(dir, name), (name === "runuser" ? "#!/usr/bin/env bash\n" : PREAMBLE) + STUBS[name] + "\n", { mode: 0o755 });
  for (const n of ["runuser", "node", "install", "systemctl", "health"]) stub(bin, n);
  for (const n of ["psql", "pg_restore", "dropdb", "createdb"]) stub(pg, n);
  stub(join(root, "usr/local/sbin"), "hp-accounts");
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: d,
    STUB_DIR: d,
    HP_ROOT: root,
    HP_PG_BIN: pg,
    HP_SYSTEMCTL: join(bin, "systemctl"),
    HP_HEALTH_CMD: join(bin, "health"),
    HP_S3_ACCESS_KEY_ID: AKID,
    HP_S3_SECRET_ACCESS_KEY: SECRET,
  };
  const marker = join(root, "var/lib/hosting-panel/panel-restore.pending");
  const dumpDir = join(root, "var/lib/hosting-panel/panel-dump");
  const run = (args: string[] = ARGS, extra: Record<string, string> = {}, input = "") => {
    const r = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...env, ...extra }, input, timeout: 30_000 });
    const calls = readFileSync(join(d, "calls.log"), "utf8").replaceAll(root, "$R").split("\n").filter(Boolean);
    writeFileSync(join(d, "calls.log"), "");
    return { code: r.status, out: r.stdout + r.stderr, calls };
  };
  const leftovers = () => ["restore.pgdump", "restore.key"].filter((f) => existsSync(join(dumpDir, f)));
  const file = (name: string) => readFileSync(join(d, name), "utf8");
  return { d, root, env, run, marker, leftovers, file };
}
const named = (calls: string[], name: string) => calls.filter((c) => c.split(" ")[1] === name);

const ORDER = [
  "root psql -X -tAc SELECT count(*) FROM public.sites -h 127.0.0.1 -U hosting_panel -d hosting_panel",
  "hp-executor node $R/opt/hosting-panel/current/apps/docker-executor/dist/cli/panel-fetch.js --endpoint https://s3.example.test --region eu-test-1 --bucket bkt --prefix hp/old",
  "root pg_restore --data-only --table=schema_migrations --file=- $R/var/lib/hosting-panel/panel-dump/restore.pgdump",
  "root systemctl stop hp-web hp-api",
  "root install -m 0400 -o hp-api -g root $R/var/lib/hosting-panel/panel-dump/restore.key $R/etc/hosting-panel/secrets-master.key",
  "postgres dropdb --force --if-exists hosting_panel [M]",
  "postgres createdb -O hosting_panel hosting_panel [M]",
  "root pg_restore -h 127.0.0.1 -U hosting_panel --dbname=hosting_panel --no-owner --exit-on-error [M]",
  "root hp-accounts setup --name panel.example.test --hostname panel.example.test --ipv4 192.0.2.10 [M]",
  "root psql -X -q -v ON_ERROR_STOP=1 --single-transaction -h 127.0.0.1 -U hosting_panel -d hosting_panel -f - [M]",
  "root systemctl start hp-api hp-web",
  "root health ",
];

describe("restore-panel.sh refusals", () => {
  it("(a) a missing --bucket exits 2 with the usage", () => {
    const f = fixture();
    const r = f.run(["--endpoint", "e", "--region", "r"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("Usage:");
    expect(r.calls).toEqual([]);
  });

  it("(b) a normal user without HP_ROOT is told to run as root", () => {
    const f = fixture();
    const r = f.run(ARGS, { HP_ROOT: "" });
    expect(r.code).toBe(2);
    expect(r.out).toContain("Run as root");
    expect(r.calls).toEqual([]);
  });

  it("(c) without backup.key nothing runs", () => {
    const f = fixture();
    rmSync(join(f.root, "etc/hosting-panel/backup.key"));
    const r = f.run();
    expect(r.code).toBe(2);
    expect(r.out).toContain("backup.key");
    expect(r.calls).toEqual([]);
  });

  it("(d) a panel with sites is refused before the fetch", () => {
    const f = fixture();
    const r = f.run(ARGS, { STUB_SITES: "3" });
    expect(r.code).toBe(2);
    expect(r.out).toContain("already has 3 site(s)");
    expect(r.calls).toEqual([ORDER[0]]);
  });

  it("(d) a site count that is not only digits is refused and never printed", () => {
    const r = fixture().run(ARGS, { STUB_SITES: "1\x1b[2J" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("unexpected answer");
    expect(r.out).toContain("Nothing on this server was changed");
    expect(r.out).not.toContain("\x1b");
    expect(r.calls).toEqual([ORDER[0]]);
  });

  it("(e) with the marker of an interrupted run the site count is skipped", () => {
    const f = fixture();
    writeFileSync(f.marker, "");
    const r = f.run(ARGS, { STUB_SITES: "3" });
    expect(r.code, r.out).toBe(0);
    expect(r.calls.some((c) => c.includes("count(*)"))).toBe(false);
    expect(existsSync(f.marker)).toBe(false);
  });

  it("(f) a failed fetch stops nothing and leaves no restore files", () => {
    const f = fixture();
    const r = f.run(ARGS, { STUB_FETCH_RC: "1" });
    expect(r.code).toBe(1);
    expect(named(r.calls, "systemctl")).toEqual([]);
    expect(f.leftovers()).toEqual([]);
  });

  it("(g) a fetched key that is not 64 hex is refused", () => {
    const f = fixture();
    const r = f.run(ARGS, { STUB_KEY: "not-a-key" });
    expect(r.code).toBe(1);
    expect(named(r.calls, "systemctl")).toEqual([]);
    expect(f.leftovers()).toEqual([]);
  });

  it("(h) a copy made by a newer panel is refused before anything is stopped", () => {
    const f = fixture();
    const r = f.run(ARGS, { STUB_MIGRATIONS: "0001_a.sql,0002_b.sql,0099_future.sql" });
    expect(r.code).toBe(2);
    expect(r.out).toContain("0099_future.sql");
    expect(r.out).toContain("hp-update --version");
    for (const n of ["systemctl", "install", "dropdb"]) expect(named(r.calls, n)).toEqual([]);
    expect(f.leftovers()).toEqual([]);
  });

  it("(h) a migration name that is not a plain file name is refused", () => {
    const f = fixture();
    const r = f.run(ARGS, { STUB_MIGRATIONS: "0001_a.sql,../../x.sql" });
    expect(r.code).toBe(1);
    expect(named(r.calls, "systemctl")).toEqual([]);
  });

  const DB_REFUSALS: [string, string | null][] = [
    ["no api.env", null],
    ["no DATABASE_URL", "NODE_ENV=production\n"],
    ["another user", `DATABASE_URL=postgresql://postgres:${PGPW}@127.0.0.1:5432/hosting_panel\n`],
    ["another host", `DATABASE_URL=postgresql://hosting_panel:${PGPW}@db.example.test:5432/hosting_panel\n`],
    ["an encoded password", `DATABASE_URL=postgresql://hosting_panel:a%40b@127.0.0.1:5432/hosting_panel\n`],
  ];
  for (const [label, content] of DB_REFUSALS) {
    it(`(r) ${label} in api.env is refused before anything changes`, () => {
      const f = fixture();
      const apiEnv = join(f.root, "etc/hosting-panel/api.env");
      if (content === null) rmSync(apiEnv);
      else writeFileSync(apiEnv, content);
      const r = f.run();
      expect(r.code).toBe(1);
      expect(r.out).toContain("Nothing on this server was changed");
      expect(r.out).not.toContain(PGPW);
      expect(r.calls).toEqual([]);
      expect(f.leftovers()).toEqual([]);
    });
  }
  it("(r) the three api.env refusals have their own sentences", () => {
    const outs = DB_REFUSALS.slice(0, 3).map(([, content]) => {
      const f = fixture();
      const apiEnv = join(f.root, "etc/hosting-panel/api.env");
      if (content === null) rmSync(apiEnv);
      else writeFileSync(apiEnv, content);
      return f.run().out;
    });
    expect(new Set(outs).size).toBe(3);
  });

  it.skipIf(process.getuid?.() !== 0)("(l) as root the test overrides are refused", () => {
    const f = fixture();
    const r = f.run();
    expect(r.code).toBe(2);
    expect(r.out).toContain("HP_ROOT is a test override");
  });
});

describe("restore-panel.sh happy path and keys", () => {
  it("(i) runs every step in order, the marker only around the database work", () => {
    const f = fixture();
    const r = f.run();
    expect(r.code, r.out).toBe(0);
    expect(r.calls).toEqual(ORDER);
    expect(f.file("fetch.stdin")).toBe(`${AKID}\n${SECRET}\n`);
    const fetchEnv = f.file("fetch.env");
    expect(fetchEnv).toContain(`HP_PANEL_DUMP_DIR=${join(f.root, "var/lib/hosting-panel/panel-dump")}\n`);
    expect(fetchEnv).not.toMatch(/^HP_S3_/m);
    expect(f.file("psql.stdin")).toBe("-- the shared SQL file\n");
    expect(readFileSync(join(f.root, "etc/hosting-panel/secrets-master.key"), "utf8")).toBe(MASTER);
    expect(existsSync(f.marker)).toBe(false);
    expect(f.leftovers()).toEqual([]);
    expect(r.out).toContain("Panel restored");
  });

  it("(k) the S3 keys appear in no argument, no stub environment and no output", () => {
    const f = fixture();
    const r = f.run();
    expect(r.code, r.out).toBe(0);
    const seen = [r.calls.join("\n"), f.file("fetch.argv"), f.file("env.log"), f.file("fetch.env"), r.out].join("\n");
    for (const s of [AKID, SECRET]) expect(seen).not.toContain(s);
    expect(f.file("env.log")).not.toMatch(/^HP_S3_/m);
  });

  it("(k) without the keys in the environment it asks for them and pipes them the same way", () => {
    const f = fixture();
    const r = f.run(ARGS, { HP_S3_ACCESS_KEY_ID: "", HP_S3_SECRET_ACCESS_KEY: "" }, `${AKID}\n${SECRET}\n`);
    expect(r.code, r.out).toBe(0);
    expect(f.file("fetch.stdin")).toBe(`${AKID}\n${SECRET}\n`);
    expect([r.out, f.file("env.log")].join("\n")).not.toContain(SECRET);
  });

  it("(k) without any key it refuses before anything runs past the checks", () => {
    const f = fixture();
    const r = f.run(ARGS, { HP_S3_ACCESS_KEY_ID: "", HP_S3_SECRET_ACCESS_KEY: "" });
    expect(r.code).toBe(2);
    expect(named(r.calls, "node")).toEqual([]);
  });

  it("(p) only the site count, pg_restore and the SQL file get the database password, and only in their environment", () => {
    const f = fixture();
    const r = f.run();
    expect(r.code, r.out).toBe(0);
    expect(f.file("pgpw.log").split("\n").filter(Boolean)).toEqual([`psql=${PGPW}`, `pg_restore=${PGPW}`, `psql=${PGPW}`]);
    expect(named(r.calls, "pg_restore").at(-1)).not.toContain("--role");
    const written = [join(f.root, "etc/hosting-panel"), join(f.root, "var/lib/hosting-panel")].flatMap((dir) =>
      readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name), "utf8")),
    );
    const seen = [r.calls.join("\n"), f.file("fetch.argv"), f.file("fetch.env"), r.out, ...written.filter((c) => !c.includes("DATABASE_URL="))].join("\n");
    expect(seen).not.toContain(PGPW);
  });

  it("(p) only dropdb and createdb run as the superuser, also on a run after a complete restore", () => {
    const f = fixture();
    const first = f.run();
    expect(first.code, first.out).toBe(0);
    const again = f.run();
    expect(again.code, again.out).toBe(0);
    for (const r of [first, again]) {
      expect(r.calls.filter((c) => c.startsWith("postgres ")).map((c) => c.split(" ")[1])).toEqual(["dropdb", "createdb"]);
    }
  });

  it("(q) the copy's date is shown; without --yes and with no terminal the answer is no and nothing changes", () => {
    const f = fixture();
    const yes = f.run();
    expect(yes.code, yes.out).toBe(0);
    expect(yes.out).toContain(COPY_TIME);
    for (const input of ["", "y\n"]) {
      const r = fixture().run(TARGET, {}, input);
      expect(r.code).toBe(2);
      expect(r.out).toContain(COPY_TIME);
      expect(r.out).toContain("--yes");
      for (const n of ["systemctl", "install", "dropdb", "createdb"]) expect(named(r.calls, n)).toEqual([]);
    }
    const g = fixture();
    const no = g.run(TARGET);
    expect(no.code).toBe(2);
    expect(g.leftovers()).toEqual([]);
    expect(existsSync(g.marker)).toBe(false);
  });

  it("(o) without --prefix the fetch gets no --prefix", () => {
    const f = fixture();
    const r = f.run([...TARGET.slice(0, 6), "--yes"]);
    expect(r.code, r.out).toBe(0);
    expect(f.file("fetch.argv")).not.toContain("--prefix");
  });
});

describe("restore-panel.sh failures", () => {
  it("(j, m) a failed pg_restore keeps the marker, and a second run with sites goes through", () => {
    const f = fixture();
    const r = f.run(ARGS, { STUB_FAIL: "pg_restore" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("run this again");
    expect(existsSync(f.marker)).toBe(true);
    expect(r.calls.some((c) => c.includes("start"))).toBe(false);
    expect(f.leftovers()).toEqual([]);

    const again = f.run(ARGS, { STUB_SITES: "3" });
    expect(again.code, again.out).toBe(0);
    const unmarked = (c: string) => c.replace(/ \[M\]$/, "");
    expect(again.calls.map(unmarked)).toEqual(ORDER.slice(1).map(unmarked));
    expect(existsSync(f.marker)).toBe(false);
  });

  it("(n) a failed load gives each of its two causes its own next step", () => {
    const r = fixture().run(ARGS, { STUB_FAIL: "pg_restore" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("df -h");
    expect(r.out).toContain("free disk space and run this again");
    expect(r.out).toContain("may have been tampered with: do not use it");
  });

  it("(n) a failed site count names PostgreSQL and the password in api.env", () => {
    const f = fixture();
    const r = f.run(ARGS, { STUB_FAIL: "count" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("systemctl status postgresql");
    expect(r.out).toContain("DATABASE_URL");
    expect(r.out).toContain("install.sh");
    expect(r.out).toContain("Nothing on this server was changed");
    expect(r.out).not.toContain(PGPW);
    expect(r.calls).toEqual([ORDER[0]]);
  });

  for (const step of ["stop", "install"]) {
    it(`(m) a failed ${step} before dropdb leaves no marker and drops nothing`, () => {
      const f = fixture();
      const r = f.run(ARGS, { STUB_FAIL: step });
      expect(r.code).toBe(1);
      expect(r.out).toContain("systemctl start hp-api hp-web");
      expect(r.out).toContain("run this again");
      expect(existsSync(f.marker)).toBe(false);
      expect(named(r.calls, "dropdb")).toEqual([]);
      expect(f.leftovers()).toEqual([]);
    });
  }

  const FETCH_MESSAGES: Record<string, string> = {
    "2": "The bucket settings were refused",
    "3": "--endpoint, --region, --bucket",
    "4": "No copy of the panel",
    "5": "backup.key",
    "6": "free space",
    "1": "Fetching the copy failed",
  };
  for (const [rc, text] of Object.entries(FETCH_MESSAGES)) {
    it(`(n) fetch exit ${rc} ends with exit 1 and its own message`, () => {
      const f = fixture();
      const r = f.run(ARGS, { STUB_FETCH_RC: rc });
      expect(r.code).toBe(1);
      expect(r.out).toContain(text);
      expect(r.out).toContain("Nothing on this server was changed");
      for (const n of ["systemctl", "dropdb", "install"]) expect(named(r.calls, n)).toEqual([]);
      expect(f.leftovers()).toEqual([]);
    });
  }
  it("(n) the six fetch messages differ", () => {
    const outs = Object.keys(FETCH_MESSAGES).map((rc) => fixture().run(ARGS, { STUB_FETCH_RC: rc }).out);
    expect(new Set(outs).size).toBe(outs.length);
  });
});
