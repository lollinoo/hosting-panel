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

export interface CertificateStatusReport {
  readable: boolean;
  certificates: StoredCertificate[];
}
