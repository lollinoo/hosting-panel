/**
 * Security matrix of the site template validator. Each row is the smallest document that would give a template a power
 * it must not have (host access, privilege, a foreign image, a secret in the clear...), mutated from a valid one.
 * Every row must be refused with the exact code at the exact path, and no message may repeat the value.
 */
import { describe, expect, it } from "vitest";
import { parseTemplateYaml, type YamlValue } from "@hosting-panel/contracts";
import { SERVICE_KEY_REFUSALS, ROOT_KEY_REFUSALS, validateSiteTemplate, validateSiteTemplateSource } from "../src/site-template-validation.js";

const BASE_SOURCE = [
  "x-hp-module: wordpress",
  "x-hp-parameters:",
  "  - key: php_version",
  "    label: Versione PHP",
  "    type: enum",
  '    options: ["8.3", "8.4", "8.5"]',
  '    default: "8.4"',
  "    customer: true",
  "services:",
  "  app:",
  "    image: ${HP_MODULE_IMAGE}",
  "    volumes:",
  "      - html:/var/www/html",
  "    expose:",
  '      - "80"',
  "    deploy:",
  "      resources:",
  "        limits:",
  '          cpus: "1.0"',
  "          memory: 512M",
  "volumes:",
  "  html: {}",
  "",
].join("\n");

const parsed = parseTemplateYaml(BASE_SOURCE);
if (!parsed.ok) throw new Error("the base fixture must parse");
const BASE: YamlValue = parsed.value;

type Path = readonly (string | number)[];
type Edit = readonly [path: Path, value: unknown];
type Node = Record<string | number, unknown>;
const REMOVE = Symbol("remove");

function build(...edits: Edit[]): unknown {
  const root = structuredClone(BASE) as Node;
  for (const [path, value] of edits) {
    let node = root;
    for (const key of path.slice(0, -1)) node = node[key] as Node;
    const last = path[path.length - 1]!;
    if (value === REMOVE) delete node[last];
    else node[last] = value;
  }
  return root;
}

const app = (...rest: (string | number)[]): Path => ["services", "app", ...rest];
const ENV = app("environment");
const VOLUMES = app("volumes");
const IMAGE = app("image");

/** Asserts the document is refused with `code` at `path`; returns every error for further checks. */
function refused(doc: unknown, code: string, path: string) {
  const result = validateSiteTemplate(doc, "wordpress");
  expect(result.ok, `${code} at ${path}`).toBe(false);
  if (result.ok) return [];
  expect(result.errors).toContainEqual(expect.objectContaining({ code, path }));
  return result.errors;
}
const leaks = (errors: readonly unknown[], text: string): boolean => JSON.stringify(errors).includes(text);

describe("1-3 container privileges", () => {
  it.each<[string, unknown]>([
    ["privileged: true", true],
    ["privileged: 'true'", "true"],
    ["privileged: false", false],
  ])("%s", (_name, value) => {
    refused(build([app("privileged"), value]), "KEY_FORBIDDEN_SECURITY", "services.app.privileged");
  });

  it.each<[string, unknown]>([
    ["cap_add", ["SYS_ADMIN"]],
    ["cap_drop", ["ALL"]],
    ["devices", ["/dev/sda:/dev/sda"]],
    ["security_opt", ["seccomp=unconfined"]],
    ["sysctls", { "net.ipv4.ip_forward": "1" }],
    ["userns_mode", "host"],
    ["pid", "host"],
    ["ipc", "host"],
    ["uts", "host"],
    ["cgroup_parent", "system.slice"],
    ["user", "root"],
    ["group_add", ["docker"]],
    ["gpus", "all"],
  ])("%s", (key, value) => {
    refused(build([app(key), value]), "KEY_FORBIDDEN_SECURITY", `services.app.${key}`);
  });

  it("refuses every key of the security table, whatever its value", () => {
    for (const key of SERVICE_KEY_REFUSALS.KEY_FORBIDDEN_SECURITY ?? []) {
      refused(build([app(key), "x"]), "KEY_FORBIDDEN_SECURITY", `services.app.${key}`);
    }
  });
});

describe("4-7 networking", () => {
  it.each<[string, Path, unknown, string]>([
    ["network_mode: host", app("network_mode"), "host", "services.app.network_mode"],
    ["service networks", app("networks"), ["x"], "services.app.networks"],
    ["top-level networks", ["networks"], { x: {} }, "networks"],
    ["ports 80:80", app("ports"), ["80:80"], "services.app.ports"],
    ["ports 8080:80", app("ports"), ["8080:80"], "services.app.ports"],
    ["ports 3306 on loopback", app("ports"), ["127.0.0.1:3306:3306"], "services.app.ports"],
    ["extra_hosts", app("extra_hosts"), ["host.docker.internal:host-gateway"], "services.app.extra_hosts"],
    ["dns", app("dns"), ["1.1.1.1"], "services.app.dns"],
    ["hostname", app("hostname"), "x", "services.app.hostname"],
    ["links", app("links"), ["db"], "services.app.links"],
    ["mac_address", app("mac_address"), "02:42:ac:11:00:02", "services.app.mac_address"],
  ])("%s", (_name, path, value, where) => {
    refused(build([path, value]), "KEY_FORBIDDEN_NETWORK", where);
  });

  it.each<[string, unknown[], string]>([
    ["a host mapping", ["8080:80"], "services.app.expose[0]"],
    ["another port", ["3306"], "services.app.expose[0]"],
    ["a protocol", ["80/tcp"], "services.app.expose[0]"],
    ["a number that is not the site port", [8080], "services.app.expose[0]"],
    ["two entries", ["80", "80"], "services.app.expose"],
  ])("expose with %s", (_name, value, where) => {
    refused(build([app("expose"), value]), "EXPOSE_INVALID", where);
  });
});

describe("8-14 volumes", () => {
  const withVolume = (item: unknown): unknown => build([VOLUMES, ["html:/var/www/html", item]]);

  it.each([
    "/var/run/docker.sock:/var/run/docker.sock",
    "/var/run/docker.sock:/x",
    "./sock:/var/run/docker.sock",
    "data:/var/run/docker.sock",
  ])("the docker socket in %s", (item) => {
    refused(withVolume(item), "VOLUME_DOCKER_SOCKET", "services.app.volumes[1]");
  });

  it.each(["/etc:/etc", "/:/host", "./data:/var/www/html", "../x:/y", "~/x:/y", "C:\\x:/y", "/srv/a:/var/www/html", ".:/x"])(
    "the host path %s",
    (item) => {
      refused(withVolume(item), "VOLUME_HOST_PATH", "services.app.volumes[1]");
    },
  );

  it.each(["/etc", "/etc/x", "/proc/x", "/sys", "/var/run", "/root", "/", "/boot", "/dev", "/run/secrets", "/var/www/../etc", "/a//b", "/a/", "/a b", "relative"])(
    "the target %s",
    (target) => {
      refused(withVolume(`data:${target}`), "VOLUME_TARGET_INVALID", "services.app.volumes[1]");
    },
  );

  it.each([["ro"], ["z"], ["Z"], ["nocopy"], ["rw,z"]])("the mode %s", (mode) => {
    refused(build([VOLUMES, [`html:/var/www/html:${mode}`]]), "VOLUME_MODE_UNSUPPORTED", "services.app.volumes[0]");
  });

  it("the long syntax and other shapes", () => {
    refused(withVolume({ type: "bind", source: "/etc", target: "/x" }), "VOLUME_SYNTAX", "services.app.volumes[1]");
    refused(withVolume("html"), "VOLUME_SYNTAX", "services.app.volumes[1]");
    refused(withVolume("Data:/x"), "VOLUME_SYNTAX", "services.app.volumes[1]");
    refused(withVolume("ab:/x:rw:z"), "VOLUME_SYNTAX", "services.app.volumes[1]");
    refused(withVolume(3), "VOLUME_SYNTAX", "services.app.volumes[1]");
  });

  it("reads a one-letter name followed by a slash as a Windows drive, a host path (conservative)", () => {
    refused(withVolume("d:/data"), "VOLUME_HOST_PATH", "services.app.volumes[1]");
  });

  it.each<[string, unknown]>([
    ["driver_opts that bind the host root", { html: { driver_opts: { type: "none", o: "bind", device: "/" } } }],
    ["external", { html: { external: true } }],
    ["driver", { html: { driver: "local" } }],
    ["name", { html: { name: "x" } }],
    ["labels", { html: { labels: { a: "b" } } }],
  ])("a top-level volume with %s", (_name, volumes) => {
    refused(build([["volumes"], volumes]), "VOLUME_OPTIONS_REFUSED", "volumes.html");
  });

  it("a volume that is not declared at the top level", () => {
    refused(build([["volumes"], {}]), "VOLUME_UNDECLARED", "services.app.volumes[0]");
    refused(build([["volumes"], REMOVE]), "VOLUME_UNDECLARED", "services.app.volumes[0]");
    refused(build([VOLUMES, ["html:/var/www/html", "other:/data"]]), "VOLUME_UNDECLARED", "services.app.volumes[1]");
  });

  it("a second named volume, a missing html volume, a html volume at another target", () => {
    refused(build([VOLUMES, ["html:/var/www/html", "data:/data"]], [["volumes", "data"], {}]), "VOLUME_EXTRA_NOT_ALLOWED", "services.app.volumes[1]");
    refused(build([VOLUMES, []]), "VOLUME_REQUIRED_MISSING", "services.app.volumes");
    refused(build([VOLUMES, REMOVE]), "VOLUME_REQUIRED_MISSING", "services.app");
    refused(build([VOLUMES, ["html:/var/www/other"]]), "VOLUME_REQUIRED_MISSING", "services.app.volumes");
    refused(build([VOLUMES, ["html:/var/www/html", "html:/other"]]), "VOLUME_DUPLICATE", "services.app.volumes[1]");
  });
});

describe("15-19 the image", () => {
  const codesFor = (image: unknown): string[] => {
    const result = validateSiteTemplate(build([IMAGE, image]), "wordpress");
    return result.ok ? [] : [...new Set(result.errors.map((error) => error.code))];
  };

  it.each(["wordpress:latest", "wordpress", "wordpress:7.1.4", "wordpress:php8.4-apache", "wordpress:7.1-php8.4-apache", "wordpress:7.1.4-php8.4-fpm"])(
    "the floating or wrong tag %s",
    (image) => {
      refused(build([IMAGE, image]), "IMAGE_TAG_NOT_ALLOWED", "services.app.image");
      expect(codesFor(image)).toEqual(["IMAGE_TAG_NOT_ALLOWED"]);
    },
  );

  // The executor gives extra Linux capabilities to any image whose name ends in /wordpress (and nginx, php...).
  const CAPABILITY_GRANT = /(?:^|\/)(?:nginx|httpd|apache2?|wordpress|php|postgres)(?::|@|$)/i;
  it.each([
    "evil.example/wordpress:7.1.4-php8.4-apache",
    "docker.io/library/wordpress:7.1.4-php8.4-apache",
    "library/wordpress:7.1.4-php8.4-apache",
    "nginx:1.27.0",
    "wordpress-evil:7.1.4-php8.4-apache",
    "localhost:5000/wordpress:7.1.4-php8.4-apache",
    "ghcr.io/evil/php:8.4",
  ])("the foreign repository %s", (image) => {
    refused(build([IMAGE, image]), "IMAGE_REPOSITORY_NOT_ALLOWED", "services.app.image");
    expect(codesFor(image)).toEqual(["IMAGE_REPOSITORY_NOT_ALLOWED"]);
  });

  it("proves the capability grant pattern would match foreign images the validator refuses", () => {
    expect(CAPABILITY_GRANT.test("evil.example/wordpress:7.1.4-php8.4-apache")).toBe(true);
    expect(CAPABILITY_GRANT.test("library/wordpress:7.1.4-php8.4-apache")).toBe(true);
    expect(CAPABILITY_GRANT.test("ghcr.io/evil/php:8.4")).toBe(true);
  });

  const digest = `sha256:${"a".repeat(64)}`;
  it.each([`wordpress@${digest}`, `wordpress:7.1.4-php8.4-apache@${digest}`])("the digest in %s", (image) => {
    refused(build([IMAGE, image]), "IMAGE_DIGEST_NOT_ALLOWED", "services.app.image");
    expect(codesFor(image)).toEqual(["IMAGE_DIGEST_NOT_ALLOWED"]);
  });

  it("an image that is empty, null, of the wrong type or malformed", () => {
    refused(build([IMAGE, ""]), "IMAGE_MISSING", "services.app.image");
    refused(build([IMAGE, null]), "IMAGE_MISSING", "services.app.image");
    refused(build([IMAGE, REMOVE]), "IMAGE_MISSING", "services.app");
    refused(build([IMAGE, ["x"]]), "TYPE_MISMATCH", "services.app.image");
    refused(build([IMAGE, 3]), "TYPE_MISMATCH", "services.app.image");
    refused(build([IMAGE, "a b"]), "IMAGE_MALFORMED", "services.app.image");
    refused(build([IMAGE, "WordPress:1"]), "IMAGE_MALFORMED", "services.app.image");
    refused(build([IMAGE, `wordpress:${"1".repeat(300)}`]), "IMAGE_MALFORMED", "services.app.image");
  });

  it("placeholders in the image", () => {
    refused(build([IMAGE, "${HP_MODULE_IMAGE}-x"]), "INTERP_MODULE_IMAGE_MISPLACED", "services.app.image");
    refused(build([IMAGE, "x${HP_MODULE_IMAGE}"]), "INTERP_MODULE_IMAGE_MISPLACED", "services.app.image");
    refused(build([IMAGE, "${HP_SITE_ID}"]), "IMAGE_VARIABLE_NOT_ALLOWED", "services.app.image");
    refused(build([IMAGE, "wordpress:${other}-php8.4-apache"]), "IMAGE_VARIABLE_NOT_ALLOWED", "services.app.image");
    refused(build([IMAGE, "${php_version"]), "INTERP_SYNTAX", "services.app.image");
  });
});

describe("20-22 limits and unsupported keys", () => {
  const limits = (cpus: unknown, memory: unknown): unknown => build([app("deploy", "resources", "limits"), { cpus, memory }]);
  const CPUS = "services.app.deploy.resources.limits.cpus";
  const MEMORY = "services.app.deploy.resources.limits.memory";

  it.each<[unknown, string]>([
    ["65", "LIMIT_CPU_RANGE"],
    ["64.001", "LIMIT_CPU_RANGE"],
    ["0.05", "LIMIT_CPU_RANGE"],
    [0, "LIMIT_CPU_RANGE"],
    ["-1", "LIMIT_CPU_FORMAT"],
    ["abc", "LIMIT_CPU_FORMAT"],
    ["1e3", "LIMIT_CPU_FORMAT"],
  ])("cpus %j", (cpus, code) => {
    refused(limits(cpus, "512M"), code, CPUS);
  });

  it.each<[unknown, string]>([
    ["65G", "LIMIT_MEMORY_RANGE"],
    [68719476737, "LIMIT_MEMORY_RANGE"],
    ["127M", "LIMIT_MEMORY_RANGE"],
    [0, "LIMIT_MEMORY_FORMAT"],
    ["-1M", "LIMIT_MEMORY_FORMAT"],
    ["1.5G", "LIMIT_MEMORY_FORMAT"],
    ["lots", "LIMIT_MEMORY_FORMAT"],
  ])("memory %j", (memory, code) => {
    refused(limits("1", memory), code, MEMORY);
  });

  it.each<[string, Path, unknown]>([
    ["resources.reservations", app("deploy", "resources", "reservations"), { cpus: "1" }],
    ["deploy.replicas", app("deploy", "replicas"), 3],
    ["deploy.restart_policy", app("deploy", "restart_policy"), { condition: "any" }],
    ["deploy.placement", app("deploy", "placement"), { constraints: ["node.role==manager"] }],
    ["mem_limit", app("mem_limit"), "2g"],
    ["cpus", app("cpus"), 2],
    ["command", app("command"), ["sh", "-c", "x"]],
    ["entrypoint", app("entrypoint"), ["/bin/sh"]],
    ["healthcheck", app("healthcheck"), { test: ["CMD", "true"] }],
    ["restart", app("restart"), "always"],
    ["logging", app("logging"), { driver: "syslog" }],
    ["depends_on", app("depends_on"), ["db"]],
  ])("%s", (_name, path, value) => {
    refused(build([path, value]), "KEY_UNSUPPORTED", path.join(".").replace(/\.(\d+)/g, "[$1]"));
  });

  it("an unknown key anywhere", () => {
    refused(build([app("whatever"), 1]), "KEY_UNKNOWN", "services.app.whatever");
    refused(build([["x-hp-other"], 1]), "KEY_UNKNOWN", "x-hp-other");
    refused(build([app("deploy", "whatever"), 1]), "KEY_UNKNOWN", "services.app.deploy.whatever");
  });
});

describe("23-30 the environment", () => {
  const env = (name: string, value: unknown): unknown => build([ENV, { [name]: value }]);
  const at = (name: string): string => `services.app.environment.${name}`;

  it.each<[string, string]>([
    ["${DB_PASS}", "INTERP_UNKNOWN_VARIABLE"],
    ["${HP_ROOT_PASSWORD}", "INTERP_UNKNOWN_VARIABLE"],
    ["${HOME}", "INTERP_UNKNOWN_VARIABLE"],
    ["${a:-b}", "INTERP_SYNTAX"],
    ["$HOME", "INTERP_SYNTAX"],
    ["$", "INTERP_SYNTAX"],
    ["${", "INTERP_SYNTAX"],
    ["${}", "INTERP_SYNTAX"],
    ["$(id)", "INTERP_SYNTAX"],
  ])("the value %s", (value, code) => {
    refused(env("WP_X", value), code, at("WP_X"));
  });

  it.each(["DB_PASSWORD", "PASSWORD", "API_TOKEN", "AUTH_KEY", "MY_SECRET", "STRIPE_API_KEY", "NONCE_SALT", "PRIVATE_KEY"])(
    "the secret-looking name %s",
    (name) => {
      const errors = refused(env(name, "hunter2-value-xyz"), "ENV_NAME_SECRET_LIKE", at(name));
      refused(env(name, "${php_version}"), "ENV_NAME_SECRET_LIKE", at(name));
      expect(leaks(errors, "hunter2-value-xyz")).toBe(false);
    },
  );

  it.each<[string, string]>([
    ["a private key header", "-----BEGIN RSA PRIVATE KEY-----"],
    ["a bearer token", "Bearer abcdefghijklmnop12"],
    ["an AWS key id", "AKIAIOSFODNN7EXAMPLE"],
    ["a GitHub token", `ghp_${"a1".repeat(15)}`],
    ["credentials in a URL", "https://user:s3cretpw@host.example/"],
  ])("the secret-looking value: %s", (_name, value) => {
    const errors = refused(env("WP_X", value), "ENV_VALUE_SECRET_LIKE", at("WP_X"));
    expect(leaks(errors, value)).toBe(false);
  });

  it.each(["unix:///var/run/docker.sock", "docker.sock", "X=docker.SOCK", "tcp://x/var/run/docker.sock"])("the docker socket value %s", (value) => {
    const errors = refused(env("WP_X", value), "ENV_VALUE_DOCKER_SOCKET", at("WP_X"));
    expect(leaks(errors, value)).toBe(false);
  });

  it.each(["HP_SITE_ID", "HP_X", "LD_PRELOAD", "DOCKER_HOST", "PATH", "PORT", "PHPRC", "PHP_INI_SCAN_DIR", "X_FILE"])("the reserved name %s", (name) => {
    refused(env(name, "1"), "ENV_NAME_RESERVED", at(name));
  });

  it("an invalid name", () => {
    refused(env("lower", "1"), "ENV_NAME_INVALID", at("lower"));
    refused(build([ENV, ["1BAD=1"]]), "ENV_NAME_INVALID", "services.app.environment[0]");
  });

  it("a variable taken from the host", () => {
    refused(env("WP_X", null), "ENV_VALUE_MISSING", at("WP_X"));
    refused(build([ENV, ["WP_X"]]), "ENV_VALUE_MISSING", "services.app.environment[0]");
  });

  it("a value that is too long", () => {
    const long = "y".repeat(4097);
    const errors = refused(env("WP_X", long), "ENV_VALUE_TOO_LONG", at("WP_X"));
    expect(leaks(errors, "y".repeat(40))).toBe(false);
    refused(env("WP_X", "${HP_SITE_URL}${HP_SITE_URL}${HP_SITE_URL}"), "ENV_VALUE_TOO_LONG", at("WP_X"));
  });

  it("a value with a line break or a NUL", () => {
    for (const value of ["a\nb", "a\u0000b", "a\rb"]) {
      const errors = refused(env("WP_X", value), "ENV_VALUE_INVALID", at("WP_X"));
      expect(leaks(errors, "a\\nb")).toBe(false);
    }
  });
});

describe("32-33 host access and services", () => {
  it.each<[string, unknown]>([
    ["build", "."],
    ["env_file", ".env"],
    ["secrets", ["x"]],
    ["configs", ["x"]],
    ["labels", { "traefik.enable": "true" }],
    ["container_name", "x"],
    ["volumes_from", ["other"]],
    ["tmpfs", ["/run"]],
    ["extends", { file: "x.yml" }],
  ])("the service key %s", (key, value) => {
    refused(build([app(key), value]), "KEY_FORBIDDEN_HOST_ACCESS", `services.app.${key}`);
  });

  it.each(["secrets", "configs", "include", "extends"])("the top-level key %s", (key) => {
    refused(build([[key], {}]), "KEY_FORBIDDEN_HOST_ACCESS", key);
  });

  it("every key of both refusal tables is refused with its own code", () => {
    for (const [code, keys] of Object.entries(ROOT_KEY_REFUSALS)) {
      for (const key of keys) refused(build([[key], {}]), code, key);
    }
    for (const [code, keys] of Object.entries(SERVICE_KEY_REFUSALS)) {
      for (const key of keys) refused(build([app(key), "x"]), code, `services.app.${key}`);
    }
  });

  it("a second service and an empty services mapping", () => {
    refused(build([["services", "db"], { image: "mysql:8" }]), "SERVICES_MULTIPLE", "services.db");
    refused(build([["services"], {}]), "SERVICES_MISSING", "services");
    refused(build([["services"], REMOVE]), "SERVICES_MISSING", "");
    refused(build([["services"], { App: { image: "x" } }]), "SERVICE_NAME_INVALID", "services.App");
  });
});

describe("34-35 PHP settings and the PHP parameter", () => {
  const php = (settings: unknown): unknown => build([["x-hp-php"], settings]);

  it.each(["auto_prepend_file", "disable_functions", "open_basedir", "extension", "allow_url_include"])("the directive %s", (key) => {
    refused(php({ [key]: "/etc/passwd" }), "PHP_KEY_UNKNOWN", `x-hp-php.${key}`);
  });

  it.each(["64M; extension=x", "64M\nauto_prepend_file=/x", "-1", "unlimited", "0", " 64M", "64 M"])("the upload_max_filesize value %j", (value) => {
    const errors = refused(php({ upload_max_filesize: value }), "PHP_VALUE_INVALID", "x-hp-php.upload_max_filesize");
    expect(leaks(errors, "auto_prepend_file")).toBe(false);
  });

  it("an unsupported or missing PHP version", () => {
    const option = (options: unknown[]) => build([["x-hp-parameters", 0, "options"], options]);
    refused(option(["7.4"]), "PHP_VERSION_UNSUPPORTED", "x-hp-parameters[0].options[0]");
    refused(option(["8.4", "9.0"]), "PHP_VERSION_UNSUPPORTED", "x-hp-parameters[0].options[1]");
    refused(build([["x-hp-parameters"], []]), "PHP_PARAM_MISSING", "x-hp-parameters");
    refused(build([["x-hp-parameters"], REMOVE]), "PHP_PARAM_MISSING", "");
  });
});

describe("36 attacks at the YAML level", () => {
  it.each<[string, string, string]>([
    ["an anchor", "x-hp-module: &a wordpress\n", "ANCHOR"],
    ["an alias", "x-hp-module: *a\n", "ALIAS"],
    ["a merge key", "<<: *a\n", "MERGE_KEY"],
    ["a tag", "x-hp-module: !!str wordpress\n", "TAG"],
    ["a second document", "x-hp-module: wordpress\n---\nservices: {}\n", "MULTI_DOCUMENT"],
    ["a duplicate key", "x-hp-module: wordpress\nx-hp-module: other\n", "DUPLICATE_KEY"],
    ["a __proto__ key", "__proto__: {privileged: true}\n", "FORBIDDEN_KEY"],
    ["a tab indent", "services:\n\tapp: 1\n", "TAB_INDENT"],
    ["a block scalar", "x-hp-module: |\n  wordpress\n", "BLOCK_SCALAR"],
    ["a 65 KiB source", `# ${"x".repeat(65_536)}\n`, "TOO_LARGE"],
    ["17 levels of nesting", `a: ${"[".repeat(17)}${"]".repeat(17)}\n`, "TOO_DEEP"],
    ["a control character", "x-hp-module: word\u001bpress\n", "CONTROL_CHARACTER"],
  ])("%s", (_name, source, code) => {
    expect(validateSiteTemplateSource(source, "wordpress")).toEqual({
      ok: false,
      errors: [{ path: "", line: expect.any(Number), column: expect.any(Number), code, message: expect.any(String) }],
    });
  });
});

describe("37 prototype pollution", () => {
  it("refuses an own __proto__ key at every level without touching Object.prototype", () => {
    const polluted = JSON.parse('{"__proto__":{"privileged":true}}') as unknown;
    refused(polluted, "KEY_UNKNOWN", "__proto__");
    refused(JSON.parse('{"constructor":{"prototype":{}}}'), "KEY_UNKNOWN", "constructor");

    const nested = build() as { services: { app: Record<string, unknown> } };
    Object.defineProperty(nested.services.app, "__proto__", { value: { privileged: true }, enumerable: true, configurable: true, writable: true });
    refused(nested, "KEY_UNKNOWN", "services.app.__proto__");

    // A literal makes __proto__ the prototype, not a key: the document is simply incomplete.
    const literal = { "__proto__": { privileged: true } };
    expect(validateSiteTemplate(literal, "wordpress").ok).toBe(false);

    expect(Object.keys(Object.prototype)).toEqual([]);
    expect(({} as Record<string, unknown>).privileged).toBeUndefined();
  });

  it("does not take a key from the prototype chain", () => {
    const inherited = Object.create(structuredClone(BASE) as object) as unknown;
    expect(validateSiteTemplate(inherited, "wordpress").ok).toBe(false);
  });

  it("accepts a parameter named like an Object.prototype member without confusing it", () => {
    const doc = build([["x-hp-parameters", 1], { key: "constructor", label: "C", type: "boolean", default: true }]);
    expect(validateSiteTemplate(doc, "wordpress").ok).toBe(true);
    refused(build([ENV, { WP_X: "${toString}" }]), "INTERP_UNKNOWN_VARIABLE", "services.app.environment.WP_X");
  });
});

describe("38-40 wrong types and oversize parameters", () => {
  it.each<[string, Path, unknown, string]>([
    ["services as a list", ["services"], [], "services"],
    ["environment as text", ENV, "A=b", "services.app.environment"],
    ["volumes as a mapping", VOLUMES, {}, "services.app.volumes"],
    ["deploy as a list", app("deploy"), [], "services.app.deploy"],
    ["x-hp-parameters as a mapping", ["x-hp-parameters"], {}, "x-hp-parameters"],
    ["x-hp-php as a list", ["x-hp-php"], [], "x-hp-php"],
    ["the service as text", app(), "x", "services.app"],
    ["volumes (top level) as a list", ["volumes"], ["html"], "volumes"],
  ])("%s", (_name, path, value, where) => {
    refused(build([path, value]), "TYPE_MISMATCH", where);
  });

  it("the module", () => {
    refused(build([["x-hp-module"], REMOVE]), "MODULE_MISSING", "");
    refused(build([["x-hp-module"], "other"]), "MODULE_MISMATCH", "x-hp-module");
  });

  it.each<[string, Record<string, unknown>, string, string]>([
    ["33 options", { options: Array.from({ length: 33 }, (_, i) => `o${i}`), default: "o0" }, "PARAM_OPTIONS_INVALID", "options"],
    ["an option with a space", { options: ["a b"], default: "a b" }, "PARAM_OPTIONS_INVALID", "options[0]"],
    ["a label of 81 characters", { label: "L".repeat(81) }, "PARAM_LABEL_INVALID", "label"],
    ["a label with a control character", { label: "a\u0001b" }, "PARAM_LABEL_INVALID", "label"],
  ])("a parameter with %s", (_name, overrides, code, field) => {
    const parameter = { key: "m", label: "M", type: "enum", options: ["a"], default: "a", ...overrides };
    refused(build([["x-hp-parameters", 1], parameter]), code, `x-hp-parameters[1].${field}`);
  });
});
