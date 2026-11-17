import { describe, expect, it } from "vitest";
import { SHA512_CRYPT_HASH_PATTERN } from "@hosting-panel/contracts";
import { sha512Crypt } from "../src/sites/sha512-crypt.js";

describe("sha512Crypt (Drepper SHA-512 crypt $6$)", () => {
  it("matches all five published Drepper test vectors exactly", () => {
    expect(sha512Crypt("Hello world!", "saltstring")).toBe(
      "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1",
    );

    expect(sha512Crypt("Hello world!", "saltstringsaltstring", 10_000)).toBe(
      "$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v.",
    );

    expect(sha512Crypt("This is just a test", "toolongsaltstring", 5_000)).toBe(
      "$6$rounds=5000$toolongsaltstrin$lQ8jolhgVRVhY4b5pZKaysCLi0QBxGoNeKQzQ3glMhwllF7oGDZxUhx1yxdYcz/e1JSbq3y6JMxxl8audkUEm0",
    );

    expect(
      sha512Crypt(
        "a very much longer text to encrypt.  This one even stretches over morethan one line.",
        "anotherlongsaltstring",
        1_400,
      ),
    ).toBe(
      "$6$rounds=1400$anotherlongsalts$POfYwTEok97VWcjxIiSOjiykti.o/pQs.wPvMxQ6Fm7I6IoYN3CmLs66x9t0oSwbtEW7o7UmJEiDwGqd8p4ur1",
    );

    expect(
      sha512Crypt("we have a short salt string but not a short password", "short", 77_777),
    ).toBe(
      "$6$rounds=77777$short$WuQyW2YR.hBNpjjRhpYD/ifIw05xdfeEyQoMxIXbkvr0gge1a1x3yRULJ5CCaUeOxFmtlcGZelFl5CxtgfiAc0",
    );
  });

  it("uses default 5000 rounds without a rounds= prefix and a 16-char random salt", () => {
    const hash = sha512Crypt("test-password");
    expect(hash).toMatch(/^\$6\$[./0-9A-Za-z]{16}\$[./0-9A-Za-z]{86}$/);
    expect(hash).not.toContain("rounds=");
    expect(SHA512_CRYPT_HASH_PATTERN.test(hash)).toBe(true);
  });

  it("produces distinct salts across consecutive calls", () => {
    const first = sha512Crypt("same-password");
    const second = sha512Crypt("same-password");
    expect(first).not.toBe(second);
    expect(first.split("$")[2]).not.toBe(second.split("$")[2]);
  });

  it("truncates provided salts longer than 16 characters", () => {
    const longSalt = "0123456789abcdefEXTRA";
    expect(sha512Crypt("pw", longSalt)).toBe(sha512Crypt("pw", "0123456789abcdef"));
  });

  it("handles UTF-8 and empty passwords while matching SHA512_CRYPT_HASH_PATTERN", () => {
    expect(SHA512_CRYPT_HASH_PATTERN.test(sha512Crypt("", "saltstring"))).toBe(true);
    expect(SHA512_CRYPT_HASH_PATTERN.test(sha512Crypt("pàsswörd-€", "saltstring"))).toBe(true);
  });

  it("rejects empty or invalid salts and non-finite rounds", () => {
    expect(() => sha512Crypt("pw", "")).toThrow();
    expect(() => sha512Crypt("pw", "bad:salt")).toThrow();
    expect(() => sha512Crypt("pw", "bad\nsalt")).toThrow();
    expect(() => sha512Crypt("pw", "saltstring", Number.NaN)).toThrow();
  });
});
