import { siteDatabasePrefix, siteDatabaseSignOnUser } from "@hosting-panel/contracts";
import { describe, expect, it } from "vitest";
import { ACCOUNT_UPGRADE_QUERY, planAccountUpgrade } from "../src/db-account-upgrade.js";
import { SiteDatabasesRunner, type ExecResult } from "../src/index.js";

const P = siteDatabasePrefix("site_upgrade_a");
const P_ESC = P.replaceAll("_", "\\_");
const Q = siteDatabasePrefix("site_upgrade_b");
const hex = (s: string): string => Buffer.from(s, "utf8").toString("hex").toUpperCase();
const user = (name: string, max: number): string => `u\t${hex(name)}\t${String(max)}`;
const grant = (name: string, db: string): string => `d\t${hex(name)}\t${hex(db)}`;

function ok(stdout = ""): ExecResult {
  return { exitCode: 0, exitUnknown: false, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), truncated: false };
}

describe("planAccountUpgrade", () => {
  it("caps an old-style site account and re-grants its unescaped grant, escaped first", () => {
    const plan = planAccountUpgrade([user(P, 0), grant(P, P), grant(P, `${P}_shop`)].join("\n"));
    expect(plan).toEqual({
      capped: 1,
      regranted: 2,
      sql: [
        `ALTER USER '${P}'@'%' WITH MAX_USER_CONNECTIONS 40;`,
        `GRANT ALL PRIVILEGES ON \`${P_ESC}\`.* TO '${P}'@'%';`,
        `REVOKE ALL PRIVILEGES ON \`${P}\`.* FROM '${P}'@'%';`,
        `GRANT ALL PRIVILEGES ON \`${P_ESC}\\_shop\`.* TO '${P}'@'%';`,
        `REVOKE ALL PRIVILEGES ON \`${P}_shop\`.* FROM '${P}'@'%';`,
        "",
      ].join("\n"),
    });
  });

  it("changes nothing for a capped account whose grant is already escaped", () => {
    expect(planAccountUpgrade([user(P, 40), grant(P, P_ESC), user(Q, 40), grant(Q, Q.replaceAll("_", "\\_"))].join("\n"))).toEqual({
      sql: null,
      capped: 0,
      regranted: 0,
    });
  });

  it("never touches a foreign, extra, sign-on or panel account, nor a grant on another site's database", () => {
    const rows = [
      user("root", 0),
      user("hosting_panel", 0),
      user(`${P}_app`, 0),
      grant(`${P}_app`, `${P}_shop`),
      user(siteDatabaseSignOnUser("site_upgrade_a"), 0),
      grant(siteDatabaseSignOnUser("site_upgrade_a"), P),
      grant(P, Q),
      grant(P, "other_db"),
    ];
    expect(planAccountUpgrade(rows.join("\n"))).toEqual({ sql: null, capped: 0, regranted: 0 });
  });

  it("skips names that are not hex, not the exact shape, or hostile", () => {
    const rows = [
      `u\t${P}\t0`,
      `u\tZZ\t0`,
      user(`${P}'@'%'; DROP USER x; --`, 0),
      user(`${P}\n`, 0),
      user(P.toUpperCase(), 0),
      grant(P, `${P}\`.* TO 'x'@'%'; --`),
      grant(P, `${P}_%`),
      grant(P, "wpXabcdefabcdef"),
      `d\t${hex(P)}`,
      "",
    ];
    expect(planAccountUpgrade(rows.join("\n"))).toEqual({ sql: null, capped: 0, regranted: 0 });
  });

  it("reads names in hex only", () => {
    expect(ACCOUNT_UPGRADE_QUERY).toContain("HEX(User)");
    expect(ACCOUNT_UPGRADE_QUERY).toContain("HEX(Db)");
  });
});

describe("SiteDatabasesRunner.upgradeAccounts", () => {
  it("runs the plan once, and a second pass over the result changes nothing", async () => {
    const calls: string[] = [];
    const answers = [ok([user(P, 0), grant(P, P)].join("\n")), ok(), ok([user(P, 40), grant(P, P_ESC)].join("\n"))];
    const runner = new SiteDatabasesRunner({
      runSql: (sql) => {
        calls.push(sql);
        return Promise.resolve(answers.shift()!);
      },
      ensurePhpMyAdmin: () => Promise.resolve(),
    });
    await expect(runner.upgradeAccounts()).resolves.toEqual({ capped: 1, regranted: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain(`ALTER USER '${P}'@'%' WITH MAX_USER_CONNECTIONS 40;`);
    await expect(runner.upgradeAccounts()).resolves.toEqual({ capped: 0, regranted: 0 });
    expect(calls).toHaveLength(3);
  });

  it("throws a fixed error, never what MariaDB said", async () => {
    const runner = new SiteDatabasesRunner({
      runSql: () =>
        Promise.resolve({ ...ok(), exitCode: 1, stderr: Buffer.from(`ERROR 1045: denied for '${P}'`) }),
      ensurePhpMyAdmin: () => Promise.resolve(),
    });
    const err = await runner.upgradeAccounts().catch((e: unknown) => e);
    expect((err as Error).message).not.toContain(P);
    expect((err as { code?: string }).code).toBe("INTERNAL_ERROR");
  });
});
