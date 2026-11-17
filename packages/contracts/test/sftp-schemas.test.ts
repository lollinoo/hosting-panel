import { describe, expect, it } from "vitest";
import {
  SFTP_MAX_USERS,
  SFTP_USERNAME_PATTERN,
  SHA512_CRYPT_HASH_PATTERN,
  SftpAccessApplyIpcRequestSchema,
  SftpAccessUserSchema,
  SftpApplyIpcResponseSchema,
  SftpStatusReportWireSchema,
  type SftpAccessUser,
} from "../src/index.js";

// Published Drepper SHA-512 crypt vectors (from sftp-infra.md).
const HASH_WITHOUT_ROUNDS =
  "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1";
const HASH_WITH_ROUNDS_10000 =
  "$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v.";
const HASH_WITH_ROUNDS_5000 =
  "$6$rounds=5000$toolongsaltstrin$lQ8jolhgVRVhY4b5pZKaysCLi0QBxGoNeKQzQ3glMhwllF7oGDZxUhx1yxdYcz/e1JSbq3y6JMxxl8audkUEm0";
const HASH_WITH_ROUNDS_1400 =
  "$6$rounds=1400$anotherlongsalts$POfYwTEok97VWcjxIiSOjiykti.o/pQs.wPvMxQ6Fm7I6IoYN3CmLs66x9t0oSwbtEW7o7UmJEiDwGqd8p4ur1";
const HASH_WITH_ROUNDS_77777 =
  "$6$rounds=77777$short$WuQyW2YR.hBNpjjRhpYD/ifIw05xdfeEyQoMxIXbkvr0gge1a1x3yRULJ5CCaUeOxFmtlcGZelFl5CxtgfiAc0";

const VALID_FINGERPRINT = "SHA256:DpQ/0ofF8CkAqPsHW7jwFQRyQl9a/6hX0T+BCi463zM";

function makeUser(overrides: Partial<SftpAccessUser> = {}): SftpAccessUser {
  return {
    username: "s1a2b3c4d_web",
    passwordHash: HASH_WITHOUT_ROUNDS,
    siteId: "site_a",
    serviceInstanceId: "svc_a",
    ...overrides,
  };
}

describe("SFTP contracts schemas", () => {
  describe("SFTP_USERNAME_PATTERN", () => {
    it("accepts valid site-scoped usernames including min/max length bounds", () => {
      for (const ok of [
        "s1a2b3c4d_web",
        "ab_c",
        `${"a".repeat(15)}_${"b".repeat(16)}`,
        "a0_0",
      ]) {
        expect(SFTP_USERNAME_PATTERN.test(ok), `expected '${ok}' to match`).toBe(true);
        expect(SftpAccessUserSchema.safeParse(makeUser({ username: ok })).success).toBe(true);
      }
    });

    it("refuses upper-case letters, 1-char prefix, 17-char name part, delimiters and control chars", () => {
      const invalidNames = [
        "S1a2b3c4d_web",
        "s1A2b3c4d_web",
        "s1a2b3c4d_Web",
        "a_x",
        `s1a2b3c4d_${"a".repeat(17)}`,
        `${"a".repeat(16)}_web`,
        "s1a2b3c4d_a:b",
        "s1a2b3c4d_a b",
        "s1a2b3c4d_a/b",
        "s1a2b3c4d_a.b",
        "s1a2b3c4d_a\nb",
        "s1a2b3c4d_web\n",
        "s1a2b3c4d_a\0b",
        "s1a2b3c4d_",
        "s1a2b3c4dweb",
        "1a2b3c4d_web",
        "root",
        "",
      ];
      for (const bad of invalidNames) {
        expect(SFTP_USERNAME_PATTERN.test(bad), `expected '${JSON.stringify(bad)}' to fail`).toBe(
          false,
        );
        expect(SftpAccessUserSchema.safeParse(makeUser({ username: bad })).success).toBe(false);
      }
    });
  });

  describe("SHA512_CRYPT_HASH_PATTERN", () => {
    it("accepts published $6$ hashes with and without rounds=", () => {
      for (const validHash of [
        HASH_WITHOUT_ROUNDS,
        HASH_WITH_ROUNDS_10000,
        HASH_WITH_ROUNDS_5000,
        HASH_WITH_ROUNDS_1400,
        HASH_WITH_ROUNDS_77777,
      ]) {
        expect(SHA512_CRYPT_HASH_PATTERN.test(validHash)).toBe(true);
        expect(SftpAccessUserSchema.safeParse(makeUser({ passwordHash: validHash })).success).toBe(
          true,
        );
      }
    });

    it("refuses ':', newlines, $1$/$5$/$y$, empty string, and truncated or malformed hashes", () => {
      const valid86 = "a".repeat(86);
      const invalidHashes = [
        `$6$salt:bad$${valid86}`,
        `$6$saltstring$${"a".repeat(85)}:`,
        `$6$saltstring$${"a".repeat(40)}\n${"a".repeat(45)}`,
        `${HASH_WITHOUT_ROUNDS}\n`,
        `$6$salt\nstring$${valid86}`,
        `$1$saltstring$${valid86}`,
        `$5$saltstring$${valid86}`,
        `$y$j9T$saltstring$${valid86}`,
        "",
        HASH_WITHOUT_ROUNDS.slice(0, -1), // one character short (85-char digest)
        `${HASH_WITHOUT_ROUNDS}a`, // one character too long
        `$6$$${valid86}`, // empty salt
        `$6$${"s".repeat(17)}$${valid86}`, // 17-char salt
        `$6$rounds=999$saltstring$${valid86}`, // <4 digit rounds
        `$6$saltstring$${"a".repeat(85)}\0`,
      ];
      for (const bad of invalidHashes) {
        expect(SHA512_CRYPT_HASH_PATTERN.test(bad), `expected '${bad}' to fail`).toBe(false);
        expect(SftpAccessUserSchema.safeParse(makeUser({ passwordHash: bad })).success).toBe(false);
      }
    });
  });

  describe("siteId and serviceInstanceId", () => {
    it("accepts alphanumeric, '_' and '-' starting with alphanumeric up to 64 chars", () => {
      for (const id of ["a", "0", "site_1-prod", "A".repeat(64)]) {
        expect(
          SftpAccessUserSchema.safeParse(makeUser({ siteId: id, serviceInstanceId: id })).success,
        ).toBe(true);
      }
    });

    it("refuses leading '_' or '-', '/', ':', '..', empty string, and 65 characters for both ids", () => {
      const badIds = [
        "_site",
        "-site",
        "a/b",
        "a:b",
        "..",
        "a..b",
        "",
        "a".repeat(65),
        "a\nb",
        "a\0b",
        "a b",
      ];
      for (const bad of badIds) {
        expect(SftpAccessUserSchema.safeParse(makeUser({ siteId: bad })).success).toBe(false);
        expect(SftpAccessUserSchema.safeParse(makeUser({ serviceInstanceId: bad })).success).toBe(
          false,
        );
      }
    });
  });

  describe("SftpAccessApplyIpcRequestSchema", () => {
    it("accepts two users on the same site and service, and empty user list", () => {
      expect(SftpAccessApplyIpcRequestSchema.safeParse({ users: [] }).success).toBe(true);
      expect(
        SftpAccessApplyIpcRequestSchema.safeParse({
          users: [
            makeUser({ username: "s1a2b3c4d_one", siteId: "site_1", serviceInstanceId: "svc_1" }),
            makeUser({
              username: "s1a2b3c4d_two",
              passwordHash: HASH_WITH_ROUNDS_10000,
              siteId: "site_1",
              serviceInstanceId: "svc_1",
            }),
          ],
        }).success,
      ).toBe(true);
    });

    it("refuses duplicate usernames and one site mapped to two services", () => {
      const dupSameSite = SftpAccessApplyIpcRequestSchema.safeParse({
        users: [
          makeUser({ username: "s1a2b3c4d_dup", siteId: "site_1", serviceInstanceId: "svc_1" }),
          makeUser({ username: "s1a2b3c4d_dup", siteId: "site_1", serviceInstanceId: "svc_1" }),
        ],
      });
      expect(dupSameSite.success).toBe(false);

      const dupDiffSite = SftpAccessApplyIpcRequestSchema.safeParse({
        users: [
          makeUser({ username: "s1a2b3c4d_dup", siteId: "site_1", serviceInstanceId: "svc_1" }),
          makeUser({ username: "s1a2b3c4d_dup", siteId: "site_2", serviceInstanceId: "svc_2" }),
        ],
      });
      expect(dupDiffSite.success).toBe(false);

      const twoServicesSameSite = SftpAccessApplyIpcRequestSchema.safeParse({
        users: [
          makeUser({ username: "s1a2b3c4d_one", siteId: "site_1", serviceInstanceId: "svc_1" }),
          makeUser({ username: "s1a2b3c4d_two", siteId: "site_1", serviceInstanceId: "svc_2" }),
        ],
      });
      expect(twoServicesSameSite.success).toBe(false);
    });

    it("accepts 2000 users and refuses 2001 users", () => {
      const users2000: SftpAccessUser[] = Array.from({ length: SFTP_MAX_USERS }, (_, i) =>
        makeUser({
          username: `s1000000_u${String(i)}`,
          siteId: `site_${String(i)}`,
          serviceInstanceId: `svc_${String(i)}`,
        }),
      );
      expect(SftpAccessApplyIpcRequestSchema.safeParse({ users: users2000 }).success).toBe(true);

      const users2001: SftpAccessUser[] = [
        ...users2000,
        makeUser({
          username: "s1000000_extra",
          siteId: "site_extra",
          serviceInstanceId: "svc_extra",
        }),
      ];
      expect(SftpAccessApplyIpcRequestSchema.safeParse({ users: users2001 }).success).toBe(false);
    });

    it("refuses unknown keys on SftpAccessUserSchema and SftpAccessApplyIpcRequestSchema (strict)", () => {
      const badUserPw = SftpAccessUserSchema.safeParse({
        ...makeUser(),
        password: "plaintext-should-not-pass-through",
      });
      expect(badUserPw.success).toBe(false);

      const badUserExtra = SftpAccessUserSchema.safeParse({
        ...makeUser(),
        extra: true,
      });
      expect(badUserExtra.success).toBe(false);

      const badReq = SftpAccessApplyIpcRequestSchema.safeParse({
        users: [makeUser()],
        unexpected: "rejected",
      });
      expect(badReq.success).toBe(false);

      const badUserInReq = SftpAccessApplyIpcRequestSchema.safeParse({
        users: [{ ...makeUser(), extra: 1 }],
      });
      expect(badUserInReq.success).toBe(false);

      const parsedRes = SftpApplyIpcResponseSchema.safeParse({ applied: 1, extra: 2 });
      expect(parsedRes.success).toBe(true);
      if (parsedRes.success) {
        expect(parsedRes.data).not.toHaveProperty("extra");
      }
    });
  });

  describe("SftpStatusReportWireSchema", () => {
    it("accepts valid ports, SHA256:+43 base64 fingerprints, and null fingerprint", () => {
      expect(
        SftpStatusReportWireSchema.safeParse({
          running: true,
          port: 2222,
          hostKeyFingerprint: VALID_FINGERPRINT,
        }).success,
      ).toBe(true);
      expect(
        SftpStatusReportWireSchema.safeParse({
          running: false,
          port: 1,
          hostKeyFingerprint: null,
        }).success,
      ).toBe(true);
      expect(
        SftpStatusReportWireSchema.safeParse({
          running: false,
          port: 65535,
          hostKeyFingerprint: null,
        }).success,
      ).toBe(true);
    });

    it("refuses port 0, 65536, and invalid hostKeyFingerprint values", () => {
      for (const badPort of [0, 65536, -1, 22.5]) {
        expect(
          SftpStatusReportWireSchema.safeParse({
            running: true,
            port: badPort,
            hostKeyFingerprint: null,
          }).success,
        ).toBe(false);
      }

      const badFingerprints = [
        `${VALID_FINGERPRINT}=`, // trailing '=' padding
        VALID_FINGERPRINT.slice(0, -1), // 42 chars
        `${VALID_FINGERPRINT}A`, // 44 chars
        "SHA512:DpQ/0ofF8CkAqPsHW7jwFQRyQl9a/6hX0T+BCi463zM",
        "SHA256:DpQ_0ofF8CkAqPsHW7jwFQRyQl9a-6hX0T+BCi463zM", // base64url '-'/'_'
        "DpQ/0ofF8CkAqPsHW7jwFQRyQl9a/6hX0T+BCi463zM",
        "",
      ];
      for (const badFp of badFingerprints) {
        expect(
          SftpStatusReportWireSchema.safeParse({
            running: true,
            port: 2222,
            hostKeyFingerprint: badFp,
          }).success,
          `expected '${badFp}' to fail`,
        ).toBe(false);
      }
    });
  });
});
