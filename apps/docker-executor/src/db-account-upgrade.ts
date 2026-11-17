import { SITE_DATABASE_PREFIX_PATTERN, isSiteDatabaseName } from "@hosting-panel/contracts";
import { MARIADB_OWN_MAX_USER_CONNECTIONS } from "./site-jobs.js";

/** Every '%' account and database grant; names come back in hex, so no byte of a name can break a row. */
export const ACCOUNT_UPGRADE_QUERY = `SELECT 'u', HEX(User), max_user_connections FROM mysql.user WHERE Host = '%';
SELECT 'd', HEX(User), HEX(Db) FROM mysql.db WHERE Host = '%';
`;

export interface AccountUpgradePlan {
  readonly sql: string | null;
  readonly capped: number;
  readonly regranted: number;
}

/** A hex column back to text, or null when it is not hex. */
function unhex(value: string | undefined): string | null {
  return value !== undefined && /^(?:[0-9A-F]{2})+$/.test(value) ? Buffer.from(value, "hex").toString("utf8") : null;
}

/** The statements that cap and re-grant site accounts made before the cap and the escaped grant (R30, R40). */
export function planAccountUpgrade(stdout: string): AccountUpgradePlan {
  const lines: string[] = [];
  let capped = 0;
  let regranted = 0;
  for (const row of stdout.split("\n")) {
    const [tag, rawUser, value] = row.split("\t");
    const user = unhex(rawUser);
    // Only a site's own account: panel, phpMyAdmin and extra accounts never match this shape.
    if (user === null || !SITE_DATABASE_PREFIX_PATTERN.test(user)) continue;
    if (tag === "u" && value === "0") {
      lines.push(`ALTER USER '${user}'@'%' WITH MAX_USER_CONNECTIONS ${String(MARIADB_OWN_MAX_USER_CONNECTIONS)};`);
      capped += 1;
    } else if (tag === "d") {
      const db = unhex(value);
      // An escaped grant holds a backslash; an unescaped one lets `_` match any character.
      if (db === null || !isSiteDatabaseName(user, db)) continue;
      // The escaped grant first, so a running site never loses access.
      lines.push(
        `GRANT ALL PRIVILEGES ON \`${db.replaceAll("_", "\\_")}\`.* TO '${user}'@'%';`,
        `REVOKE ALL PRIVILEGES ON \`${db}\`.* FROM '${user}'@'%';`,
      );
      regranted += 1;
    }
  }
  return { sql: lines.length > 0 ? `${lines.join("\n")}\n` : null, capped, regranted };
}
