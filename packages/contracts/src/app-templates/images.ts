export interface AppImageAllowlistEntry {
  /** Exactly the `[registry/]repository` a template source writes, compared with ===: `memcached` and
   *  `docker.io/library/memcached` are two different rows. */
  readonly repository: string;
  /** Config.User the executor sets for this image (APP_STACK_RUN_AS_USER_PATTERN); null = the image's own user. */
  readonly runAsUser: string | null;
  /** Licence and provenance, one line, for the ADR and reviewers (never shown to customers). */
  readonly note: string;
  /** In-memory areas the image needs besides /tmp (APP_IMAGE_SCRATCH_PATH_PATTERN, at most APP_IMAGE_SCRATCH_PATHS_MAX).
   *  Declared here only: a template or a customer cannot ask for one (ADR-0039 D3). */
  readonly scratchPaths?: readonly string[];
}

/** A scratch area sits directly under /run and is never the directory of the secret files. */
export const APP_IMAGE_SCRATCH_PATH_PATTERN = /^\/run\/(?!secrets$)[a-z][a-z0-9_-]{0,31}$/;
export const APP_IMAGE_SCRATCH_PATHS_MAX = 2;

/** What the built-in templates need, nothing more; each row needs the owner's confirmation (BLOCKED.md #4). */
export const APP_IMAGE_ALLOWLIST: readonly AppImageAllowlistEntry[] = Object.freeze([
  Object.freeze({
    repository: "nginxinc/nginx-unprivileged",
    runAsUser: null,
    note: "nginx BSD-2-Clause, packaging Apache-2.0; Docker Hub Verified Publisher NGINX Inc.; Alpine base with unmodified GPL-2.0-only busybox/apk-tools; image user 101, port 8080; registry read 2026-11-22",
  }),
  Object.freeze({
    repository: "memcached",
    runAsUser: null,
    note: "BSD-3-Clause, packaging BSD-3-Clause; Docker Official Image; runtime libs libevent BSD-3-Clause, libsasl BSD-4-Clause, gdbm GPL-3.0-or-later (aggregate); Alpine base with unmodified GPL-2.0-only busybox/apk-tools; image user memcache 11211; registry read 2026-11-22",
  }),
  Object.freeze({
    repository: "valkey/valkey",
    runAsUser: "999:1000",
    note: "BSD-3-Clause, packaging BSD-3-Clause; Docker-Sponsored Open Source (publisher valkey); tini MIT, setpriv/libcap-ng GPL-2.0-or-later; Alpine base with unmodified GPL-2.0-only busybox/apk-tools; image default root, forced to 999:1000; registry read 2026-11-22",
  }),
  // The two database images are written in full, never `mariadb` or `postgres` short: the WordPress template of release
  // 0.10.0 names `mariadb` short and runs it as the image's own user, and a short row would refuse its stored plans.
  Object.freeze({
    repository: "docker.io/library/mariadb",
    runAsUser: "999:999",
    note: "MariaDB Server GPL-2.0-only, packaging GPL-2.0 (image label org.opencontainers.image.licenses); Docker Official Image, source github.com/MariaDB/mariadb-docker; Ubuntu noble base; a separate program reached over the network, nothing of it is linked into the panel; image user unset (the entrypoint drops to mysql 999:999), forced here so the entrypoint never runs as root; port 3306; local image read 2026-11-23",
  }),
  Object.freeze({
    repository: "docker.io/library/postgres",
    runAsUser: "999:999",
    note: "PostgreSQL Licence, packaging MIT; Docker Official Image; Debian bookworm base; image user unset (the entrypoint drops to postgres 999:999), forced here so the entrypoint never runs as root; port 5432; needs its socket directory writable, declared as the one scratch area; local image read 2026-11-23",
    scratchPaths: Object.freeze(["/run/postgresql"]),
  }),
]);

/** Plan form of an image: "<name>@sha256:<64 hex>", tag dropped. */
// eslint-disable-next-line no-control-regex
export const APP_STACK_PLAN_IMAGE_PATTERN = /^[^\s@\u0000-\u001f\u007f-\u009f]{1,255}@sha256:[a-f0-9]{64}$/;

export function findAppImageAllowlistEntry(
  repository: string,
  allowlist: readonly AppImageAllowlistEntry[] = APP_IMAGE_ALLOWLIST,
): AppImageAllowlistEntry | null {
  return allowlist.find((entry) => entry.repository === repository) ?? null;
}

/** Scratch areas of a plan image ("<name>@sha256:…"), in the row's order; none when the row declares none or is missing. */
export function appStackImageScratchPaths(
  image: string,
  allowlist: readonly AppImageAllowlistEntry[] = APP_IMAGE_ALLOWLIST,
): readonly string[] {
  const at = image.lastIndexOf("@");
  return findAppImageAllowlistEntry(at < 0 ? image : image.slice(0, at), allowlist)?.scratchPaths ?? [];
}

export type AppStackImageProblem = "not_digest_pinned" | "not_allowlisted" | "user_mismatch";

export function appStackImageProblem(
  image: string,
  runAsUser: string | null,
  allowlist: readonly AppImageAllowlistEntry[] = APP_IMAGE_ALLOWLIST,
): AppStackImageProblem | null {
  if (!APP_STACK_PLAN_IMAGE_PATTERN.test(image)) return "not_digest_pinned";
  const entry = findAppImageAllowlistEntry(image.slice(0, image.lastIndexOf("@")), allowlist);
  if (entry === null) return "not_allowlisted";
  return entry.runAsUser === runAsUser ? null : "user_mismatch";
}

/** `HCP-STACK/v2`: any repository, still digest-pinned. A row of the allowlist keeps forcing its user; a repository
 *  without a row runs as the image's own user (null), so a plan can never name a user of its choice. */
export function appStackFreeImageProblem(
  image: string,
  runAsUser: string | null,
  allowlist: readonly AppImageAllowlistEntry[] = APP_IMAGE_ALLOWLIST,
): AppStackImageProblem | null {
  if (!APP_STACK_PLAN_IMAGE_PATTERN.test(image)) return "not_digest_pinned";
  const entry = findAppImageAllowlistEntry(image.slice(0, image.lastIndexOf("@")), allowlist);
  return (entry?.runAsUser ?? null) === runAsUser ? null : "user_mismatch";
}

/** One entry per refused component, in plan order; the executor refuses a non-empty result before any pull. A version 2
 *  plan follows the free-image rule, every other plan the allowlist.
 *  `plan` is structural (an ApprovedStackPlan is assignable) so this file needs no import of plan.ts. */
export function appStackPlanImageProblems(
  plan: {
    readonly schemaVersion?: number;
    readonly components: readonly { readonly key: string; readonly image: string; readonly runAsUser: string | null }[];
  },
  allowlist: readonly AppImageAllowlistEntry[] = APP_IMAGE_ALLOWLIST,
): Array<{ readonly componentKey: string; readonly problem: AppStackImageProblem }> {
  const problemOf = plan.schemaVersion === 2 ? appStackFreeImageProblem : appStackImageProblem;
  return plan.components.flatMap((component) => {
    const problem = problemOf(component.image, component.runAsUser, allowlist);
    return problem === null ? [] : [{ componentKey: component.key, problem }];
  });
}

/** What the importer asks the executor to resolve: "[registry/]repository[:tag]", no digest, no credentials, no
 *  scheme. Lowercase repository as registries require; the tag is optional ("latest" is what a registry assumes). */
export const APP_STACK_IMAGE_LOOKUP_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:[._-]+[a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?$/;
export const APP_STACK_IMAGE_LOOKUP_MAX_LENGTH = 255;

export function appStackImageLookupProblem(image: string): "invalid" | null {
  return image.length >= 1 && image.length <= APP_STACK_IMAGE_LOOKUP_MAX_LENGTH && APP_STACK_IMAGE_LOOKUP_PATTERN.test(image) ? null : "invalid";
}
