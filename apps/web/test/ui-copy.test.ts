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
const sections = ["login", "account", "shell", "site", "notFound"] as const;

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
    .replace(/^(\s*)"[a-z]+\.[a-z]+":/gm, "$1") // operation-kind keys are identifiers, not copy
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
    const jargon = /\b(container|docker|image|volume|network|service|template|mariadb|job|organization|revision|drift|allocation|outbox)\b|HCP-SPEC|AC-F|ADR-/i;
    for (const text of copy()) expect(text).not.toMatch(jargon);
  });
});

describe("admin hard-coded Italian is gone", () => {
  const adminDirs = ["app/admin", "components/admin", "components/layout", "components/shared"].map((d) =>
    path.join(src, d),
  );
  const text = /[A-Za-z]/;
  // JSX text nodes (between tags, around {expressions}) and literal accessible-name attributes.
  const jsxText = [/(?<![=/-])>([^<>{}]*)</g, /(?<![=/-])>([^<>{}]*)\{/g, /\}([^<>{}]*)</g];
  // Generics, arrows and statements between braces also sit between > and <; they are code.
  const isCode = (t: string) => /[;]|^\s*[()=,.:?]|\b(?:return|const|case|default|else)\b/.test(t);
  const attrs = /\b(?:title|placeholder|aria-label|alt)="([^"]*)"/g;

  it("keeps copy out of JSX text and title/placeholder/aria-label literals", () => {
    const offenders: string[] = [];
    for (const f of adminDirs.flatMap(files)) {
      const t = strip(fs.readFileSync(f, "utf-8"));
      for (const re of [...jsxText, attrs])
        for (const m of t.matchAll(re)) if (text.test(m[1]!) && !isCode(m[1]!)) offenders.push(`${path.relative(src, f)}: ${m[1]!.trim()}`);
    }
    expect(offenders).toEqual([]);
  });

  it("has an English counterpart for every admin key", () => {
    expect(Object.keys(en.admin).sort()).toEqual(Object.keys(itMsgs.admin).sort());
  });
});
