import { describe, expect, it } from "vitest";
import { APP_BUILT_IN_TEMPLATES } from "../src/app-templates/built-in.js";
import { APP_IMAGE_ALLOWLIST, appStackPlanImageProblems, findAppImageAllowlistEntry } from "../src/app-templates/images.js";
import { APP_DATABASE_TEMPLATE_CATEGORY } from "../src/app-templates/stack-links.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE_LINE = /^ {4}image: ([^:@\s]+)[:@]/gm;
/** The user the compile step writes for a component: the row's, else the image's own (policy-engine app-template-compile.ts). */
const compiledUser = (repository: string) => findAppImageAllowlistEntry(repository)?.runAsUser ?? null;
/** The check the executor runs on every plan it receives (docker-executor plan-check.ts), with the default rows. */
const executorProblems = (schemaVersion: 1 | 2, repository: string, runAsUser: string | null) =>
  appStackPlanImageProblems({ schemaVersion, components: [{ key: "db", image: `${repository}@${DIGEST}`, runAsUser }] });

// The WordPress template of release 0.10.0 (HCP-STACK/v2) names `mariadb` short and runs its database with the image's
// own user, and the plans of the applications installed from it store that user. A row for `mariadb` or `postgres`
// written short would force a user on such a component and refuse those stored plans, so the database templates of
// ADR-0039 write their images in full and their rows are matched exactly as written: never normalise a repository.
describe("allowlist rows of the database images (ADR-0039)", () => {
  it.each(["mariadb", "postgres"])("%s written short has no row; only the full name does", (short) => {
    expect(findAppImageAllowlistEntry(short)).toBeNull();
    expect(findAppImageAllowlistEntry(`docker.io/library/${short}`)).toMatchObject({ runAsUser: "999:999" });
    for (const other of [`library/${short}`, `docker.io/${short}`, `index.docker.io/library/${short}`, `Docker.io/library/${short}`, `docker.io/library/${short}/`]) {
      expect(findAppImageAllowlistEntry(other), other).toBeNull();
    }
  });

  it("no row is written short for an official image a database template uses", () => {
    expect(APP_IMAGE_ALLOWLIST.map((entry) => entry.repository).filter((repository) => ["mariadb", "postgres", "library/mariadb", "library/postgres"].includes(repository))).toEqual([]);
  });

  it("the database templates name the images of their rows in full, and the WordPress template keeps mariadb short", () => {
    const repositories = (slug: string) => [...APP_BUILT_IN_TEMPLATES.find((t) => t.slug === slug)!.source.matchAll(IMAGE_LINE)].map((m) => m[1]);
    expect(APP_BUILT_IN_TEMPLATES.filter((t) => t.category === APP_DATABASE_TEMPLATE_CATEGORY).flatMap((t) => repositories(t.slug))).toEqual([
      "docker.io/library/mariadb",
      "docker.io/library/postgres",
      "valkey/valkey",
    ]);
    expect(repositories("wordpress-mariadb")).toEqual(["wordpress", "mariadb"]);
  });

  it.each([
    ["mariadb", null],
    ["postgres", null],
    ["docker.io/library/mariadb", "999:999"],
    ["docker.io/library/postgres", "999:999"],
  ] as const)("%s: the executor accepts exactly the user the compile step gives", (repository, user) => {
    expect(compiledUser(repository)).toBe(user);
    // The extended format (any repository): the plan stored by an application of release 0.10.0 or 0.11.0 included.
    expect(executorProblems(2, repository, user)).toEqual([]);
    expect(executorProblems(2, repository, user === null ? "999:999" : null)).toEqual([{ componentKey: "db", problem: "user_mismatch" }]);
    // The first format: only a row allows an image at all.
    expect(executorProblems(1, repository, user)).toEqual(user === null ? [{ componentKey: "db", problem: "not_allowlisted" }] : []);
  });
});
