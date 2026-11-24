import { createHash, randomInt } from "node:crypto";

// The "$apr1$" verifier of a password (MD5-crypt with the Apache magic, 1000 rounds): the salted form the proxy
// accepts for HTTP Basic that node:crypto can compute without a new dependency (ADR-0037). Only the verifier is stored.
const ALPHABET = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MAGIC = "$apr1$";
const SALT_PATTERN = /^[./0-9A-Za-z]{8}$/;
const ROUNDS = 1000;
/** Digest bytes per output group, most significant first; the last group is one byte. */
const GROUPS: readonly (readonly number[])[] = [[0, 6, 12], [1, 7, 13], [2, 8, 14], [3, 9, 15], [4, 10, 5], [11]];

function randomSalt(): string {
  let salt = "";
  for (let i = 0; i < 8; i += 1) salt += ALPHABET[randomInt(0, ALPHABET.length)];
  return salt;
}

function encode(digest: Buffer): string {
  let out = "";
  for (const group of GROUPS) {
    let value = 0;
    for (const index of group) value = (value << 8) | digest.readUInt8(index);
    // Six bits per character, least significant first: four characters for three bytes, two for the last byte.
    for (let n = group.length === 1 ? 2 : 4; n > 0; n -= 1) {
      out += ALPHABET[value & 0x3f];
      value >>>= 6;
    }
  }
  return out;
}

/** `$apr1$<salt>$<22 characters>`; a random salt of eight characters unless one is given (tests). */
export function apr1Verifier(password: string, salt: string = randomSalt()): string {
  if (!SALT_PATTERN.test(salt)) throw new Error("Invalid apr1 salt.");
  const pw = Buffer.from(password, "utf8");
  const saltBytes = Buffer.from(salt, "latin1");
  const alternate = createHash("md5").update(pw).update(saltBytes).update(pw).digest();
  const first = createHash("md5").update(pw).update(MAGIC).update(saltBytes);
  for (let left = pw.length; left > 0; left -= 16) first.update(alternate.subarray(0, Math.min(16, left)));
  for (let bits = pw.length; bits > 0; bits >>>= 1) first.update(bits & 1 ? Buffer.alloc(1) : pw.subarray(0, 1));
  let digest = first.digest();
  for (let round = 0; round < ROUNDS; round += 1) {
    const hash = createHash("md5").update(round & 1 ? pw : digest);
    if (round % 3 !== 0) hash.update(saltBytes);
    if (round % 7 !== 0) hash.update(pw);
    digest = hash.update(round & 1 ? digest : pw).digest();
  }
  return `${MAGIC}${salt}$${encode(digest)}`;
}
