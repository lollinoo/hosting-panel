import {
  APP_IMAGE_ALLOWLIST,
  ApprovedStackPlanSchema,
  appStackPlanImageProblems,
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

/** For start/restart: the files of ONE component (parameterKey -> content). */
export function assertAppStackSecretContents(
  plan: ApprovedStackPlan,
  componentKey: string,
  entries: readonly AppStackSecretFileContent[],
): Readonly<Record<string, string>> {
  const pinned = new Set(plan.components.flatMap((c) => c.secretFiles.map((s) => `${s.parameterKey}:${s.version}`)));
  if (entries.some((entry) => !pinned.has(`${entry.parameterKey}:${entry.version}`))) {
    throw new AppStackExecutorError("STACK_PLAN_INVALID", "A secret entry is not part of the plan");
  }
  const component = plan.components.find((c) => c.key === componentKey);
  if (component === undefined) {
    throw new AppStackExecutorError("STACK_PLAN_INVALID", `The component ${componentKey} is not part of the plan`);
  }
  const contents: Record<string, string> = {};
  const versions = new Map<string, number>();
  for (const file of component.secretFiles) {
    const [entry, ...more] = entries.filter((e) => e.parameterKey === file.parameterKey && e.version === file.version);
    if (more.length > 0 || (versions.get(file.parameterKey) ?? file.version) !== file.version) {
      throw new AppStackExecutorError("STACK_PLAN_INVALID", `A secret of component ${componentKey} has more than one entry`);
    }
    versions.set(file.parameterKey, file.version);
    if (entry === undefined) {
      throw new AppStackExecutorError("STACK_SECRET_MISSING", `A secret of component ${componentKey} is missing`);
    }
    contents[file.parameterKey] = entry.content;
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
