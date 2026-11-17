import { createHash, randomInt } from "node:crypto";

const B64_ALPHABET = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const VALID_SALT_PATTERN = /^[./0-9A-Za-z]{1,16}$/;
const DEFAULT_ROUNDS = 5_000;
const MIN_ROUNDS = 1_000;
const MAX_ROUNDS = 999_999_999;
const MAX_SALT_LENGTH = 16;

const SHA512_PERMUTATION: readonly (readonly [number, number, number])[] = [
  [0, 21, 42],
  [22, 43, 1],
  [44, 2, 23],
  [3, 24, 45],
  [25, 46, 4],
  [47, 5, 26],
  [6, 27, 48],
  [28, 49, 7],
  [50, 8, 29],
  [9, 30, 51],
  [31, 52, 10],
  [53, 11, 32],
  [12, 33, 54],
  [34, 55, 13],
  [56, 14, 35],
  [15, 36, 57],
  [37, 58, 16],
  [59, 17, 38],
  [18, 39, 60],
  [40, 61, 19],
  [62, 20, 41],
];

function generateSalt(): string {
  let out = "";
  for (let i = 0; i < MAX_SALT_LENGTH; i += 1) {
    out += B64_ALPHABET[randomInt(0, B64_ALPHABET.length)];
  }
  return out;
}

function repeatDigest(digest: Buffer, length: number): Buffer {
  const out = Buffer.allocUnsafe(length);
  for (let offset = 0; offset < length; offset += digest.length) {
    const chunkLen = Math.min(digest.length, length - offset);
    digest.copy(out, offset, 0, chunkLen);
  }
  return out;
}

function b64From24Bit(b2: number, b1: number, b0: number, count: number): string {
  let w = ((b2 & 0xff) << 16) | ((b1 & 0xff) << 8) | (b0 & 0xff);
  let out = "";
  for (let i = 0; i < count; i += 1) {
    out += B64_ALPHABET[w & 0x3f];
    w >>>= 6;
  }
  return out;
}

/**
 * Drepper SHA-512 crypt (`$6$`), compatible with glibc/musl `crypt(3)` and OpenSSH.
 * Defaults to 5000 rounds (without a `rounds=` prefix) and a 16-character random salt.
 */
export function sha512Crypt(password: string, salt?: string, rounds?: number): string {
  const effectiveSalt = salt === undefined ? generateSalt() : salt.slice(0, MAX_SALT_LENGTH);
  if (!VALID_SALT_PATTERN.test(effectiveSalt)) {
    throw new Error("Invalid SHA-512 crypt salt.");
  }

  let actualRounds = DEFAULT_ROUNDS;
  let roundsPrefix = "";
  if (rounds !== undefined) {
    if (!Number.isFinite(rounds)) {
      throw new RangeError("SHA-512 crypt rounds must be a finite number.");
    }
    actualRounds = Math.min(MAX_ROUNDS, Math.max(MIN_ROUNDS, Math.trunc(rounds)));
    roundsPrefix = `rounds=${actualRounds}$`;
  }

  const key = Buffer.from(password, "utf8");
  const saltBuf = Buffer.from(effectiveSalt, "utf8");

  const digestB = createHash("sha512").update(key).update(saltBuf).update(key).digest();

  const ctxA = createHash("sha512").update(key).update(saltBuf);
  for (let remaining = key.length; remaining > 0; remaining -= 64) {
    ctxA.update(remaining >= 64 ? digestB : digestB.subarray(0, remaining));
  }
  for (let bits = key.length; bits > 0; bits >>= 1) {
    ctxA.update((bits & 1) !== 0 ? digestB : key);
  }
  let current = ctxA.digest();

  const ctxDP = createHash("sha512");
  for (let i = 0; i < key.length; i += 1) {
    ctxDP.update(key);
  }
  const pBytes = repeatDigest(ctxDP.digest(), key.length);

  const ctxDS = createHash("sha512");
  const dsIterations = 16 + current[0]!;
  for (let i = 0; i < dsIterations; i += 1) {
    ctxDS.update(saltBuf);
  }
  const sBytes = repeatDigest(ctxDS.digest(), saltBuf.length);

  for (let r = 0; r < actualRounds; r += 1) {
    const ctxC = createHash("sha512");
    ctxC.update((r & 1) !== 0 ? pBytes : current);
    if (r % 3 !== 0) {
      ctxC.update(sBytes);
    }
    if (r % 7 !== 0) {
      ctxC.update(pBytes);
    }
    ctxC.update((r & 1) !== 0 ? current : pBytes);
    current = ctxC.digest();
  }

  let encoded = "";
  for (const [i2, i1, i0] of SHA512_PERMUTATION) {
    encoded += b64From24Bit(current[i2]!, current[i1]!, current[i0]!, 4);
  }
  encoded += b64From24Bit(0, 0, current[63]!, 2);

  return `$6$${roundsPrefix}${effectiveSalt}$${encoded}`;
}
