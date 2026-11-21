import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import tls from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CERTIFICATE_PROBLEM_REASONS,
  type CertificateProblemReason,
  type ErrorCode,
  type PemShapeField,
} from "@hosting-panel/contracts";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import {
  TlsCertificateValidator,
  TlsValidationGate,
  type TlsCertificateInput,
} from "../src/certificates/tls-certificate-validator.js";
import {
  OID_ANY_EKU,
  OID_CLIENT_AUTH,
  OID_SERVER_AUTH,
  encryptedKeyPem,
  encryptedLegacyRsaPem,
  generateKey,
  issueCert,
  issueLongChain,
  issuePki,
  sanEmail,
  toPem,
  traditionalKeyPem,
  type CertSpec,
  type IssuedCert,
  type Pki,
} from "./fixtures/tls-certgen.js";

const DAY = 86_400_000;
const NO_PEM = /BEGIN|END|PRIVATE|CERTIFICATE-----/;

/** Whole seconds: DER dates have no milliseconds. */
const at = (offsetMs: number): Date => new Date(Math.floor((Date.now() + offsetMs) / 1000) * 1000);

const upload = (pki: { leaf: IssuedCert; chainPem?: string }): TlsCertificateInput => ({
  leafPem: pki.leaf.pem,
  chainPem: pki.chainPem ?? "",
  privateKeyPem: pki.leaf.keyPem,
});

const validatorFor = (pki: Pki | { root: IssuedCert }, now?: Date): TlsCertificateValidator =>
  new TlsCertificateValidator({ trustAnchors: [pki.root.pem], ...(now ? { now: () => now } : {}) });

async function rejection(promise: Promise<unknown>): Promise<ControlPlaneError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ControlPlaneError);
    return error as ControlPlaneError;
  }
  throw new Error("expected the validation to be refused");
}

/** Asserts one detail with fixed text and no PEM, base64 or parser output of the upload. */
function expectRefusal(
  error: ControlPlaneError,
  code: ErrorCode,
  field: PemShapeField,
  reason: CertificateProblemReason,
  input?: TlsCertificateInput,
): void {
  expect(error.code).toBe(code);
  expect(error.details).toHaveLength(1);
  const detail = error.details[0]!;
  expect(detail.field).toBe(field);
  expect(detail.reason).toBe(reason);
  expect(CERTIFICATE_PROBLEM_REASONS).toContain(reason);
  expect(detail.message).toBe(error.message);
  const everything = JSON.stringify([error.message, error.details, error.code]);
  expect(everything).not.toMatch(NO_PEM);
  if (input !== undefined) {
    for (const text of [input.leafPem, input.chainPem, input.privateKeyPem]) {
      const base64 = text.replace(/-----[^-]+-----|\s+/g, "");
      if (base64.length >= 32) expect(everything).not.toContain(base64.slice(0, 32));
    }
  }
}

describe("TlsCertificateValidator: accepted material", () => {
  it("returns exact metadata and re-encodes the material", async () => {
    const notBefore = at(-DAY);
    const notAfter = at(60 * DAY);
    const serial = Buffer.from("0a1b2c3d4e5f60718293a4b5c6d7e8f9", "hex");
    const pki = issuePki({
      leaf: { dns: ["Shop.Example.com", "*.example.com", "example.com", "example.com"], cn: "example.com", notBefore, notAfter, serial },
    });
    const input = upload(pki);

    const result = await validatorFor(pki).validate({ ...input, leafPem: `\r\n${input.leafPem.replace(/\n/g, "\r\n")}\r\n` });

    expect(result.sanDns).toEqual(["*.example.com", "example.com", "shop.example.com"]);
    expect(result.wildcard).toBe(true);
    expect(result.serialNumber).toBe("0A1B2C3D4E5F60718293A4B5C6D7E8F9");
    expect(result.fingerprintSha256).toBe(createHash("sha256").update(pki.leaf.der).digest("hex"));
    expect(result.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.notBefore).toEqual(notBefore);
    expect(result.notAfter).toEqual(notAfter);
    expect(result.subject).toBe("CN=example.com");
    expect(result.issuer).toBe("CN=Test Intermediate CA");
    expect(result.keyType).toBe("ec");
    expect(result.keyBits).toBe(256);
    expect(result.leafPem).toBe(pki.leaf.pem);
    expect(result.chainPem).toBe(pki.intermediate.pem);
    expect(result.privateKeyPem).toBe(pki.leaf.keyPem);
    expect(result.privateKeyPem.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
  });

  it("accepts RSA 2048, EC P-384, traditional key layouts and a leaf issued by the anchor", async () => {
    const rsa = issuePki({ leaf: { dns: ["rsa.example.com"], key: { type: "rsa", bits: 2048 } } });
    expect(await validatorFor(rsa).validate(upload(rsa))).toMatchObject({ keyType: "rsa", keyBits: 2048 });
    const legacyRsa = { ...upload(rsa), privateKeyPem: traditionalKeyPem(rsa.leaf.key) };
    expect(legacyRsa.privateKeyPem).toContain("BEGIN RSA PRIVATE KEY");
    expect((await validatorFor(rsa).validate(legacyRsa)).privateKeyPem).toBe(rsa.leaf.keyPem);

    const p384 = issuePki({ leaf: { dns: ["ec.example.com"], key: { type: "ec", curve: "secp384r1" } } });
    const sec1 = { ...upload(p384), privateKeyPem: traditionalKeyPem(p384.leaf.key) };
    expect(sec1.privateKeyPem).toContain("BEGIN EC PRIVATE KEY");
    expect(await validatorFor(p384).validate(sec1)).toMatchObject({ keyType: "ec", keyBits: 384 });

    const root = issueCert({ cn: "Direct Root", basicConstraints: "ca", eku: null });
    const direct = issueCert({ dns: ["direct.example.com"], issuer: root });
    expect(await validatorFor({ root }).validate({ leafPem: direct.pem, chainPem: "", privateKeyPem: direct.keyPem })).toMatchObject({
      chainPem: "",
    });
  });

  it("accepts a missing CN, a CN equal to a SAN, EKU variants and a chain that carries the root", async () => {
    for (const leaf of [
      { dns: ["a.example.com"], cn: null },
      { dns: ["a.example.com", "b.example.com"], cn: "B.EXAMPLE.com" },
      { dns: ["*.example.com"], cn: "*.example.com" },
      { dns: ["a.example.com"], eku: null },
      { dns: ["a.example.com"], eku: [OID_CLIENT_AUTH, OID_SERVER_AUTH] },
    ] satisfies CertSpec[]) {
      const pki = issuePki({ leaf });
      await expect(validatorFor(pki).validate(upload(pki))).resolves.toBeDefined();
    }
    const pki = issuePki({ leaf: { dns: ["a.example.com"] } });
    await expect(
      validatorFor(pki).validate({ ...upload(pki), chainPem: pki.intermediate.pem + pki.root.pem }),
    ).resolves.toBeDefined();
  });

  it("accepts 64 DNS names and 20 intermediates", async () => {
    const names = Array.from({ length: 64 }, (_, index) => `h${index}.example.com`);
    const pki = issuePki({ leaf: { dns: names, cn: null } });
    expect((await validatorFor(pki).validate(upload(pki))).sanDns).toHaveLength(64);

    const long = issueLongChain(20, ["deep.example.com"]);
    await expect(validatorFor(long).validate(upload(long))).resolves.toBeDefined();
  });

  it("uses the real clock and the bundled anchors by default", async () => {
    const pki = issuePki({ leaf: { dns: ["example.com"] } });
    const input = upload(pki);
    // Every date check passed on the real clock; the test root is not a Mozilla anchor.
    expectRefusal(
      await rejection(new TlsCertificateValidator().validate(input)),
      "CERTIFICATE_CHAIN_INVALID",
      "chainPem",
      "untrusted_or_incomplete",
      input,
    );
  });
});

interface Row {
  readonly name: string;
  readonly build: () => { input: TlsCertificateInput; validator: TlsCertificateValidator };
  readonly code: ErrorCode;
  readonly field: PemShapeField;
  readonly reason: CertificateProblemReason;
}

const good = (leaf: CertSpec = {}, now?: Date) => {
  const pki = issuePki({ leaf: { dns: ["example.com"], ...leaf } });
  return { pki, input: upload(pki), validator: validatorFor(pki, now) };
};
const withInput = (patch: Partial<TlsCertificateInput>, leaf: CertSpec = {}) => {
  const { input, validator } = good(leaf);
  return { input: { ...input, ...patch }, validator };
};
const sanRow = (name: string, dns: string[], reason: CertificateProblemReason): Row => ({
  name,
  build: () => good({ dns, cn: "example.com" }),
  code: "CERTIFICATE_INVALID",
  field: "leafPem",
  reason,
});
const tamper = (pem: string): string => pem.replace(/^(-----BEGIN [A-Z ]+-----\n)(.{4})/, "$1é$2");

const ROWS: Row[] = [
  // size and PEM shape
  {
    name: "over 512 KiB in total",
    build: () => withInput({ chainPem: toPem("CERTIFICATE", Buffer.alloc(600 * 1024, 1)) }),
    code: "CERTIFICATE_UPLOAD_TOO_LARGE",
    field: "chainPem",
    reason: "too_large",
  },
  {
    name: "NUL byte",
    build: () => withInput({ leafPem: `${good().input.leafPem}\u0000` }),
    code: "CERTIFICATE_FORMAT_UNSUPPORTED",
    field: "leafPem",
    reason: "nul_byte",
  },
  {
    name: "binary file (no PEM markers)",
    build: () => withInput({ leafPem: "\u0001\u0002\u0003\u0004 PK12" }),
    code: "CERTIFICATE_FORMAT_UNSUPPORTED",
    field: "leafPem",
    reason: "format_unsupported",
  },
  {
    name: "junk before a block",
    build: () => withInput({ leafPem: `hello\n${good().input.leafPem}` }),
    code: "CERTIFICATE_FORMAT_UNSUPPORTED",
    field: "leafPem",
    reason: "not_pem",
  },
  {
    name: "junk between chain blocks",
    build: () => {
      const pki = issuePki({ leaf: { dns: ["example.com"] } });
      return {
        input: { ...upload(pki), chainPem: `${pki.intermediate.pem}junk\n${pki.root.pem}` },
        validator: validatorFor(pki),
      };
    },
    code: "CERTIFICATE_FORMAT_UNSUPPORTED",
    field: "chainPem",
    reason: "not_pem",
  },
  {
    name: "non-ASCII inside a block",
    build: () => withInput({ leafPem: tamper(good().input.leafPem) }),
    code: "CERTIFICATE_FORMAT_UNSUPPORTED",
    field: "leafPem",
    reason: "not_pem",
  },
  {
    name: "bad base64",
    build: () => withInput({ leafPem: good().input.leafPem.replace(/^(-----BEGIN [A-Z ]+-----\n.{4})./, "$1!") }),
    code: "CERTIFICATE_FORMAT_UNSUPPORTED",
    field: "leafPem",
    reason: "not_pem",
  },
  {
    name: "empty leaf",
    build: () => withInput({ leafPem: "" }),
    code: "CERTIFICATE_INVALID",
    field: "leafPem",
    reason: "required",
  },
  {
    name: "two leaf blocks",
    build: () => {
      const { input, validator } = good();
      return { input: { ...input, leafPem: input.leafPem + input.leafPem }, validator };
    },
    code: "CERTIFICATE_INVALID",
    field: "leafPem",
    reason: "multiple_blocks",
  },
  {
    name: "private key in the leaf field",
    build: () => {
      const { input, validator } = good();
      return { input: { ...input, leafPem: input.privateKeyPem }, validator };
    },
    code: "CERTIFICATE_FORMAT_UNSUPPORTED",
    field: "leafPem",
    reason: "wrong_block_type",
  },
  {
    name: "21 chain blocks",
    build: () => {
      const { pki, input, validator } = good();
      return { input: { ...input, chainPem: pki.intermediate.pem.repeat(21) }, validator };
    },
    code: "CERTIFICATE_INVALID",
    field: "chainPem",
    reason: "too_many_intermediates",
  },
  {
    name: "PKCS#8 key with a passphrase",
    build: () => {
      const { pki, input, validator } = good();
      return { input: { ...input, privateKeyPem: encryptedKeyPem(pki.leaf.key) }, validator };
    },
    code: "CERTIFICATE_FORMAT_UNSUPPORTED",
    field: "privateKeyPem",
    reason: "encrypted_key",
  },
  {
    name: "traditional RSA key with Proc-Type: 4,ENCRYPTED",
    build: () => {
      const pki = issuePki({ leaf: { dns: ["example.com"], key: { type: "rsa", bits: 2048 } } });
      const legacy = encryptedLegacyRsaPem(pki.leaf.key);
      expect(legacy).toContain("Proc-Type: 4,ENCRYPTED");
      return { input: { ...upload(pki), privateKeyPem: legacy }, validator: validatorFor(pki) };
    },
    code: "CERTIFICATE_FORMAT_UNSUPPORTED",
    field: "privateKeyPem",
    reason: "encrypted_key",
  },
  {
    name: "certificate in the key field",
    build: () => {
      const { input, validator } = good();
      return { input: { ...input, privateKeyPem: input.leafPem }, validator };
    },
    code: "CERTIFICATE_FORMAT_UNSUPPORTED",
    field: "privateKeyPem",
    reason: "wrong_block_type",
  },
  {
    name: "two keys",
    build: () => {
      const { input, validator } = good();
      return { input: { ...input, privateKeyPem: input.privateKeyPem + input.privateKeyPem }, validator };
    },
    code: "CERTIFICATE_INVALID",
    field: "privateKeyPem",
    reason: "multiple_blocks",
  },
  {
    name: "no key",
    build: () => withInput({ privateKeyPem: "" }),
    code: "CERTIFICATE_INVALID",
    field: "privateKeyPem",
    reason: "required",
  },
  // parsing
  {
    name: "leaf that is not X.509",
    build: () => withInput({ leafPem: toPem("CERTIFICATE", Buffer.from("this is not a certificate")) }),
    code: "CERTIFICATE_INVALID",
    field: "leafPem",
    reason: "parse_failed",
  },
  {
    name: "intermediate that is not X.509",
    build: () => withInput({ chainPem: toPem("CERTIFICATE", Buffer.from("this is not a certificate")) }),
    code: "CERTIFICATE_INVALID",
    field: "chainPem",
    reason: "parse_failed",
  },
  {
    name: "key that is not a key",
    build: () => withInput({ privateKeyPem: toPem("PRIVATE KEY", Buffer.from("this is not a private key")) }),
    code: "CERTIFICATE_INVALID",
    field: "privateKeyPem",
    reason: "key_parse_failed",
  },
  // key algorithm and match
  {
    name: "RSA 1024",
    build: () => good({ key: { type: "rsa", bits: 1024 } }),
    code: "CERTIFICATE_FORMAT_UNSUPPORTED",
    field: "privateKeyPem",
    reason: "key_algorithm",
  },
  {
    name: "ed25519",
    build: () => good({ key: { type: "ed25519" } }),
    code: "CERTIFICATE_FORMAT_UNSUPPORTED",
    field: "privateKeyPem",
    reason: "key_algorithm",
  },
  {
    name: "EC secp256k1",
    build: () => good({ key: { type: "ec", curve: "secp256k1" } }),
    code: "CERTIFICATE_FORMAT_UNSUPPORTED",
    field: "privateKeyPem",
    reason: "key_algorithm",
  },
  {
    name: "key of another certificate",
    build: () => withInput({ privateKeyPem: generateKey().privateKey.export({ type: "pkcs8", format: "pem" }) as string }),
    code: "CERTIFICATE_KEY_MISMATCH",
    field: "privateKeyPem",
    reason: "key_mismatch",
  },
  // CA, EKU
  {
    name: "CA certificate as the leaf",
    build: () => good({ basicConstraints: "ca" }),
    code: "CERTIFICATE_INVALID",
    field: "leafPem",
    reason: "leaf_is_ca",
  },
  {
    name: "clientAuth only",
    build: () => good({ eku: [OID_CLIENT_AUTH] }),
    code: "CERTIFICATE_INVALID",
    field: "leafPem",
    reason: "eku_not_server_auth",
  },
  {
    name: "anyExtendedKeyUsage only (OpenSSL refuses it for a server purpose)",
    build: () => good({ eku: [OID_ANY_EKU] }),
    code: "CERTIFICATE_INVALID",
    field: "leafPem",
    reason: "eku_not_server_auth",
  },
  {
    name: "intermediate that forbids serverAuth (OpenSSL INVALID_PURPOSE)",
    build: () => {
      const pki = issuePki({ intermediate: { eku: [OID_CLIENT_AUTH] }, leaf: { dns: ["example.com"] } });
      return { input: upload(pki), validator: validatorFor(pki) };
    },
    code: "CERTIFICATE_INVALID",
    field: "chainPem",
    reason: "eku_not_server_auth",
  },
  // dates (injected clock)
  {
    name: "one second before notBefore",
    build: () => {
      const notBefore = at(-DAY);
      return good({ notBefore }, new Date(notBefore.getTime() - 1000));
    },
    code: "CERTIFICATE_NOT_YET_VALID",
    field: "leafPem",
    reason: "not_yet_valid",
  },
  {
    name: "exactly notAfter",
    build: () => {
      const notAfter = at(10 * DAY);
      return good({ notAfter }, notAfter);
    },
    code: "CERTIFICATE_EXPIRED",
    field: "leafPem",
    reason: "expired",
  },
  {
    name: "a year after notAfter",
    build: () => {
      const notAfter = at(10 * DAY);
      return good({ notAfter }, new Date(notAfter.getTime() + 365 * DAY));
    },
    code: "CERTIFICATE_EXPIRED",
    field: "leafPem",
    reason: "expired",
  },
  {
    name: "one second under the 24 h margin",
    build: () => {
      const notAfter = at(10 * DAY);
      return good({ notAfter }, new Date(notAfter.getTime() - DAY + 1000));
    },
    code: "CERTIFICATE_EXPIRED",
    field: "leafPem",
    reason: "expires_within_24h",
  },
  // DNS names
  {
    name: "no SAN, CN only (no CN fallback)",
    build: () => good({ dns: [], cn: "example.com" }),
    code: "CERTIFICATE_INVALID",
    field: "leafPem",
    reason: "no_dns_san",
  },
  {
    name: "SAN without a DNS name",
    build: () => good({ dns: [], cn: "example.com", rawSans: [sanEmail("admin@example.com")] }),
    code: "CERTIFICATE_INVALID",
    field: "leafPem",
    reason: "no_dns_san",
  },
  {
    name: "IP SAN only",
    build: () => good({ dns: [], ip: ["192.0.2.10"], cn: null }),
    code: "CERTIFICATE_INVALID",
    field: "leafPem",
    reason: "ip_san_unsupported",
  },
  {
    name: "DNS SAN plus an IP SAN",
    build: () => good({ dns: ["example.com"], ip: ["192.0.2.10"] }),
    code: "CERTIFICATE_INVALID",
    field: "leafPem",
    reason: "ip_san_unsupported",
  },
  {
    name: "65 DNS names",
    build: () => good({ dns: Array.from({ length: 65 }, (_, index) => `h${index}.example.com`), cn: null }),
    code: "CERTIFICATE_INVALID",
    field: "leafPem",
    reason: "too_many_sans",
  },
  sanRow("partial wildcard f*.example.com", ["f*.example.com"], "unsupported_wildcard"),
  sanRow("wildcard on the TLD", ["*.com"], "unsupported_wildcard"),
  sanRow("nested wildcard", ["*.*.example.com"], "unsupported_wildcard"),
  sanRow("wildcard that is not the first label", ["a.*.example.com"], "unsupported_wildcard"),
  sanRow("bare *", ["*"], "unsupported_wildcard"),
  sanRow("underscore in a label", ["bad_name.example.com"], "san_invalid"),
  sanRow("trailing dot", ["example.com."], "san_invalid"),
  sanRow("single label", ["intranet"], "san_invalid"),
  sanRow("label over 63 characters", [`${"a".repeat(64)}.example.com`], "san_invalid"),
  sanRow("name with a space", ["exa mple.com"], "san_invalid"),
  sanRow("label starting with a hyphen", ["-a.example.com"], "san_invalid"),
  sanRow("label ending with a hyphen", ["a-.example.com"], "san_invalid"),
  sanRow("name over 253 characters", [`${`${"a".repeat(63)}.`.repeat(4)}com`], "san_invalid"),
  sanRow("IPv4-shaped DNS name", ["1.2.3.4"], "ip_san_unsupported"),
  sanRow("wildcard over an IPv4-shaped name", ["*.1.2.3.4"], "ip_san_unsupported"),
  sanRow("entry that smuggles a second SAN", ["a.example.com, DNS:b.example.com"], "san_invalid"),
  sanRow("embedded NUL", ["a\u0000.example.com"], "san_invalid"),
  sanRow("empty label", ["a..example.com"], "san_invalid"),
  // CN
  {
    name: "CN that is not a SAN",
    build: () => good({ dns: ["example.com"], cn: "other.example.com" }),
    code: "CERTIFICATE_INVALID",
    field: "leafPem",
    reason: "cn_not_in_san",
  },
  {
    name: "CN covered by a wildcard SAN but not listed",
    build: () => good({ dns: ["*.example.com"], cn: "shop.example.com" }),
    code: "CERTIFICATE_INVALID",
    field: "leafPem",
    reason: "cn_not_in_san",
  },
  // path validation (handshake)
  {
    name: "chain to an unknown root",
    build: () => {
      const { input } = good();
      return { input, validator: validatorFor({ root: issueCert({ cn: "Other Root", basicConstraints: "ca", eku: null }) }) };
    },
    code: "CERTIFICATE_CHAIN_INVALID",
    field: "chainPem",
    reason: "untrusted_or_incomplete",
  },
  {
    name: "missing intermediate",
    build: () => withInput({ chainPem: "" }),
    code: "CERTIFICATE_CHAIN_INVALID",
    field: "chainPem",
    reason: "untrusted_or_incomplete",
  },
  {
    name: "self-signed leaf",
    build: () => {
      const leaf = issueCert({ dns: ["example.com"] });
      return {
        input: { leafPem: leaf.pem, chainPem: "", privateKeyPem: leaf.keyPem },
        validator: validatorFor({ root: issueCert({ cn: "Unrelated", basicConstraints: "ca", eku: null }) }),
      };
    },
    code: "CERTIFICATE_CHAIN_INVALID",
    field: "chainPem",
    reason: "untrusted_or_incomplete",
  },
  {
    name: "expired intermediate",
    build: () => {
      const pki = issuePki({
        intermediate: { notBefore: at(-3 * 365 * DAY), notAfter: at(-365 * DAY) },
        leaf: { dns: ["example.com"] },
      });
      return { input: upload(pki), validator: validatorFor(pki) };
    },
    code: "CERTIFICATE_CHAIN_INVALID",
    field: "chainPem",
    reason: "chain_expired",
  },
  {
    name: "intermediate not valid yet",
    build: () => {
      const pki = issuePki({
        intermediate: { notBefore: at(30 * DAY), notAfter: at(365 * DAY) },
        leaf: { dns: ["example.com"] },
      });
      return { input: upload(pki), validator: validatorFor(pki) };
    },
    code: "CERTIFICATE_CHAIN_INVALID",
    field: "chainPem",
    reason: "chain_expired",
  },
  {
    name: "leaf signed by a key that is not the intermediate's",
    build: () => {
      const pki = issuePki();
      const forger = { ...pki.intermediate, key: generateKey() };
      const leaf = issueCert({ dns: ["example.com"], issuer: forger });
      return { input: upload({ leaf, chainPem: pki.intermediate.pem }), validator: validatorFor(pki) };
    },
    code: "CERTIFICATE_CHAIN_INVALID",
    field: "chainPem",
    reason: "bad_signature",
  },
  {
    name: "path length constraint exceeded",
    build: () => {
      const root = issueCert({ cn: "Path Root", basicConstraints: "ca", eku: null });
      const top = issueCert({ cn: "Path CA 1", basicConstraints: "ca", pathLen: 0, eku: null, issuer: root });
      const below = issueCert({ cn: "Path CA 2", basicConstraints: "ca", eku: null, issuer: top });
      const leaf = issueCert({ dns: ["example.com"], issuer: below });
      return { input: upload({ leaf, chainPem: below.pem + top.pem }), validator: validatorFor({ root }) };
    },
    code: "CERTIFICATE_CHAIN_INVALID",
    field: "chainPem",
    reason: "chain_invalid",
  },
];

describe("TlsCertificateValidator: refusals", () => {
  it.each(ROWS)("$name -> $code / $reason", async (row) => {
    const { input, validator } = row.build();
    expectRefusal(await rejection(validator.validate(input)), row.code, row.field, row.reason, input);
  });

  it("covers every validation reason of the contracts catalog", () => {
    const covered = new Set<string>([...ROWS.map((row) => row.reason), "verify_timeout"]);
    const validation = CERTIFICATE_PROBLEM_REASONS.slice(0, CERTIFICATE_PROBLEM_REASONS.indexOf("not_covered"));
    // invalid_name belongs to the import form (name), not to the material
    expect(validation.filter((reason) => !covered.has(reason))).toEqual(["invalid_name"]);
  });

  it("checks the key before the dates and the dates before the names", async () => {
    const expiredWithBadKey = good({ notAfter: at(10 * DAY), key: { type: "ed25519" } }, at(20 * DAY));
    expectRefusal(
      await rejection(expiredWithBadKey.validator.validate(expiredWithBadKey.input)),
      "CERTIFICATE_FORMAT_UNSUPPORTED",
      "privateKeyPem",
      "key_algorithm",
    );
    const expiredNoSan = good({ notAfter: at(10 * DAY), dns: [], cn: "example.com" }, at(20 * DAY));
    expectRefusal(
      await rejection(expiredNoSan.validator.validate(expiredNoSan.input)),
      "CERTIFICATE_EXPIRED",
      "leafPem",
      "expired",
    );
  });

  it("accepts exactly 24 h before notAfter and exactly notBefore", async () => {
    const notBefore = at(-DAY);
    const notAfter = at(10 * DAY);
    const pki = issuePki({ leaf: { dns: ["example.com"], notBefore, notAfter } });
    await expect(validatorFor(pki, new Date(notAfter.getTime() - DAY)).validate(upload(pki))).resolves.toBeDefined();
    await expect(validatorFor(pki, notBefore).validate(upload(pki))).resolves.toBeDefined();
  });

  describe("handshake timeout", () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("reports verify_timeout and releases the server", async () => {
      const fake = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      const connect = vi.spyOn(tls, "connect").mockImplementation(() => fake as unknown as tls.TLSSocket);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { input, validator } = good();
      const pending = rejection(validator.validate(input));
      while (connect.mock.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
      vi.advanceTimersByTime(5_000);
      expectRefusal(await pending, "CERTIFICATE_CHAIN_INVALID", "chainPem", "verify_timeout", input);
      expect(fake.destroy).toHaveBeenCalled();
    });
  });
});

describe("TlsValidationGate", () => {
  const hold = () => {
    let release!: () => void;
    const done = new Promise<void>((resolve) => (release = resolve));
    return { done, release };
  };

  it("lets one validation per organisation and two per server run", async () => {
    const gate = new TlsValidationGate();
    const a = hold();
    const b = hold();
    const first = gate.run("org-a", () => a.done);
    const second = gate.run("org-b", () => b.done);

    const sameOrg = await rejection(gate.run("org-a", async () => "never"));
    expect(sameOrg.code).toBe("RATE_LIMITED");
    expect(sameOrg.retryAfterMs).toBeGreaterThan(0);
    expect((await rejection(gate.run("org-c", async () => "never"))).code).toBe("RATE_LIMITED");

    a.release();
    await first;
    await expect(gate.run("org-c", async () => "ok")).resolves.toBe("ok");
    b.release();
    await second;
  });

  it("frees the slot when the work throws", async () => {
    const gate = new TlsValidationGate();
    await expect(gate.run("org-a", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(gate.run("org-a", async () => "ok")).resolves.toBe("ok");
    await expect(gate.run("org-b", async () => "ok")).resolves.toBe("ok");
  });
});
