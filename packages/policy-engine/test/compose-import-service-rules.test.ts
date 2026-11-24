/**
 * Compose importer (spec §7), rule by rule, second half of the table: volumes, ports, dependencies, health checks,
 * commands, limits and the keys that are dropped or refused. Each case is a file with one service unless it says
 * otherwise; every accepted draft is checked by the template validator.
 */
import { describe, expect, it } from "vitest";
import { type AppTemplateSpec } from "@hosting-panel/contracts";
import { validateAppTemplateSource } from "../src/app-template-validation.js";
import { COMPOSE_IMPORT_KEY_LEVELS, importComposeToAppTemplate, listComposeImages, type ComposeImportResult } from "../src/compose-import.js";

const IMAGE = "registry.example.invalid/acme/web:1.0";
const digest = (n: number): string => `sha256:${n.toString(16).padStart(2, "0").repeat(32)}`;

const file = (...lines: string[]): string => `${lines.join("\n")}\n`;
/** The lines of a service called `name`, made of an image and the given lines. */
const serviceLines = (name: string, image: string, ...lines: string[]): string[] => [`  ${name}:`, `    image: ${image}`, ...lines.map((line) => `    ${line}`)];
/** A file with one service, `web`. */
const web = (...lines: string[]): string => file("services:", ...serviceLines("web", IMAGE, ...lines));

/** Imports a file with a digest resolved for every image it lists: the n-th listed image gets `digest(n)`. */
const run = (compose: string): ComposeImportResult =>
  importComposeToAppTemplate({ compose, digests: new Map(listComposeImages(compose).map((image, index) => [image, digest(index + 1)])) });

const notes = (result: ComposeImportResult): string[] => result.report.map((note) => `${note.level} ${note.code} ${note.path}`);
const refusals = (result: ComposeImportResult): string[] => notes(result).filter((note) => note.startsWith("refused "));
const messageOf = (result: ComposeImportResult, code: string): string => result.report.find((note) => note.code === code)?.message ?? "";

/** The draft as the validator reads it; fails the test when the importer refused the file or the draft is not valid. */
function specOf(result: ComposeImportResult): AppTemplateSpec {
  if (!result.ok) throw new Error(`refused: ${notes(result).join("; ")}`);
  const checked = validateAppTemplateSource(result.source);
  if (!checked.ok) throw new Error(`draft not valid: ${checked.errors.map((issue) => `${issue.code} ${issue.path}`).join("; ")}`);
  return checked.spec;
}

const serviceOf = (result: ComposeImportResult, key = "web"): AppTemplateSpec["services"][number] => {
  const found = specOf(result).services.find((candidate) => candidate.key === key);
  if (found === undefined) throw new Error(`no service ${key}`);
  return found;
};

const expectRefused = (result: ComposeImportResult, ...expected: string[]): void => {
  expect(result.ok).toBe(false);
  expect("source" in result).toBe(false);
  expect(refusals(result)).toEqual(expected);
};

const mount = (volumeKey: string, containerPath: string, readOnly = false): object => ({ volumeKey, containerPath, readOnly });
const MIB = 1024 * 1024;

describe("volumes", () => {
  it("keeps named volumes, with ':ro' and ':rw', declared or not at the top of the file", () => {
    const result = run(`${web("volumes:", "  - data:/data", "  - logs:/var/log/app:rw", "  - conf:/usr/local/etc/redis:ro")}volumes:\n  data:\n  conf: {}\n`);
    expect(serviceOf(result).volumes).toEqual([mount("data", "/data"), mount("logs", "/var/log/app"), mount("conf", "/usr/local/etc/redis", true)]);
    expect(specOf(result).volumes).toEqual([{ key: "conf" }, { key: "data" }, { key: "logs" }]);
    expect(notes(result).filter((note) => note.includes("VOLUME"))).toEqual([]);
  });

  it("reads the long form of a named volume", () => {
    const result = run(web("volumes:", "  - type: volume", "    source: long", "    target: /srv/long/", "    read_only: true"));
    expect(serviceOf(result).volumes).toEqual([mount("long", "/srv/long", true)]);
  });

  it("shares one volume between two services", () => {
    const compose = file("services:", ...serviceLines("a", IMAGE, "volumes:", "  - shared:/srv/a"), ...serviceLines("b", IMAGE, "volumes:", "  - shared:/srv/b:ro"));
    const result = run(compose);
    expect(specOf(result).volumes).toEqual([{ key: "shared" }]);
    expect(serviceOf(result, "b").volumes).toEqual([mount("shared", "/srv/b", true)]);
  });

  it("drops the options of a top-level volume, a volume nothing mounts and an anonymous volume", () => {
    const result = run(
      `${web("volumes:", "  - data:/data", "  - /srv/anonymous", "  - type: volume", "    target: /srv/unnamed")}volumes:\n  data:\n    driver: local\n    external: true\n  spare:\n`,
    );
    expect(serviceOf(result).volumes).toEqual([mount("data", "/data")]);
    expect(specOf(result).volumes).toEqual([{ key: "data" }]);
    expect(notes(result).filter((note) => note.includes("VOLUME"))).toEqual([
      "dropped VOLUME_OPTION_DROPPED volumes.data",
      "dropped VOLUME_ANONYMOUS_DROPPED services.web.volumes[1]",
      "dropped VOLUME_ANONYMOUS_DROPPED services.web.volumes[2]",
      "dropped VOLUME_UNUSED_DROPPED volumes.spare",
    ]);
  });

  it("renames a volume the platform cannot name and drops a mount option that means nothing here", () => {
    const result = run(`${web("volumes:", "  - cache_dir:/var/cache/app:z")}volumes:\n  cache_dir:\n`);
    expect(serviceOf(result).volumes).toEqual([mount("cache-dir", "/var/cache/app")]);
    expect(notes(result).filter((note) => note.includes("VOLUME"))).toEqual([
      "changed VOLUME_RENAMED volumes.cache_dir",
      "dropped VOLUME_OPTION_DROPPED services.web.volumes[0]",
    ]);
  });

  it.each([
    ["a relative host path", "./host:/srv/path"],
    ["a parent host path", "../host:/srv/path"],
    ["an absolute host path", "/host:/srv/path"],
    ["a home path", "~/host:/srv/path"],
    ["a Windows path", "'C:\\data:/srv/path'"],
  ])("refuses %s", (_title, item) => {
    expectRefused(run(web("volumes:", `  - ${item}`)), "refused VOLUME_HOST_PATH services.web.volumes[0]");
  });

  it("refuses a bind mount in the long form", () => {
    expectRefused(run(web("volumes:", "  - type: bind", "    source: ./host", "    target: /srv/path")), "refused VOLUME_HOST_PATH services.web.volumes[0]");
  });

  it.each(["/var/run/docker.sock:/var/run/docker.sock", "/var/run/docker.sock:/var/run/docker.sock:ro", "sock:/var/run/docker.sock", "/run/user/1000/docker.sock:/srv/engine.sock"])(
    "refuses the Docker socket (%s)",
    (item) => {
      expectRefused(run(web("volumes:", `  - ${item}`)), "refused VOLUME_DOCKER_SOCKET services.web.volumes[0]");
    },
  );

  it("refuses the Docker socket in the long form", () => {
    const result = run(web("volumes:", "  - type: bind", "    source: /var/run/docker.sock", "    target: /var/run/docker.sock"));
    expectRefused(result, "refused VOLUME_DOCKER_SOCKET services.web.volumes[0]");
  });

  it.each([
    ["a variable as the volume", "${VOL}:/srv/x"],
    ["too many parts", "a:b:c:d"],
    ["a name with no path", "data"],
    ["an unknown mode", "data:/data:weird"],
    ["an item that is not text", "5"],
    ["a name the platform cannot use", "'Bad!:/srv/x'"],
  ])("refuses %s", (_title, item) => {
    expectRefused(run(web("volumes:", `  - ${item}`)), "refused VOLUME_INVALID services.web.volumes[0]");
  });

  it("refuses a tmpfs mount in the long form", () => {
    expectRefused(run(web("volumes:", "  - type: tmpfs", "    target: /srv/scratch")), "refused VOLUME_INVALID services.web.volumes[0]");
  });

  it.each(["/run/app", "/tmp/cache", "/etc/app", "/", "relative/path", "/proc/sys"])("refuses the target %s, which the platform does not let a volume cover", (target) => {
    expectRefused(run(web("volumes:", `  - data:${target}`)), "refused VOLUME_TARGET_REFUSED services.web.volumes[0]");
  });

  it("refuses two volumes on the same path", () => {
    expectRefused(run(web("volumes:", "  - one:/data", "  - two:/data/")), "refused VOLUME_TARGET_REFUSED services.web.volumes[1]");
  });

  it("refuses two names that would become the same volume", () => {
    const result = run(`${web("volumes:", "  - my_data:/srv/a", "  - my-data:/srv/b")}volumes:\n  my_data:\n  my-data:\n`);
    // Said where the second name is declared and where it is mounted.
    expectRefused(result, "refused VOLUME_INVALID volumes.my-data", "refused VOLUME_INVALID services.web.volumes[1]");
  });

  it("refuses 'volumes' of the wrong shape", () => {
    expectRefused(run(web("volumes: nope")), "refused VALUE_INVALID services.web.volumes");
    expectRefused(run(`${web()}volumes:\n  - data\n`), "refused VALUE_INVALID volumes");
  });

  it("accepts eight mounts in a service and refuses nine", () => {
    const lines = (count: number): string[] => Array.from({ length: count }, (_unused, index) => `  - shared:/srv/m${index}`);
    expect(serviceOf(run(web("volumes:", ...lines(8)))).volumes).toHaveLength(8);
    expectRefused(run(web("volumes:", ...lines(9))), "refused VOLUME_TOO_MANY services.web.volumes");
  });

  it("refuses more than eight volumes in a stack", () => {
    const one = (name: string, from: number, count: number): string[] =>
      serviceLines(name, IMAGE, "volumes:", ...Array.from({ length: count }, (_unused, index) => `  - v${from + index}:/srv/m${index}`));
    expect(specOf(run(file("services:", ...one("a", 0, 4), ...one("b", 4, 4)))).volumes).toHaveLength(8);
    expectRefused(run(file("services:", ...one("a", 0, 5), ...one("b", 5, 4))), "refused VOLUME_TOO_MANY volumes");
  });
});

describe("ports and expose", () => {
  it("drops 'ports' and exposes their container side, after the ports of 'expose'", () => {
    const result = run(
      web(
        "ports:",
        '  - "8080:80"',
        "  - 443",
        '  - "127.0.0.1:8081:81/tcp"',
        '  - "5353:53/udp"',
        '  - "7000-7005:7000-7005"',
        "  - target: 9000",
        "    published: 9001",
        "expose:",
        '  - "3000"',
        "  - 3001",
        '  - "3002/tcp"',
        '  - "3003-3005"',
        "  - 3000",
      ),
    );
    expect(serviceOf(result).expose).toEqual([3000, 3001, 3002, 80, 443, 81, 9000]);
    expect(notes(result).filter((note) => /PORTS|EXPOSE/.test(note))).toEqual([
      "dropped PORTS_ITEM_UNREAD services.web.ports[3]",
      "dropped PORTS_ITEM_UNREAD services.web.ports[4]",
      "dropped PORTS_DROPPED services.web.ports",
      "dropped EXPOSE_DROPPED services.web.expose[3]",
    ]);
    expect(messageOf(result, "PORTS_DROPPED")).toContain("80, 443, 81, 9000");
    expect(specOf(result).ingress).toEqual([]);
  });

  it("says of each 'ports' entry it keeps nothing of whether it is not TCP or not readable", () => {
    const result = run(
      web("ports:", '  - "53:53/udp"', '  - "80/TCP"', '  - "8080:${PORT}"', '  - "9000/tcp/extra"', "  - target: 9443", "    protocol: sctp", "  - target: 9444", "    protocol: quic", "  - [1, 2]", "  - 70000"),
    );
    expect(serviceOf(result).expose).toEqual([80]);
    const unread = result.report.filter((note) => note.code === "PORTS_ITEM_UNREAD");
    expect(unread.map((note) => `${note.level} ${note.path}`)).toEqual([
      "dropped services.web.ports[0]",
      "dropped services.web.ports[2]",
      "dropped services.web.ports[3]",
      "dropped services.web.ports[4]",
      "dropped services.web.ports[5]",
      "dropped services.web.ports[6]",
      "dropped services.web.ports[7]",
    ]);
    const notTcp = "This 'ports' entry is not TCP: nothing of it is kept, not even under 'expose'.";
    const notRead =
      "The importer reads one TCP port per 'ports' entry, and this one is a range, a variable or a form it does not know: nothing of it is kept, not even under 'expose'.";
    expect(unread.map((note) => note.message)).toEqual([notTcp, notRead, notRead, notTcp, notRead, notRead, notRead]);
  });

  it("reads the long form of a 'ports' entry with every key Compose gives it, and refuses a key it does not know", () => {
    const entry = ["  - target: 8443", "    published: 443", "    host_ip: 127.0.0.1", "    protocol: tcp", "    mode: host", "    app_protocol: http", "    name: web"];
    const result = run(web("ports:", ...entry));
    expect(serviceOf(result).expose).toEqual([8443]);
    expect(notes(result).filter((note) => /PORTS|KEY_/.test(note))).toEqual(["dropped PORTS_DROPPED services.web.ports"]);
    expectRefused(run(web("ports:", ...entry, "    weird_thing: 1")), "refused KEY_UNKNOWN services.web.ports[0].weird_thing");
  });

  it("refuses 'ports' or 'expose' that is not a list", () => {
    expectRefused(run(web("ports: 80")), "refused VALUE_INVALID services.web.ports");
    expectRefused(run(web("expose: 80")), "refused VALUE_INVALID services.web.expose");
  });

  it("accepts sixteen exposed ports in a stack and refuses seventeen", () => {
    const one = (name: string, from: number, count: number): string[] =>
      serviceLines(name, IMAGE, "expose:", ...Array.from({ length: count }, (_unused, index) => `  - ${from + index}`));
    expect(specOf(run(file("services:", ...one("a", 3000, 8), ...one("b", 3000, 8)))).services.flatMap((service) => service.expose)).toHaveLength(16);
    expectRefused(run(file("services:", ...one("a", 3000, 8), ...one("b", 3000, 9))), "refused EXPOSE_TOO_MANY services");
  });
});

describe("depends_on", () => {
  const stack = (...lines: string[]): string =>
    file("services:", ...serviceLines("web", IMAGE, ...lines), ...serviceLines("db", "postgres:17"), ...serviceLines("cache", "redis:7.4"));

  it("keeps the list form, each name once", () => {
    const result = run(stack("depends_on:", "  - db", "  - cache", "  - db"));
    expect(serviceOf(result).dependsOn).toEqual(["db", "cache"]);
    expect(notes(result).filter((note) => note.includes("DEPENDS"))).toEqual([]);
  });

  it("keeps the names of the map form and drops the conditions", () => {
    const result = run(stack("depends_on:", "  db:", "    condition: service_healthy", "    restart: true", "  cache:", "    condition: service_started"));
    expect(serviceOf(result).dependsOn).toEqual(["db", "cache"]);
    expect(notes(result).filter((note) => note.includes("DEPENDS"))).toEqual(["dropped DEPENDS_ON_CONDITION_DROPPED services.web.depends_on"]);
  });

  it("says that 'required: false' is not kept, beside the note about the conditions", () => {
    const result = run(stack("depends_on:", "  db:", "    condition: service_started", "    required: false", "  cache:", "    required: true"));
    expect(serviceOf(result).dependsOn).toEqual(["db", "cache"]);
    expect(notes(result).filter((note) => note.includes("DEPENDS"))).toEqual([
      "changed DEPENDS_ON_OPTIONAL_KEPT services.web.depends_on.db",
      "dropped DEPENDS_ON_CONDITION_DROPPED services.web.depends_on",
    ]);
    expect(messageOf(result, "DEPENDS_ON_OPTIONAL_KEPT")).toBe("'required: false' is not kept: in the draft the service always starts after this one, and does not start without it.");
  });

  it("refuses an entry of the map form that is not a mapping, or that has a key it does not know", () => {
    const wrongShape = run(stack("depends_on:", "  db: soon"));
    expectRefused(wrongShape, "refused DEPENDS_ON_INVALID services.web.depends_on.db");
    expect(messageOf(wrongShape, "DEPENDS_ON_INVALID")).toBe("A 'depends_on' entry is empty, or a mapping with 'condition', 'restart' and 'required'.");
    expectRefused(run(stack("depends_on:", "  db:", "    condition: service_started", "    weird_thing: 1")), "refused KEY_UNKNOWN services.web.depends_on.db.weird_thing");
  });

  it("says nothing about a map form without conditions", () => {
    const result = run(stack("depends_on:", "  db: {}", "  cache:"));
    expect(serviceOf(result).dependsOn).toEqual(["db", "cache"]);
    expect(notes(result).filter((note) => note.includes("DEPENDS"))).toEqual([]);
  });

  it("refuses a name the file does not have, in both forms", () => {
    expectRefused(run(stack("depends_on:", "  - db", "  - ghost", "  - 5")), "refused DEPENDS_ON_INVALID services.web.depends_on[1]", "refused DEPENDS_ON_INVALID services.web.depends_on[2]");
    expectRefused(run(stack("depends_on:", "  ghost:", "    condition: service_started")), "refused DEPENDS_ON_INVALID services.web.depends_on.ghost");
  });

  it("refuses a service that depends on itself", () => {
    const result = run(stack("depends_on:", "  - web"));
    expectRefused(result, "refused DEPENDS_ON_INVALID services.web.depends_on[0]");
    expect(messageOf(result, "DEPENDS_ON_INVALID")).toBe("A service cannot depend on itself.");
  });

  it("refuses a cycle, on every service of it", () => {
    const compose = file(
      "services:",
      ...serviceLines("a", IMAGE, "depends_on:", "  - b"),
      ...serviceLines("b", IMAGE, "depends_on:", "  - c"),
      ...serviceLines("c", IMAGE, "depends_on:", "  - a"),
      ...serviceLines("d", IMAGE, "depends_on:", "  - a"),
    );
    expect(refusals(run(compose))).toEqual(
      expect.arrayContaining(["refused DEPENDS_ON_CYCLE services.a.depends_on", "refused DEPENDS_ON_CYCLE services.b.depends_on", "refused DEPENDS_ON_CYCLE services.c.depends_on"]),
    );
    expect(refusals(run(compose)).every((note) => note.includes("DEPENDS_ON_CYCLE"))).toBe(true);
  });

  it("refuses 'depends_on' that is neither a list nor a mapping", () => {
    expectRefused(run(stack("depends_on: db")), "refused VALUE_INVALID services.web.depends_on");
  });
});

describe("healthcheck", () => {
  it("turns curl on localhost into an http check, and exposes its port", () => {
    const result = run(web("expose:", "  - 8080", "healthcheck:", '  test: ["CMD", "curl", "-f", "http://localhost/"]'));
    expect(serviceOf(result)).toMatchObject({ expose: [8080, 80], healthcheck: { kind: "http", port: 80, path: "/", intervalSeconds: 10, timeoutSeconds: 3 } });
    expect(notes(result)).toContain("changed HEALTHCHECK_CONVERTED services.web.healthcheck");
  });

  it("reads the string form with wget, the port and path of its URL, and brings the timing within the bounds", () => {
    const result = run(web("healthcheck:", "  test: wget -qO- http://127.0.0.1:3000/up || exit 1", "  interval: 2s", "  timeout: 2m", "  retries: 3"));
    expect(serviceOf(result).healthcheck).toEqual({ kind: "http", port: 3000, path: "/up", intervalSeconds: 5, timeoutSeconds: 5 });
    expect(notes(result).filter((note) => note.includes("HEALTHCHECK"))).toEqual([
      "changed HEALTHCHECK_CONVERTED services.web.healthcheck",
      "changed HEALTHCHECK_TIMING_ADJUSTED services.web.healthcheck.interval",
      "changed HEALTHCHECK_TIMING_ADJUSTED services.web.healthcheck.timeout",
    ]);
    expect(result.report.filter((note) => note.code === "HEALTHCHECK_TIMING_ADJUSTED").map((note) => note.message)).toEqual([
      "'interval' is outside 5 to 300 s: the draft uses 5 s.",
      "'timeout' is outside 1 to 5 s (a timeout is never longer than its interval): the draft uses 5 s.",
    ]);
    expect(messageOf(result, "HEALTHCHECK_CONVERTED")).toContain("The health check became an http check of the same path on port 3000, every 5 s with a timeout of 5 s:");
  });

  it("says nothing about the timing it keeps as written", () => {
    const result = run(web("healthcheck:", '  test: ["CMD", "curl", "http://localhost:8000/"]', "  interval: 30s", "  timeout: 10s"));
    expect(notes(result).filter((note) => note.includes("HEALTHCHECK"))).toEqual(["changed HEALTHCHECK_CONVERTED services.web.healthcheck"]);
  });

  it("uses the default for a duration without its unit, and says so", () => {
    const result = run(web("healthcheck:", '  test: ["CMD", "curl", "http://localhost:8000/"]', "  interval: 30", "  timeout: soon"));
    expect(serviceOf(result).healthcheck).toMatchObject({ intervalSeconds: 10, timeoutSeconds: 3 });
    expect(result.report.filter((note) => note.code === "HEALTHCHECK_TIMING_ADJUSTED").map((note) => `${note.path}: ${note.message}`)).toEqual([
      "services.web.healthcheck.interval: 'interval' is not a duration the importer reads (a number needs its unit, as in '30s'): the draft uses 10 s.",
      "services.web.healthcheck.timeout: 'timeout' is not a duration the importer reads (a number needs its unit, as in '30s'): the draft uses 3 s.",
    ]);
  });

  it("names the absolute bound of a timeout when the interval is not the tighter one", () => {
    const result = run(web("healthcheck:", '  test: ["CMD", "curl", "http://localhost:8000/"]', "  interval: 1m", "  timeout: 45s"));
    expect(serviceOf(result).healthcheck).toMatchObject({ intervalSeconds: 60, timeoutSeconds: 30 });
    expect(messageOf(result, "HEALTHCHECK_TIMING_ADJUSTED")).toBe("'timeout' is outside 1 to 30 s: the draft uses 30 s.");
  });

  it.each([
    ["a query string", "http://127.0.0.1:3000/up?full=1"],
    ["a fragment", "http://127.0.0.1:3000/up#ready"],
    ["a path a template does not accept", "http://127.0.0.1:3000/up%20now"],
  ])("probes the port only when the address of the check has %s, and says why", (_title, url) => {
    const result = run(web("healthcheck:", `  test: ["CMD", "wget", "-qO-", "${url}"]`));
    expect(serviceOf(result)).toMatchObject({ expose: [3000], healthcheck: { kind: "tcp", port: 3000 } });
    expect(messageOf(result, "HEALTHCHECK_CONVERTED")).toContain(
      "The health check became a tcp check, because a template cannot ask for the address the command asks (it has a query string, or a path a template does not accept), on port 3000,",
    );
    expect(JSON.stringify(result.report)).not.toContain("full=1");
  });

  it.each([
    ["1m30s", "45s", 90, 30],
    ["30s", "10s", 30, 10],
    ["10m", "1s", 300, 1],
    ["1h", "500ms", 300, 1],
  ])("reads interval %s and timeout %s", (interval, timeout, intervalSeconds, timeoutSeconds) => {
    const result = run(web("healthcheck:", '  test: ["CMD", "curl", "http://localhost:8000/"]', `  interval: ${interval}`, `  timeout: ${timeout}`));
    expect(serviceOf(result).healthcheck).toMatchObject({ intervalSeconds, timeoutSeconds });
  });

  it.each([
    ["mariadb:11.4", 3306],
    ["registry.example.invalid/lib/mysql:8.4", 3306],
    ["postgres:17-alpine", 5432],
    ["redis:7.4", 6379],
    ["valkey/valkey:8", 6379],
    ["mongo:8", 27017],
  ])("turns a command check of %s into a tcp check on its usual port %i", (image, port) => {
    const result = run(file("services:", ...serviceLines("web", image, "healthcheck:", '  test: ["CMD", "probe-it"]', "  interval: 20s")));
    expect(serviceOf(result)).toMatchObject({ expose: [port], healthcheck: { kind: "tcp", port, intervalSeconds: 20, timeoutSeconds: 3 } });
    expect(notes(result)).toContain("changed HEALTHCHECK_CONVERTED services.web.healthcheck");
  });

  it("falls back to the first exposed port, also for a URL that is https or on another host", () => {
    for (const test of ['["CMD", "probe-it"]', '["CMD", "curl", "https://localhost/"]', '["CMD", "curl", "http://status.example.invalid/"]']) {
      const result = run(web("expose:", "  - 8443", "  - 9000", "healthcheck:", `  test: ${test}`));
      expect(serviceOf(result).healthcheck).toMatchObject({ kind: "tcp", port: 8443 });
    }
  });

  it("uses the ingress port before any other for a check it cannot read", () => {
    const result = run(web("environment:", "  APP_URL: ${SERVICE_FQDN_WEB_3000}", "expose:", "  - 8443", "healthcheck:", '  test: ["CMD", "probe-it"]'));
    expect(serviceOf(result).healthcheck).toMatchObject({ kind: "tcp", port: 3000 });
    expect(notes(result)).toContain("changed HEALTHCHECK_CONVERTED services.web.healthcheck");
  });

  it("drops a check when no port can be found for it", () => {
    for (const lines of [['  test: ["CMD", "probe-it"]'], ['  test: ["CMD", "curl", "http://status.example.invalid/"]'], ["  interval: 10s"]]) {
      const result = run(web("healthcheck:", ...lines));
      expect(serviceOf(result)).toMatchObject({ healthcheck: null, expose: [] });
      expect(notes(result)).toContain("dropped HEALTHCHECK_DROPPED services.web.healthcheck");
    }
  });

  it("keeps a disabled check disabled, without a note", () => {
    for (const lines of [["  disable: true"], ['  test: ["NONE"]']]) {
      const result = run(web("expose:", "  - 8080", "healthcheck:", ...lines));
      expect(serviceOf(result).healthcheck).toBeNull();
      expect(notes(result).filter((note) => note.includes("HEALTHCHECK"))).toEqual([]);
    }
  });

  it("adds a tcp check to an ingress target whose check is disabled: the platform needs one", () => {
    const result = run(web("environment:", "  APP_URL: ${SERVICE_FQDN_WEB_3000}", "healthcheck:", "  disable: true"));
    expect(serviceOf(result).healthcheck).toEqual({ kind: "tcp", port: 3000, intervalSeconds: 10, timeoutSeconds: 3 });
    expect(notes(result)).toContain("info HEALTHCHECK_ADDED services.web.healthcheck");
  });

  it("refuses a health check of the wrong shape or with a key it does not know", () => {
    expectRefused(run(web("healthcheck: yes")), "refused VALUE_INVALID services.web.healthcheck");
    expectRefused(run(web("healthcheck:", "  test: 5")), "refused VALUE_INVALID services.web.healthcheck.test");
    expectRefused(run(web("healthcheck:", '  test: ["NONE"]', "  weird: 1")), "refused KEY_UNKNOWN services.web.healthcheck.weird");
  });
});

describe("command", () => {
  const commandOf = (...lines: string[]): readonly string[] | null => serviceOf(run(web(...lines))).command;

  it("keeps the list form, a number as text", () => {
    expect(commandOf('command: ["serve", "--port", 8080, "--name", "my app", "$$HOME"]')).toEqual(["serve", "--port", "8080", "--name", "my app", "$$HOME"]);
  });

  it("splits a one-line string on spaces, and says so", () => {
    const result = run(web("command: serve   --port 8080 --mode=fast"));
    expect(serviceOf(result).command).toEqual(["serve", "--port", "8080", "--mode=fast"]);
    expect(notes(result)).toContain("changed COMMAND_SPLIT services.web.command");
  });

  it.each([
    ["double quotes", "'serve --name \"my app\"'"],
    ["single quotes", "\"serve --name 'my app'\""],
    ["a chain", "migrate && serve"],
    ["a pipe", "serve | tee log"],
    ["a separator", "'migrate; serve'"],
    ["a substitution", "'serve --id $(hostname)'"],
    ["a redirection", "'serve > out.log'"],
    ["a backslash", "'serve \\ --port 80'"],
    ["a backtick", "'serve `hostname`'"],
  ])("refuses a string with %s rather than guess how a shell would read it", (_title, command) => {
    expectRefused(run(web(`command: ${command}`)), "refused COMMAND_REFUSED services.web.command");
  });

  it("refuses a shell or a launcher, wherever it stands", () => {
    expectRefused(run(web('command: ["sh", "-c", "serve"]')), "refused COMMAND_REFUSED services.web.command[0]");
    expectRefused(run(web('command: ["run", "--", "/bin/bash"]')), "refused COMMAND_REFUSED services.web.command[2]");
    expectRefused(run(web("command: bash start")), "refused COMMAND_REFUSED services.web.command");
  });

  it("drops an empty command", () => {
    for (const command of ['""', "[]"]) {
      const result = run(web(`command: ${command}`));
      expect(serviceOf(result).command).toBeNull();
      expect(notes(result)).toContain("dropped COMMAND_EMPTY_DROPPED services.web.command");
    }
  });

  it("keeps a variable that is a whole item, as a parameter", () => {
    const result = run(web('command: ["serve", "--workers", "${WORKERS:-2}"]'));
    expect(serviceOf(result).command).toEqual(["serve", "--workers", "${workers}"]);
    expect(specOf(result).parameters).toEqual([{ key: "workers", label: "WORKERS", type: "string", default: "2", customer: false }]);
    expect(notes(result)).toContain("info PARAMETER_FROM_VARIABLE services.web.command");
  });

  it("refuses a variable inside an item, as the program, or that is a secret", () => {
    expectRefused(run(web('command: ["serve", "--name=${NAME}"]')), "refused COMMAND_REFUSED services.web.command[1]");
    expectRefused(run(web('command: ["${PROGRAM}", "serve"]')), "refused COMMAND_REFUSED services.web.command[0]");
    expectRefused(run(web('command: ["serve", "${SERVICE_PASSWORD_ADMIN}"]')), "refused COMMAND_REFUSED services.web.command[1]");
    expectRefused(run(web('command: ["serve", "${SERVICE_FQDN_WEB}"]')), "refused COMMAND_REFUSED services.web.command[1]");
  });

  it.each([
    ["the item after an option that takes one", '["redis-server", "--requirepass", "hunter2XQ"]', "services.web.command[2]"],
    ["the value an option sets after '='", '["serve", "--api-key=hunter2XQ"]', "services.web.command[1]"],
    ["an address with a password", '["serve", "postgres://app:hunter2XQ@db:5432/app"]', "services.web.command[1]"],
    ["an address with a password and no user", '["serve", "--cache", "redis://:hunter2XQ@cache:6379/0"]', "services.web.command[2]"],
    ["a token", '["serve", "ghp_hunter2XQabcdefghijklmnopqrstuvwxyz0123"]', "services.web.command[1]"],
    ["the one-line form", "redis-server --requirepass hunter2XQ", "services.web.command"],
  ])("refuses a command that carries a secret: %s", (_title, command, path) => {
    const result = run(web(`command: ${command}`));
    expectRefused(result, `refused COMMAND_SECRET_REFUSED ${path}`);
    expect(messageOf(result, "COMMAND_SECRET_REFUSED")).toBe(
      "An item of the command is a secret, or follows an option that takes one: a template is published as it is written, so a command cannot carry a secret. Pass it in an environment variable.",
    );
    expect(JSON.stringify(result)).not.toContain("hunter2XQ");
  });

  it("refuses a command that repeats a secret of the environment, in any service", () => {
    const compose = file(
      "services:",
      ...serviceLines("web", IMAGE, 'command: ["serve", "--db-auth", "hunter2XQ-db"]'),
      ...serviceLines("db", "postgres:17", "environment:", "  POSTGRES_PASSWORD: hunter2XQ-db"),
    );
    const result = run(compose);
    expectRefused(result, "refused COMMAND_SECRET_REFUSED services.web.command[2]");
    expect(JSON.stringify(result)).not.toContain("hunter2XQ");
  });

  it("refuses a variable after an option that takes a secret, as it refuses any secret variable", () => {
    expectRefused(run(web('command: ["redis-server", "--requirepass", "${REDIS_AUTH}"]')), "refused COMMAND_REFUSED services.web.command[2]");
  });

  it("keeps the settings of a command whose options only sound like secrets", () => {
    const items = ["server", "--password-min-length", "8", "--token-ttl=3600", "--key", "/certs/key.pem", "--allow-empty-password=false", "--port", "8080"];
    expect(commandOf(`command: ${JSON.stringify(items)}`)).toEqual(items);
  });

  it("refuses a command of the wrong shape, with too many items or with an item too long", () => {
    expectRefused(run(web("command:", "  run: serve")), "refused VALUE_INVALID services.web.command");
    expectRefused(run(web('command: ["serve", [a, b]]')), "refused COMMAND_REFUSED services.web.command[1]");
    const items = (count: number): string => Array.from({ length: count }, (_unused, index) => `"a${index}"`).join(", ");
    expect(commandOf(`command: [${items(64)}]`)).toHaveLength(64);
    expectRefused(run(web(`command: [${items(65)}]`)), "refused COMMAND_REFUSED services.web.command");
    expect(commandOf(`command: ["serve", "${"x".repeat(1024)}"]`)).toHaveLength(2);
    expectRefused(run(web(`command: ["serve", "${"x".repeat(1025)}"]`)), "refused COMMAND_REFUSED services.web.command[1]");
  });
});

describe("limits", () => {
  const limitsOf = (...lines: string[]): { cpuMilli: number; memoryBytes: string } => serviceOf(run(web(...lines))).limits;

  it("applies 0.5 CPU and 512M to a service without limits, with a note", () => {
    const result = run(web());
    expect(serviceOf(result).limits).toEqual({ cpuMilli: 500, memoryBytes: String(512 * MIB) });
    expect(notes(result)).toContain("info LIMITS_DEFAULTED services.web");
    expect(messageOf(result, "LIMITS_DEFAULTED")).toBe("The file sets no CPU limit (0.5 applies) and no memory limit (512M applies) for this service.");
  });

  it("reads deploy.resources.limits before mem_limit and cpus, and drops what a template has no word for", () => {
    const result = run(
      web(
        "mem_limit: 256m",
        "cpus: 0.25",
        "deploy:",
        "  replicas: 2",
        "  resources:",
        "    limits:",
        '      cpus: "2"',
        "      memory: 2G",
        "      pids: 100",
        "    reservations:",
        "      memory: 1G",
      ),
    );
    expect(serviceOf(result).limits).toEqual({ cpuMilli: 2000, memoryBytes: String(2048 * MIB) });
    expect(notes(result).filter((note) => note.includes("deploy"))).toEqual([
      "dropped KEY_DROPPED services.web.deploy.replicas",
      "dropped KEY_DROPPED services.web.deploy.resources.reservations",
      "dropped KEY_DROPPED services.web.deploy.resources.limits.pids",
    ]);
    expect(notes(result).filter((note) => note.includes("LIMITS"))).toEqual(["dropped LIMITS_OVERRIDDEN services.web.cpus", "dropped LIMITS_OVERRIDDEN services.web.mem_limit"]);
    expect(result.report.filter((note) => note.code === "LIMITS_OVERRIDDEN").map((note) => note.message)).toEqual([
      "'cpus' is set beside 'deploy.resources.limits.cpus': the limit under 'deploy' is the one the draft uses, and 'cpus' is dropped.",
      "'mem_limit' is set beside 'deploy.resources.limits.memory': the limit under 'deploy' is the one the draft uses, and 'mem_limit' is dropped.",
    ]);
  });

  it("says nothing of 'mem_limit' and 'cpus' when 'deploy' sets the other limit only", () => {
    const result = run(web("mem_limit: 256m", "deploy:", "  resources:", "    limits:", '      cpus: "2"'));
    expect(serviceOf(result).limits).toEqual({ cpuMilli: 2000, memoryBytes: String(256 * MIB) });
    expect(notes(result).filter((note) => note.includes("LIMITS"))).toEqual([]);
  });

  it.each([
    ["1073741824", '"1.50"', 1024 * MIB, 1500],
    ["768m", "0.75", 768 * MIB, 750],
    ["1.5g", '".5"', 1536 * MIB, 500],
    ["100000k", "2", 100000 * 1024, 2000],
    ["64M", "1", 64 * MIB, 1000],
  ])("reads mem_limit %s and cpus %s", (memory, cpus, memoryBytes, cpuMilli) => {
    const result = run(web(`mem_limit: ${memory}`, `cpus: ${cpus}`));
    expect(serviceOf(result).limits).toEqual({ cpuMilli, memoryBytes: String(memoryBytes) });
    expect(notes(result).filter((note) => note.includes("LIMITS"))).toEqual([]);
  });

  it("applies the default for the one limit the file does not set", () => {
    const result = run(web("cpus: 2"));
    expect(serviceOf(result).limits).toEqual({ cpuMilli: 2000, memoryBytes: String(512 * MIB) });
    expect(messageOf(result, "LIMITS_DEFAULTED")).toBe("The file sets no memory limit (512M applies) for this service.");
  });

  it("brings a limit outside the bounds of the platform to the nearest bound, with a note", () => {
    const result = run(web("mem_limit: 8m", "cpus: 64"));
    expect(serviceOf(result).limits).toEqual({ cpuMilli: 16000, memoryBytes: String(32 * MIB) });
    expect(notes(result).filter((note) => note.includes("LIMITS"))).toEqual(["changed LIMITS_ADJUSTED services.web.cpus", "changed LIMITS_ADJUSTED services.web.mem_limit"]);
  });

  it("rounds a CPU limit to three decimals, with a note", () => {
    const result = run(web("mem_limit: 64m", "cpus: 0.1234"));
    expect(serviceOf(result).limits.cpuMilli).toBe(123);
    expect(notes(result)).toContain("changed LIMITS_ADJUSTED services.web.cpus");
  });

  it("applies the default for a limit it cannot read, with a note, and for a limit of zero", () => {
    const unreadable = run(web("mem_limit: lots", "cpus: fast"));
    expect(serviceOf(unreadable).limits).toEqual({ cpuMilli: 500, memoryBytes: String(512 * MIB) });
    expect(notes(unreadable).filter((note) => note.includes("LIMITS"))).toEqual([
      "changed LIMITS_ADJUSTED services.web.cpus",
      "changed LIMITS_ADJUSTED services.web.mem_limit",
    ]);
    expect(JSON.stringify(unreadable.report)).not.toContain("lots");
    const zero = run(web("mem_limit: 0", "cpus: 0"));
    expect(limitsOf("mem_limit: 0", "cpus: 0")).toEqual({ cpuMilli: 500, memoryBytes: String(512 * MIB) });
    expect(notes(zero).filter((note) => note.includes("LIMITS"))).toEqual(["info LIMITS_DEFAULTED services.web"]);
  });

  it("refuses 'deploy' of the wrong shape or with a key it does not know", () => {
    expectRefused(run(web("deploy: big")), "refused VALUE_INVALID services.web.deploy");
    expectRefused(run(web("deploy:", "  resources: big")), "refused VALUE_INVALID services.web.deploy.resources");
    expectRefused(run(web("deploy:", "  resources:", "    limits: big")), "refused VALUE_INVALID services.web.deploy.resources.limits");
    expectRefused(run(web("deploy:", "  weird: 1")), "refused KEY_UNKNOWN services.web.deploy.weird");
  });
});

describe("keys the importer does not read", () => {
  const LEVELS = COMPOSE_IMPORT_KEY_LEVELS;

  it.each([...LEVELS.service.dropped])("drops the service key '%s' with a note", (key) => {
    const result = run(web(`${key}: x`));
    specOf(result);
    expect(notes(result)).toContain(`dropped KEY_DROPPED services.web.${key}`);
    expect(messageOf(result, "KEY_DROPPED")).toBe(`'${key}' has no equivalent in a template: it is dropped.`);
  });

  it.each([...LEVELS.service.refused])("refuses the service key '%s': no draft is produced", (key) => {
    const result = run(web(`${key}: x`));
    expectRefused(result, `refused KEY_REFUSED services.web.${key}`);
    expect(messageOf(result, "KEY_REFUSED")).toBe(`'${key}' gives a container a privilege, a way to the host or code from outside its image: a template cannot carry it.`);
  });

  it("covers the keys the spec names on both lists", () => {
    expect(LEVELS.service.dropped).toEqual(expect.arrayContaining(["restart", "container_name", "labels", "networks", "hostname", "logging", "stop_grace_period"]));
    expect(LEVELS.service.refused).toEqual(
      expect.arrayContaining(["privileged", "cap_add", "devices", "network_mode", "pid", "ipc", "security_opt", "user", "build", "env_file", "entrypoint"]),
    );
  });

  it.each([...LEVELS.root.dropped])("drops the top-level key '%s'", (key) => {
    const result = run(`${key}: x\n${web()}`);
    specOf(result);
    expect(notes(result)).toContain(`dropped KEY_DROPPED ${key}`);
  });

  it.each([...LEVELS.root.refused])("refuses the top-level key '%s'", (key) => {
    expectRefused(run(`${web()}${key}: x\n`), `refused KEY_REFUSED ${key}`);
  });

  it.each([...LEVELS.deploy.dropped])("drops the deploy key '%s'", (key) => {
    const result = run(web("deploy:", `  ${key}: x`));
    specOf(result);
    expect(notes(result)).toContain(`dropped KEY_DROPPED services.web.deploy.${key}`);
  });

  it("drops the keys of resources and limits it does not read", () => {
    const result = run(web("deploy:", "  resources:", "    reservations: x", "    limits:", "      pids: 5", "      devices: x", "      memory: 64M", '      cpus: "1"'));
    specOf(result);
    expect(notes(result).filter((note) => note.includes("KEY_DROPPED"))).toEqual([
      "dropped KEY_DROPPED services.web.deploy.resources.reservations",
      "dropped KEY_DROPPED services.web.deploy.resources.limits.pids",
      "dropped KEY_DROPPED services.web.deploy.resources.limits.devices",
    ]);
  });

  it("drops an extension key, at the top and in a service", () => {
    const result = run(`x-defaults: x\n${web("x-note: x")}`);
    specOf(result);
    expect(notes(result).filter((note) => note.includes("KEY_DROPPED"))).toEqual(["dropped KEY_DROPPED x-defaults", "dropped KEY_DROPPED services.web.x-note"]);
    expect(messageOf(result, "KEY_DROPPED")).toBe("An extension key ('x-...') means nothing to the platform: it is dropped.");
  });

  it("refuses a key on neither list, at every level, and does not repeat it in the message", () => {
    const message = "The importer does not know this key and refuses the file rather than guess what the key grants.";
    for (const [compose, path] of [
      [`${web()}weird_thing: x\n`, "weird_thing"],
      [web("weird_thing: x"), "services.web.weird_thing"],
      [web("deploy:", "  resources:", "    weird_thing: x"), "services.web.deploy.resources.weird_thing"],
      [web("deploy:", "  resources:", "    limits:", "      weird_thing: x"), "services.web.deploy.resources.limits.weird_thing"],
      [web("healthcheck:", "  weird_thing: x"), "services.web.healthcheck.weird_thing"],
      [web("ports:", "  - target: 80", "    weird_thing: x"), "services.web.ports[0].weird_thing"],
      [file("services:", ...serviceLines("web", IMAGE, "depends_on:", "  db:", "    weird_thing: x"), ...serviceLines("db", IMAGE)), "services.web.depends_on.db.weird_thing"],
    ] as const) {
      const result = run(compose);
      expectRefused(result, `refused KEY_UNKNOWN ${path}`);
      expect(messageOf(result, "KEY_UNKNOWN")).toBe(message);
    }
  });

  it("has a test above for every level the importer keeps lists for", () => {
    expect(Object.keys(LEVELS).sort()).toEqual(["dependency", "deploy", "healthcheck", "limits", "port", "resources", "root", "service"]);
    // A key of these levels is either read or unknown: what the level loses is said by the note of its conversion.
    for (const level of ["healthcheck", "port", "dependency"] as const) expect([...LEVELS[level].dropped, ...LEVELS[level].refused]).toEqual([]);
  });

  it("never repeats the value of a dropped or refused key", () => {
    const dropped = run(web("labels:", '  note: "Bearer abcdefghijklmnopqrstuvwxyz012345"', "container_name: very-private-name"));
    specOf(dropped);
    expect(JSON.stringify(dropped)).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(JSON.stringify(dropped)).not.toContain("very-private-name");
    const refused = run(web("env_file: ./very-private.env", "user: operator-9000"));
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).not.toContain("very-private");
    expect(JSON.stringify(refused)).not.toContain("operator-9000");
  });
});
