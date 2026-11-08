import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEDICATED_NFTABLES_RULESET_SHA256 =
  "e02539a5ed5ef38253d5a4b824a593cfdefef288cf88696f6cb6a7898369a0fc" as const;

export const PRODUCTION_DEDICATED_NFTABLES_RULESET_PATH =
  "/etc/hosting-panel/nftables-dedicated.conf" as const;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export const REPO_DEDICATED_NFTABLES_RULESET_PATH = resolve(
  MODULE_DIR,
  "../../../infra/linux/nftables-dedicated.conf",
);

const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i;

export class HostPolicyDeniedError extends Error {
  public readonly code = "HOST_POLICY_DENIED" as const;
  public readonly statusCode = 403 as const;

  public constructor(message: string) {
    super(message);
    this.name = "HostPolicyDeniedError";
  }
}

export function resolveDefaultNftablesRulesetPath(): string {
  if (existsSync(PRODUCTION_DEDICATED_NFTABLES_RULESET_PATH)) {
    return PRODUCTION_DEDICATED_NFTABLES_RULESET_PATH;
  }
  return REPO_DEDICATED_NFTABLES_RULESET_PATH;
}

export interface VerifiedStaticRuleset {
  readonly rulesetId: "nftables-dedicated-22-80-443";
  readonly sha256: string;
  readonly byteLength: number;
}

export async function verifyStaticNftablesRuleset(
  rulesetFilePath: string,
  expectedSha256: string = DEDICATED_NFTABLES_RULESET_SHA256,
): Promise<VerifiedStaticRuleset> {
  if (!SHA256_HEX_REGEX.test(expectedSha256)) {
    throw new HostPolicyDeniedError("Pinned nftables ruleset SHA-256 digest is malformed");
  }

  let rulesetBytes: Buffer;
  try {
    rulesetBytes = await readFile(rulesetFilePath);
  } catch {
    throw new HostPolicyDeniedError("Static nftables ruleset file is missing or unreadable");
  }

  const actualSha256 = createHash("sha256").update(rulesetBytes).digest("hex");
  const actualBuf = Buffer.from(actualSha256, "hex");
  const expectedBuf = Buffer.from(expectedSha256.toLowerCase(), "hex");

  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    throw new HostPolicyDeniedError(
      "Static nftables ruleset SHA-256 integrity verification failed",
    );
  }

  return Object.freeze({
    rulesetId: "nftables-dedicated-22-80-443" as const,
    sha256: actualSha256,
    byteLength: rulesetBytes.byteLength,
  });
}
