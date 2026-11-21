import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_PUBLIC_DTO_KEYS,
  findForbiddenPublicDtoKeys,
  findPemValues,
  findPlaintextSecretKeys,
  redactSensitiveString,
  redactSensitiveValue,
} from "../src/index.js";

// Synthetic, not a real key: the body is a short base64 filler.
const KEY_BLOCK = [
  "-----BEGIN PRIVATE KEY-----",
  "MC4CAQAwBQYDK2VwBCIEIFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK",
  "-----END PRIVATE KEY-----",
].join("\n");
const CERT_BLOCK = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE",
  "-----END CERTIFICATE-----",
].join("\n");

describe("PEM redaction in strings", () => {
  it("replaces a full private key block and keeps the surrounding text", () => {
    const out = redactSensitiveString(`upload failed for ${KEY_BLOCK} (retry later)`);
    expect(out).toBe("upload failed for [REDACTED_PEM] (retry later)");
    expect(out).not.toContain("FAKE");
  });

  it("replaces RSA, EC and encrypted key block types", () => {
    for (const type of ["RSA PRIVATE KEY", "EC PRIVATE KEY", "ENCRYPTED PRIVATE KEY"]) {
      const block = `-----BEGIN ${type}-----\nQUJDREVGRw==\n-----END ${type}-----`;
      expect(redactSensitiveString(`x ${block} y`)).toBe("x [REDACTED_PEM] y");
    }
  });

  it("replaces any label of letters, digits, dots and spaces, in any case, not only the standard ones", () => {
    for (const type of ["X9.42 DH PRIVATE KEY", "private key", "OPENSSH PRIVATE KEY", "DSA PARAMETERS", "Weird Label 2"]) {
      const block = `-----BEGIN ${type}-----\nQUJDREVGRw==\n-----END ${type}-----`;
      expect(redactSensitiveString(`x ${block} y`), type).toBe("x [REDACTED_PEM] y");
    }
    expect(redactSensitiveString("x -----BEGIN x9.42 dh private key-----\nQUJD")).toBe("x [REDACTED_PEM]");
  });

  it("keeps a label bounded at 64 characters and linear on 2 MB of label-like text", () => {
    const unit = `-----BEGIN ${"A.".repeat(32)}-----\nxx\n-----END ${"A.".repeat(32)}-----\n`;
    expect(redactSensitiveString(unit)).toBe("[REDACTED_PEM]\n");
    const lookalikes = "-----BEGIN A.b c-----BEGIN ".repeat(Math.ceil((2 * 1024 * 1024) / 27));
    const started = performance.now();
    redactSensitiveString(lookalikes);
    redactSensitiveString(`-----BEGIN ${"a".repeat(2 * 1024 * 1024)}`);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("replaces a truncated block up to the end of the string", () => {
    const truncated = `error: -----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIFAKEFAKE`;
    expect(redactSensitiveString(truncated)).toBe("error: [REDACTED_PEM]");
  });

  it("replaces a certificate block and several blocks in one string", () => {
    expect(redactSensitiveString(CERT_BLOCK)).toBe("[REDACTED_PEM]");
    expect(redactSensitiveString(`${CERT_BLOCK}\n${KEY_BLOCK}`)).toBe("[REDACTED_PEM]\n[REDACTED_PEM]");
  });

  it("leaves a string without a PEM block unchanged and keeps the bearer redaction", () => {
    expect(redactSensitiveString("BEGIN is a word, END too")).toBe("BEGIN is a word, END too");
    expect(redactSensitiveString("Bearer abc.def-ghi")).toBe("Bearer [REDACTED]");
  });

  it("reaches nested strings through redactSensitiveValue", () => {
    const value = { error: { message: `bad ${KEY_BLOCK}` }, list: [CERT_BLOCK], count: 2 };
    expect(redactSensitiveValue(value)).toEqual({
      error: { message: "bad [REDACTED_PEM]" },
      list: ["[REDACTED_PEM]"],
      count: 2,
    });
  });
});

describe("PEM key names", () => {
  it("treat privateKeyPem and keyPem (camel and snake case) as forbidden DTO keys", () => {
    expect(FORBIDDEN_PUBLIC_DTO_KEYS).toContain("privateKeyPem");
    expect(FORBIDDEN_PUBLIC_DTO_KEYS).toContain("keyPem");
    const body = { cert: { privateKeyPem: "x", keyPem: "y", private_key_pem: "z", key_pem: "w" }, leafPem: "ok" };
    expect(findForbiddenPublicDtoKeys(body)).toEqual([
      "cert.privateKeyPem",
      "cert.keyPem",
      "cert.private_key_pem",
      "cert.key_pem",
    ]);
  });

  it("flag a non-empty privateKeyPem as a plaintext secret and redact it", () => {
    expect(findPlaintextSecretKeys({ a: { privateKeyPem: KEY_BLOCK } })).toEqual(["a.privateKeyPem"]);
    expect(findPlaintextSecretKeys({ a: { keyPem: "" } })).toEqual([]);
    expect(redactSensitiveValue({ privateKeyPem: KEY_BLOCK, keyPem: "k", leafPem: "kept" })).toEqual({
      privateKeyPem: "[REDACTED]",
      keyPem: "[REDACTED]",
      leafPem: "kept",
    });
  });
});

describe("findPemValues", () => {
  it("returns the paths of the strings that hold a PEM block", () => {
    const payload = {
      ok: "plain",
      cert: CERT_BLOCK,
      nested: { list: ["fine", `see ${KEY_BLOCK}`], deep: { text: "-----BEGIN PRIVATE KEY-----" } },
      n: 1,
      nothing: null,
    };
    expect(findPemValues(payload)).toEqual(["cert", "nested.list[1]", "nested.deep.text"]);
  });

  it("returns [] for values without a PEM block and for non-objects", () => {
    expect(findPemValues({ a: "BEGIN", b: ["x"], c: { d: "---BEGIN" } })).toEqual([]);
    expect(findPemValues("-----BEGIN CERTIFICATE-----")).toEqual([""]);
    expect(findPemValues(null)).toEqual([]);
    expect(findPemValues(42)).toEqual([]);
    expect(findPemValues(undefined)).toEqual([]);
  });

  it("walks cyclic-free arrays at the root", () => {
    expect(findPemValues([CERT_BLOCK, "x"])).toEqual(["[0]"]);
  });
});
