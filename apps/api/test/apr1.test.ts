import { APP_ROUTE_PASSWORD_HASH_PATTERN } from "@hosting-panel/contracts";
import { describe, expect, it } from "vitest";
import { apr1Verifier } from "../src/app-stacks/apr1.js";

// Each vector is the output of `openssl passwd -apr1 -salt <salt> <password>` (OpenSSL 3.0.13).
const VECTORS: [string, string, string][] = [
  ["r31.....", "myPassword", "$apr1$r31.....$HqJZimcKQFAMYayBlzkrA/"],
  ["abcdefgh", "correct horse battery", "$apr1$abcdefgh$GQF3hbcxO2ySp4igPQ/3a."],
  // 16 and 17 bytes: either side of one digest length.
  ["Zz09./aB", "0123456789abcdef", "$apr1$Zz09./aB$C.kDlL5tkAxqWQE6WcD0z1"],
  ["saltsalt", "0123456789abcdefg", "$apr1$saltsalt$zEghXWGhM0psocYwTG.hX1"],
  ["........", "x", "$apr1$........$9pFeOtCA.ZbDw95kSOFEJ1"],
  ["AAAAAAAA", 'a pass with spaces and ~!@#$%^&*()_+{}|:"<>?', "$apr1$AAAAAAAA$J6eAfo6Iv7Db6T80zHQ43/"],
  ["q1w2e3r4", "k".repeat(128), "$apr1$q1w2e3r4$3EM/GETBheLD52x7xLf.y0"],
];

describe("apr1Verifier", () => {
  it.each(VECTORS)("salt %s gives the verifier OpenSSL gives", (salt, password, verifier) => {
    expect(apr1Verifier(password, salt)).toBe(verifier);
  });

  it("draws a new salt each time, in the shape the contracts and the executor accept", () => {
    const made = Array.from({ length: 20 }, () => apr1Verifier("correct horse battery"));
    for (const verifier of made) expect(verifier).toMatch(APP_ROUTE_PASSWORD_HASH_PATTERN);
    expect(new Set(made).size).toBe(20);
    expect(made.join("")).not.toContain("correct horse battery");
  });

  it("refuses a salt of another shape", () => {
    for (const salt of ["", "short", "ninechars", "bad$salt", "bad:salt"]) expect(() => apr1Verifier("x", salt)).toThrow("Invalid apr1 salt.");
  });
});
