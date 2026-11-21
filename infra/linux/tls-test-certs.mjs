/**
 * Node-only X.509 v3 builder for the manual-certificate acceptance script (accept-tls-manual.mjs).
 *
 * ECDSA P-256 certificates assembled as DER by hand and signed with node:crypto: no external tool, no
 * dependency. Test material only; every key lives in memory and is thrown away with the process.
 *
 *   makeCert({ sans, cn, days, ca, issuer, notBefore })  one certificate (self-signed without `issuer`)
 *   makeChain({ sans, cn })                              root -> intermediate -> leaf
 *
 * `cn` defaults to the first SAN; pass a CN that is not in `sans` to build the "CN not in SAN"
 * certificate (Traefik indexes and serves on the CN even then, see arch-tls-ingress E13/E14).
 * `sans` may be empty (no SAN extension at all).
 */
import { X509Certificate, generateKeyPairSync, randomBytes, sign } from "node:crypto";

const len = (n) => {
  if (n < 128) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 255);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
// DER INTEGERs are minimal: drop redundant leading zero bytes (OpenSSL refuses them as
// "illegal padding"), then add one back only when the high bit would make the value negative.
const int = (raw) => {
  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0 && (raw[start + 1] & 0x80) === 0) start += 1;
  const buf = raw.subarray(start);
  return tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
};
const oid = (dotted) => {
  const arcs = dotted.split(".").map(Number);
  const out = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const groups = [];
    let v = arc;
    do {
      groups.unshift(v & 127);
      v >>= 7;
    } while (v > 0);
    for (let i = 0; i < groups.length - 1; i++) groups[i] |= 128;
    out.push(...groups);
  }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (s) => tlv(0x0c, Buffer.from(s, "utf8"));
const utc = (d) => tlv(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`));
const bits = (buf, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), buf]));
const octets = (buf) => tlv(0x04, buf);
const ctx = (n, body) => tlv(0xa0 + n, body);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const extension = (id, value, critical = false) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

const ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const pemOf = (der) => `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`;

/**
 * @param {object} o
 * @param {string[]} [o.sans] DNS SANs
 * @param {string} [o.cn] subject CN (default: first SAN)
 * @param {number} [o.days] validity in days from now (default 90)
 * @param {Date} [o.notBefore] default: one hour ago
 * @param {boolean} [o.ca] CA certificate (basicConstraints cA, keyCertSign) instead of a serverAuth leaf
 * @param {{key: import("node:crypto").KeyObject, nameDer: Buffer}} [o.issuer] signer; omit for self-signed
 */
export function makeCert({ sans = [], cn = sans[0] ?? "hp-test", days = 90, notBefore, ca = false, issuer } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const alg = seq(oid(ECDSA_SHA256));
  const nameDer = seq(set(seq(oid("2.5.4.3"), utf8(cn))));
  const from = notBefore ?? new Date(Date.now() - 3600e3);
  const until = new Date(Date.now() + days * 86400e3);
  const extensions = [
    ...(sans.length > 0
      ? [extension("2.5.29.17", seq(...sans.map((name) => tlv(0x82, Buffer.from(name)))))]
      : []),
    extension("2.5.29.19", ca ? seq(bool(true)) : seq(), true),
    ...(ca
      ? [extension("2.5.29.15", bits(Buffer.from([0x06]), 1), true)] // keyCertSign, cRLSign
      : [extension("2.5.29.37", seq(oid(SERVER_AUTH)))]),
  ];
  const tbs = seq(
    ctx(0, int(Buffer.from([2]))),
    int(randomBytes(16)),
    alg,
    issuer?.nameDer ?? nameDer,
    seq(utc(from), utc(until)),
    nameDer,
    publicKey.export({ type: "spki", format: "der" }),
    ctx(3, seq(...extensions)),
  );
  const der = seq(tbs, alg, bits(sign("sha256", tbs, issuer?.key ?? privateKey)));
  const certPem = pemOf(der);
  const x = new X509Certificate(certPem);
  if (!x.checkPrivateKey(privateKey)) throw new Error("test certificate does not match its key");
  if (issuer?.publicKey ? !x.verify(issuer.publicKey) : !x.verify(publicKey)) throw new Error("test certificate signature check failed");
  return {
    certPem,
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    key: privateKey,
    publicKey,
    nameDer,
    fp: x.fingerprint256.replaceAll(":", "").toLowerCase(),
    x,
  };
}

/** Root CA -> intermediate CA -> serverAuth leaf. `fullchainPem` is leaf + intermediate (the root is not served). */
export function makeChain({ sans = [], cn, days = 90 } = {}) {
  const root = makeCert({ cn: "HP Test Root CA", ca: true, days: days + 400 });
  const intermediate = makeCert({ cn: "HP Test Intermediate CA", ca: true, days: days + 200, issuer: root });
  const leaf = makeCert({ sans, ...(cn === undefined ? {} : { cn }), days, issuer: intermediate });
  return {
    root,
    intermediate,
    leaf,
    fullchainPem: `${leaf.certPem}${intermediate.certPem}`,
    keyPem: leaf.keyPem,
    fp: leaf.fp,
  };
}
