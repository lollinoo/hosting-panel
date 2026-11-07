export const PLATFORM_SPEC_ID = "HCP-SPEC-001" as const;
export const PLATFORM_API_VERSION = "v1" as const;
export const PLATFORM_DEFAULT_LOCALE = "it-IT" as const;

export interface WorkspaceMetadata {
  readonly specId: typeof PLATFORM_SPEC_ID;
  readonly apiVersion: typeof PLATFORM_API_VERSION;
  readonly defaultLocale: typeof PLATFORM_DEFAULT_LOCALE;
}

export const WORKSPACE_METADATA: WorkspaceMetadata = Object.freeze({
  specId: PLATFORM_SPEC_ID,
  apiVersion: PLATFORM_API_VERSION,
  defaultLocale: PLATFORM_DEFAULT_LOCALE,
});
