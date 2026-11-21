// Test-only X.509 v3 builder: DER written by hand, signed with node:crypto. Every key is generated when a test runs
// (nothing is committed) and nothing shells out to openssl. Enough of X.509 for the validator tests: CN-only names,
// SAN (DNS + IPv4), basicConstraints, extendedKeyUsage, chosen validity, RSA / EC / ed25519 keys, root → intermediate
// → leaf chains.
import {
  X509Certificate,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import { isIPv4 } from "node:net";

export const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
export const OID_CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";
export const OID_ANY_EKU = "2.5.29.37.0";

export type KeySpec =
  | { readonly type: "rsa"; readonly bits: number }
  | { readonly type: "ec"; readonly curve: "prime256v1" | "secp384r1" | "secp256k1" }
  | { readonly type: "ed25519" };

export interface KeyPair {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

export function generateKey(spec: KeySpec = { type: "ec", curve: "prime256v1" }): KeyPair {
  if (spec.type === "rsa") return generateKeyPairSync("rsa", { modulusLength: spec.bits });
  if (spec.type === "ec") return generateKeyPairSync("ec", { namedCurve: spec.curve });
  return generateKeyPairSync("ed25519");
}

export interface CertSpec {
  /** Subject CN: default = the first DNS name; `null` = empty subject. */
  readonly cn?: string | null;
  readonly dns?: readonly string[];
  /** IPv4 literals. */
  readonly ip?: readonly string[];
  /** Raw SAN GeneralName TLVs, appended after dns/ip (to build names the validator must refuse). */
  readonly rawSans?: readonly Buffer[];
  /** `leaf` (default): basicConstraints CA:FALSE; `ca`: CA:TRUE; `none`: no extension. */
  readonly basicConstraints?: "leaf" | "ca" | "none";
  readonly pathLen?: number;
  /** EKU OIDs (default: serverAuth); `null` = no extension. */
  readonly eku?: readonly string[] | null;
  readonly notBefore?: Date;
  readonly notAfter?: Date;
  readonly serial?: Buffer;
  /** The key of the certificate (default: a fresh EC P-256 key). */
  readonly key?: KeyPair | KeySpec;
  /** The signer (default: self-signed). */
  readonly issuer?: IssuedCert;
}

export interface IssuedCert {
  readonly der: Buffer;
  readonly pem: string;
  readonly key: KeyPair;
  /** PKCS#8 PEM of the private key. */
  readonly keyPem: string;
  readonly subjectDer: Buffer;
  readonly x509: X509Certificate;
}

// -- DER -----------------------------------------------------------------------------------------------------------

const derLength = (n: number): Buffer => {
  if (n < 128) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let value = n; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 255);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
export const derSeq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const derSet = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const derInt = (value: Buffer): Buffer => tlv(0x02, value[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
const derOid = (dotted: string): Buffer => {
  const parts = dotted.split(".").map(Number);
  const out = [40 * parts[0]! + parts[1]!];
  for (const part of parts.slice(2)) {
    const group = [part & 127];
    for (let rest = Math.floor(part / 128); rest > 0; rest = Math.floor(rest / 128)) group.unshift((rest & 127) | 128);
    out.push(...group);
  }
  return tlv(0x06, Buffer.from(out));
};
const derUtf8 = (text: string): Buffer => tlv(0x0c, Buffer.from(text, "utf8"));
const derBool = (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0]));
const derOctets = (body: Buffer): Buffer => tlv(0x04, body);
const derBits = (body: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), body]));
const derExplicit = (n: number, body: Buffer): Buffer => tlv(0xa0 + n, body);
const derTime = (date: Date): Buffer => {
  const iso = date.toISOString(); // 2026-11-21T10:20:30.000Z
  const digits = iso.replace(/[-:T]/g, "").slice(0, 14);
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${digits}Z`));
};
/** A dNSName GeneralName. */
export const sanDns = (name: string): Buffer => tlv(0x82, Buffer.from(name, "latin1"));
/** An iPAddress GeneralName (IPv4). */
export const sanIp = (address: string): Buffer => {
  if (!isIPv4(address)) throw new Error("tls-certgen: IPv4 only");
  return tlv(0x87, Buffer.from(address.split(".").map(Number)));
};
/** An rfc822Name GeneralName (ignored by the validator). */
export const sanEmail = (address: string): Buffer => tlv(0x81, Buffer.from(address, "latin1"));

const extension = (oid: string, value: Buffer, critical = false): Buffer =>
  derSeq(derOid(oid), ...(critical ? [derBool(true)] : []), derOctets(value));

const nameDer = (cn: string | null): Buffer =>
  cn === null ? derSeq() : derSeq(derSet(derSeq(derOid("2.5.4.3"), derUtf8(cn))));

function signatureAlgorithm(key: KeyObject): { identifier: Buffer; digest: string | null } {
  const type = key.asymmetricKeyType;
  if (type === "rsa") return { identifier: derSeq(derOid("1.2.840.113549.1.1.11"), tlv(0x05, Buffer.alloc(0))), digest: "sha256" };
  if (type === "ed25519") return { identifier: derSeq(derOid("1.3.101.112")), digest: null };
  const curve = key.asymmetricKeyDetails?.namedCurve;
  return curve === "secp384r1"
    ? { identifier: derSeq(derOid("1.2.840.10045.4.3.3")), digest: "sha384" }
    : { identifier: derSeq(derOid("1.2.840.10045.4.3.2")), digest: "sha256" };
}

export function toPem(label: string, der: Buffer): string {
  return `-----BEGIN ${label}-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
}

const isKeyPair = (value: KeyPair | KeySpec): value is KeyPair => "privateKey" in value;

/** Validity of a fresh test certificate: from an hour ago to 90 days ahead, relative to the real clock. */
export const defaultValidity = (): { notBefore: Date; notAfter: Date } => {
  const now = Date.now();
  return { notBefore: new Date(now - 3_600_000), notAfter: new Date(now + 90 * 86_400_000) };
};

export function issueCert(spec: CertSpec = {}): IssuedCert {
  const dns = spec.dns ?? [];
  const cn = spec.cn === undefined ? (dns[0] ?? null) : spec.cn;
  const key = spec.key === undefined ? generateKey() : isKeyPair(spec.key) ? spec.key : generateKey(spec.key);
  const validity = defaultValidity();
  const subject = nameDer(cn);
  const signer = spec.issuer?.key.privateKey ?? key.privateKey;
  const issuerName = spec.issuer?.subjectDer ?? subject;
  const algorithm = signatureAlgorithm(signer);

  const names = [...dns.map(sanDns), ...(spec.ip ?? []).map(sanIp), ...(spec.rawSans ?? [])];
  const extensions: Buffer[] = [];
  if (names.length > 0) extensions.push(extension("2.5.29.17", derSeq(...names), cn === null));
  const constraints = spec.basicConstraints ?? "leaf";
  if (constraints === "ca") {
    const pathLen = spec.pathLen === undefined ? [] : [derInt(Buffer.from([spec.pathLen]))];
    extensions.push(extension("2.5.29.19", derSeq(derBool(true), ...pathLen), true));
  } else if (constraints === "leaf") {
    extensions.push(extension("2.5.29.19", derSeq(), true));
  }
  const eku = spec.eku === undefined ? [OID_SERVER_AUTH] : spec.eku;
  if (eku !== null) extensions.push(extension("2.5.29.37", derSeq(...eku.map(derOid))));

  const serial = spec.serial ?? Buffer.concat([Buffer.from([(randomBytes(1)[0]! & 0x3f) | 0x40]), randomBytes(15)]);
  const tbs = derSeq(
    derExplicit(0, derInt(Buffer.from([2]))),
    derInt(serial),
    algorithm.identifier,
    issuerName,
    derSeq(derTime(spec.notBefore ?? validity.notBefore), derTime(spec.notAfter ?? validity.notAfter)),
    subject,
    key.publicKey.export({ type: "spki", format: "der" }),
    derExplicit(3, derSeq(...extensions)),
  );
  const der = derSeq(tbs, algorithm.identifier, derBits(sign(algorithm.digest, tbs, signer)));
  const pem = toPem("CERTIFICATE", der);
  return {
    der,
    pem,
    key,
    keyPem: key.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    subjectDer: subject,
    x509: new X509Certificate(der),
  };
}

export interface Pki {
  readonly root: IssuedCert;
  readonly intermediate: IssuedCert;
  readonly leaf: IssuedCert;
  /** leaf + intermediate, the usual upload. */
  readonly chainPem: string;
}

/** A root → intermediate → leaf chain; `leaf` / `intermediate` / `root` tweak the certificate specs. */
export function issuePki(
  options: {
    readonly leaf?: CertSpec;
    readonly intermediate?: CertSpec;
    readonly root?: CertSpec;
  } = {},
): Pki {
  const root = issueCert({ cn: "Test Root CA", basicConstraints: "ca", eku: null, ...options.root });
  const intermediate = issueCert({
    cn: "Test Intermediate CA",
    basicConstraints: "ca",
    eku: null,
    ...options.intermediate,
    issuer: root,
  });
  const leaf = issueCert({ dns: ["example.com"], ...options.leaf, issuer: intermediate });
  return { root, intermediate, leaf, chainPem: intermediate.pem };
}

/** A stack of `count` intermediates below a root: returns the leaf and the PEM of all intermediates, leaf-side first. */
export function issueLongChain(count: number, dns: readonly string[]): { root: IssuedCert; leaf: IssuedCert; chainPem: string } {
  const root = issueCert({ cn: "Long Root CA", basicConstraints: "ca", eku: null });
  let issuer = root;
  const intermediates: IssuedCert[] = [];
  for (let index = 0; index < count; index += 1) {
    issuer = issueCert({ cn: `Long CA ${index}`, basicConstraints: "ca", eku: null, issuer });
    intermediates.unshift(issuer);
  }
  const leaf = issueCert({ dns, issuer });
  return { root, leaf, chainPem: intermediates.map((c) => c.pem).join("") };
}

/** PKCS#8 PEM encrypted with a passphrase (`ENCRYPTED PRIVATE KEY`). */
export const encryptedKeyPem = (key: KeyPair, passphrase = "correct horse"): string =>
  key.privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase }) as string;

/** Traditional RSA PEM encrypted with a passphrase (`RSA PRIVATE KEY` + `Proc-Type: 4,ENCRYPTED`). */
export const encryptedLegacyRsaPem = (key: KeyPair, passphrase = "correct horse"): string =>
  key.privateKey.export({ type: "pkcs1", format: "pem", cipher: "aes-256-cbc", passphrase }) as string;

/** Re-export a key in the SEC1 / PKCS#1 traditional layout. */
export const traditionalKeyPem = (key: KeyPair): string =>
  key.privateKey.export({ type: key.privateKey.asymmetricKeyType === "rsa" ? "pkcs1" : "sec1", format: "pem" }) as string;

export const keyFromPem = (pem: string): KeyObject => createPrivateKey(pem);
