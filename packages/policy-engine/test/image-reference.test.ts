import { describe, expect, it } from "vitest";
import { resolveWordpressImage, SUPPORTED_PHP_VERSIONS } from "@hosting-panel/contracts";
import { parseImageReference } from "../src/image-reference.js";

const DIGEST = `sha256:${"a1b2c3d4".repeat(8)}`;

function ok(ref: string) {
  const result = parseImageReference(ref);
  if (!result.ok) throw new Error(`expected ${JSON.stringify(ref)} to parse, got ${result.reason}`);
  return result.value;
}

function reason(ref: string) {
  const result = parseImageReference(ref);
  if (result.ok) throw new Error(`expected ${JSON.stringify(ref)} to fail, got ${JSON.stringify(result.value)}`);
  return result.reason;
}

describe("parseImageReference — accepted references", () => {
  it("parses a bare repository without applying any default", () => {
    expect(ok("wordpress")).toEqual({ registry: null, repository: "wordpress", tag: null, digest: null });
  });

  it("parses repository and tag", () => {
    expect(ok("wordpress:7.1.4-php8.4-apache")).toEqual({
      registry: null,
      repository: "wordpress",
      tag: "7.1.4-php8.4-apache",
      digest: null,
    });
  });

  it("parses repository and digest", () => {
    expect(ok(`wordpress@${DIGEST}`)).toEqual({ registry: null, repository: "wordpress", tag: null, digest: DIGEST });
  });

  it("parses tag and digest together", () => {
    expect(ok(`wordpress:1.2.3@${DIGEST}`)).toEqual({ registry: null, repository: "wordpress", tag: "1.2.3", digest: DIGEST });
  });

  it("keeps docker.io/library/wordpress distinct from wordpress", () => {
    expect(ok("docker.io/library/wordpress:1")).toEqual({
      registry: "docker.io",
      repository: "library/wordpress",
      tag: "1",
      digest: null,
    });
    expect(ok("library/wordpress:1")).toEqual({ registry: null, repository: "library/wordpress", tag: "1", digest: null });
  });

  it("reads a registry with a port and a nested path", () => {
    expect(ok("localhost:5000/a/b:1")).toEqual({ registry: "localhost:5000", repository: "a/b", tag: "1", digest: null });
    expect(ok("localhost/a")).toEqual({ registry: "localhost", repository: "a", tag: null, digest: null });
    expect(ok("registry.example.com:443/team/app")).toEqual({
      registry: "registry.example.com:443",
      repository: "team/app",
      tag: null,
      digest: null,
    });
  });

  it("treats a first component without a dot, port or localhost as part of the repository", () => {
    expect(ok("team/app:2")).toEqual({ registry: null, repository: "team/app", tag: "2", digest: null });
  });

  it("accepts every separator the distribution grammar allows", () => {
    expect(ok("team/a.b_c__d-e--f").repository).toBe("team/a.b_c__d-e--f");
  });

  it("accepts the longest tag and a 255 character reference", () => {
    expect(ok(`a:${"t".repeat(128)}`).tag).toBe("t".repeat(128));
    expect(parseImageReference(`${"a".repeat(253)}:1`).ok).toBe(true);
    expect(parseImageReference("a".repeat(255)).ok).toBe(true);
  });

  it("parses the pinned image of every supported PHP version", () => {
    for (const version of SUPPORTED_PHP_VERSIONS) {
      expect(ok(resolveWordpressImage(version))).toEqual({
        registry: null,
        repository: "wordpress",
        tag: `7.1.4-php${version}-apache`,
        digest: null,
      });
    }
  });
});

describe("parseImageReference — refused references", () => {
  it("refuses an empty string", () => {
    expect(reason("")).toBe("EMPTY");
  });

  it("refuses more than 255 characters", () => {
    expect(reason("a".repeat(256))).toBe("TOO_LONG");
  });

  it("refuses whitespace and control characters anywhere", () => {
    for (const ref of [" a", "a ", "a b", "a\tb", "a\nb", "a\u0000b", "a\u007fb", "a:1 "]) {
      expect(reason(ref), JSON.stringify(ref)).toBe("WHITESPACE");
    }
  });

  it("refuses an empty tag, a second tag and a missing repository", () => {
    expect(reason("a:")).toBe("TAG_INVALID");
    expect(reason("a:tag:tag")).toBe("MALFORMED");
    expect(reason(":tag")).toBe("MALFORMED");
    expect(reason("@" + DIGEST)).toBe("MALFORMED");
  });

  it("refuses a tag that breaks the tag grammar", () => {
    expect(reason(`a:${"t".repeat(129)}`)).toBe("TAG_INVALID");
    expect(reason("a:-1")).toBe("TAG_INVALID");
    expect(reason("a:.1")).toBe("TAG_INVALID");
    expect(reason("a:1+2")).toBe("TAG_INVALID");
  });

  it("refuses a digest that is not sha256 with 64 lower-case hex digits", () => {
    expect(reason("a@sha256:short")).toBe("DIGEST_INVALID");
    expect(reason("a@")).toBe("DIGEST_INVALID");
    expect(reason(`a@sha512:${"a".repeat(64)}`)).toBe("DIGEST_INVALID");
    expect(reason(`a@sha256:${"A".repeat(64)}`)).toBe("DIGEST_INVALID");
    expect(reason(`a@${DIGEST}@${DIGEST}`)).toBe("DIGEST_INVALID");
  });

  it("refuses upper case in the repository path", () => {
    expect(reason("WordPress:1")).toBe("MALFORMED");
    expect(reason("team/App")).toBe("MALFORMED");
  });

  it("refuses empty or badly punctuated path components", () => {
    for (const ref of ["a//b", "/a", "a/", "-a", "a-", "a--", ".a", "a..b", "a_", "a___b", "a/-b", "a!b", "a*b"]) {
      expect(reason(ref), ref).toBe("MALFORMED");
    }
  });

  it("refuses a malformed registry", () => {
    for (const ref of ["-bad.example/a", "bad_host.example/a", "host.example:/a", "host.example:port/a", "host.example:123456/a", "a..b/c"]) {
      expect(reason(ref), ref).toBe("MALFORMED");
    }
  });

  it("never throws and stays fast on hostile input", () => {
    const started = Date.now();
    for (const ref of ["-".repeat(255), "a".repeat(254) + "-", `${"a-".repeat(127)}!`, "/".repeat(255), ":".repeat(255), "@".repeat(255)]) {
      expect(parseImageReference(ref).ok).toBe(false);
    }
    expect(Date.now() - started).toBeLessThan(200);
  });
});
