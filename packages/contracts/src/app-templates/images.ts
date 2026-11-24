export interface AppImageAllowlistEntry {
  /** Exactly the `[registry/]repository` a template source writes, compared with ===: `memcached` and
   *  `docker.io/library/memcached` are two different rows. */
  readonly repository: string;
  /** Config.User the executor sets for this image (APP_STACK_RUN_AS_USER_PATTERN); null = the image's own user. */
  readonly runAsUser: string | null;
  /** Licence and provenance, one line, for the ADR and reviewers (never shown to customers). */
  readonly note: string;
}

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
