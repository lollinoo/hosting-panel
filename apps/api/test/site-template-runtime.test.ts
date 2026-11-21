import {
  BUILT_IN_WORDPRESS_SPEC,
  BUILT_IN_WORDPRESS_TEMPLATE_ID,
  BUILT_IN_WORDPRESS_VERSION_ID,
  SUPPORTED_PHP_VERSIONS,
  resolveWordpressImage,
  type SiteTemplateSpec,
} from "@hosting-panel/contracts";
import {
  archiveSiteTemplate,
  createDatabaseClient,
  createSiteTemplate,
  ensureWordpressTemplate,
  updateSiteTemplate,
  type DatabaseClient,
} from "@hosting-panel/database";
import { validateSiteTemplateSource } from "@hosting-panel/policy-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import {
  assertTemplateUsable,
  expectedTemplateImage,
  loadTemplateForCreate,
  phpVersionParameter,
  resolveCreateParameters,
  storedEntries,
  templateUnavailable,
} from "../src/sites/site-template-runtime.js";
import { customSource } from "./fixtures/site-templates.js";

const checked = validateSiteTemplateSource(customSource(), "wordpress");
if (!checked.ok) throw new Error("the custom fixture must be valid");
const CUSTOM: SiteTemplateSpec = checked.spec;

/** The error a call raises, as the fields the API answers with. */
function refusalOf(call: () => unknown): { code: string; message: string; details: readonly unknown[] } {
  try {
    call();
  } catch (error) {
    if (error instanceof ControlPlaneError) return { code: error.code, message: error.message, details: error.details };
    throw error;
  }
  throw new Error("expected a ControlPlaneError");
}

describe("expectedTemplateImage", () => {
  it.each(SUPPORTED_PHP_VERSIONS)("renders the module pin for the built-in template at PHP %s", (php) => {
    expect(expectedTemplateImage(BUILT_IN_WORDPRESS_SPEC, { id: "site_a", phpVersion: php, templateParameters: null })).toBe(resolveWordpressImage(php));
  });

  it("follows php_version for a literal-tag template", () => {
    expect(expectedTemplateImage(CUSTOM, { id: "site_a", phpVersion: "8.5", templateParameters: null })).toBe(resolveWordpressImage("8.5"));
    expect(expectedTemplateImage(CUSTOM, { id: "site_a", phpVersion: "8.4", templateParameters: [{ key: "upload_limit", value: "64M" }] })).toBe(
      resolveWordpressImage("8.4"),
    );
  });

  it("falls back to the template default when the stored PHP version is not an option", () => {
    expect(expectedTemplateImage(CUSTOM, { id: "site_a", phpVersion: "8.3", templateParameters: null })).toBe(resolveWordpressImage("8.4"));
  });

  it("answers null when the spec cannot be rendered", () => {
    const corrupt = { ...CUSTOM, service: { ...CUSTOM.service, image: "wordpress:${nope}" } };
    expect(expectedTemplateImage(corrupt, { id: "site_a", phpVersion: "8.4", templateParameters: null })).toBeNull();
    expect(expectedTemplateImage({} as SiteTemplateSpec, { id: "site_a", phpVersion: "8.4", templateParameters: null })).toBeNull();
  });
});

describe("storedEntries", () => {
  const stored = [
    { key: "upload_limit", value: "64M" },
    { key: "admin_note", value: "hello" },
    { key: "php_version", value: "8.5" },
    { key: "gone", value: true },
  ];

  it("returns the wire entries without php_version", () => {
    expect(storedEntries({ templateParameters: stored })).toEqual([
      { key: "upload_limit", value: "64M" },
      { key: "admin_note", value: "hello" },
      { key: "gone", value: true },
    ]);
  });

  it("keeps only the keys the spec declares", () => {
    expect(storedEntries({ templateParameters: stored }, CUSTOM)).toEqual([
      { key: "upload_limit", value: "64M" },
      { key: "admin_note", value: "hello" },
    ]);
  });

  it("is empty for null and for a shape it does not know", () => {
    expect(storedEntries({ templateParameters: null })).toEqual([]);
    expect(storedEntries({ templateParameters: { upload_limit: "64M" } })).toEqual([]);
    expect(storedEntries({ templateParameters: [null, 3, { key: 1, value: "x" }, { key: "a", value: { x: 1 } }, { key: "b" }] })).toEqual([]);
  });
});

describe("resolveCreateParameters", () => {
  it("returns every declared parameter, defaults included", () => {
    expect(resolveCreateParameters(CUSTOM, [{ key: "upload_limit", value: "64M" }], "customer", "8.5")).toEqual({
      php_version: "8.5",
      upload_limit: "64M",
      admin_note: "x",
    });
    expect(resolveCreateParameters(BUILT_IN_WORDPRESS_SPEC, [], "customer", undefined)).toEqual({ php_version: "8.4" });
  });

  it("lets only an administrator set an admin-only parameter", () => {
    expect(resolveCreateParameters(CUSTOM, [{ key: "admin_note", value: "hi" }], "admin", undefined)["admin_note"]).toBe("hi");
    expect(refusalOf(() => resolveCreateParameters(CUSTOM, [{ key: "admin_note", value: "hi" }], "customer", undefined)).details).toEqual([
      { field: "parameters.admin_note", message: expect.any(String), reason: "not_customer" },
    ]);
  });

  it("answers a 400 naming every problem with its field and reason", () => {
    const refusal = refusalOf(() =>
      resolveCreateParameters(
        CUSTOM,
        [
          { key: "upload_limit", value: "1G" },
          { key: "nope", value: 1 },
          { key: "php_version", value: "8.5" },
        ],
        "customer",
        "8.3",
      ),
    );
    expect(refusal.code).toBe("VALIDATION_ERROR");
    expect(refusal.details).toEqual([
      { field: "parameters.upload_limit", message: expect.any(String), reason: "not_in_options" },
      { field: "parameters.nope", message: expect.any(String), reason: "unknown" },
      { field: "parameters.php_version", message: expect.any(String), reason: "reserved" },
      { field: "phpVersion", message: expect.any(String), reason: "not_in_options" },
    ]);
  });
});

describe("assertTemplateUsable", () => {
  it("accepts a source the validator accepts", () => {
    expect(() => assertTemplateUsable({ version: { source: customSource() }, module: "wordpress" })).not.toThrow();
  });

  it("stops a stored source the validator now refuses with 409 template_invalid", () => {
    const refusal = refusalOf(() =>
      assertTemplateUsable({ version: { source: customSource().replace("    volumes:", "    privileged: true\n    volumes:") }, module: "wordpress" }),
    );
    expect(refusal.code).toBe("RESOURCE_LOCKED");
    expect(refusal.details).toEqual([{ message: expect.any(String), reason: "template_invalid" }]);
  });
});

describe("phpVersionParameter and templateUnavailable", () => {
  it("finds the PHP parameter, or nothing", () => {
    expect(phpVersionParameter(CUSTOM)?.options).toEqual(["8.4", "8.5"]);
    expect(phpVersionParameter({ ...CUSTOM, parameters: [] })).toBeUndefined();
  });

  it("is one 404 whatever the reason", () => {
    const error = templateUnavailable();
    expect(error.code).toBe("NOT_FOUND");
    expect(error.details).toEqual([{ field: "templateId", message: expect.any(String), reason: "template_unavailable" }]);
  });
});

describe("loadTemplateForCreate", () => {
  let dbClient: DatabaseClient;
  let customId: string;

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await ensureWordpressTemplate(dbClient.db);
    const created = await createSiteTemplate(dbClient.db, { module: "wordpress", name: "Custom", source: customSource(), spec: CUSTOM, createdBy: null });
    customId = created.template.id;
  });
  afterEach(async () => {
    await dbClient.close();
  });

  const failure = async (call: Promise<unknown>) => {
    const error = await call.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ControlPlaneError);
    return error as ControlPlaneError;
  };

  it("takes the built-in when no id is given, for both audiences", async () => {
    for (const audience of ["customer", "admin"] as const) {
      const loaded = await loadTemplateForCreate(dbClient.db, undefined, audience);
      expect(loaded.template.id).toBe(BUILT_IN_WORDPRESS_TEMPLATE_ID);
      expect(loaded.version.id).toBe(BUILT_IN_WORDPRESS_VERSION_ID);
      expect(loaded.module).toBe("wordpress");
      expect(loaded.spec).toEqual(BUILT_IN_WORDPRESS_SPEC);
    }
  });

  it("refuses a disabled template to a customer but lets an administrator try it", async () => {
    expect((await failure(loadTemplateForCreate(dbClient.db, customId, "customer"))).details[0]?.reason).toBe("template_unavailable");
    expect((await loadTemplateForCreate(dbClient.db, customId, "admin")).spec).toEqual(CUSTOM);
    await updateSiteTemplate(dbClient.db, customId, { enabled: true });
    expect((await loadTemplateForCreate(dbClient.db, customId, "customer")).template.id).toBe(customId);
  });

  it("refuses an archived or unknown template to both audiences with the same answer", async () => {
    await archiveSiteTemplate(dbClient.db, customId);
    for (const audience of ["customer", "admin"] as const) {
      for (const id of [customId, "stpl_unknown"]) {
        const error = await failure(loadTemplateForCreate(dbClient.db, id, audience));
        expect(error.code).toBe("NOT_FOUND");
        expect(error.details).toEqual(templateUnavailable().details);
      }
    }
  });

  it("never bypasses the disabling of the built-in, even for an administrator", async () => {
    await updateSiteTemplate(dbClient.db, BUILT_IN_WORDPRESS_TEMPLATE_ID, { enabled: false });
    for (const audience of ["customer", "admin"] as const) {
      expect((await failure(loadTemplateForCreate(dbClient.db, undefined, audience))).details[0]?.reason).toBe("template_unavailable");
    }
    expect((await loadTemplateForCreate(dbClient.db, BUILT_IN_WORDPRESS_TEMPLATE_ID, "admin")).template.id).toBe(BUILT_IN_WORDPRESS_TEMPLATE_ID);
  });
});
