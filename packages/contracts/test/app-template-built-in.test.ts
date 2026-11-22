import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";
import { APP_BUILT_IN_TEMPLATES } from "../src/app-templates/built-in.js";
import { APP_IMAGE_ALLOWLIST } from "../src/app-templates/images.js";
import { APP_STACK_ID_PATTERN, APP_TEMPLATE_CATEGORY_PATTERN, APP_TEMPLATE_LIMITS } from "../src/app-templates/limits.js";
import { appStackTextProblem } from "../src/app-templates/text.js";

const CUSTOMER_WORDING = /container|image|volume|service|network|template|immagin|volum|servizi|\brete\b|\breti\b/i;
const IMAGE_LINE = /^ {4}image: (.+)$/gm;
const PINNED_IMAGE = /^([^:@\s]+):[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$/;
const seedImages = APP_BUILT_IN_TEMPLATES.flatMap((t) => [...t.source.matchAll(IMAGE_LINE)].map((m) => m[1]!));

describe("APP_BUILT_IN_TEMPLATES", () => {
  it("holds the two seeds with their fixed ids, frozen", () => {
    expect(Object.isFrozen(APP_BUILT_IN_TEMPLATES)).toBe(true);
    for (const t of APP_BUILT_IN_TEMPLATES) expect(Object.isFrozen(t), t.slug).toBe(true);
    expect(APP_BUILT_IN_TEMPLATES.map(({ templateId, versionId, slug, category, name }) => ({ templateId, versionId, slug, category, name }))).toEqual([
      { templateId: "atpl_http_cache", versionId: "atv_http_cache_1", slug: "http-cache", category: "web", name: "Sito HTTP con cache" },
      {
        templateId: "atpl_worker_storage",
        versionId: "atv_worker_storage_1",
        slug: "worker-storage",
        category: "jobs",
        name: "Lavoro periodico con archivio",
      },
    ]);
  });

  it.each(APP_BUILT_IN_TEMPLATES.map((t) => [t.slug, t] as const))("%s: ids, slug and category fit every pattern", (_, t) => {
    expect(t.templateId).toMatch(APP_STACK_ID_PATTERN);
    expect(t.versionId).toMatch(APP_STACK_ID_PATTERN);
    expect(t.slug).toMatch(/^[a-z][a-z0-9-]{1,47}$/);
    expect(t.category).toMatch(APP_TEMPLATE_CATEGORY_PATTERN);
    expect(t.category).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
  });

  it.each(APP_BUILT_IN_TEMPLATES.map((t) => [t.slug, t] as const))("%s: texts are bounded, clean and in customer wording", (_, t) => {
    expect(t.name.length).toBeLessThanOrEqual(APP_TEMPLATE_LIMITS.stackName);
    expect(t.description.length).toBeLessThanOrEqual(APP_TEMPLATE_LIMITS.stackDescription);
    expect(t.descriptionEn.length).toBeLessThanOrEqual(APP_TEMPLATE_LIMITS.stackDescription);
    for (const text of [t.name, t.description, t.descriptionEn]) {
      expect(text.length).toBeGreaterThan(0);
      expect(appStackTextProblem(text), text).toBeNull();
      expect(text).not.toMatch(CUSTOMER_WORDING);
    }
  });

  it.each(APP_BUILT_IN_TEMPLATES.map((t) => [t.slug, t] as const))("%s: source is bounded LF text that repeats the metadata", (_, t) => {
    expect(new TextEncoder().encode(t.source).length).toBeLessThanOrEqual(APP_TEMPLATE_LIMITS.sourceBytes);
    expect(t.source).not.toContain("\r");
    expect(t.source.endsWith("\n")).toBe(true);
    for (const word of ["secret", "build", "x-hp-ports", "latest"]) expect(t.source).not.toContain(word);
    expect(t.source.startsWith("x-hp-stack:\n  schemaVersion: 1\n")).toBe(true);
    expect(t.source).toContain(`\n  name: "${t.name}"\n  category: ${t.category}\n  description: "${t.description}"\n`);
  });

  it("pins every image by digest to an allowlist row, and uses every row", () => {
    expect(seedImages).toHaveLength(4);
    const repositories = seedImages.map((image) => PINNED_IMAGE.exec(image)?.[1]);
    expect(new Set(repositories)).toEqual(new Set(APP_IMAGE_ALLOWLIST.map((entry) => entry.repository)));
  });

  it("exports no *_IMAGE constant carrying a seed image", () => {
    const imageExports = Object.entries(contracts).filter(([name]) => name.endsWith("_IMAGE"));
    expect(imageExports.length).toBeGreaterThan(0);
    for (const [name, value] of imageExports) {
      for (const image of seedImages) expect(String(value), name).not.toContain(image.slice(image.indexOf("@")));
    }
  });
});
