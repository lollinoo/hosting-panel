import { describe, expect, it } from "vitest";
import {
  WORDPRESS_ITEM_NAME_PATTERN,
  WORDPRESS_JOB_REASONS,
  WORDPRESS_RESET_CLIENT_WAIT_MS,
  WORDPRESS_RESULT_MAX_BYTES,
  WORDPRESS_UPDATE_TARGET_PATTERN,
  WORDPRESS_USER_ID_PATTERN,
  WordpressStateResultSchema,
  WordpressUpdateResultSchema,
  wordpressJobReason,
} from "../src/index.js";

const plugin = (i: number) => ({
  name: `plugin-${String(i)}`,
  title: `Plugin ${String(i)}`,
  status: i % 2 === 0 ? "active" : "inactive",
  version: "1.0.0",
  updateVersion: i % 3 === 0 ? "1.1.0" : null,
});

const state = (over: Record<string, unknown> = {}) => ({
  coreVersion: "7.1.4",
  coreUpdate: null,
  updatesKnown: true,
  plugins: Array.from({ length: 66 }, (_, i) => plugin(i)),
  themes: [{ name: "twentytwentyfive", title: "Twenty Twenty-Five", status: "active", version: "1.5", updateVersion: null }],
  administrators: [{ id: 1, login: "admin" }],
  ...over,
});

describe("WordPress result schemas", () => {
  it("accepts a state with 66 plugins whole", () => {
    const parsed = WordpressStateResultSchema.parse(state());
    expect(parsed.plugins).toHaveLength(66);
    expect(parsed).toEqual(state());
  });

  it("accepts a plugin name with a space (names in a result are free text)", () => {
    expect(WordpressStateResultSchema.safeParse(state({ plugins: [{ ...plugin(1), name: "my plugin" }] })).success).toBe(true);
  });

  it("refuses counts over the bounds, control or bidi characters, unknown statuses and extra keys", () => {
    const bad = [
      state({ plugins: Array.from({ length: 501 }, (_, i) => plugin(i)) }),
      state({ administrators: Array.from({ length: 201 }, (_, i) => ({ id: i + 1, login: `a${String(i)}` })) }),
      state({ plugins: [{ ...plugin(1), name: "evil‮name" }] }),
      state({ plugins: [{ ...plugin(1), name: "evil\u0007name" }] }),
      state({ plugins: [{ ...plugin(1), status: "deleted" }] }),
      state({ themes: [{ name: "t", title: "T", status: "must-use", version: null, updateVersion: null }] }),
      state({ extra: 1 }),
      state({ plugins: [{ ...plugin(1), extra: 1 }] }),
      state({ plugins: [{ ...plugin(1), name: "" }] }),
      state({ plugins: [{ ...plugin(1), version: "1".repeat(41) }] }),
      state({ administrators: [{ id: 0, login: "admin" }] }),
      state({ coreVersion: "" }),
    ];
    for (const value of bad) {
      expect(WordpressStateResultSchema.safeParse(value).success).toBe(false);
    }
  });

  it("checks update results", () => {
    const item = { type: "plugin", name: "classic-editor", oldVersion: "1.6.0", newVersion: "1.7.0", status: "updated" };
    expect(WordpressUpdateResultSchema.safeParse({ items: [item] }).success).toBe(true);
    expect(WordpressUpdateResultSchema.safeParse({ items: [] }).success).toBe(true);
    expect(WordpressUpdateResultSchema.safeParse({ items: Array.from({ length: 702 }, () => item) }).success).toBe(false);
    expect(WordpressUpdateResultSchema.safeParse({ items: [{ ...item, status: "skipped" }] }).success).toBe(false);
    expect(WordpressUpdateResultSchema.safeParse({ items: [{ ...item, type: "language" }] }).success).toBe(false);
    expect(WordpressUpdateResultSchema.safeParse({ items: [], extra: 1 }).success).toBe(false);
  });
});

describe("WordPress patterns and constants", () => {
  it("pins the patterns and numbers", () => {
    expect(WORDPRESS_RESULT_MAX_BYTES).toBe(262_144);
    expect(WORDPRESS_RESET_CLIENT_WAIT_MS).toBe(75_000);
    for (const ok of ["all", "core", "plugin:classic-editor", "theme:twentytwentyfive", "plugin:a.b_c-d"]) {
      expect(WORDPRESS_UPDATE_TARGET_PATTERN.test(ok)).toBe(true);
    }
    for (const bad of ["plugin:-x", "plugin:a b", "core;id", "plugin:", "plugin:../x", "plugin:.x", "ALL", `plugin:${"a".repeat(101)}`]) {
      expect(WORDPRESS_UPDATE_TARGET_PATTERN.test(bad)).toBe(false);
    }
    expect(WORDPRESS_ITEM_NAME_PATTERN.test("classic-editor")).toBe(true);
    expect(WORDPRESS_ITEM_NAME_PATTERN.test("my plugin")).toBe(false);
    for (const ok of ["1", "42", "9999999999"]) expect(WORDPRESS_USER_ID_PATTERN.test(ok)).toBe(true);
    for (const bad of ["0", "01", "-1", "1 OR 1", "12345678901"]) expect(WORDPRESS_USER_ID_PATTERN.test(bad)).toBe(false);
  });
});

describe("wordpressJobReason", () => {
  it("maps exit codes to the closed list of reasons", () => {
    expect(wordpressJobReason(0, true, true)).toBeNull();
    expect(wordpressJobReason(0, false, true)).toBe("result_unreadable");
    expect(wordpressJobReason(0, false, false)).toBeNull();
    const table: Record<number, string> = {
      21: "not_wordpress",
      22: "broken_configuration",
      23: "database_unreachable",
      30: "wordpress_org_unreachable",
      31: "item_unknown",
      32: "update_failed",
      40: "not_administrator",
      64: "bad_request",
      70: "result_unreadable",
      124: "timed_out",
      137: "timed_out",
    };
    for (const [code, reason] of Object.entries(table)) {
      expect(wordpressJobReason(Number(code), false, true)).toBe(reason);
      expect(WORDPRESS_JOB_REASONS).toContain(reason);
    }
    expect(wordpressJobReason(1, false, true)).toBe("other");
    expect(wordpressJobReason(1, true, false)).toBe("other");
  });
});
