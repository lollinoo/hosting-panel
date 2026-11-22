import { describe, expect, it } from "vitest";
import { APP_TEMPLATE_LIMITS } from "../src/app-templates/limits.js";
import {
  APP_STACK_SHELL_INTERPRETERS,
  AppStackHealthcheckSchema,
  appStackArgvExecutableProblem,
  appStackArgvItemProblem,
  appStackContainerPathProblem,
  appStackEnvValueNameProblem,
  appStackHealthPathProblem,
  appStackSecretEnvNameProblem,
  appStackSecretFilePath,
  appStackTextProblem,
} from "../src/app-templates/text.js";

describe("appStackTextProblem", () => {
  it.each([
    ["plain text with $$ and ; | & > shell metacharacters", null],
    ["a\u0000b", "control_character"],
    ["a\nb", "control_character"],
    ["a\tb", "control_character"],
    ["a\u007fb", "control_character"],
    ["a\u0085b", "control_character"],
    ["a\u2028b", "control_character"],
    ["a\u2029b", "control_character"],
    ["/var/run/docker.sock", "docker_socket"],
    ["unix:///run/DOCKER.SOCK", "docker_socket"],
    ["Docker.Sock", "docker_socket"],
    ["http://169.254.169.254/latest/meta-data", "metadata_endpoint"],
    ["[fd00:ec2::254]", "metadata_endpoint"],
    ["FD00:EC2::254", "metadata_endpoint"],
    ["http://metadata.google.internal/computeMetadata/v1", "metadata_endpoint"],
    ["http://u:p@h", "url_credentials"],
    ["postgres://app:pw@db:5432/app", "url_credentials"],
    ["http://host:8080/path", null],
    ["user@example.com", null],
    ["\ndocker.sock", "control_character"],
    ["a\ud800b", "control_character"],
    ["a\udc00b", "control_character"],
    ["\ud800", "control_character"],
    ["\udc00", "control_character"],
    ["emoji \ud83d\ude00 ok", null],
  ] as const)("%j -> %s", (text, problem) => {
    expect(appStackTextProblem(text)).toBe(problem);
  });

  it("runs in linear time on 64 KiB adversarial inputs", () => {
    const size = APP_TEMPLATE_LIMITS.sourceBytes;
    for (const text of ["a".repeat(size), "://a".repeat(size / 4), `://a:${":".repeat(size)}`, `://${"a:".repeat(size / 2)}`, "169.254".repeat(size / 7)]) {
      const started = performance.now();
      appStackTextProblem(text);
      expect(performance.now() - started).toBeLessThan(200);
    }
  });
});

describe("appStackArgvExecutableProblem", () => {
  it.each(APP_STACK_SHELL_INTERPRETERS.flatMap((name) => [name, `/bin/${name}`, `/usr/bin/${name}`]))("%s is a shell", (argv0) => {
    expect(appStackArgvExecutableProblem(argv0)).toBe("shell");
  });

  it.each(["/bin/sh", "/usr/bin/env", "busybox", "/bin/busybox"])("%s is a shell", (argv0) => {
    expect(appStackArgvExecutableProblem(argv0)).toBe("shell");
  });

  it.each(["rbash", "lksh", "yash", "posh", "pdksh", "oksh", "loksh", "hush", "toybox"])("%s is listed", (name) => {
    expect(APP_STACK_SHELL_INTERPRETERS).toContain(name);
  });

  it.each(["sh ", " sh", "bash ", "/bin/sh ", "\u00a0sh"])("%j is a shell after trimming", (argv0) => {
    expect(appStackArgvExecutableProblem(argv0)).toBe("shell");
  });

  it.each(["sh2", "shell", "bashful", "/usr/local/bin/app", "nginx", "envoy"])("%s passes", (argv0) => {
    expect(appStackArgvExecutableProblem(argv0)).toBeNull();
  });

  it.each(["", "/", "/usr/bin/"])("%j is empty", (argv0) => {
    expect(appStackArgvExecutableProblem(argv0)).toBe("empty");
  });
});

describe("appStackArgvItemProblem", () => {
  it.each([
    ["/bin/sh", "shell"],
    ["sh", "shell"],
    ["sh ", "shell"],
    ["/usr/bin/env", "shell"],
    ["toybox", "shell"],
    ["shell", null],
    ["-c", null],
    ["serve", null],
    ["", null],
  ] as const)("%j -> %s", (item, problem) => {
    expect(appStackArgvItemProblem(item)).toBe(problem);
  });
});

describe("appStackContainerPathProblem", () => {
  it.each([
    ["/app/data", null],
    ["/var/lib/app", null],
    ["/srv/a.b_c-d", null],
    ["/", "invalid"],
    ["", "invalid"],
    ["app", "invalid"],
    ["/etc", "invalid"],
    ["/etc/x", "invalid"],
    ["/proc", "invalid"],
    ["/sys/x", "invalid"],
    ["/dev", "invalid"],
    ["/var/run", "invalid"],
    ["/run/secrets/x", "invalid"],
    ["/run/hosting-panel", "invalid"],
    ["/app/../etc", "invalid"],
    ["/app/./x", "invalid"],
    ["/..", "invalid"],
    ["//x", "invalid"],
    ["/x/", "invalid"],
    ["/x:y", "invalid"],
    ["/x y", "invalid"],
    [`/${"a".repeat(254)}`, null],
    [`/${"a".repeat(255)}`, "invalid"],
    ["/run", "reserved"],
    ["/run/app", "reserved"],
    ["/tmp", "reserved"],
    ["/tmp/x", "reserved"],
    ["/tmpx", null],
    ["/runner", null],
  ] as const)("%j -> %s", (path, problem) => {
    expect(appStackContainerPathProblem(path)).toBe(problem);
  });
});

describe("env name rules", () => {
  it.each([
    ["PORT", null],
    ["APP_MODE", null],
    ["_X", null],
    ["lower", "invalid"],
    ["1X", "invalid"],
    ["A-B", "invalid"],
    ["", "invalid"],
    [`A${"B".repeat(64)}`, "invalid"],
    ["X_FILE", "reserved"],
    ["HP_X", "reserved"],
    ["LD_PRELOAD", "reserved"],
    ["DOCKER_HOST", "reserved"],
    ["PATH", "reserved"],
  ] as const)("value entry %j -> %s", (name, problem) => {
    expect(appStackEnvValueNameProblem(name)).toBe(problem);
  });

  it.each([
    ["APP_SECRET_FILE", null],
    ["X_FILE", null],
    ["_FILE", "invalid"],
    ["APP_SECRET", "invalid"],
    ["app_secret_file", "invalid"],
    ["HP_X_FILE", "invalid"],
    ["LD_X_FILE", "invalid"],
    ["DOCKER_X_FILE", "invalid"],
    ["PATH_FILE", "invalid"],
  ] as const)("secret entry %j -> %s", (name, problem) => {
    expect(appStackSecretEnvNameProblem(name)).toBe(problem);
  });

  it("puts secret files under /run/secrets", () => {
    expect(appStackSecretFilePath("app_secret")).toBe("/run/secrets/app_secret");
  });
});

describe("health checks", () => {
  it.each([
    ["/", null],
    ["/healthz", null],
    ["/api/v1/health.json", null],
    ["/a~b_c-d/", null],
    [`/${"a".repeat(255)}`, null],
    [`/${"a".repeat(256)}`, "invalid"],
    ["", "invalid"],
    ["healthz", "invalid"],
    ["//x", "invalid"],
    ["/a//b", "invalid"],
    ["/a/../b", "invalid"],
    ["/.", "invalid"],
    ["/a?b=1", "invalid"],
    ["/a b", "invalid"],
    ["http://x/", "invalid"],
  ] as const)("path %j -> %s", (path, problem) => {
    expect(appStackHealthPathProblem(path)).toBe(problem);
  });

  it("accepts tcp and http checks within the timing bounds", () => {
    expect(AppStackHealthcheckSchema.safeParse({ kind: "tcp", port: 8080, intervalSeconds: 15, timeoutSeconds: 3 }).success).toBe(true);
    expect(AppStackHealthcheckSchema.safeParse({ kind: "http", port: 80, path: "/healthz", intervalSeconds: 5, timeoutSeconds: 5 }).success).toBe(true);
  });

  it.each([
    { kind: "tcp", port: 8080, path: "/x", intervalSeconds: 10, timeoutSeconds: 3 },
    { kind: "http", port: 8080, intervalSeconds: 10, timeoutSeconds: 3 },
    { kind: "http", port: 8080, path: "/a/../b", intervalSeconds: 10, timeoutSeconds: 3 },
    { kind: "exec", port: 8080, intervalSeconds: 10, timeoutSeconds: 3 },
    { kind: "tcp", port: 0, intervalSeconds: 10, timeoutSeconds: 3 },
    { kind: "tcp", port: 8080, intervalSeconds: 4, timeoutSeconds: 3 },
    { kind: "tcp", port: 8080, intervalSeconds: 301, timeoutSeconds: 3 },
    { kind: "tcp", port: 8080, intervalSeconds: 10, timeoutSeconds: 0 },
    { kind: "tcp", port: 8080, intervalSeconds: 60, timeoutSeconds: 31 },
    { kind: "tcp", port: 8080, intervalSeconds: 5, timeoutSeconds: 6 },
    { kind: "tcp", port: 8080, intervalSeconds: 10.5, timeoutSeconds: 3 },
    { kind: "tcp", port: 8080, intervalSeconds: 10 },
    { kind: "tcp", port: 8080, intervalSeconds: 10, timeoutSeconds: 3, host: "x" },
  ])("refuses %j", (check) => {
    expect(AppStackHealthcheckSchema.safeParse(check).success).toBe(false);
  });
});
