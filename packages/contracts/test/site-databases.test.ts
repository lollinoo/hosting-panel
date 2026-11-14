import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CreateSiteDatabaseRequestSchema,
  CreateSiteDatabaseUserRequestSchema,
  MYSQL_NATIVE_PASSWORD_HASH_PATTERN,
  SITE_DATABASES_MAX,
  SITE_DATABASES_RESULT_SCHEMAS,
  SITE_DATABASE_CUSTOM_NAME_PATTERN,
  SITE_DATABASE_NAME_PATTERN,
  SITE_DATABASE_PREFIX_PATTERN,
  SITE_DATABASE_SIGNON_USER_PATTERN,
  SITE_DATABASE_SUFFIX_PATTERN,
  SITE_DATABASE_USERS_MAX,
  SiteDatabaseSignOnDtoSchema,
  SiteDatabasesDtoSchema,
  SiteDatabasesIpcRequestSchema,
  isSiteDatabaseName,
  mysqlNativePasswordHash,
  siteDatabaseFullName,
  siteDatabasePrefix,
  siteDatabaseSignOnUser,
} from "../src/index.js";

const SITE_ID = "site_01j8x7k9m2p4q6r8s0t2";
const OTHER_SITE_ID = "site_other_999";
const VALID_HASH = "*2470C0C06DEE42FD1618BB99005ADCA2EC9D1E19";

function expectedHash12(siteId: string): string {
  return createHash("sha256").update(siteId).digest("hex").slice(0, 12);
}

describe("site-databases helpers and hash", () => {
  it("computes prefix, sign-on user, and full database name for a fixed site id", () => {
    const hash12 = expectedHash12(SITE_ID);
    const prefix = siteDatabasePrefix(SITE_ID);
    const signOn = siteDatabaseSignOnUser(SITE_ID);

    expect(prefix).toBe(`wp_${hash12}`);
    expect(signOn).toBe(`pma_${hash12}`);
    expect(prefix).toMatch(SITE_DATABASE_PREFIX_PATTERN);
    expect(signOn).toMatch(SITE_DATABASE_SIGNON_USER_PATTERN);
    expect(siteDatabaseFullName(prefix, "shop")).toBe(`${prefix}_shop`);
    expect(SITE_DATABASES_MAX).toBe(10);
    expect(SITE_DATABASE_USERS_MAX).toBe(10);
  });

  it("checks isSiteDatabaseName across valid and rejected forms", () => {
    const prefix = siteDatabasePrefix(SITE_ID);
    const otherPrefix = siteDatabasePrefix(OTHER_SITE_ID);

    expect(isSiteDatabaseName(prefix, prefix)).toBe(true);
    expect(isSiteDatabaseName(prefix, `${prefix}_shop`)).toBe(true);
    expect(isSiteDatabaseName(prefix, `${prefix}_${"a".repeat(16)}`)).toBe(true);

    expect(isSiteDatabaseName(prefix, otherPrefix)).toBe(false);
    expect(isSiteDatabaseName(prefix, `${otherPrefix}_shop`)).toBe(false);
    expect(isSiteDatabaseName(prefix, `${prefix}_Shop`)).toBe(false);
    expect(isSiteDatabaseName(prefix, `${prefix}_${"a".repeat(17)}`)).toBe(false);
    expect(isSiteDatabaseName(prefix, `${prefix}_`)).toBe(false);
    expect(isSiteDatabaseName(prefix, `${prefix}__shop`)).toBe(false);
    expect(isSiteDatabaseName(prefix, `${prefix}X_shop`)).toBe(false);
    expect(isSiteDatabaseName(prefix, `${prefix}x_shop`)).toBe(false);
  });

  it("computes the pinned mysql_native_password SHA-1 vector", () => {
    expect(mysqlNativePasswordHash("password")).toBe(VALID_HASH);
    expect(mysqlNativePasswordHash("another-secret-24")).toMatch(MYSQL_NATIVE_PASSWORD_HASH_PATTERN);
  });
});

describe("SiteDatabasesIpcRequestSchema", () => {
  const prefix = siteDatabasePrefix(SITE_ID);
  const fullDb = `${prefix}_shop`;
  const fullUser = `${prefix}_app`;

  it("accepts one valid request per operation", () => {
    const validRequests = [
      { siteId: SITE_ID, op: "list" },
      { siteId: SITE_ID, op: "createDatabase", database: fullDb },
      { siteId: SITE_ID, op: "deleteDatabase", database: fullDb },
      { siteId: SITE_ID, op: "createUser", user: fullUser, passwordHash: VALID_HASH },
      { siteId: SITE_ID, op: "setUserPassword", user: fullUser, passwordHash: VALID_HASH },
      { siteId: SITE_ID, op: "deleteUser", user: fullUser },
      { siteId: SITE_ID, op: "grant", user: fullUser, database: fullDb },
      { siteId: SITE_ID, op: "grant", user: fullUser, database: prefix },
      { siteId: SITE_ID, op: "revoke", user: fullUser, database: fullDb },
      { siteId: SITE_ID, op: "revoke", user: fullUser, database: prefix },
      { siteId: SITE_ID, op: "phpMyAdminSignOn", passwordHash: VALID_HASH },
      { siteId: SITE_ID, op: "dropAll" },
    ];

    for (const req of validRequests) {
      expect(SiteDatabasesIpcRequestSchema.safeParse(req).success).toBe(true);
    }
  });

  it("refuses unknown keys on strict IPC objects", () => {
    expect(
      SiteDatabasesIpcRequestSchema.safeParse({ siteId: SITE_ID, op: "list", extra: 1 }).success,
    ).toBe(false);
    expect(
      SiteDatabasesIpcRequestSchema.safeParse({
        siteId: SITE_ID,
        op: "createUser",
        user: fullUser,
        passwordHash: VALID_HASH,
        password: "leak",
      }).success,
    ).toBe(false);
  });

  it("refuses bare prefix as user or createDatabase/deleteDatabase database", () => {
    expect(
      SiteDatabasesIpcRequestSchema.safeParse({
        siteId: SITE_ID,
        op: "createDatabase",
        database: prefix,
      }).success,
    ).toBe(false);
    expect(
      SiteDatabasesIpcRequestSchema.safeParse({
        siteId: SITE_ID,
        op: "deleteDatabase",
        database: prefix,
      }).success,
    ).toBe(false);

    for (const req of [
      { siteId: SITE_ID, op: "createUser", user: prefix, passwordHash: VALID_HASH },
      { siteId: SITE_ID, op: "setUserPassword", user: prefix, passwordHash: VALID_HASH },
      { siteId: SITE_ID, op: "deleteUser", user: prefix },
      { siteId: SITE_ID, op: "grant", user: prefix, database: fullDb },
      { siteId: SITE_ID, op: "revoke", user: prefix, database: fullDb },
    ]) {
      expect(SiteDatabasesIpcRequestSchema.safeParse(req).success).toBe(false);
    }
  });

  it("refuses malformed password hashes", () => {
    const badHashes = [
      VALID_HASH.toLowerCase(),
      VALID_HASH.slice(0, -1),
      `${VALID_HASH}A`,
      VALID_HASH.slice(1),
      `*${"G".repeat(40)}`,
      "plaintext",
    ];

    for (const passwordHash of badHashes) {
      expect(
        SiteDatabasesIpcRequestSchema.safeParse({
          siteId: SITE_ID,
          op: "createUser",
          user: fullUser,
          passwordHash,
        }).success,
      ).toBe(false);
      expect(
        SiteDatabasesIpcRequestSchema.safeParse({
          siteId: SITE_ID,
          op: "phpMyAdminSignOn",
          passwordHash,
        }).success,
      ).toBe(false);
    }
  });

  it("refuses names containing quotes, backticks, backslashes, spaces, or semicolons", () => {
    const badChars = ["'", '"', "`", "\\", " ", ";"];
    for (const ch of badChars) {
      const badName = `${prefix}_ab${ch}c`;
      expect(SITE_DATABASE_NAME_PATTERN.test(badName)).toBe(false);
      expect(SITE_DATABASE_CUSTOM_NAME_PATTERN.test(badName)).toBe(false);
      expect(SITE_DATABASE_SUFFIX_PATTERN.test(`ab${ch}c`)).toBe(false);
      expect(
        SiteDatabasesIpcRequestSchema.safeParse({
          siteId: SITE_ID,
          op: "createDatabase",
          database: badName,
        }).success,
      ).toBe(false);
      expect(
        SiteDatabasesIpcRequestSchema.safeParse({
          siteId: SITE_ID,
          op: "createUser",
          user: badName,
          passwordHash: VALID_HASH,
        }).success,
      ).toBe(false);
    }
  });
});

describe("site-databases DTO and result schemas", () => {
  it("validates public DTOs and IPC result schemas", () => {
    const prefix = siteDatabasePrefix(SITE_ID);
    const signOnUser = siteDatabaseSignOnUser(SITE_ID);

    expect(CreateSiteDatabaseRequestSchema.parse({ name: "  Shop_1 " })).toEqual({ name: "shop_1" });
    expect(CreateSiteDatabaseUserRequestSchema.safeParse({ name: "_bad" }).success).toBe(false);
    expect(
      SiteDatabasesDtoSchema.safeParse({
        prefix,
        databases: [{ name: prefix, primary: true, sizeBytes: 0 }],
        users: [{ name: `${prefix}_app`, primary: false, databases: [prefix] }],
        limits: { databases: 10, users: 10 },
        phpMyAdminAvailable: false,
      }).success,
    ).toBe(true);
    expect(
      SiteDatabaseSignOnDtoSchema.safeParse({
        username: signOnUser,
        temporaryPassword: "A".repeat(24),
      }).success,
    ).toBe(true);

    expect(
      SITE_DATABASES_RESULT_SCHEMAS.phpMyAdminSignOn.safeParse({ username: signOnUser }).success,
    ).toBe(true);
    expect(SITE_DATABASES_RESULT_SCHEMAS.dropAll.safeParse({}).success).toBe(true);
  });
});
