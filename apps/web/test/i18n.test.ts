import { describe, expect, it } from "vitest";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { errorMessage, format, resolveLocale } from "@/i18n";
import type { SessionData } from "@/lib/session";

function leaves(o: unknown, prefix = ""): [string, unknown][] {
  if (typeof o === "object" && o !== null) {
    return Object.entries(o).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
  }
  return [[prefix, o]];
}

describe("i18n", () => {
  it("it and en have identical key sets", () => {
    expect(leaves(en).map(([k]) => k).sort()).toEqual(leaves(itMsgs).map(([k]) => k).sort());
  });

  it("no empty translations", () => {
    for (const [k, v] of [...leaves(en), ...leaves(itMsgs)]) {
      expect(typeof v === "string" && v.trim().length > 0, k).toBe(true);
    }
  });

  it("format replaces placeholders", () => {
    expect(format("Ciao {name}", { name: "Mario" })).toBe("Ciao Mario");
  });

  it("resolveLocale prefers session, then cookie, then it", () => {
    const s = { user: { locale: "en" } } as SessionData;
    expect(resolveLocale(s, "it")).toBe("en");
    expect(resolveLocale(null, "en")).toBe("en");
    expect(resolveLocale(null, "xx")).toBe("it");
    expect(resolveLocale(null, undefined)).toBe("it");
  });

  it("errorMessage falls back to generic for unknown codes", () => {
    expect(errorMessage(en, "NOPE")).toBe(en.errors.generic);
    expect(errorMessage(en, "ACCOUNT_LOCKED")).toBe(en.errors.ACCOUNT_LOCKED);
  });
});
