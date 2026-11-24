/**
 * #98: the executor refuses an image that declares a folder (Config.Volumes) no volume of a component using it covers.
 * No built-in template may trip that refusal, or it could never be deployed. The folders below are what the pinned
 * digests of the built-in templates declare, as read with `docker image inspect` on 2026-11-24 (issue #98); this test
 * does not read them from a registry, it takes them as given. A new image in a built-in template has no row here, so
 * the test stops until someone has looked at what that image declares.
 */
import { APP_BUILT_IN_TEMPLATES, type ApprovedStackPlan } from "@hosting-panel/contracts";
import { appStackUncoveredImageFolder } from "@hosting-panel/docker-executor";
import { compileAppStackPlan } from "@hosting-panel/policy-engine";
import { describe, expect, it } from "vitest";

/** The folders each image declares, by the last segment of its repository. */
const DECLARED: Readonly<Record<string, readonly string[]>> = {
  wordpress: ["/var/www/html"],
  mariadb: ["/var/lib/mysql"],
  postgres: ["/var/lib/postgresql"],
  valkey: [],
  memcached: [],
  "nginx-unprivileged": [],
};
/** The reserved values each seed asks for; the others ask for none. */
const SECRETS: Readonly<Record<string, readonly string[]>> = {
  mariadb: ["admin_password", "database_password"],
  postgresql: ["database_password"],
  "wordpress-mariadb": ["db_password", "db_root_password"],
};

const repositoryOf = (image: string): string => (image.split("@")[0] ?? "").split("/").at(-1) ?? "";

/** Every version a built-in template ever shipped, each compiled with its defaults. */
const PLANS = APP_BUILT_IN_TEMPLATES.flatMap((t) =>
  [...(t.previousVersions ?? []), { versionId: t.versionId, source: t.source }].map((version) => {
    const result = compileAppStackPlan({
      source: version.source,
      parameters: [],
      secretVersions: new Map((SECRETS[t.slug] ?? []).map((key) => [key, 1])),
      ids: {
        stackId: "stk_0123456789abcdef0123456789abcdef",
        organizationId: "org_acme",
        hostAllocationId: "alloc_0123456789abcdef0123456789abcdef",
        templateVersionId: version.versionId,
        revisionId: "srev_0123456789abcdef0123456789abcdef",
      },
    });
    if (!result.ok) throw new Error(`${version.versionId} does not compile: ${JSON.stringify(result.issues)}`);
    return [version.versionId, result.plan] as const;
  }),
);

const imagesOf = (plan: ApprovedStackPlan): string[] => [...new Set(plan.components.map((c) => c.image))];
const declaredBy = (image: string): readonly string[] => {
  const declared = DECLARED[repositoryOf(image)];
  if (declared === undefined) throw new Error(`no declared folders recorded for ${image}`);
  return declared;
};

describe("the built-in templates and the folders their images declare (#98)", () => {
  it("covers every version of every built-in template", () => {
    expect(PLANS.map(([id]) => id)).toEqual(expect.arrayContaining(["atv_wordpress_mariadb_1"]));
    expect(PLANS.length).toBeGreaterThanOrEqual(APP_BUILT_IN_TEMPLATES.length + 1);
  });

  it.each(PLANS)("%s: every image it uses is covered, folder by folder, by the mounts of every component that uses it", (_id, plan) => {
    for (const image of imagesOf(plan)) {
      expect(appStackUncoveredImageFolder(plan, image, declaredBy(image)), image).toBeNull();
    }
  });

  it("the images that declare a folder are WordPress, MariaDB and PostgreSQL, and the rest declare none", () => {
    const images = [...new Set(PLANS.flatMap(([, plan]) => imagesOf(plan)))];
    const withFolders = images.filter((image) => declaredBy(image).length > 0).map(repositoryOf);
    expect([...new Set(withFolders)].sort()).toEqual(["mariadb", "postgres", "wordpress"]);
    expect([...new Set(images.map(repositoryOf))].sort()).toEqual(["memcached", "mariadb", "nginx-unprivileged", "postgres", "valkey", "wordpress"].sort());
  });

  it.each(PLANS)("%s: control, the same plan without any volume is refused for the first folder its images declare", (_id, plan) => {
    // The plan is a union of two formats; the spread keeps whichever one it is, only the mounts go.
    const bare = { ...plan, components: plan.components.map((c) => ({ ...c, volumes: [] })) } as ApprovedStackPlan;
    for (const image of imagesOf(plan)) {
      const declared = declaredBy(image);
      const open = appStackUncoveredImageFolder(bare, image, declared);
      if (declared.length === 0) expect(open, image).toBeNull();
      else expect(open, image).toEqual({ componentKey: expect.any(String), folder: declared[0] });
    }
  });
});
