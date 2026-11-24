import { describe, expect, it } from "vitest";
import { findPlaintextSecretKeys } from "@hosting-panel/contracts";
import {
  ENV_MAX_ENTRIES,
  ENV_NAME_PATTERN,
  ENV_VALUE_MAX_LENGTH,
  envNameProblem,
  envValueProblem,
} from "../src/site-template-env.js";

describe("env limits", () => {
  it("fixes the entry count, the value length and the name grammar", () => {
    expect(ENV_MAX_ENTRIES).toBe(64);
    expect(ENV_VALUE_MAX_LENGTH).toBe(4096);
    expect(ENV_NAME_PATTERN.test("A")).toBe(true);
  });
});

describe("envNameProblem", () => {
  it("accepts ordinary names", () => {
    for (const name of ["WORDPRESS_DEBUG", "A", "_X", "WORDPRESS_DEBUG_LOG", "WP_MEMORY_LIMIT", "A".repeat(64)]) {
      expect(envNameProblem(name), name).toBeNull();
    }
  });

  it("refuses names outside the grammar", () => {
    for (const name of ["", "A".repeat(65), "wordpress_debug", "1A", "A-B", "A B", "A.B", "É", "A\n", "a"]) {
      expect(envNameProblem(name), JSON.stringify(name)).toBe("ENV_NAME_INVALID");
    }
  });

  it("refuses names the platform owns or that would change how the container starts", () => {
    for (const name of ["HP_X", "HP_SITE_ID", "LD_PRELOAD", "DOCKER_HOST", "DB_PASSWORD_FILE", "X_FILE", "PATH", "PHPRC", "PHP_INI_SCAN_DIR", "PORT"]) {
      expect(envNameProblem(name), name).toBe("ENV_NAME_RESERVED");
    }
  });

  it("matches reserved names exactly or by prefix/suffix, not by substring", () => {
    for (const name of ["MYPATH", "PATH_INFO", "PORTAL", "SUPPORT", "HPX_Y", "MYHP_X", "FILE", "X_FILES", "SHADOCKER_X"]) {
      expect(envNameProblem(name), name).toBeNull();
    }
  });

  it("refuses names that look like secrets", () => {
    for (const name of [
      "DB_PASSWORD",
      "PASSWORD",
      "PASSWD",
      "MY_SECRET",
      "SECRETS",
      "API_TOKEN",
      "TOKEN",
      "STRIPE_API_KEY",
      "AUTH_KEY",
      "NONCE_SALT",
      "SALT",
      "PRIVATE_KEY",
      "CLIENT_SECRET",
      "JWT_SECRET_KEY",
      "AWS_ACCESS_KEY",
      "AWS_SECRET",
      "SIGNING_KEY",
      "MASTER_KEY",
      "ENCRYPTION_KEY",
      "SOME_CREDENTIALS",
      "KEY",
      "APIKEY",
      "PRIVATEKEY",
      "AUTHKEY",
      "PASSWORD_POLICY_URL",
    ]) {
      expect(envNameProblem(name), name).toBe("ENV_NAME_SECRET_LIKE");
    }
  });

  it("does not take a longer word for a secret segment", () => {
    for (const name of ["KEYBOARD_LAYOUT", "MONKEY_MODE", "TOKENIZER_MODE", "WORDPRESS_DEBUG_LOG", "SALTY_MODE", "KEY_ID", "SECRETARY", "CLIENT_ID"]) {
      expect(envNameProblem(name), name).toBeNull();
    }
  });

  it("is never laxer than the executor's own plaintext-secret gate", () => {
    for (const name of ["PASSWORD", "SECRET", "TOKEN", "MASTERKEY", "APIKEY", "PRIVATEKEY", "KEYPEM", "CONNECTIONSTRING", "CLIENT_SECRET", "AUTH_TOKEN", "KEY_PEM", "CONNECTION_STRING"]) {
      expect(findPlaintextSecretKeys({ [name]: "x" }), name).not.toEqual([]);
      expect(envNameProblem(name), name).not.toBeNull();
    }
  });

  it("answers reserved before secret-like for the _FILE channel", () => {
    expect(envNameProblem("DB_PASSWORD_FILE")).toBe("ENV_NAME_RESERVED");
    expect(envNameProblem("HP_ROOT_PASSWORD")).toBe("ENV_NAME_RESERVED");
  });
});

describe("envValueProblem", () => {
  it("accepts ordinary values, including the empty string", () => {
    for (const value of ["", "true", "http://example.com/a", "Bearer", "Bearer short", "skate", "sk-short", "https://example.com:8080/x", "http://host:8080/path@x", "https://host:8443/?to=a@b", "http://[::1]:8080/", "tcp://:8080", "mail@example.com", "a=b", "ünï ✓", "${HP_SITE_URL}"]) {
      expect(envValueProblem(value), value).toBeNull();
    }
  });

  it("refuses control characters and line breaks", () => {
    for (const value of ["a\nb", "a\rb", "a\u0000b", "a\tb", "a\u001bb", "a\u007fb", "a\u0085b", "a\u2028b", "a\u2029b"]) {
      expect(envValueProblem(value), JSON.stringify(value)).toBe("ENV_VALUE_INVALID");
    }
  });

  it("refuses secret-looking literals", () => {
    for (const value of [
      "-----BEGIN PRIVATE KEY-----",
      "-----BEGIN RSA PRIVATE KEY-----",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "Bearer abcdefghijklmnop12",
      "Basic dXNlcjpwYXNzd29yZDEyMzQ=",
      "AKIAIOSFODNN7EXAMPLE",
      `ghp_${"a".repeat(30)}`,
      `github_pat_${"A1_".repeat(10)}`,
      "xoxb-1234567890-abcdef",
      `sk-${"a1".repeat(12)}`,
      "https://u:p@host/",
      "postgres://admin:hunter2@db.internal:5432/app",
    ]) {
      expect(envValueProblem(value), value).toBe("ENV_VALUE_SECRET_LIKE");
    }
  });

  it("refuses the docker socket in any spelling", () => {
    for (const value of ["unix:///var/run/docker.sock", "docker.sock", "X=docker.SOCK", "/run/DOCKER.SOCK", "/var/run/docker.sock"]) {
      expect(envValueProblem(value), value).toBe("ENV_VALUE_DOCKER_SOCKET");
    }
  });

  it("names the more specific problem first when a multi-line value is a key or points at the socket", () => {
    expect(envValueProblem("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg")).toBe("ENV_VALUE_SECRET_LIKE");
    expect(envValueProblem("unix:///var/run/docker.sock\n")).toBe("ENV_VALUE_DOCKER_SOCKET");
  });

  it("agrees with the executor's unsafe-input gate on a docker socket path", () => {
    expect(envValueProblem("/var/run/docker.sock")).not.toBeNull();
  });

  it("stays linear on hostile input", () => {
    const started = Date.now();
    for (const value of ["Bearer " + "a".repeat(100_000), "://" + "a".repeat(100_000), "-----BEGIN " + "A ".repeat(50_000), "sk-" + "a".repeat(100_000)]) {
      envValueProblem(value);
    }
    expect(Date.now() - started).toBeLessThan(500);
  });
});
