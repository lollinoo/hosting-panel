import path from "node:path";
import {
  APP_IMAGE_ALLOWLIST,
  ApprovedStackPlanSchema,
  appStackComponentSecretRefs,
  appStackEngineNameProblem,
  appStackPlanEnvironmentSecretRefs,
  appStackPlanImageProblems,
  appStackPlanSecretRefs,
  type AppImageAllowlistEntry,
  type AppStackSecretFileContent,
  type ApprovedStackPlan,
} from "@hosting-panel/contracts";
import { verifyAppStackPlanHash } from "@hosting-panel/hosting-domain";
import { AppStackExecutorError } from "./errors.js";

export interface AppStackPlanCheckOptions {
  readonly allowlist?: readonly AppImageAllowlistEntry[];
}

/** Pure, synchronous, no I/O. Returns the parsed plan or throws AppStackExecutorError. */
export function assertExecutableAppStackPlan(input: unknown, options: AppStackPlanCheckOptions = {}): ApprovedStackPlan {
  const parsed = ApprovedStackPlanSchema.safeParse(input);
  if (!parsed.success) {
    const at = (parsed.error.issues[0]?.path ?? []).map(String).join(".").slice(0, 128);
    throw new AppStackExecutorError(
      "STACK_PLAN_INVALID",
      at === "" ? "The application plan is invalid" : `The application plan is invalid at ${at}`,
    );
  }
  const plan = parsed.data;
  const unnamed = plan.components.findIndex((c) => appStackEngineNameProblem(plan.stackId, c.key) !== null);
  if (unnamed !== -1) {
    throw new AppStackExecutorError("STACK_PLAN_INVALID", `The application plan is invalid at components.${unnamed}.key`);
  }
  const [refused] = appStackPlanImageProblems(plan, options.allowlist ?? APP_IMAGE_ALLOWLIST);
  if (refused !== undefined) {
    throw new AppStackExecutorError(
      "STACK_IMAGE_NOT_ALLOWED",
      `The image of component ${refused.componentKey} is not allowed (${refused.problem})`,
    );
  }
  if (!verifyAppStackPlanHash(plan)) {
    throw new AppStackExecutorError("STACK_PLAN_HASH_MISMATCH", "The application plan does not match its hash");
  }
  return plan;
}

const refId = (ref: { readonly parameterKey: string; readonly version: number }) => `${ref.parameterKey}:${String(ref.version)}`;

/** For start/restart: the secrets of ONE component (parameterKey -> content), the ones delivered as files and, in a
 *  version 2 plan, the ones in its environment. */
export function assertAppStackSecretContents(
  plan: ApprovedStackPlan,
  componentKey: string,
  entries: readonly AppStackSecretFileContent[],
): Readonly<Record<string, string>> {
  const pinned = new Set(appStackPlanSecretRefs(plan).map(refId));
  if (entries.some((entry) => !pinned.has(refId(entry)))) {
    throw new AppStackExecutorError("STACK_PLAN_INVALID", "A secret entry is not part of the plan");
  }
  const component = plan.components.find((c) => c.key === componentKey);
  if (component === undefined) {
    throw new AppStackExecutorError("STACK_PLAN_INVALID", `The component ${componentKey} is not part of the plan`);
  }
  const contents: Record<string, string> = {};
  const versions = new Map<string, number>();
  for (const ref of appStackComponentSecretRefs(component)) {
    const [entry, ...more] = entries.filter((e) => e.parameterKey === ref.parameterKey && e.version === ref.version);
    if (more.length > 0 || (versions.get(ref.parameterKey) ?? ref.version) !== ref.version) {
      throw new AppStackExecutorError("STACK_PLAN_INVALID", `A secret of component ${componentKey} has more than one entry`);
    }
    versions.set(ref.parameterKey, ref.version);
    if (entry === undefined) {
      throw new AppStackExecutorError("STACK_SECRET_MISSING", `A secret of component ${componentKey} is missing`);
    }
    contents[ref.parameterKey] = entry.content;
  }
  return contents;
}

/** For create: the environment secrets of the WHOLE plan (parameterKey -> content). A version 1 plan, and a version 2
 *  plan without environment secrets, takes no entry at all. Run before anything is removed or created. */
export function assertAppStackCreateSecretContents(
  plan: ApprovedStackPlan,
  entries: readonly AppStackSecretFileContent[] | undefined,
): Readonly<Record<string, string>> {
  const refs = appStackPlanEnvironmentSecretRefs(plan);
  const wanted = new Set(refs.map(refId));
  const given = entries ?? [];
  if (given.some((entry) => !wanted.has(refId(entry)))) {
    throw new AppStackExecutorError("STACK_PLAN_INVALID", "A secret entry is not part of the plan");
  }
  const contents: Record<string, string> = {};
  for (const ref of refs) {
    const [entry, ...more] = given.filter((e) => e.parameterKey === ref.parameterKey);
    if (more.length > 0 || Object.hasOwn(contents, ref.parameterKey)) {
      throw new AppStackExecutorError("STACK_PLAN_INVALID", "A secret of the application has more than one entry");
    }
    if (entry === undefined) {
      throw new AppStackExecutorError("STACK_SECRET_MISSING", "A secret of the application is missing");
    }
    contents[ref.parameterKey] = entry.content;
  }
  return contents;
}

const familiar = (name: string) => name.replace(/^docker\.io\//, "").replace(/^library\//, "");

function nameAndDigest(reference: string): readonly [string, string] | null {
  const at = reference.lastIndexOf("@");
  return at > 0 ? [familiar(reference.slice(0, at)), reference.slice(at + 1)] : null;
}

/** RepoDigests check after a pull (E11). */
export function appStackImageDigestMatches(planImage: string, repoDigests: readonly unknown[] | undefined): boolean {
  const wanted = nameAndDigest(planImage);
  return (
    wanted !== null &&
    (repoDigests ?? []).some((entry) => {
      const found = typeof entry === "string" ? nameAndDigest(entry) : null;
      return found !== null && found[0] === wanted[0] && found[1] === wanted[1];
    })
  );
}

/** #98: the first component of the plan that runs `image`, and the first of the folders the image declares
 *  (`Config.Volumes`), that no volume of that component is mounted at exactly. The Engine gives a hidden, unlabelled,
 *  unbounded anonymous volume to a declared folder with no mount at it, so the plan is refused instead. A folder is
 *  cleaned like a path in `holdsAppStackSecretDir` (one trailing slash, repeated slashes and dot segments gone), so
 *  `/data/` and `/data` are one folder. A mount at a parent folder or inside the folder does not cover it. A tmpfs
 *  and a secret file do not count as a mount. The folder is returned cleaned, without its trailing slash. */
export function appStackUncoveredImageFolder(
  plan: ApprovedStackPlan,
  image: string,
  declared: readonly string[],
): { readonly componentKey: string; readonly folder: string } | null {
  const clean = (folder: string) => path.posix.normalize(`${folder}/`);
  for (const component of plan.components) {
    if (component.image !== image) continue;
    const mounted = new Set(component.volumes.map((mount) => clean(mount.containerPath)));
    for (const folder of declared) {
      const seen = clean(folder);
      if (!mounted.has(seen)) return { componentKey: component.key, folder: seen.length > 1 ? seen.slice(0, -1) : seen };
    }
  }
  return null;
}
