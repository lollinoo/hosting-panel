import { describe, expect, it } from "vitest";
import { APP_STACK_COMPONENT_KEY_MAX, APP_STACK_ID_PATTERN, APP_STACK_KEY_PATTERN } from "../src/app-templates/limits.js";
import { APP_ID_PREFIXES } from "../src/app-templates/stack-ids.js";
import {
  APP_DATABASE_TEMPLATE_CATEGORY,
  APP_STACK_LINK_OUTCOMES,
  APP_STACK_LINK_STATES,
  AppStackLinkDtoSchema,
  AppStackLinksDtoSchema,
  AppStackLinksIpcRequestSchema,
  AppStackLinksIpcResultSchema,
  CreateAppStackLinkInputSchema,
  MAX_APP_STACK_LINKS_PER_APPLICATION,
  MAX_APP_STACK_LINKS_PER_DATABASE,
  appStackLinkAlias,
  appStackLinkTarget,
} from "../src/app-templates/stack-links.js";
import { APP_AUDIT_ACTIONS, APP_AUDIT_TARGET_TYPES } from "../src/app-templates/stack-operations.js";
import { findForbiddenPublicDtoKeys, findPlaintextSecretKeys, findUnsafeDockerInputFields } from "../src/resources.js";

const minted = (n: number): string => `stk_${n.toString(16).padStart(24, "0")}`;
const DB = minted(1);
const ORG = "org_0123456789abcdef0123456789abcdef";

describe("private links between a database and an application (ADR-0039)", () => {
  it("pins the category, the caps, the states and the audit names", () => {
    expect(APP_DATABASE_TEMPLATE_CATEGORY).toBe("database");
    expect(MAX_APP_STACK_LINKS_PER_APPLICATION).toBe(4);
    expect(MAX_APP_STACK_LINKS_PER_DATABASE).toBe(8);
    expect(APP_STACK_LINK_STATES).toEqual(["pending", "active"]);
    expect(APP_STACK_LINK_OUTCOMES).toEqual(["connected", "already_connected", "pending"]);
    expect(APP_ID_PREFIXES.link).toBe("slnk");
    expect(APP_AUDIT_ACTIONS.linkCreate).toBe("app.stack.link.create");
    expect(APP_AUDIT_ACTIONS.linkRemove).toBe("app.stack.link.remove");
    expect(APP_AUDIT_TARGET_TYPES.link).toBe("app_stack_link");
  });

  describe("appStackLinkAlias", () => {
    it("is the id with a hyphen for every underscore", () => {
      expect(appStackLinkAlias("stk_0123456789abcdef01234567")).toBe("stk-0123456789abcdef01234567");
      expect(appStackLinkAlias("stk_swarmtest_0123456789ab_a")).toBe("stk-swarmtest-0123456789ab-a");
    });

    it("gives every minted id a name, and a different one each", () => {
      const ids = Array.from({ length: 64 }, (_, i) => minted(i * 7919));
      const names = ids.map(appStackLinkAlias);
      expect(names.every((name) => name !== null)).toBe(true);
      expect(new Set(names).size).toBe(ids.length);
    });

    it("is a DNS label that no component key can equal", () => {
      const name = appStackLinkAlias(DB)!;
      expect(name).toMatch(/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/);
      expect(name.length).toBeGreaterThan(APP_STACK_COMPONENT_KEY_MAX);
      expect(name.length).toBeLessThanOrEqual(63);
      // The longest component key is shorter, so the name never takes the place of a component.
      expect(APP_STACK_KEY_PATTERN.test("a".repeat(APP_STACK_COMPONENT_KEY_MAX))).toBe(true);
    });

    it.each([
      ["a short id", "stk_abc"],
      ["an id of exactly the longest component key", `stk_${"a".repeat(APP_STACK_COMPONENT_KEY_MAX - 4)}`],
      ["an id that ends with an underscore", `stk_${"a".repeat(30)}_`],
      ["an id longer than a DNS label", `s${"a".repeat(63)}`],
      ["an empty id", ""],
      ["an id that is no id", `Stk_${"a".repeat(30)}`],
      ["an id with a dot", `stk_${"a".repeat(30)}.evil`],
    ])("gives no name to %s", (_, id) => {
      expect(appStackLinkAlias(id)).toBeNull();
    });

    it("the ids it refuses are either too short, too long or not a label", () => {
      expect(APP_STACK_ID_PATTERN.test(`stk_${"a".repeat(30)}_`)).toBe(true);
      expect(appStackLinkAlias(`stk_${"a".repeat(23)}`)).toBeNull();
      expect(appStackLinkAlias(`stk_${"a".repeat(24)}`)).not.toBeNull();
    });
  });

  describe("appStackLinkTarget", () => {
    it("is the only component on its only port", () => {
      expect(appStackLinkTarget([{ key: "db", expose: [5432] }])).toEqual({ componentKey: "db", port: 5432 });
    });

    it.each([
      ["no component", []],
      ["two components", [{ key: "db", expose: [5432] }, { key: "web", expose: [8080] }]],
      ["a component with no port", [{ key: "db", expose: [] }]],
      ["a component with two ports", [{ key: "db", expose: [5432, 5433] }]],
    ])("is nothing for %s", (_, components) => {
      expect(appStackLinkTarget(components)).toBeNull();
    });
  });

  describe("AppStackLinksIpcRequestSchema", () => {
    const base = { stackId: DB, organizationId: ORG, componentKey: "db", consumerStackIds: [minted(2), minted(3)] };

    it("accepts the declared state of one database, the empty one included", () => {
      expect(AppStackLinksIpcRequestSchema.safeParse(base).success).toBe(true);
      expect(AppStackLinksIpcRequestSchema.safeParse({ ...base, consumerStackIds: [] }).success).toBe(true);
    });

    it.each([
      ["a Docker network name", { ...base, networks: ["hp_ingress_net"] }],
      ["an alias chosen by the caller", { ...base, alias: "db" }],
      ["a container name", { ...base, container: "hp_mariadb" }],
      ["the database among its applications", { ...base, consumerStackIds: [DB] }],
      ["the same application twice", { ...base, consumerStackIds: [minted(2), minted(2)] }],
      ["more applications than the cap", { ...base, consumerStackIds: Array.from({ length: 9 }, (_, i) => minted(i + 10)) }],
      ["an application id that is no id", { ...base, consumerStackIds: ["hp-ingress-net"] }],
      ["a path as application id", { ...base, consumerStackIds: ["../x"] }],
      ["a database whose id gives no name", { ...base, stackId: "stk_short" }],
      ["a component key that is no key", { ...base, componentKey: "DB" }],
      ["a component key longer than the longest", { ...base, componentKey: "a".repeat(APP_STACK_COMPONENT_KEY_MAX + 1) }],
      ["no organisation", { stackId: DB, componentKey: "db", consumerStackIds: [] }],
    ])("refuses %s", (_, value) => {
      expect(AppStackLinksIpcRequestSchema.safeParse(value).success).toBe(false);
    });
  });

  describe("AppStackLinksIpcResultSchema", () => {
    const base = { container: true, links: [{ consumerStackId: minted(2), outcome: "connected" }], disconnected: [minted(4)] };

    it("accepts outcomes by application id", () => {
      expect(AppStackLinksIpcResultSchema.safeParse(base).success).toBe(true);
      expect(AppStackLinksIpcResultSchema.safeParse({ container: false, links: [], disconnected: [] }).success).toBe(true);
    });

    it.each([
      ["a Docker network id", { ...base, networkId: "f".repeat(64) }],
      ["a Docker id inside a link", { ...base, links: [{ consumerStackId: minted(2), outcome: "connected", endpointId: "f".repeat(64) }] }],
      ["an address inside a link", { ...base, links: [{ consumerStackId: minted(2), outcome: "connected", ip: "172.18.0.2" }] }],
      ["a network name as a detached application", { ...base, disconnected: ["hp_appnet_x-y"] }],
      ["an unknown outcome", { ...base, links: [{ consumerStackId: minted(2), outcome: "failed" }] }],
    ])("refuses %s", (_, value) => {
      expect(AppStackLinksIpcResultSchema.safeParse(value).success).toBe(false);
    });

    it("carries no key the public finders refuse", () => {
      expect(findUnsafeDockerInputFields(base)).toEqual([]);
      expect(findForbiddenPublicDtoKeys(base)).toEqual([]);
      expect(findPlaintextSecretKeys(base)).toEqual([]);
    });
  });

  describe("customer DTOs", () => {
    const link = {
      id: "slnk_0123456789abcdef01234567",
      state: "active",
      createdAt: "2026-11-23T10:00:00.000Z",
      databaseStackId: DB,
      databaseName: "Dati del negozio",
      databaseKind: "Database MariaDB",
      applicationStackId: minted(2),
      applicationName: "Negozio",
      connection: { host: appStackLinkAlias(DB), port: 3306 },
    };
    const list = { stackId: DB, role: "database", connection: link.connection, links: [link], candidates: [], limit: 8 };

    it("accepts a link and a list", () => {
      expect(AppStackLinkDtoSchema.safeParse(link).success).toBe(true);
      expect(AppStackLinksDtoSchema.safeParse(list).success).toBe(true);
      expect(AppStackLinksDtoSchema.safeParse({ ...list, role: "application", connection: null, limit: 4 }).success).toBe(true);
    });

    it("names no Docker object and no reserved value", () => {
      for (const value of [link, list]) {
        expect(findUnsafeDockerInputFields(value)).toEqual([]);
        expect(findForbiddenPublicDtoKeys(value)).toEqual([]);
        expect(findPlaintextSecretKeys(value)).toEqual([]);
      }
      expect(JSON.stringify(list)).not.toMatch(/hp_app|hp_appnet|sha256|password/i);
    });

    it("the create input is the database to connect and nothing else", () => {
      expect(CreateAppStackLinkInputSchema.safeParse({ databaseStackId: DB }).success).toBe(true);
      for (const value of [{}, { databaseStackId: DB, alias: "db" }, { databaseStackId: DB, port: 3306 }, { databaseStackId: "x y" }]) {
        expect(CreateAppStackLinkInputSchema.safeParse(value).success).toBe(false);
      }
    });
  });
});
