/**
 * Encoding and spelling edges of the application template validator (Q-ENCODE, acceptance rows A4, A7, A13): the same
 * power spelled in a way a naive string comparison would miss. Every row edits the SOURCE text of the notes-demo fixture
 * and goes through `validateAppTemplateSource`, so the YAML layer is part of what is tested.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_TEMPLATE_ISSUE_REASON, formatTemplatePath, type AppImageAllowlistEntry, type AppTemplateIssue, type AppTemplateIssueCode } from "@hosting-panel/contracts";
import { validateAppTemplateSource } from "../src/index.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../contracts/test/fixtures/app-stack-notes-demo/${name}`, import.meta.url), "utf8");
const SOURCE = fixture("source.yaml");
const ALLOWLIST = JSON.parse(fixture("allowlist.json")) as AppImageAllowlistEntry[];
const DIGEST = `sha256:${"a".repeat(64)}`;

/** The fixture with each [from, to] replaced once; a `from` that is not in the fixture is a bug in the test. */
function edit(...replacements: (readonly [from: string | RegExp, to: string])[]): string {
  let source = SOURCE;
  for (const [from, to] of replacements) {
    const next = source.replace(from, () => to);
    if (next === source) throw new Error(`the fixture does not contain ${String(from)}`);
    source = next;
  }
  return source;
}

const check = (source: string) => validateAppTemplateSource(source, { allowlist: ALLOWLIST });
const errorsOf = (source: string): AppTemplateIssue[] => {
  const result = check(source);
  if (result.ok) throw new Error("expected the source to be refused");
  return result.errors;
};

/** A source is refused with one of `codes` at `path`, and the issue carries the reason the code maps to. */
function expectRefused(source: string, codes: readonly AppTemplateIssueCode[], path: string): void {
  const errors = errorsOf(source);
  const hit = errors.find((issue) => issue.path === path && codes.includes(issue.code));
  expect(hit, `expected ${codes.join("|")} at "${path}", got ${JSON.stringify(errors.map((e) => [e.path, e.code]))}`).toBeDefined();
  expect(hit?.reason).toBe(APP_TEMPLATE_ISSUE_REASON[hit!.code]);
}

const json = (value: unknown): string => JSON.stringify(value);
const withCommand = (argv: readonly string[]): string => edit([/ {4}command: \[.*\]\n/, `    command: ${json(argv)}\n`]);
const withEnv = (name: string, value: string): string => edit(["      - name: CACHE_HOST\n        value: cache\n", `      - name: ${name}\n        value: ${json(value)}\n`]);
const withImage = (image: string): string => edit([/ {4}image: registry\.example\.invalid\/demo\/app:\S+\n/, `    image: ${json(image)}\n`]);
const withHealthPath = (path: string): string => edit(["      kind: tcp\n      port: 8080\n", `      kind: http\n      port: 8080\n      path: ${json(path)}\n`]);

describe("baseline", () => {
  it("the unchanged fixture is accepted", () => {
    expect(check(SOURCE).ok).toBe(true);
  });

  it("the edit helpers are neutral: re-spelling the same values is accepted", () => {
    expect(check(withCommand(["serve", "--workers", "${worker_count}"])).ok).toBe(true);
    expect(check(withEnv("CACHE_HOST", "cache")).ok).toBe(true);
    expect(check(withHealthPath("/health")).ok).toBe(true);
    expect(check(withImage(`registry.example.invalid/demo/app:1.2.3@${DIGEST}`)).ok).toBe(true);
  });
});

describe("A4: case variants and spelling of forbidden keys are unknown keys, never accepted", () => {
  const spellings = ["Privileged", "PRIVILEGED", "pRiVileged", "Network_Mode", "NETWORK_MODE", "Cap_Add", "CAP_ADD", "Ports", "PORTS", "Build", "Volumes_From", "privileged ", " privileged", "privileged\t"];

  it.each(spellings)("service key %j -> KEY_UNKNOWN", (key) => {
    const source = edit(["  app:\n    image:", `  app:\n    ${json(key)}: true\n    image:`]);
    expectRefused(source, ["KEY_UNKNOWN"], formatTemplatePath(["services", "app", key]));
  });

  it.each(["Privileged", "PRIVILEGED", "Hostname", "Ports"])("root key %s -> KEY_UNKNOWN", (key) => {
    expectRefused(`${SOURCE}${key}: true\n`, ["KEY_UNKNOWN"], key);
  });

  it.each(["Privileged", "Name", "Category"])("header key %s -> KEY_UNKNOWN", (key) => {
    expectRefused(edit(["x-hp-stack:\n", `x-hp-stack:\n  ${key}: true\n`]), ["KEY_UNKNOWN"], `x-hp-stack.${key}`);
  });

  it("a case variant of a known key is not the key: `Image` is unknown and `image` is then missing", () => {
    const source = edit([/ {4}image: registry\.example\.invalid\/demo\/app:/, "    Image: registry.example.invalid/demo/app:"]);
    const errors = errorsOf(source);
    expect(errors.map((issue) => issue.code)).toEqual(expect.arrayContaining(["KEY_UNKNOWN", "IMAGE_MISSING"]));
  });

  it("a case variant of a known health check key is not the key", () => {
    const errors = errorsOf(edit(["      kind: tcp\n", "      Kind: tcp\n"]));
    expect(errors.map((issue) => issue.code)).toEqual(expect.arrayContaining(["KEY_UNKNOWN", "HEALTH_KIND_INVALID"]));
  });

  it("the lower-case spelling stays a named refusal (the case variant is not just a weaker alias)", () => {
    expectRefused(edit(["  app:\n    image:", "  app:\n    privileged: true\n    image:"]), ["KEY_FORBIDDEN_SECURITY"], "services.app.privileged");
  });
});

describe("A7: argv[0] spellings of a shell", () => {
  const SHELL_CODES: AppTemplateIssueCode[] = ["ARGV_SHELL_REFUSED", "ARGV_ITEM_INVALID"];
  const argv0 = [
    "sh", "/bin/sh", "/bin//sh", "./sh", "../bin/sh", "/usr/bin/../bin/sh", "bash", "/usr/local/bin/dash", "ash",
    "zsh", "ksh", "mksh", "csh", "tcsh", "fish", "busybox", "/bin/busybox", "env", "/usr/bin/env", "/usr/bin//env", "sh ", " sh", "sh\t", "bash ",
  ];

  it.each(argv0)("argv[0] %j is refused", (executable) => {
    expectRefused(withCommand([executable, "-c", "x"]), SHELL_CODES, "services.app.command[0]");
  });

  it.each(["/bin/sh/", "/", ""])("argv[0] %j is refused (no executable name)", (executable) => {
    const errors = errorsOf(withCommand([executable, "serve"]));
    expect(errors.some((issue) => issue.path === "services.app.command[0]")).toBe(true);
  });

  it.each([1, 2, 3])("a shell name at argv[%i] is refused too (launcher route)", (index) => {
    const command = ["serve", "--a", "--b", "--c"];
    command[index] = "/bin/sh";
    expectRefused(withCommand(command), SHELL_CODES, `services.app.command[${index}]`);
  });

  it("names that merely contain a shell name are not shells", () => {
    expect(check(withCommand(["/usr/bin/shellcheck", "x"])).ok).toBe(true);
    expect(check(withCommand(["bashful", "x"])).ok).toBe(true);
  });
});

describe("A7: reserved and secret-like environment names", () => {
  const RESERVED: AppTemplateIssueCode[] = ["ENV_NAME_RESERVED"];
  it.each(["LD_PRELOAD", "LD_LIBRARY_PATH", "HP_X", "HP_SITE_ID", "DOCKER_HOST", "DOCKER_CONFIG", "PATH", "PHPRC", "PHP_INI_SCAN_DIR", "X_FILE", "DB_PASSWORD_FILE"])(
    "value entry %s -> ENV_NAME_RESERVED",
    (name) => {
      expectRefused(withEnv(name, "x"), RESERVED, "services.app.environment[0].name");
    },
  );

  it.each(["ld_preload", "Path", "path", "hp_x", "Docker_Host", "LD-PRELOAD", "LD_PRELOAD ", "1LD", "LD.PRELOAD", ""])(
    "spelling %j is not a valid name, never accepted",
    (name) => {
      expectRefused(withEnv(name, "x"), ["ENV_NAME_INVALID", "ENV_NAME_RESERVED"], "services.app.environment[0].name");
    },
  );

  it.each(["MY_PASSWORD", "API_TOKEN", "DB_SECRET", "PRIVATE_KEY"])("secret-looking value name %s is refused", (name) => {
    expectRefused(withEnv(name, "x"), ["ENV_NAME_SECRET_LIKE"], "services.app.environment[0].name");
  });

  it("a reserved name is refused as a secret entry too", () => {
    const source = edit(["      - name: APP_SECRET_FILE\n", "      - name: LD_PRELOAD_FILE\n"]);
    expectRefused(source, ["ENV_SECRET_NAME_INVALID"], "services.app.environment[1].name");
  });

  it("PORT is the documented exception", () => {
    expect(check(withEnv("PORT", "8080")).ok).toBe(true);
  });
});

describe("A13: image reference look-alikes", () => {
  const APP = "registry.example.invalid/demo/app";
  const IMAGE_CODES: AppTemplateIssueCode[] = ["IMAGE_MALFORMED", "IMAGE_NOT_ALLOWLISTED", "IMAGE_DIGEST_REQUIRED", "IMAGE_TAG_LATEST"];

  it.each([
    ["Docker Hub library image, digest pinned", `docker.io/library/memcached@${DIGEST}`],
    ["upper-case repository", `MEMCACHED@${DIGEST}`],
    ["bare library name", `memcached@${DIGEST}`],
    ["upper-case registry", `Registry.Example.Invalid/demo/app@${DIGEST}`],
    ["upper-case allowlisted repository", `registry.example.invalid/demo/APP@${DIGEST}`],
    ["suffix look-alike", `${APP}-evil@${DIGEST}`],
    ["prefix look-alike", `x${APP}@${DIGEST}`],
    ["registry look-alike host", `registry.example.invalid.evil.example/demo/app@${DIGEST}`],
    ["registry with a port", `registry.example.invalid:443/demo/app@${DIGEST}`],
    ["double slash", `registry.example.invalid//demo/app@${DIGEST}`],
    ["trailing slash", `${APP}/@${DIGEST}`],
    ["nested path", `${APP}/sub@${DIGEST}`],
    ["dot segment", `registry.example.invalid/demo/./app@${DIGEST}`],
    ["parent segment", `registry.example.invalid/demo/x/../app@${DIGEST}`],
    ["leading space", ` ${APP}@${DIGEST}`],
    ["trailing space", `${APP}@${DIGEST} `],
    ["upper-case digest hex", `${APP}@sha256:${"A".repeat(64)}`],
    ["upper-case digest algorithm", `${APP}@SHA256:${"a".repeat(64)}`],
    ["sha512 digest", `${APP}@sha512:${"a".repeat(128)}`],
    ["63-digit digest", `${APP}@sha256:${"a".repeat(63)}`],
    ["65-digit digest", `${APP}@sha256:${"a".repeat(65)}`],
    ["empty digest", `${APP}@`],
    ["two digests", `${APP}@${DIGEST}@${DIGEST}`],
    ["URL scheme", `https://${APP}@${DIGEST}`],
    ["credentials in the registry", `user:pw@registry.example.invalid/demo/app@${DIGEST}`],
  ])("%s is never accepted", (_name, image) => {
    const errors = errorsOf(withImage(image));
    const issue = errors.find((candidate) => candidate.path === "services.app.image");
    expect(issue, JSON.stringify(errors)).toBeDefined();
    expect(IMAGE_CODES).toContain(issue!.code);
    expect(issue!.reason).toBe("STACK_IMAGE_NOT_ALLOWED");
  });

  it("memcached:latest@sha256 is refused (a pinned digest does not excuse the latest tag)", () => {
    expectRefused(withImage(`memcached:latest@${DIGEST}`), ["IMAGE_TAG_LATEST", "IMAGE_NOT_ALLOWLISTED"], "services.app.image");
    expectRefused(withImage(`${APP}:latest@${DIGEST}`), ["IMAGE_TAG_LATEST"], "services.app.image");
  });

  it("an allowlisted repository with a different tag is accepted; only the exact name counts", () => {
    expect(check(withImage(`${APP}:9.9.9@${DIGEST}`)).ok).toBe(true);
    expect(check(withImage(`${APP}@${DIGEST}`)).ok).toBe(true);
  });

  it("never echoes the refused image reference", () => {
    const message = errorsOf(withImage(`docker.io/library/zzmarker@${DIGEST}`)).map((issue) => issue.message).join(" ");
    expect(message).not.toContain("zzmarker");
  });
});

describe("A7: metadata-endpoint literals in any case", () => {
  const METADATA = ["http://169.254.169.254/latest", "HTTP://169.254.169.254/", "metadata.google.internal", "Metadata.Google.Internal", "METADATA.GOOGLE.INTERNAL", "http://Metadata.Google.Internal/computeMetadata/v1/", "fd00:ec2::254", "FD00:EC2::254", "Fd00:Ec2::254", "http://[fd00:ec2::254]/", "x169.254.1.1"];

  it.each(METADATA)("environment value %j -> ENV_VALUE_METADATA_ENDPOINT", (value) => {
    expectRefused(withEnv("UPSTREAM", value), ["ENV_VALUE_METADATA_ENDPOINT"], "services.app.environment[0].value");
  });

  it.each(METADATA)("argv item %j -> ARGV_ITEM_INVALID", (value) => {
    expectRefused(withCommand(["serve", value]), ["ARGV_ITEM_INVALID"], "services.app.command[1]");
  });

  it.each(["/var/run/docker.sock", "/VAR/RUN/Docker.Sock", "DOCKER.SOCK"])("docker socket spelling %j in an env value is refused", (value) => {
    expectRefused(withEnv("UPSTREAM", value), ["ENV_VALUE_DOCKER_SOCKET"], "services.app.environment[0].value");
  });

  it("the unchanged literal next to them is fine", () => {
    expect(check(withEnv("UPSTREAM", "http://cache:6379/")).ok).toBe(true);
  });

  it("documented acceptance: the decimal IP form of the metadata address passes the text rule", () => {
    // 2852039166 == 169.254.169.254. Text rules cannot resolve addresses; the control is the network drop (T4), see ADR-0035.
    expect(check(withEnv("UPSTREAM", "http://2852039166/")).ok).toBe(true);
    expect(check(withCommand(["serve", "http://2852039166/"])).ok).toBe(true);
    // and the dotted form is refused, so this row is about the spelling, not about the host being allowed
    expect(check(withEnv("UPSTREAM", "http://169.254.169.254/")).ok).toBe(false);
  });
});

describe("health path traversal and encoding", () => {
  const BAD = [
    "/a/../b", "/..", "/a/..", "/../a", "/.", "/a/.", "/a/./b", "//a", "/a//b", "//", "/%2e", "/%2E", "/%2e%2e/x", "/a/%2e%2e/b", "/%2f", "/a%2fb",
    "a", "", "http://evil.example/", "/a?x=1", "/a#f", "/a b", "/a\\b", "/a;b", "/é", "/a‮b",
  ];

  it.each(BAD)("path %j -> HEALTH_PATH_INVALID", (path) => {
    expectRefused(withHealthPath(path), ["HEALTH_PATH_INVALID"], "services.app.healthcheck.path");
  });

  it.each(["/", "/health", "/a/b-c_d.e", "/v1.2/ready", "/a..b", "/.well-known"])("path %j is accepted", (path) => {
    expect(check(withHealthPath(path)).ok, JSON.stringify(path)).toBe(true);
  });

  it("a NUL in the path is refused (by the YAML layer, before the path rule)", () => {
    expect(check(withHealthPath("/a\u0000b")).ok).toBe(false);
  });

  it("a path with a placeholder is refused (no interpolation in a health check)", () => {
    expectRefused(withHealthPath("/${worker_count}"), ["HEALTH_PATH_INVALID"], "services.app.healthcheck.path");
  });
});
