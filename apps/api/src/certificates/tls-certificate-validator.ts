import { X509Certificate, createHash, createPrivateKey, type KeyObject } from "node:crypto";
import { isIP, type AddressInfo, type Socket } from "node:net";
import tls from "node:tls";
import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  TLS_MAX_INTERMEDIATES,
  TLS_VALIDITY_MARGIN_MS,
  checkPemShape,
  type CertificateProblemReason,
  type ErrorCode,
  type PemShapeField,
  type PemShapeReason,
  type TlsKeyType,
} from "@hosting-panel/contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";

/**
 * Injection token of the validator's test seam: a clock and the trust anchors of the loopback handshake. Production
 * registers `{}` (real clock, the Mozilla bundle pinned by the Node build); no environment variable or flag widens it.
 */
export const TLS_VALIDATOR_OPTIONS = Symbol.for("hosting-panel.api.tlsValidatorOptions");

export interface TlsValidatorOptions {
  readonly now?: () => Date;
  /** PEM certificates trusted by the handshake instead of `tls.rootCertificates` (tests only). */
  readonly trustAnchors?: readonly string[];
}

export interface TlsCertificateInput {
  readonly leafPem: string;
  readonly chainPem: string;
  readonly privateKeyPem: string;
}

export interface ValidatedTlsMaterial {
  /** The leaf and the intermediates re-encoded from DER; the key re-exported as PKCS#8. */
  readonly leafPem: string;
  readonly chainPem: string;
  readonly privateKeyPem: string;
  readonly subject: string;
  readonly issuer: string;
  /** Upper-case hex. */
  readonly serialNumber: string;
  /** Lower-case hex SHA-256 of the leaf DER. */
  readonly fingerprintSha256: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  /** Lower-case, sorted, de-duplicated. */
  readonly sanDns: readonly string[];
  readonly wildcard: boolean;
  readonly keyType: TlsKeyType;
  readonly keyBits: number;
}

type Field = Extract<PemShapeField, "leafPem" | "chainPem" | "privateKeyPem">;

const MAX_SANS = 64;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const EKU_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const RSA_BITS = { min: 2048, max: 8192 } as const;
const EC_CURVES: Readonly<Record<string, number>> = { prime256v1: 256, secp384r1: 384 };
const DNS_LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const DNS_NAME = new RegExp(`^(${DNS_LABEL}\\.)+${DNS_LABEL}$`);
const DNS_NAME_MAX = 253;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\u0000-\u007f]/;

/** Fixed texts: nothing a parser or the certificate said is ever repeated. */
const MESSAGES: Partial<Record<CertificateProblemReason, string>> = {
  too_large: "The certificate, the chain and the key are too large.",
  nul_byte: "The file contains binary data. Upload PEM text.",
  not_pem: "The text is not valid PEM.",
  format_unsupported: "This file format is not supported. Upload PEM text.",
  encrypted_key: "The private key is encrypted. Upload it without a passphrase.",
  wrong_block_type: "The text holds a PEM block of the wrong type.",
  required: "This field is required.",
  multiple_blocks: "This field must hold exactly one PEM block.",
  too_many_intermediates: `The chain can hold at most ${TLS_MAX_INTERMEDIATES} certificates.`,
  parse_failed: "The certificate cannot be read.",
  key_parse_failed: "The private key cannot be read.",
  key_algorithm: "The key must be RSA (2048 to 8192 bits) or EC (P-256 or P-384).",
  key_mismatch: "The private key does not belong to the certificate.",
  leaf_is_ca: "The certificate is a CA certificate, not a server certificate.",
  eku_not_server_auth: "The certificate is not valid for server authentication.",
  not_yet_valid: "The certificate is not valid yet.",
  expired: "The certificate has expired.",
  expires_within_24h: "The certificate expires in less than 24 hours.",
  no_dns_san: "The certificate has no DNS name in its Subject Alternative Names.",
  too_many_sans: `The certificate has more than ${MAX_SANS} DNS names.`,
  unsupported_wildcard: "Only wildcards such as *.example.com are supported.",
  san_invalid: "The certificate has an invalid DNS name.",
  cn_not_in_san: "The certificate's common name is not one of its DNS names.",
  ip_san_unsupported: "Certificates for IP addresses are not supported.",
  untrusted_or_incomplete: "The certificate chain is incomplete or not issued by a trusted authority.",
  chain_expired: "A certificate of the chain has expired or is not valid yet.",
  bad_signature: "A signature of the chain is invalid.",
  verify_timeout: "The chain check timed out.",
  chain_invalid: "The certificate chain is not valid.",
};

function fail(code: ErrorCode, field: Field, reason: CertificateProblemReason): never {
  const message = MESSAGES[reason] ?? "The certificate is not valid.";
  throw new ControlPlaneError(code, message, { details: [{ field, reason, message }] });
}

const SHAPE_CODES: Readonly<Record<PemShapeReason, ErrorCode>> = {
  required: "CERTIFICATE_INVALID",
  too_large: "CERTIFICATE_UPLOAD_TOO_LARGE",
  nul_byte: "CERTIFICATE_FORMAT_UNSUPPORTED",
  not_pem: "CERTIFICATE_FORMAT_UNSUPPORTED",
  wrong_block_type: "CERTIFICATE_FORMAT_UNSUPPORTED",
  multiple_blocks: "CERTIFICATE_INVALID",
  too_many_intermediates: "CERTIFICATE_INVALID",
  encrypted_key: "CERTIFICATE_FORMAT_UNSUPPORTED",
  format_unsupported: "CERTIFICATE_FORMAT_UNSUPPORTED",
  invalid_name: "CERTIFICATE_INVALID",
};

/** The DER of every `-----BEGIN <label>-----` block of a text that checkPemShape already found clean. */
function pemBlocks(field: Field, text: string): { label: string; der: Buffer }[] {
  if (NON_ASCII.test(text)) fail("CERTIFICATE_FORMAT_UNSUPPORTED", field, "not_pem");
  const blocks: { label: string; der: Buffer }[] = [];
  // checkPemShape guarantees the body holds no "-----"; anything else in it (an RFC 1421 header, a stray dash) is
  // refused below instead of being skipped.
  const pattern = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;
  for (const match of text.matchAll(pattern)) {
    const base64 = match[2]!.replace(/\s+/g, "");
    if (!BASE64.test(base64) || base64.length % 4 !== 0) fail("CERTIFICATE_FORMAT_UNSUPPORTED", field, "not_pem");
    blocks.push({ label: match[1]!, der: Buffer.from(base64, "base64") });
  }
  if (blocks.length === 0 && field !== "chainPem") fail("CERTIFICATE_FORMAT_UNSUPPORTED", field, "not_pem");
  return blocks;
}

function parseCertificate(field: Field, der: Buffer): X509Certificate {
  try {
    return new X509Certificate(der);
  } catch {
    return fail("CERTIFICATE_INVALID", field, "parse_failed");
  }
}

function parsePrivateKey(der: Buffer, label: string): KeyObject {
  const type = label === "PRIVATE KEY" ? "pkcs8" : label === "RSA PRIVATE KEY" ? "pkcs1" : "sec1";
  try {
    return createPrivateKey({ key: der, format: "der", type });
  } catch {
    return fail("CERTIFICATE_INVALID", "privateKeyPem", "key_parse_failed");
  }
}

function keyShape(key: KeyObject): { keyType: TlsKeyType; keyBits: number } {
  const details = key.asymmetricKeyDetails;
  if (key.asymmetricKeyType === "rsa") {
    const bits = details?.modulusLength ?? 0;
    if (bits >= RSA_BITS.min && bits <= RSA_BITS.max) return { keyType: "rsa", keyBits: bits };
  } else if (key.asymmetricKeyType === "ec") {
    const bits = EC_CURVES[details?.namedCurve ?? ""];
    if (bits !== undefined) return { keyType: "ec", keyBits: bits };
  }
  return fail("CERTIFICATE_FORMAT_UNSUPPORTED", "privateKeyPem", "key_algorithm");
}

/** `CN=a\nO=b` → ["a"]; a quoted value is unquoted. Only non-empty common names are returned. */
function commonNames(subject: string): string[] {
  const names: string[] = [];
  for (const line of subject.split("\n")) {
    if (!line.startsWith("CN=")) continue;
    let value = line.slice(3);
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        // an unparsable quoted value cannot be a SAN either: kept as is
      }
    }
    if (value !== "") names.push(value);
  }
  return names;
}

function dnsSans(leaf: X509Certificate): string[] {
  const raw = leaf.subjectAltName ?? "";
  // Node quotes every entry with a special character; no valid host name needs it.
  if (raw.includes('"')) fail("CERTIFICATE_INVALID", "leafPem", "san_invalid");
  const entries = raw === "" ? [] : raw.split(", ");
  if (entries.some((entry) => entry.startsWith("IP Address:"))) {
    fail("CERTIFICATE_INVALID", "leafPem", "ip_san_unsupported");
  }
  const names = entries.filter((entry) => entry.startsWith("DNS:")).map((entry) => entry.slice(4).toLowerCase());
  if (names.length === 0) fail("CERTIFICATE_INVALID", "leafPem", "no_dns_san");
  if (names.length > MAX_SANS) fail("CERTIFICATE_INVALID", "leafPem", "too_many_sans");
  for (const name of names) {
    const wildcard = name.startsWith("*.");
    const base = wildcard ? name.slice(2) : name;
    if (name.includes("*") && (!wildcard || base.includes("*") || !base.includes("."))) {
      fail("CERTIFICATE_INVALID", "leafPem", "unsupported_wildcard");
    }
    if (isIP(base) !== 0) fail("CERTIFICATE_INVALID", "leafPem", "ip_san_unsupported");
    if (name.length > DNS_NAME_MAX || !DNS_NAME.test(base)) fail("CERTIFICATE_INVALID", "leafPem", "san_invalid");
    // OpenSSL's own matcher must agree: the exact name, or one label under the wildcard, and no partial wildcard.
    const probe = wildcard ? `hp-probe.${base}` : name;
    if (leaf.checkHost(probe, { subject: "never", partialWildcards: false }) === undefined) {
      fail("CERTIFICATE_INVALID", "leafPem", "san_invalid");
    }
  }
  return [...new Set(names)].sort();
}

/**
 * The chain must be the path above the leaf: no repeated certificate, not the leaf itself, and every certificate
 * issues the one before it (leaf first). Reasons (all existing): a repeated certificate or the leaf → chain_invalid;
 * an issuer that is not the next certificate (swapped order, unrelated CA) → untrusted_or_incomplete; a matching issuer
 * with a bad signature → bad_signature.
 */
function checkChainPath(leaf: X509Certificate, chain: readonly X509Certificate[]): void {
  const seen = new Set([leaf.fingerprint256]);
  let child = leaf;
  for (const certificate of chain) {
    if (seen.has(certificate.fingerprint256)) fail("CERTIFICATE_CHAIN_INVALID", "chainPem", "chain_invalid");
    seen.add(certificate.fingerprint256);
    if (!child.checkIssued(certificate)) fail("CERTIFICATE_CHAIN_INVALID", "chainPem", "untrusted_or_incomplete");
    if (!child.verify(certificate.publicKey)) fail("CERTIFICATE_CHAIN_INVALID", "chainPem", "bad_signature");
    child = certificate;
  }
}

const flatName = (name: string): string => name.split("\n").join(", ");

const CHAIN_ERRORS: Readonly<Record<string, CertificateProblemReason>> = {
  UNABLE_TO_GET_ISSUER_CERT: "untrusted_or_incomplete",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "untrusted_or_incomplete",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "untrusted_or_incomplete",
  SELF_SIGNED_CERT_IN_CHAIN: "untrusted_or_incomplete",
  DEPTH_ZERO_SELF_SIGNED_CERT: "untrusted_or_incomplete",
  CERT_HAS_EXPIRED: "chain_expired",
  CERT_NOT_YET_VALID: "chain_expired",
  CERT_SIGNATURE_FAILURE: "bad_signature",
};

type Handshake = { ok: true } | { ok: false; error: string };

/**
 * In-process TLS handshake on a loopback socket: the server presents leaf + chain, the client verifies them against
 * the anchors. Host name checks are off (done on the SANs above) and the real clock judges the intermediates.
 */
function handshake(options: {
  key: string;
  cert: string;
  anchors: readonly string[];
  servername: string;
}): Promise<Handshake> {
  return new Promise<Handshake>((resolve) => {
    const sockets = new Set<Socket>();
    let client: tls.TLSSocket | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const ignore = (): void => undefined;
    let server: tls.Server | undefined;
    const finish = (result: Handshake): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client?.destroy();
      for (const socket of sockets) socket.destroy();
      try {
        server?.close();
      } catch {
        // already closed
      }
      resolve(result);
    };
    // Nothing below may throw outside this promise: an exception in a listener callback would end the API process.
    try {
      timer = setTimeout(() => finish({ ok: false, error: "TIMEOUT" }), HANDSHAKE_TIMEOUT_MS);
      server = tls.createServer({ key: options.key, cert: options.cert });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("error", ignore);
      });
      server.on("secureConnection", (socket) => socket.on("error", ignore));
      server.on("tlsClientError", ignore);
      server.on("error", () => finish({ ok: false, error: "SERVER_ERROR" }));
      server.listen(0, "127.0.0.1", () => {
        try {
          client = tls.connect({
            host: "127.0.0.1",
            port: (server?.address() as AddressInfo).port,
            ca: [...options.anchors],
            servername: options.servername,
            rejectUnauthorized: false,
            checkServerIdentity: () => undefined,
          });
          client.on("secureConnect", () => {
            const failure = client?.authorizationError;
            finish(client?.authorized === true ? { ok: true } : { ok: false, error: String(failure ?? "UNKNOWN") });
          });
          client.on("error", () => finish({ ok: false, error: "CONNECT_ERROR" }));
        } catch {
          finish({ ok: false, error: "CONNECT_ERROR" });
        }
      });
    } catch {
      finish({ ok: false, error: "SERVER_ERROR" });
    }
  });
}

@Injectable()
export class TlsCertificateValidator {
  readonly #now: () => Date;
  readonly #anchors: readonly string[];

  public constructor(@Optional() @Inject(TLS_VALIDATOR_OPTIONS) options?: TlsValidatorOptions) {
    this.#now = options?.now ?? (() => new Date());
    this.#anchors = options?.trustAnchors ?? tls.rootCertificates;
  }

  /**
   * Checks an uploaded certificate, its chain and its key, in this order, and throws a ControlPlaneError for the
   * first problem (`details[0] = { field, reason, message }`; fixed texts, never PEM or parser output).
   */
  public async validate(input: TlsCertificateInput): Promise<ValidatedTlsMaterial> {
    const issue = checkPemShape(input)[0];
    if (issue !== undefined) {
      fail(SHAPE_CODES[issue.reason], issue.field as Field, issue.reason);
    }

    const leafBlocks = pemBlocks("leafPem", input.leafPem);
    const chainBlocks = pemBlocks("chainPem", input.chainPem);
    const keyBlock = pemBlocks("privateKeyPem", input.privateKeyPem)[0]!;
    const leaf = parseCertificate("leafPem", leafBlocks[0]!.der);
    const chain = chainBlocks.map((block) => parseCertificate("chainPem", block.der));
    const key = parsePrivateKey(keyBlock.der, keyBlock.label);
    const { keyType, keyBits } = keyShape(key);
    if (!leaf.checkPrivateKey(key)) fail("CERTIFICATE_KEY_MISMATCH", "privateKeyPem", "key_mismatch");

    if (leaf.ca) fail("CERTIFICATE_INVALID", "leafPem", "leaf_is_ca");
    const usages = leaf.keyUsage;
    // serverAuth is required when the extension exists: OpenSSL (the handshake below) refuses anyExtendedKeyUsage alone.
    if (Array.isArray(usages) && usages.length > 0 && !usages.includes(EKU_SERVER_AUTH)) {
      fail("CERTIFICATE_INVALID", "leafPem", "eku_not_server_auth");
    }

    const now = this.#now().getTime();
    const notBefore = leaf.validFromDate;
    const notAfter = leaf.validToDate;
    if (now < notBefore.getTime()) fail("CERTIFICATE_NOT_YET_VALID", "leafPem", "not_yet_valid");
    if (notAfter.getTime() <= now) fail("CERTIFICATE_EXPIRED", "leafPem", "expired");
    if (notAfter.getTime() - now < TLS_VALIDITY_MARGIN_MS) fail("CERTIFICATE_EXPIRED", "leafPem", "expires_within_24h");

    const sanDnsNames = dnsSans(leaf);
    if (commonNames(leaf.subject).some((cn) => !sanDnsNames.includes(cn.toLowerCase()))) {
      fail("CERTIFICATE_INVALID", "leafPem", "cn_not_in_san");
    }

    checkChainPath(leaf, chain);

    const leafPem = leaf.toString();
    const chainPem = chain.map((certificate) => certificate.toString()).join("");
    const privateKeyPem = key.export({ type: "pkcs8", format: "pem" }) as string;
    const first = sanDnsNames[0]!;
    const verdict = await handshake({
      key: privateKeyPem,
      cert: leafPem + chainPem,
      anchors: this.#anchors,
      servername: first.startsWith("*.") ? `hp-probe.${first.slice(2)}` : first,
    });
    if (!verdict.ok) {
      if (verdict.error === "INVALID_PURPOSE") fail("CERTIFICATE_INVALID", "chainPem", "eku_not_server_auth");
      const reason = verdict.error === "TIMEOUT" ? "verify_timeout" : (CHAIN_ERRORS[verdict.error] ?? "chain_invalid");
      fail("CERTIFICATE_CHAIN_INVALID", "chainPem", reason);
    }

    return {
      leafPem,
      chainPem,
      privateKeyPem,
      subject: flatName(leaf.subject),
      issuer: flatName(leaf.issuer),
      serialNumber: leaf.serialNumber.toUpperCase(),
      fingerprintSha256: createHash("sha256").update(leaf.raw).digest("hex"),
      notBefore,
      notAfter,
      sanDns: sanDnsNames,
      wildcard: sanDnsNames.some((name) => name.startsWith("*.")),
      keyType,
      keyBits,
    };
  }
}

/** Certificate checks in flight: a validation costs a loopback handshake, so 2 run at once per server, 1 per organisation. */
export const TLS_VALIDATIONS_MAX = 2;
export const TLS_VALIDATIONS_PER_ORG_MAX = 1;

@Injectable()
export class TlsValidationGate {
  #running = 0;
  readonly #byOrg = new Map<string, number>();

  /** A validation over the cap is refused, never queued. */
  public async run<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
    const org = this.#byOrg.get(organizationId) ?? 0;
    if (this.#running >= TLS_VALIDATIONS_MAX || org >= TLS_VALIDATIONS_PER_ORG_MAX) {
      throw new ControlPlaneError("RATE_LIMITED", "Too many certificate checks right now. Try again in a few seconds.", {
        retryable: true,
        retryAfterMs: 5_000,
      });
    }
    this.#running += 1;
    this.#byOrg.set(organizationId, org + 1);
    try {
      return await work();
    } finally {
      this.#running -= 1;
      const left = (this.#byOrg.get(organizationId) ?? 1) - 1;
      if (left <= 0) this.#byOrg.delete(organizationId);
      else this.#byOrg.set(organizationId, left);
    }
  }
}
