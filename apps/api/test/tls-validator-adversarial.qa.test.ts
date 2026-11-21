// QA (adversarial) for TlsCertificateValidator: hostile PEM framing, size limits, forged chains, odd names and keys.
// Complements tls-certificate-validator.test.ts (engineers' table); nothing here repeats one of its rows.
import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CERTIFICATE_PROBLEM_REASONS, TLS_PEM_MAX_BYTES, type CertificateProblemReason, type ErrorCode } from "@hosting-panel/contracts";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import { TlsCertificateValidator, type TlsCertificateInput } from "../src/certificates/tls-certificate-validator.js";
import {
  OID_ANY_EKU,
  OID_CLIENT_AUTH,
  OID_SERVER_AUTH,
  encryptedKeyPem,
  generateKey,
  issueCert,
  issueLongChain,
  issuePki,
  toPem,
  type CertSpec,
  type IssuedCert,
} from "./fixtures/tls-certgen.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const PEM_MARKERS = /BEGIN|END|PRIVATE|CERTIFICATE-----/;

const upload = (pki: { leaf: IssuedCert; chainPem?: string }): TlsCertificateInput => ({
  leafPem: pki.leaf.pem,
  chainPem: pki.chainPem ?? "",
  privateKeyPem: pki.leaf.keyPem,
});
const validatorFor = (pki: { root: IssuedCert }): TlsCertificateValidator =>
  new TlsCertificateValidator({ trustAnchors: [pki.root.pem] });
/** A good PKI whose leaf is tweaked by `leaf`, with its upload and a validator that trusts its root. */
const good = (leaf: CertSpec = {}) => {
  const pki = issuePki({ leaf: { dns: ["example.com"], ...leaf } });
  return { pki, input: upload(pki), validator: validatorFor(pki) };
};
const derOf = (pem: string): Buffer => Buffer.from(pem.replace(/-----[^-]+-----|\s+/g, ""), "base64");
const bodyOf = (pem: string): string => pem.replace(/-----[^-]+-----|\s+/g, "");

async function rejection(promise: Promise<unknown>): Promise<ControlPlaneError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ControlPlaneError);
    return error as ControlPlaneError;
  }
  throw new Error("expected the validation to be refused");
}

/** Everything an error can carry out to a client or a log: message, code, details, stack, enumerable props. */
function expectRefused(
  error: ControlPlaneError,
  code: ErrorCode,
  field: string,
  reason: CertificateProblemReason,
  input?: TlsCertificateInput,
): void {
  expect(error.code).toBe(code);
  expect(error.details).toHaveLength(1);
  expect(error.details[0]).toMatchObject({ field, reason, message: error.message });
  expect(CERTIFICATE_PROBLEM_REASONS).toContain(reason);
  const everything = JSON.stringify([error.message, error.code, error.details, error.stack, { ...error }]);
  expect(everything).not.toMatch(PEM_MARKERS);
  if (input !== undefined) {
    for (const text of [input.leafPem, input.chainPem, input.privateKeyPem]) {
      const body = bodyOf(text);
      for (let at = 0; at + 24 <= Math.min(body.length, 4000); at += 97) {
        expect(everything).not.toContain(body.slice(at, at + 24));
      }
    }
  }
}

const sizeOf = (input: TlsCertificateInput): number =>
  [input.leafPem, input.chainPem, input.privateKeyPem].reduce((sum, text) => sum + Buffer.byteLength(text), 0);

describe("size limits (TLS-02)", () => {
  it("accepts exactly 512 KiB in total and refuses one byte more", async () => {
    const { input, validator } = good();
    const padding = TLS_PEM_MAX_BYTES - sizeOf(input);
    expect(padding).toBeGreaterThan(0);

    const exact = { ...input, chainPem: input.chainPem + "\n".repeat(padding) };
    expect(sizeOf(exact)).toBe(TLS_PEM_MAX_BYTES);
    await expect(validator.validate(exact)).resolves.toMatchObject({ sanDns: ["example.com"] });

    const over = { ...input, chainPem: input.chainPem + "\n".repeat(padding + 1) };
    expect(sizeOf(over)).toBe(TLS_PEM_MAX_BYTES + 1);
    expectRefused(await rejection(validator.validate(over)), "CERTIFICATE_UPLOAD_TOO_LARGE", "chainPem", "too_large", over);
  });

  it("counts UTF-8 bytes, not characters, and reports the largest field", async () => {
    const { input, validator } = good();
    // 300 000 characters but 600 000 bytes: under the limit by length, over it by bytes.
    const wide = { ...input, privateKeyPem: "é".repeat(300_000) };
    expectRefused(await rejection(validator.validate(wide)), "CERTIFICATE_UPLOAD_TOO_LARGE", "privateKeyPem", "too_large", wide);
  });

  it("refuses megabytes of input without echoing or hanging", async () => {
    const { input, validator } = good();
    const huge = { ...input, leafPem: `${input.leafPem}${"A".repeat(5 * 1024 * 1024)}` };
    expectRefused(await rejection(validator.validate(huge)), "CERTIFICATE_UPLOAD_TOO_LARGE", "leafPem", "too_large");
  });

  it("an enormous base64 block is a parse failure, in bounded time, with no echo", async () => {
    const { input, validator } = good();
    const blob = Buffer.alloc(300 * 1024, 0x5a); // valid base64 of 400 KiB, but not DER
    const started = Date.now();
    const leaf = { ...input, leafPem: toPem("CERTIFICATE", blob) };
    expectRefused(await rejection(validator.validate(leaf)), "CERTIFICATE_INVALID", "leafPem", "parse_failed", leaf);
    const chain = { ...input, chainPem: toPem("CERTIFICATE", blob) };
    expectRefused(await rejection(validator.validate(chain)), "CERTIFICATE_INVALID", "chainPem", "parse_failed", chain);
    const key = { ...input, privateKeyPem: toPem("PRIVATE KEY", blob) };
    expectRefused(await rejection(validator.validate(key)), "CERTIFICATE_INVALID", "privateKeyPem", "key_parse_failed", key);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it.each([
    ["18 000 unterminated BEGIN markers", () => "-----BEGIN CERTIFICATE-----\n".repeat(18_000)],
    ["one BEGIN then 500 000 base64 characters and no END", () => `-----BEGIN CERTIFICATE-----\n${"A".repeat(500_000)}`],
    ["500 000 dashes", () => "-".repeat(500_000)],
    ["20 000 END markers", () => "-----END CERTIFICATE-----\n".repeat(20_000)],
    ["BEGIN markers whose END labels differ", () => "-----BEGIN CERTIFICATE-----\nAAAA\n-----END PRIVATE KEY-----\n".repeat(8_000)],
  ])("does not go quadratic on %s", async (_name, make) => {
    const { input, validator } = good();
    const hostile = { ...input, leafPem: make() };
    expect(sizeOf(hostile)).toBeLessThanOrEqual(TLS_PEM_MAX_BYTES);
    const started = Date.now();
    const error = await rejection(validator.validate(hostile));
    expect(Date.now() - started).toBeLessThan(2_000);
    expectRefused(error, "CERTIFICATE_FORMAT_UNSUPPORTED", "leafPem", "not_pem");
  });
});

describe("PEM framing (TLS-02)", () => {
  const FIELDS = ["leafPem", "chainPem", "privateKeyPem"] as const;

  it.each(FIELDS)("a NUL byte in %s, inside a block or after it, is nul_byte", async (field) => {
    const { input, validator } = good();
    const inside = { ...input, [field]: input[field].replace(/\n/, "\u0000\n") };
    expectRefused(await rejection(validator.validate(inside)), "CERTIFICATE_FORMAT_UNSUPPORTED", field, "nul_byte", inside);
    const after = { ...input, [field]: `${input[field]}\u0000` };
    expectRefused(await rejection(validator.validate(after)), "CERTIFICATE_FORMAT_UNSUPPORTED", field, "nul_byte", after);
  });

  it("accepts CRLF, lone CR, tabs, trailing blanks and blank lines in all three fields", async () => {
    const { pki, input, validator } = good();
    const messy = (pem: string, eol: string): string =>
      `${eol}${eol}\t${pem
        .split("\n")
        .map((line) => (/^-----/.test(line) || line === "" ? line : `${line} \t`))
        .join(eol)}${eol}${eol}  ${eol}`;
    for (const eol of ["\r\n", "\r", "\n\n"]) {
      const result = await validator.validate({
        leafPem: messy(input.leafPem, eol),
        chainPem: messy(input.chainPem, eol),
        privateKeyPem: messy(input.privateKeyPem, eol),
      });
      expect(result.leafPem).toBe(pki.leaf.pem);
      expect(result.chainPem).toBe(pki.intermediate.pem);
      expect(result.privateKeyPem).toBe(pki.leaf.keyPem);
    }
  });

  const JUNK = [
    "hello world\n",
    "# my certificate\n",
    "Bag Attributes\n    friendlyName: site\nsubject=CN = example.com\n",
    "​", // zero-width space
    "-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----\n",
  ];
  describe.each(FIELDS)("junk around the block of %s", (field) => {
    it.each(JUNK)("before: %j", async (junk) => {
      const { input, validator } = good();
      const hostile = { ...input, [field]: `${junk}${input[field]}` };
      const error = await rejection(validator.validate(hostile));
      expect(error.code).toBe("CERTIFICATE_FORMAT_UNSUPPORTED");
      expect(error.details[0]).toMatchObject({ field });
      expect(["not_pem", "wrong_block_type"]).toContain(error.details[0]!.reason);
      expect(JSON.stringify(error.details)).not.toMatch(PEM_MARKERS);
    });
    it.each(JUNK.slice(0, 4))("after: %j", async (junk) => {
      const { input, validator } = good();
      const hostile = { ...input, [field]: `${input[field]}${junk}` };
      expectRefused(await rejection(validator.validate(hostile)), "CERTIFICATE_FORMAT_UNSUPPORTED", field, "not_pem", hostile);
    });
  });

  it.each([
    ["text glued to the END marker", (p: string) => p.replace(/-----END CERTIFICATE-----/, "-----END CERTIFICATE-----x")],
    ["text glued to the BEGIN marker", (p: string) => `x${p}`],
    ["an END label that differs", (p: string) => p.replace(/-----END CERTIFICATE-----/, "-----END PRIVATE KEY-----")],
    ["a lower-case label", (p: string) => p.replace(/CERTIFICATE/g, "certificate")],
    ["no END marker", (p: string) => p.replace(/-----END CERTIFICATE-----\n?/, "")],
    ["an empty block", () => "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n"],
    ["the base64url alphabet", (p: string) => p.replace(/^(-----BEGIN CERTIFICATE-----\n.{8})./, "$1_")],
    ["padding in the middle", (p: string) => p.replace(/^(-----BEGIN CERTIFICATE-----\n.{8})./, "$1=")],
    ["a length that is not a multiple of 4", (p: string) => p.replace(/\n-----END/, "A\n-----END")],
  ])("refuses a leaf with %s as not_pem", async (_name, mutate) => {
    const { input, validator } = good();
    const hostile = { ...input, leafPem: mutate(input.leafPem) };
    expectRefused(await rejection(validator.validate(hostile)), "CERTIFICATE_FORMAT_UNSUPPORTED", "leafPem", "not_pem", hostile);
  });

  it.each([
    ["TRUSTED CERTIFICATE"],
    ["X509 CRL"],
    ["PKCS7"],
    ["PUBLIC KEY"],
    ["CERTIFICATE REQUEST"],
  ])("a %s block in the chain is wrong_block_type", async (label) => {
    const { pki, input, validator } = good();
    const hostile = { ...input, chainPem: pki.intermediate.pem + toPem(label, Buffer.alloc(40, 1)) };
    expectRefused(await rejection(validator.validate(hostile)), "CERTIFICATE_FORMAT_UNSUPPORTED", "chainPem", "wrong_block_type", hostile);
  });

  it("an `openssl ecparam -genkey` file (EC PARAMETERS + EC PRIVATE KEY) is wrong_block_type", async () => {
    const { input, validator } = good();
    const ecParams = toPem("EC PARAMETERS", Buffer.from("06082a8648ce3d030107", "hex"));
    const hostile = { ...input, privateKeyPem: ecParams + input.privateKeyPem };
    expectRefused(await rejection(validator.validate(hostile)), "CERTIFICATE_FORMAT_UNSUPPORTED", "privateKeyPem", "wrong_block_type", hostile);
  });

  it("drops DER bytes appended after a certificate or a key (nothing is smuggled into the stored material)", async () => {
    const { pki, validator } = good();
    const trailer = Buffer.alloc(64, 7);
    const result = await validator.validate({
      leafPem: toPem("CERTIFICATE", Buffer.concat([pki.leaf.der, trailer])),
      chainPem: toPem("CERTIFICATE", Buffer.concat([pki.intermediate.der, trailer])),
      privateKeyPem: toPem("PRIVATE KEY", Buffer.concat([pki.leaf.key.privateKey.export({ type: "pkcs8", format: "der" }), trailer])),
    });
    expect(derOf(result.leafPem).equals(pki.leaf.der)).toBe(true);
    expect(derOf(result.chainPem).equals(pki.intermediate.der)).toBe(true);
    expect(result.privateKeyPem).toBe(pki.leaf.keyPem);
    expect(result.fingerprintSha256).toBe(createHash("sha256").update(pki.leaf.der).digest("hex"));
  });
});

describe("forged and incomplete chains (TLS-02)", () => {
  const forgedKey = () => issueCert({}).key; // an attacker's key pair

  it("a leaf that names the real intermediate as issuer but is signed by another key is bad_signature", async () => {
    const pki = issuePki();
    const leaf = issueCert({ dns: ["example.com"], issuer: { ...pki.intermediate, key: forgedKey() } });
    const input = upload({ leaf, chainPem: pki.chainPem });
    expectRefused(await rejection(validatorFor(pki).validate(input)), "CERTIFICATE_CHAIN_INVALID", "chainPem", "bad_signature", input);
  });

  it("a leaf that names the trusted root as issuer, signed by the attacker, is refused", async () => {
    const pki = issuePki();
    const leaf = issueCert({ dns: ["example.com"], issuer: { ...pki.root, key: forgedKey() } });
    const input = upload({ leaf, chainPem: "" });
    const error = await rejection(validatorFor(pki).validate(input));
    expect(error.code).toBe("CERTIFICATE_CHAIN_INVALID");
    expect(["bad_signature", "untrusted_or_incomplete"]).toContain(error.details[0]!.reason);
  });

  it("a forged intermediate carrying the real intermediate's name is bad_signature", async () => {
    const pki = issuePki();
    const fake = issueCert({ cn: "Test Intermediate CA", basicConstraints: "ca", eku: null, issuer: { ...pki.root, key: forgedKey() } });
    const leaf = issueCert({ dns: ["example.com"], issuer: fake });
    const input = upload({ leaf, chainPem: fake.pem });
    expectRefused(await rejection(validatorFor(pki).validate(input)), "CERTIFICATE_CHAIN_INVALID", "chainPem", "bad_signature", input);
  });

  it("an attacker root with the trusted root's name, shipped in the chain, does not become a trust anchor", async () => {
    const pki = issuePki();
    const fakeRoot = issueCert({ cn: "Test Root CA", basicConstraints: "ca", eku: null });
    const middle = issueCert({ cn: "Attacker CA", basicConstraints: "ca", eku: null, issuer: fakeRoot });
    const leaf = issueCert({ dns: ["example.com"], issuer: middle });
    for (const chainPem of [middle.pem + fakeRoot.pem, middle.pem]) {
      const input = { leafPem: leaf.pem, chainPem, privateKeyPem: leaf.keyPem };
      const error = await rejection(validatorFor(pki).validate(input));
      expect(error.code).toBe("CERTIFICATE_CHAIN_INVALID");
      expect(["bad_signature", "untrusted_or_incomplete"]).toContain(error.details[0]!.reason);
    }
  });

  it("a hole in the middle of a three-intermediate chain is untrusted_or_incomplete", async () => {
    const long = issueLongChain(3, ["example.com"]);
    const blocks = long.chainPem.match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----\n/g)!;
    expect(blocks).toHaveLength(3);
    const input = { leafPem: long.leaf.pem, chainPem: blocks[0]! + blocks[2]!, privateKeyPem: long.leaf.keyPem };
    expectRefused(await rejection(validatorFor(long).validate(input)), "CERTIFICATE_CHAIN_INVALID", "chainPem", "untrusted_or_incomplete", input);
  });

  it("only the root of the chain is missing from the trust store: untrusted_or_incomplete", async () => {
    const { input } = good();
    const stranger = issueCert({ cn: "Stranger Root", basicConstraints: "ca", eku: null });
    expectRefused(await rejection(validatorFor({ root: stranger }).validate(input)), "CERTIFICATE_CHAIN_INVALID", "chainPem", "untrusted_or_incomplete", input);
  });

  it("a self-signed leaf is untrusted under the production anchors (no test anchors)", async () => {
    const leaf = issueCert({ dns: ["example.com"] });
    const input = { leafPem: leaf.pem, chainPem: "", privateKeyPem: leaf.keyPem };
    expectRefused(await rejection(new TlsCertificateValidator().validate(input)), "CERTIFICATE_CHAIN_INVALID", "chainPem", "untrusted_or_incomplete", input);
  });

  it("a self-signed CA:TRUE leaf is leaf_is_ca before any chain work", async () => {
    const leaf = issueCert({ dns: ["example.com"], basicConstraints: "ca" });
    const input = { leafPem: leaf.pem, chainPem: "", privateKeyPem: leaf.keyPem };
    expectRefused(await rejection(new TlsCertificateValidator({ trustAnchors: [leaf.pem] }).validate(input)), "CERTIFICATE_INVALID", "leafPem", "leaf_is_ca", input);
  });

  it("a CA:TRUE leaf that is also clientAuth-only reports leaf_is_ca (CA check first)", async () => {
    const { input, validator } = good({ basicConstraints: "ca", eku: [OID_CLIENT_AUTH] });
    expectRefused(await rejection(validator.validate(input)), "CERTIFICATE_INVALID", "leafPem", "leaf_is_ca", input);
  });

  it("21 real intermediates are too_many_intermediates before any crypto; a junk 21st block too", async () => {
    const long = issueLongChain(21, ["deep.example.com"]);
    const input = { leafPem: long.leaf.pem, chainPem: long.chainPem, privateKeyPem: long.leaf.keyPem };
    expectRefused(await rejection(validatorFor(long).validate(input)), "CERTIFICATE_INVALID", "chainPem", "too_many_intermediates", input);

    const twenty = issueLongChain(20, ["deep.example.com"]);
    const withJunk = { leafPem: twenty.leaf.pem, chainPem: twenty.chainPem + toPem("CERTIFICATE", Buffer.from("junk")), privateKeyPem: twenty.leaf.keyPem };
    expectRefused(await rejection(validatorFor(twenty).validate(withJunk)), "CERTIFICATE_INVALID", "chainPem", "too_many_intermediates", withJunk);
  });
});

describe("leaf extensions and names (TLS-03)", () => {
  const refuse = async (leaf: CertSpec, code: ErrorCode, field: string, reason: CertificateProblemReason): Promise<void> => {
    const { input, validator } = good(leaf);
    expectRefused(await rejection(validator.validate(input)), code, field, reason, input);
  };

  it.each([
    ["clientAuth + emailProtection", ["1.3.6.1.5.5.7.3.2", "1.3.6.1.5.5.7.3.4"]],
    ["codeSigning only", ["1.3.6.1.5.5.7.3.3"]],
    ["anyExtendedKeyUsage + clientAuth (no serverAuth)", [OID_ANY_EKU, OID_CLIENT_AUTH]],
  ])("EKU %s is eku_not_server_auth", async (_name, eku) => {
    await refuse({ eku }, "CERTIFICATE_INVALID", "leafPem", "eku_not_server_auth");
  });

  it("an EKU extension with an empty sequence is refused (stable code; OpenSSL reports it on the chain)", async () => {
    const { input, validator } = good({ eku: [] });
    const error = await rejection(validator.validate(input));
    expect(error.code).toBe("CERTIFICATE_INVALID");
    expect(error.details[0]!.reason).toBe("eku_not_server_auth");
    expect(JSON.stringify(error.details)).not.toMatch(PEM_MARKERS);
  });

  it("anyExtendedKeyUsage next to serverAuth is accepted", async () => {
    const { input, validator } = good({ eku: [OID_ANY_EKU, OID_SERVER_AUTH] });
    await expect(validator.validate(input)).resolves.toBeDefined();
  });

  it.each([
    ["a leading space", " example.com"],
    ["a trailing dot", "example.com."],
    ["an IP address", "192.0.2.10"],
    ["a wildcard that the SAN does not list", "*.example.com"],
    ["an accented letter", "exämple.com"],
    ["a newline that fakes a second CN", "example.com\nCN=evil.example.com"],
    ["a newline that fakes another RDN", "example.com\nO=x"],
  ])("a CN with %s is cn_not_in_san", async (_name, cn) => {
    await refuse({ dns: ["example.com"], cn }, "CERTIFICATE_INVALID", "leafPem", "cn_not_in_san");
  });

  it("an upper-case CN equal to a SAN, and an empty CN, are accepted", async () => {
    for (const cn of ["EXAMPLE.COM", ""]) {
      const { input, validator } = good({ dns: ["example.com"], cn });
      await expect(validator.validate(input)).resolves.toMatchObject({ sanDns: ["example.com"] });
    }
  });

  it("IPv6 and malformed IP SANs are ip_san_unsupported; a CN that is an IP changes nothing", async () => {
    await refuse(
      { dns: [], cn: null, rawSans: [Buffer.concat([Buffer.from([0x87, 16]), Buffer.alloc(16, 1)])] },
      "CERTIFICATE_INVALID",
      "leafPem",
      "ip_san_unsupported",
    );
    await refuse(
      { dns: ["example.com"], rawSans: [Buffer.from([0x87, 5, 1, 2, 3, 4, 5])] },
      "CERTIFICATE_INVALID",
      "leafPem",
      "ip_san_unsupported",
    );
    await refuse({ dns: [], ip: ["192.0.2.10"], cn: "192.0.2.10" }, "CERTIFICATE_INVALID", "leafPem", "ip_san_unsupported");
  });

  it("a URI SAN is not a DNS name: alone it is no_dns_san, and one that embeds `, DNS:` is not parsed as one", async () => {
    const uri = (text: string): Buffer => Buffer.concat([Buffer.from([0x86, text.length]), Buffer.from(text, "latin1")]);
    await refuse({ dns: [], cn: null, rawSans: [uri("https://example.com")] }, "CERTIFICATE_INVALID", "leafPem", "no_dns_san");
    await refuse({ dns: ["example.com"], rawSans: [uri("https://x/, DNS:evil.example.com")] }, "CERTIFICATE_INVALID", "leafPem", "san_invalid");
  });

  it.each(["a*.example.com", "*a.example.com", "*example.com", "**.example.com", "*.*.example.com", "*.example.*", "*.", "w*", "a.*.example.com"])(
    "the SAN %s is unsupported_wildcard, even next to a valid name",
    async (name) => {
      await refuse({ dns: ["example.com", name], cn: "example.com" }, "CERTIFICATE_INVALID", "leafPem", "unsupported_wildcard");
    },
  );

  it.each(["EXAMPLE.COM.", "example.com ", " example.com", ".example.com", "*.example.com.", "*.EXAMPLE.com.", "exa\tmple.com", "Ünï.example.com"])(
    "the SAN %j is san_invalid",
    async (name) => {
      await refuse({ dns: [name], cn: null }, "CERTIFICATE_INVALID", "leafPem", "san_invalid");
    },
  );

  it("upper-case names and wildcards are lower-cased, de-duplicated by case and sorted", async () => {
    const { input, validator } = good({ dns: ["WWW.Example.COM", "*.EXAMPLE.com", "www.example.com", "Example.Com"], cn: null });
    const result = await validator.validate(input);
    expect(result.sanDns).toEqual(["*.example.com", "example.com", "www.example.com"]);
    expect(result.wildcard).toBe(true);
  });

  describe("dates on the real clock", () => {
    it("expiring in 23 h is expires_within_24h; in 25 h it is accepted", async () => {
      const soon = good({ notAfter: new Date(Date.now() + 23 * HOUR) });
      expectRefused(await rejection(soon.validator.validate(soon.input)), "CERTIFICATE_EXPIRED", "leafPem", "expires_within_24h", soon.input);
      const later = good({ notAfter: new Date(Date.now() + 25 * HOUR) });
      await expect(later.validator.validate(later.input)).resolves.toBeDefined();
    });

    it("expired an hour ago is expired; valid from tomorrow is not_yet_valid", async () => {
      await refuse({ notBefore: new Date(Date.now() - 30 * DAY), notAfter: new Date(Date.now() - HOUR) }, "CERTIFICATE_EXPIRED", "leafPem", "expired");
      await refuse({ notBefore: new Date(Date.now() + DAY), notAfter: new Date(Date.now() + 90 * DAY) }, "CERTIFICATE_NOT_YET_VALID", "leafPem", "not_yet_valid");
    });

    it("an inverted validity window (notBefore after notAfter) is refused with a date code", async () => {
      const { input, validator } = good({ notBefore: new Date(Date.now() + DAY), notAfter: new Date(Date.now() - DAY) });
      const error = await rejection(validator.validate(input));
      expect(["CERTIFICATE_NOT_YET_VALID", "CERTIFICATE_EXPIRED"]).toContain(error.code);
    });

    it("dates on both sides of the 2050 UTCTime / GeneralizedTime switch are read correctly", async () => {
      for (const year of ["2049-12-31T23:59:59Z", "2051-01-01T00:00:00Z"]) {
        const notAfter = new Date(year);
        const { input, validator } = good({ notAfter });
        expect((await validator.validate(input)).notAfter).toEqual(notAfter);
      }
    });
  });
});

describe("keys (TLS-02)", () => {
  const FORMAT = "CERTIFICATE_FORMAT_UNSUPPORTED" as const;

  it.each([
    ["RSA 1536", () => ({ key: { type: "rsa", bits: 1536 } }) satisfies CertSpec],
    ["RSA-PSS 2048", () => ({ key: generateKeyPairSync("rsa-pss", { modulusLength: 2048 }) }) satisfies CertSpec],
    ["secp521r1", () => ({ key: generateKeyPairSync("ec", { namedCurve: "secp521r1" }) }) satisfies CertSpec],
    ["brainpoolP256r1", () => ({ key: generateKeyPairSync("ec", { namedCurve: "brainpoolP256r1" }) }) satisfies CertSpec],
  ])("%s is key_algorithm", async (_name, spec) => {
    const { input, validator } = good(spec());
    expectRefused(await rejection(validator.validate(input)), FORMAT, "privateKeyPem", "key_algorithm", input);
  });

  it("a weak key is reported before a mismatch, an expiry or a CA flag", async () => {
    const weak = good({ key: { type: "rsa", bits: 1024 }, basicConstraints: "ca", notAfter: new Date(Date.now() - DAY), notBefore: new Date(Date.now() - 9 * DAY) });
    expectRefused(await rejection(weak.validator.validate(weak.input)), FORMAT, "privateKeyPem", "key_algorithm");
  });

  it.each([
    ["RSA certificate, another RSA key", { type: "rsa", bits: 2048 }, () => generateKey({ type: "rsa", bits: 2048 })],
    ["EC certificate, an RSA key", { type: "ec", curve: "prime256v1" }, () => generateKey({ type: "rsa", bits: 2048 })],
    ["RSA certificate, an EC key", { type: "rsa", bits: 2048 }, () => generateKey({ type: "ec", curve: "secp384r1" })],
    ["P-256 certificate, a P-384 key", { type: "ec", curve: "prime256v1" }, () => generateKey({ type: "ec", curve: "secp384r1" })],
  ] as const)("%s is key_mismatch, ahead of the date and CA checks", async (_name, certKey, otherKey) => {
    const { input, validator } = good({ key: certKey, basicConstraints: "ca", notAfter: new Date(Date.now() - DAY), notBefore: new Date(Date.now() - 9 * DAY) });
    const wrong = { ...input, privateKeyPem: otherKey().privateKey.export({ type: "pkcs8", format: "pem" }) as string };
    expectRefused(await rejection(validator.validate(wrong)), "CERTIFICATE_KEY_MISMATCH", "privateKeyPem", "key_mismatch", wrong);
  });

  it("the key of the intermediate does not unlock the leaf", async () => {
    const { pki, input, validator } = good();
    const wrong = { ...input, privateKeyPem: pki.intermediate.keyPem };
    expectRefused(await rejection(validator.validate(wrong)), "CERTIFICATE_KEY_MISMATCH", "privateKeyPem", "key_mismatch", wrong);
  });

  it("an encrypted EC key (SEC1 + Proc-Type) and an encrypted PKCS#8 key never echo their passphrase", async () => {
    const { pki, input, validator } = good();
    const sec1 = pki.leaf.key.privateKey.export({ type: "sec1", format: "pem", cipher: "aes-256-cbc", passphrase: "hunter2-secret" }) as string;
    expect(sec1).toContain("ENCRYPTED");
    const pkcs8 = encryptedKeyPem(pki.leaf.key, "hunter2-secret");
    for (const privateKeyPem of [sec1, pkcs8]) {
      const hostile = { ...input, privateKeyPem };
      const error = await rejection(validator.validate(hostile));
      expectRefused(error, FORMAT, "privateKeyPem", "encrypted_key", hostile);
      expect(JSON.stringify([error.message, error.details, error.stack])).not.toContain("hunter2");
    }
  });

  it("a certificate and its key swapped between the fields are wrong_block_type, not a crash", async () => {
    const { input, validator } = good();
    const swapped = { ...input, leafPem: input.privateKeyPem, privateKeyPem: input.leafPem };
    expectRefused(await rejection(validator.validate(swapped)), FORMAT, "leafPem", "wrong_block_type");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Defects found by this suite, now fixed and pinned as normal tests.
// ---------------------------------------------------------------------------------------------------------------
describe("former defects (fixed: the validator refuses these with a stable code)", () => {
  /** Runs a validation with the process-level exception handlers swapped for a recorder. */
  async function withUncaughtRecorder(work: () => Promise<unknown>): Promise<{ uncaught: unknown[]; settled: "resolved" | "rejected" | "pending" }> {
    const uncaught: unknown[] = [];
    const saved = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    const record = (error: unknown): void => void uncaught.push(error);
    process.on("uncaughtException", record);
    let settled: "resolved" | "rejected" | "pending" = "pending";
    void work().then(
      () => (settled = "resolved"),
      () => (settled = "rejected"),
    );
    try {
      for (let waited = 0; waited < 1_500 && uncaught.length === 0 && settled === "pending"; waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      process.off("uncaughtException", record);
      for (const listener of saved) process.on("uncaughtException", listener);
    }
    return { uncaught, settled };
  }

  // tls-certificate-validator.ts: handshake() calls tls.connect({ servername: <first SAN> }) inside server.listen's
  // callback. Node throws ERR_INVALID_ARG_VALUE synchronously for an IP-shaped servername; that throw is outside the
  // Promise executor's frame, so it becomes an uncaught exception (process crash in production) and the validation
  // hangs until the 5 s timer. DNS_NAME accepts "1.2.3.4" as a hostname, so any importer can trigger it.
  it("a DNS SAN shaped like an IPv4 address is refused as ip_san_unsupported, without an uncaught exception", async () => {
    const { input, validator } = good({ dns: ["1.2.3.4"], cn: null });
    const { uncaught, settled } = await withUncaughtRecorder(() => validator.validate(input));
    expect(uncaught).toEqual([]);
    expect(settled).toBe("rejected");
    expectRefused(await rejection(validator.validate(input)), "CERTIFICATE_INVALID", "leafPem", "ip_san_unsupported");
  });

  // pemBlocks() matches `([^-]*)` for the body: a block whose body holds a single "-" (an RFC 1421 header such as
  // `DEK-Info:` / `Proc-Type:`, or a stray dash) is not matched at all. checkPemShape lets it through (it only refuses
  // "-----"), so a leaf or key block yields `blocks[0]!` = undefined -> a raw TypeError (500, not a stable 4xx), and a
  // chain block is silently dropped instead of refused.
  it.each([
    ["leafPem", "CERTIFICATE_FORMAT_UNSUPPORTED"],
    ["privateKeyPem", "CERTIFICATE_FORMAT_UNSUPPORTED"],
    ["chainPem", "CERTIFICATE_FORMAT_UNSUPPORTED"],
  ] as const)("a '-' inside the body of a %s block is refused as not_pem with a ControlPlaneError", async (field, code) => {
    const { input, validator } = good();
    const poison = (pem: string): string => pem.replace(/^(-----BEGIN [A-Z ]+-----\n.{8})./, "$1-");
    const hostile = { ...input, [field]: poison(input[field]) };
    expectRefused(await rejection(validator.validate(hostile)), code, field, "not_pem", hostile);
  });

  it("a certificate with a `Proc-Type: 4,ENCRYPTED`-style header line is refused as not_pem, not a TypeError", async () => {
    const { input, validator } = good();
    const hostile = { ...input, leafPem: input.leafPem.replace(/^(-----BEGIN CERTIFICATE-----\n)/, "$1Proc-Type: 4,ENCRYPTED\n\n") };
    expectRefused(await rejection(validator.validate(hostile)), "CERTIFICATE_FORMAT_UNSUPPORTED", "leafPem", "not_pem", hostile);
  });

  // DNS_NAME has no 253-character cap although the IPC schema (TlsHostnameSchema) refuses names over 253.
  it("a DNS SAN over 253 characters is san_invalid", async () => {
    const name = `${`${"a".repeat(63)}.`.repeat(5)}com`;
    expect(name.length).toBeGreaterThan(253);
    const { input, validator } = good({ dns: [name], cn: null });
    expectRefused(await rejection(validator.validate(input)), "CERTIFICATE_INVALID", "leafPem", "san_invalid");
  });

  // SPEC 4: "successione degli issuer" must be checked; an out-of-order chain is stored and later served as uploaded.
  it("intermediates uploaded in the wrong order are refused as untrusted_or_incomplete", async () => {
    const long = issueLongChain(2, ["example.com"]);
    const blocks = long.chainPem.match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----\n/g)!;
    const validator = validatorFor(long);
    const base = { leafPem: long.leaf.pem, privateKeyPem: long.leaf.keyPem };
    expectRefused(
      await rejection(validator.validate({ ...base, chainPem: blocks.slice().reverse().join("") })),
      "CERTIFICATE_CHAIN_INVALID",
      "chainPem",
      "untrusted_or_incomplete",
    );
    expect((await validator.validate({ ...base, chainPem: blocks.join("") })).chainPem).toBe(blocks.join(""));
  });

  // SPEC line 109: arbitrary concatenations are refused; chainPem is "soli intermedi" of the path.
  it("a certificate that is not part of the path (unrelated CA, the leaf itself, a duplicate) is refused", async () => {
    const { pki, input, validator } = good();
    const stranger = issueCert({ cn: "Unrelated CA", basicConstraints: "ca", eku: null });
    for (const [extra, reason] of [
      [stranger.pem, "untrusted_or_incomplete"],
      [pki.leaf.pem, "chain_invalid"],
      [pki.intermediate.pem, "chain_invalid"],
    ] as const) {
      expectRefused(
        await rejection(validator.validate({ ...input, chainPem: input.chainPem + extra })),
        "CERTIFICATE_CHAIN_INVALID",
        "chainPem",
        reason,
      );
    }
  });
});
