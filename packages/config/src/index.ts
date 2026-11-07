export const PLATFORM_SPEC_ID = "HCP-SPEC-002" as const;
export const PLATFORM_PHASE = "phase-1" as const;
export const PLATFORM_API_VERSION = "v1" as const;
export const PLATFORM_DEFAULT_LOCALE = "it-IT" as const;

export interface WorkspaceMetadata {
  readonly specId: typeof PLATFORM_SPEC_ID;
  readonly phase: typeof PLATFORM_PHASE;
  readonly apiVersion: typeof PLATFORM_API_VERSION;
  readonly defaultLocale: typeof PLATFORM_DEFAULT_LOCALE;
}

export const WORKSPACE_METADATA: WorkspaceMetadata = Object.freeze({
  specId: PLATFORM_SPEC_ID,
  phase: PLATFORM_PHASE,
  apiVersion: PLATFORM_API_VERSION,
  defaultLocale: PLATFORM_DEFAULT_LOCALE,
});
