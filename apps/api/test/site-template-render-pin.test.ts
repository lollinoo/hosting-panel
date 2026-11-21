// Proves the renderer alone: the built-in WordPress template renders exactly the literal that
// ManagedSitesService.create writes today, which is what the frozen ADR 0029 fixtures hold.
// It only reads spec-hash.json; the end-to-end guard is site-type-pins.test.ts.
import { readFileSync } from "node:fs";
import {
  BUILT_IN_WORDPRESS_SPEC,
  SUPPORTED_PHP_VERSIONS,
  WORDPRESS_SITE_TYPE,
  renderSiteTemplate,
  resolveSiteTemplateParameters,
  resolveWordpressImage,
  toStoredSiteTemplateParameters,
  type SiteTemplateParameterMap,
  type SiteTemplateRenderContext,
} from "@hosting-panel/contracts";
import { buildImmutableStackRevision } from "@hosting-panel/hosting-domain";
import { describe, expect, it } from "vitest";

interface Revision {
  readonly config: Record<string, unknown>;
  readonly resourceLimits: Record<string, unknown>;
  readonly secretRefs: Record<string, string>;
}
interface Fixture {
  readonly afterCreate: { readonly hashOf: Revision; readonly specHash: string };
  readonly atEnd: { readonly hashOf: Revision; readonly specHash: string };
}

const fixture = JSON.parse(readFileSync(new URL("./fixtures/site-type-pins/spec-hash.json", import.meta.url), "utf8")) as Fixture;
const CONTEXT: SiteTemplateRenderContext = { siteId: "site_pin", siteDomain: "wp-a.example.test", siteUrl: "https://wp-a.example.test" };

/** Verbatim copy of the literal in apps/api/src/sites/managed-sites.service.ts (createServiceWithRevisionTransactional). */
function legacyRevision(phpVersion: string) {
  return {
    configuration: {
      image: resolveWordpressImage(phpVersion as (typeof SUPPORTED_PHP_VERSIONS)[number]),
      internalPort: 80,
      exposeHttp: true,
      siteMail: true,
      volumeMounts: [
        {
          volumeSuffix: WORDPRESS_SITE_TYPE.files.volumeSuffix,
          containerPath: WORDPRESS_SITE_TYPE.files.mountPath,
        },
      ],
    },
    resourceLimits: { cpuMilli: 1000, memoryBytes: "536870912" },
    secretRefs: {},
  };
}

const render = (values: SiteTemplateParameterMap) => renderSiteTemplate(BUILT_IN_WORDPRESS_SPEC, values, CONTEXT);

/** Same key order as the stack revision hash. */
function sortedJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`).join(",")}}`;
}

const specHashOf = (rendered: ReturnType<typeof render>) =>
  buildImmutableStackRevision({
    serviceInstanceId: "svc_x",
    organizationId: "org_x",
    currentRevisionNumber: 0,
    declarativeConfig: rendered.configuration,
    secretRefs: rendered.secretRefs,
    resourceLimits: rendered.resourceLimits,
  }).specHash;

describe("built-in WordPress template: byte-identical render", () => {
  it("renders the legacy revision for every supported PHP version", () => {
    for (const php of SUPPORTED_PHP_VERSIONS) {
      const rendered = render({ php_version: php });
      const legacy = legacyRevision(php);
      expect(rendered.configuration, php).toEqual(legacy.configuration);
      expect(rendered.resourceLimits, php).toEqual(legacy.resourceLimits);
      expect(rendered.secretRefs, php).toEqual(legacy.secretRefs);
      expect(sortedJson(rendered.configuration), php).toBe(sortedJson(legacy.configuration));
      expect(sortedJson({ limits: rendered.resourceLimits, refs: rendered.secretRefs }), php).toBe(
        sortedJson({ limits: legacy.resourceLimits, refs: legacy.secretRefs }),
      );
    }
  });

  it("equals the frozen fixture (PHP 8.3)", () => {
    const rendered = render({ php_version: "8.3" });
    for (const stage of [fixture.afterCreate, fixture.atEnd]) {
      expect(rendered.configuration).toEqual(stage.hashOf.config);
      expect(rendered.resourceLimits).toEqual(stage.hashOf.resourceLimits);
      expect(rendered.secretRefs).toEqual(stage.hashOf.secretRefs);
    }
  });

  it("hashes to the frozen spec hash", () => {
    const rendered = render({ php_version: "8.3" });
    expect(fixture.afterCreate.specHash).toMatch(/^[0-9a-f]{64}$/);
    expect(specHashOf(rendered)).toBe(fixture.afterCreate.specHash);
    expect(specHashOf(rendered)).toBe(fixture.atEnd.specHash);
  });

  it("renders the legacy revision for the default parameters", () => {
    const resolved = resolveSiteTemplateParameters(BUILT_IN_WORDPRESS_SPEC, [], { audience: "customer" });
    if (!resolved.ok) throw new Error(JSON.stringify(resolved.issues));
    expect(resolved.values).toEqual({ php_version: "8.4" });
    expect(render(resolved.values)).toEqual({ ...legacyRevision("8.4"), phpVersion: "8.4" });

    const pinned = resolveSiteTemplateParameters(BUILT_IN_WORDPRESS_SPEC, [], { audience: "customer", phpVersion: "8.3" });
    if (!pinned.ok) throw new Error(JSON.stringify(pinned.issues));
    expect(render(pinned.values).configuration).toEqual(fixture.afterCreate.hashOf.config);
    expect(specHashOf(render(pinned.values))).toBe(fixture.afterCreate.specHash);
  });

  it("stores no parameter for a default site", () => {
    const resolved = resolveSiteTemplateParameters(BUILT_IN_WORDPRESS_SPEC, [], { audience: "customer" });
    if (!resolved.ok) throw new Error(JSON.stringify(resolved.issues));
    expect(toStoredSiteTemplateParameters(BUILT_IN_WORDPRESS_SPEC, resolved.values)).toBeNull();
  });
});
