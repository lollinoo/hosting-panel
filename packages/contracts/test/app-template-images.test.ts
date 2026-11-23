import { describe, expect, it } from "vitest";
import {
  APP_IMAGE_ALLOWLIST,
  APP_IMAGE_SCRATCH_PATH_PATTERN,
  APP_IMAGE_SCRATCH_PATHS_MAX,
  appStackImageProblem,
  appStackImageScratchPaths,
  appStackPlanImageProblems,
  findAppImageAllowlistEntry,
  type AppImageAllowlistEntry,
} from "../src/app-templates/images.js";
import { APP_STACK_RUN_AS_USER_PATTERN } from "../src/app-templates/limits.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const ALLOWLIST: readonly AppImageAllowlistEntry[] = [
  { repository: "memcached", runAsUser: null, note: "test row" },
  { repository: "valkey/valkey", runAsUser: "999:1000", note: "test row" },
];

describe("APP_IMAGE_ALLOWLIST", () => {
  it("is frozen, with unique repositories and valid runAsUser values", () => {
    expect(Object.isFrozen(APP_IMAGE_ALLOWLIST)).toBe(true);
    const repositories = APP_IMAGE_ALLOWLIST.map((entry) => entry.repository);
    expect(new Set(repositories).size).toBe(repositories.length);
    for (const entry of APP_IMAGE_ALLOWLIST) {
      expect(Object.isFrozen(entry), entry.repository).toBe(true);
      if (entry.runAsUser !== null) expect(entry.runAsUser).toMatch(APP_STACK_RUN_AS_USER_PATTERN);
      expect(entry.note.length).toBeGreaterThan(0);
    }
  });

  it("is the default list of every lookup", () => {
    expect(findAppImageAllowlistEntry("memcached")).toBe(APP_IMAGE_ALLOWLIST.find((e) => e.repository === "memcached") ?? null);
  });
});

describe("findAppImageAllowlistEntry", () => {
  it("matches the repository exactly", () => {
    expect(findAppImageAllowlistEntry("memcached", ALLOWLIST)).toBe(ALLOWLIST[0]);
    expect(findAppImageAllowlistEntry("docker.io/library/memcached", ALLOWLIST)).toBeNull();
    expect(findAppImageAllowlistEntry("evil/memcached", ALLOWLIST)).toBeNull();
    expect(findAppImageAllowlistEntry("memcached2", ALLOWLIST)).toBeNull();
    expect(findAppImageAllowlistEntry("Memcached", ALLOWLIST)).toBeNull();
  });
});

describe("appStackImageProblem", () => {
  it.each([
    [`memcached@${DIGEST}`, null, null],
    [`valkey/valkey@${DIGEST}`, "999:1000", null],
    [`docker.io/library/memcached@${DIGEST}`, null, "not_allowlisted"],
    [`evil/memcached@${DIGEST}`, null, "not_allowlisted"],
    [`valkey/valkey@${DIGEST}`, null, "user_mismatch"],
    [`memcached@${DIGEST}`, "0", "user_mismatch"],
    ["memcached", null, "not_digest_pinned"],
    ["memcached:1.6", null, "not_digest_pinned"],
    ["memcached:1.6@sha256:abc", null, "not_digest_pinned"],
    [`memcached@sha256:${"A".repeat(64)}`, null, "not_digest_pinned"],
    [`memcached@sha512:${"a".repeat(64)}`, null, "not_digest_pinned"],
    [`@${DIGEST}`, null, "not_digest_pinned"],
    [`mem cached@${DIGEST}`, null, "not_digest_pinned"],
    [`mem\u0000cached@${DIGEST}`, null, "not_digest_pinned"],
    [`a@memcached@${DIGEST}`, null, "not_digest_pinned"],
    [`${"a".repeat(256)}@${DIGEST}`, null, "not_digest_pinned"],
  ] as const)("%s as %s -> %s", (image, user, problem) => {
    expect(appStackImageProblem(image, user, ALLOWLIST)).toBe(problem);
  });

  it("holds exactly the five seed rows by default", () => {
    expect(APP_IMAGE_ALLOWLIST.map(({ repository, runAsUser }) => ({ repository, runAsUser }))).toEqual([
      { repository: "nginxinc/nginx-unprivileged", runAsUser: null },
      { repository: "memcached", runAsUser: null },
      { repository: "valkey/valkey", runAsUser: "999:1000" },
      { repository: "mariadb", runAsUser: "999:999" },
      { repository: "postgres", runAsUser: "999:999" },
    ]);
  });
});

describe("scratch areas", () => {
  it("only the postgres row declares one, and it is the socket directory", () => {
    expect(APP_IMAGE_ALLOWLIST.filter((entry) => entry.scratchPaths !== undefined).map(({ repository, scratchPaths }) => ({ repository, scratchPaths }))).toEqual([
      { repository: "postgres", scratchPaths: ["/run/postgresql"] },
    ]);
  });

  it("every declared area is frozen, bounded and directly under /run", () => {
    for (const entry of APP_IMAGE_ALLOWLIST) {
      const paths = entry.scratchPaths ?? [];
      expect(Object.isFrozen(paths) || paths.length === 0, entry.repository).toBe(true);
      expect(paths.length).toBeLessThanOrEqual(APP_IMAGE_SCRATCH_PATHS_MAX);
      expect(new Set(paths).size).toBe(paths.length);
      for (const path of paths) expect(path).toMatch(APP_IMAGE_SCRATCH_PATH_PATTERN);
    }
  });

  it.each(["/tmp", "/run", "/run/", "/run/secrets", "/run/secrets/x", "/run/a/b", "/var/run/postgresql", "/run/../etc", "/run/Postgresql", "run/postgresql", "/run/a b", `/run/${"a".repeat(33)}`])(
    "%s is not a scratch area",
    (path) => {
      expect(APP_IMAGE_SCRATCH_PATH_PATTERN.test(path)).toBe(false);
    },
  );

  it("accepts a plain directory under /run", () => {
    for (const path of ["/run/postgresql", "/run/secrets-x", "/run/a", "/run/my_dir-2"]) expect(APP_IMAGE_SCRATCH_PATH_PATTERN.test(path)).toBe(true);
  });

  it("reads the areas of a plan image from its row", () => {
    const rows: readonly AppImageAllowlistEntry[] = [...ALLOWLIST, { repository: "postgres", runAsUser: "999:999", note: "test row", scratchPaths: ["/run/postgresql"] }];
    expect(appStackImageScratchPaths(`postgres@${DIGEST}`, rows)).toEqual(["/run/postgresql"]);
    expect(appStackImageScratchPaths(`memcached@${DIGEST}`, rows)).toEqual([]);
    expect(appStackImageScratchPaths(`evil/postgres@${DIGEST}`, rows)).toEqual([]);
    expect(appStackImageScratchPaths(`postgres2@${DIGEST}`, rows)).toEqual([]);
    expect(appStackImageScratchPaths("postgres", rows)).toEqual(["/run/postgresql"]);
    expect(appStackImageScratchPaths(`postgres@${DIGEST}`)).toEqual(["/run/postgresql"]);
    expect(appStackImageScratchPaths(`mariadb@${DIGEST}`)).toEqual([]);
  });
});

describe("appStackPlanImageProblems", () => {
  it("lists the refused components in plan order", () => {
    const plan = {
      components: [
        { key: "web", image: `evil/memcached@${DIGEST}`, runAsUser: null },
        { key: "cache", image: `memcached@${DIGEST}`, runAsUser: null },
        { key: "store", image: `valkey/valkey@${DIGEST}`, runAsUser: null },
        { key: "old", image: "memcached:latest", runAsUser: null },
      ],
    };
    expect(appStackPlanImageProblems(plan, ALLOWLIST)).toEqual([
      { componentKey: "web", problem: "not_allowlisted" },
      { componentKey: "store", problem: "user_mismatch" },
      { componentKey: "old", problem: "not_digest_pinned" },
    ]);
    expect(appStackPlanImageProblems({ components: [plan.components[1]!] }, ALLOWLIST)).toEqual([]);
  });
});
