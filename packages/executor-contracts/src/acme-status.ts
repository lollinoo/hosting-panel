import type { CertProblem } from "@hosting-panel/contracts";

export interface StoredCertificate {
  readonly hostname: string;
  readonly notAfter: string;
  readonly serialNumber: string;
}

export interface AcmeFailure {
  readonly hostname: string;
  readonly at: string;
  readonly kind: "obtain" | "renew";
  readonly problem: CertProblem;
  readonly detail: string;
}

/** What reading one ACME store file yields. */
export interface AcmeStoreRead {
  readable: boolean;
  certificates: StoredCertificate[];
}

export interface CertificateStatusReport {
  readonly acmeEnabled: boolean;
  /** False for the staging or a custom CA: its certificates are not trusted by browsers. */
  readonly trusted: boolean;
  readonly readable: boolean;
  readonly certificates: readonly StoredCertificate[];
  readonly failures: readonly AcmeFailure[];
}
