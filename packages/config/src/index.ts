export const PLATFORM_SPEC_ID = "HCP-SPEC-002" as const;
export const PHASE_2_SPEC_ID = "HCP-SPEC-003" as const;
export const PLATFORM_PHASE = "phase-1" as const;
export const PLATFORM_PHASES = ["phase-1", "phase-2"] as const;
export const PLATFORM_API_VERSION = "v1" as const;
export const PLATFORM_DEFAULT_LOCALE = "it-IT" as const;

export type PlatformPhase = (typeof PLATFORM_PHASES)[number];
export type PlatformSpecId = typeof PLATFORM_SPEC_ID | typeof PHASE_2_SPEC_ID;

export interface WorkspaceMetadata<
  TSpecId extends PlatformSpecId = PlatformSpecId,
  TPhase extends PlatformPhase = PlatformPhase,
> {
  readonly specId: TSpecId;
  readonly phase: TPhase;
  readonly apiVersion: typeof PLATFORM_API_VERSION;
  readonly defaultLocale: typeof PLATFORM_DEFAULT_LOCALE;
}

export const WORKSPACE_METADATA: WorkspaceMetadata<
  typeof PLATFORM_SPEC_ID,
  typeof PLATFORM_PHASE
> = Object.freeze({
  specId: PLATFORM_SPEC_ID,
  phase: PLATFORM_PHASE,
  apiVersion: PLATFORM_API_VERSION,
  defaultLocale: PLATFORM_DEFAULT_LOCALE,
});

const PHASE_2_WORKSPACE_METADATA: WorkspaceMetadata<
  typeof PHASE_2_SPEC_ID,
  "phase-2"
> = Object.freeze({
  specId: PHASE_2_SPEC_ID,
  phase: "phase-2",
  apiVersion: PLATFORM_API_VERSION,
  defaultLocale: PLATFORM_DEFAULT_LOCALE,
});

export function getWorkspaceMetadata(phase: PlatformPhase = "phase-1"): WorkspaceMetadata {
  if (phase === "phase-2") {
    return PHASE_2_WORKSPACE_METADATA;
  }
  return WORKSPACE_METADATA;
}
