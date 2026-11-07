import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PHASE_2_SPEC_ID,
  PLATFORM_API_VERSION,
  PLATFORM_DEFAULT_LOCALE,
  PLATFORM_PHASE,
  PLATFORM_PHASES,
  PLATFORM_SPEC_ID,
  WORKSPACE_METADATA,
  getWorkspaceMetadata,
} from "../src/index.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

describe("@hosting-panel/config", () => {
  it("exports canonical HCP-SPEC-002 and HCP-SPEC-003 workspace metadata constants", () => {
    expect(PLATFORM_SPEC_ID).toBe("HCP-SPEC-002");
    expect(PHASE_2_SPEC_ID).toBe("HCP-SPEC-003");
    expect(PLATFORM_PHASE).toBe("phase-1");
    expect(PLATFORM_PHASES).toEqual(["phase-1", "phase-2"]);
    expect(PLATFORM_API_VERSION).toBe("v1");
    expect(PLATFORM_DEFAULT_LOCALE).toBe("it-IT");
    expect(WORKSPACE_METADATA).toEqual({
      specId: "HCP-SPEC-002",
      phase: "phase-1",
      apiVersion: "v1",
      defaultLocale: "it-IT",
    });
    expect(Object.isFrozen(WORKSPACE_METADATA)).toBe(true);
  });

  it("returns phase-appropriate workspace metadata via getWorkspaceMetadata", () => {
    const p1Default = getWorkspaceMetadata();
    expect(p1Default).toEqual(WORKSPACE_METADATA);
    expect(Object.isFrozen(p1Default)).toBe(true);

    const p1Explicit = getWorkspaceMetadata("phase-1");
    expect(p1Explicit).toEqual({
      specId: "HCP-SPEC-002",
      phase: "phase-1",
      apiVersion: "v1",
      defaultLocale: "it-IT",
    });

    const p2 = getWorkspaceMetadata("phase-2");
    expect(p2).toEqual({
      specId: "HCP-SPEC-003",
      phase: "phase-2",
      apiVersion: "v1",
      defaultLocale: "it-IT",
    });
    expect(Object.isFrozen(p2)).toBe(true);
  });

  it("exposes tsconfig.base.json extending the strict root TypeScript configuration", () => {
    const pkgTsconfigPath = resolve(currentDir, "../tsconfig.base.json");
    const rootTsconfigPath = resolve(currentDir, "../../../tsconfig.base.json");

    const pkgTsconfig = JSON.parse(readFileSync(pkgTsconfigPath, "utf8")) as {
      extends?: string;
    };
    const rootTsconfig = JSON.parse(readFileSync(rootTsconfigPath, "utf8")) as {
      compilerOptions?: Record<string, unknown>;
    };

    expect(pkgTsconfig.extends).toBe("../../tsconfig.base.json");
    expect(rootTsconfig.compilerOptions).toMatchObject({
      target: "ES2023",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: false,
      declaration: true,
      sourceMap: true,
      skipLibCheck: true,
      esModuleInterop: true,
      isolatedModules: true,
    });
  });
});
