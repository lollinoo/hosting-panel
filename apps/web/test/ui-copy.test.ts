import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";

const src = path.resolve(__dirname, "../src");
const dirs = [
  "app/login",
  "app/account",
  "app/sites",
  "components/auth",
  "components/account",
  "components/customer",
  "components/shared",
].map((d) => path.join(src, d));
const sections = ["login", "account", "shell", "site"] as const;

function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? files(full) : /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

// Comments and imports are code, not copy.
const strip = (t: string) =>
  t
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/^\s*import[^;]*;?$/gm, "");
const sources = () => dirs.flatMap(files).map((f) => strip(fs.readFileSync(f, "utf-8")));
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
    const jargon = /\b(container|docker|revision|drift|allocation|outbox)\b|HCP-SPEC|AC-F|ADR-/i;
    for (const text of copy()) expect(text).not.toMatch(jargon);
  });
});
