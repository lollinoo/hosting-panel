import { Injectable } from "@nestjs/common";
import type { ProviderTokenSet } from "@hosting-panel/coolify-adapter";
import { ControlPlaneError } from "../common/control-plane.error.js";

export const DEFAULT_LAB_VAULT_SECRETS: Readonly<Record<string, string>> = Object.freeze({
  "vault://coolify/acme/read": "101|coolify_acme_read_token_secret_v1",
  "vault://coolify/acme/write": "102|coolify_acme_write_token_secret_v1",
  "vault://coolify/acme/deploy": "103|coolify_acme_deploy_token_secret_v1",
  "vault://coolify/beta/read": "201|coolify_beta_read_token_secret_v1",
  "vault://coolify/beta/write": "202|coolify_beta_write_token_secret_v1",
  "vault://coolify/beta/deploy": "203|coolify_beta_deploy_token_secret_v1",
  "vault://coolify/legacy/read": "301|coolify_legacy_read_token_secret_v1",
  "vault://coolify/legacy/deploy": "303|coolify_legacy_deploy_token_secret_v1",
});

@Injectable()
export class SecretVaultService {
  readonly #secrets = new Map<string, string>();
  readonly #historicalSecrets = new Set<string>();

  public constructor(initialSecrets: Readonly<Record<string, string>> = DEFAULT_LAB_VAULT_SECRETS) {
    for (const [ref, secret] of Object.entries(initialSecrets)) {
      this.setSecret(ref, secret);
    }
  }

  public setSecret(secretRef: string, rawSecret: string): void {
    const normalizedRef = secretRef.trim();
    if (!normalizedRef.startsWith("vault://")) {
      throw new Error(`Invalid secret reference '${normalizedRef}': must start with 'vault://'.`);
    }
    this.#secrets.set(normalizedRef, rawSecret);
    if (rawSecret.trim().length >= 4) {
      this.#historicalSecrets.add(rawSecret.trim());
    }
  }

  public deleteSecret(secretRef: string): void {
    this.#secrets.delete(secretRef.trim());
  }

  public resolveSecret(secretRef: string): string {
    const normalizedRef = secretRef.trim();
    const resolved = this.#secrets.get(normalizedRef);
    if (typeof resolved !== "string" || resolved.trim().length === 0) {
      throw new ControlPlaneError(
        "COOLIFY_UNAVAILABLE",
        "Required provider credential reference could not be resolved from secret vault.",
      );
    }
    return resolved;
  }

  public resolveOptionalSecret(secretRef: string | null | undefined): string | undefined {
    if (typeof secretRef !== "string" || secretRef.trim().length === 0) {
      return undefined;
    }
    const resolved = this.#secrets.get(secretRef.trim());
    return typeof resolved === "string" && resolved.trim().length > 0 ? resolved : undefined;
  }

  public resolveProviderTokenSet(refs: {
    readonly secretRefRead: string;
    readonly secretRefWrite?: string | null;
    readonly secretRefDeploy?: string | null;
  }): ProviderTokenSet {
    const read = this.resolveSecret(refs.secretRefRead);
    const write = this.resolveOptionalSecret(refs.secretRefWrite);
    const deploy = this.resolveOptionalSecret(refs.secretRefDeploy);

    return {
      read,
      ...(write !== undefined ? { write } : {}),
      ...(deploy !== undefined ? { deploy } : {}),
    };
  }

  public getAllKnownSecrets(): string[] {
    return [...this.#historicalSecrets];
  }
}
