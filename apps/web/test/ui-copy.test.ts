import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";

const src = path.resolve(__dirname, "../src");
// Task 11 extends this to app/sites, components/customer and the shell/site keys.
const dirs = ["app/login", "app/account", "components/auth"].map((d) => path.join(src, d));
const sections = ["login", "account"] as const;

function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? files(full) : /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

const sources = () => dirs.flatMap(files).map((f) => fs.readFileSync(f, "utf-8"));
const copy = () => [
  ...sources(),
  ...sections.flatMap((s) => [JSON.stringify(en[s]), JSON.stringify(itMsgs[s])]),
];

describe("ui copy", () => {
  it("no persona or dev-login remnants", () => {
    for (const text of sources()) {
      expect(text).not.toMatch(/persona|dev\/auth|fetchServerPersonas/i);
    }
  });

  it("customer surfaces avoid infrastructure jargon", () => {
    const jargon = /container|docker|revision|drift|allocation|outbox|HCP-SPEC|AC-F|ADR-/i;
    for (const text of copy()) expect(text).not.toMatch(jargon);
  });
});
