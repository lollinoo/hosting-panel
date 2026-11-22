#!/usr/bin/env node
/**
 * Real-Docker check of the routing options of an application address (ADR-0037): the route file the PRODUCTION writer
 * (TraefikIngressFileManager.writeAppStackRoutes, apps/docker-executor/dist) writes for redirect, password protection,
 * compression and path rules is loaded by the pinned proxy image and behaves as the options say. The password
 * verifiers are computed by the API's own code (apps/api/dist/app-stacks/apr1.js), so the run proves that the proxy
 * accepts them. Two passes, each with its own proxy: a server without ACME (content over HTTP), then a server with
 * ACME (content over HTTPS, HTTP only sends to HTTPS).
 *
 * It does not deploy a stack: two tiny echo backends stand in for the components, and the request check of the
 * executor (app-stacks/routes-check.ts) is covered by its unit tests. The acceptance scripts of the applications
 * cover the deploy.
 *
 * Machine safety (this machine may run a live panel):
 *  - Every object is named after this run: stack id stk_swarmtest_<hex>, so the backend names the route file points at
 *    (hp_app_stk_swarmtest_<hex>_web|api) carry swarmtest_<hex>; the proxy, the network and the temp dir use
 *    hp_swarmtest_rt_<hex>.
 *  - Nothing this script creates carries an io.hostingpanel.* label: a live executor attaches its proxy to every
 *    network with the app_edge role label and adopts labelled objects, and it must see none of these. The step
 *    test-network-is-ours-only fails when any container of another owner is on the test network, and the last step
 *    compares the networks of every container that existed before the run.
 *  - The proxy is published on 127.0.0.1:16880/16843 only. The image, the command, the mounts, the user and the
 *    hardening come from the production payload builder; the name, the network, the ports and the labels do not.
 *  - ACME (second pass) points at https://127.0.0.1:9/directory, a closed port inside the proxy container: no request
 *    for a certificate leaves the machine, and the proxy answers HTTPS with its default certificate. Every hostname is
 *    under .test.
 *  - The docker CLI is called with an argv array only and refuses any argument naming an hp_ object of another run.
 *  - Images: traefik:v3.7 and the digest-pinned web image of the built-in «HTTP + cache» template must be local; this
 *    script never pulls.
 *  - Cleanup (memoised, in `finally` and on SIGINT/SIGTERM): this run's containers and network by exact name, then
 *    the temp dir. A network that another owner's container joined is left in place and reported, never detached.
 *
 * Run: corepack pnpm run build, then node infra/linux/accept-app-routing-options.mjs
 * Steps: preflight, snapshot-before, backends-up; then per pass (http-, https-): route-file, addresses-serve,
 * compression, password, paths, redirect, change-without-restart, proxy-log; https- also plain-http-only-redirects and
 * certificate-pending; then test-network-is-ours-only, foreign-containers-untouched, nothing-left.
 * Each prints PASS/FAIL <step>; final line RESULT n/m passed.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const t0 = performance.now();
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const exists = (p) => stat(p).then(() => true, () => false);
const DIST = ["apps/docker-executor/dist/index.js", "apps/api/dist/app-stacks/apr1.js", "packages/contracts/dist/index.js"].map((p) =>
  path.resolve(repoRoot, p),
);
const missingDist = [];
for (const file of DIST) if (!(await exists(file))) missingDist.push(path.relative(repoRoot, file));
if (missingDist.length > 0) {
  console.log(`FAIL preflight: run corepack pnpm run build first (missing ${missingDist.join(", ")})`);
  console.log("RESULT 0/1 passed in 0.0s");
  process.exit(1);
}
const [executor, apr1, contracts] = await Promise.all(DIST.map((file) => import(pathToFileURL(file).href)));
const { TraefikIngressFileManager, appStackContainerName, appStackRouteFileName, buildIngressProxyContainerPayload, buildTraefikStaticYaml } = executor;
const { apr1Verifier } = apr1;
const { APP_BUILT_IN_TEMPLATES, APP_ROUTE_PASSWORD_PATTERN, APP_ROUTE_PATH_PREFIX_PATTERN, APP_ROUTE_USERNAME_PATTERN, MAX_APP_ROUTE_PATHS, MAX_APP_STACK_DOMAINS } =
  contracts;

const TRAEFIK_IMAGE = "traefik:v3.7";
/** The web image of the built-in «HTTP + cache» template: digest-pinned, on the product's allowlist. */
const BACKEND_IMAGE = /^\s*image:\s*(nginxinc\/nginx-unprivileged\S*@sha256:[0-9a-f]{64})\s*$/m.exec(
  String(APP_BUILT_IN_TEMPLATES.find((t) => t.slug === "http-cache")?.source ?? ""),
)?.[1];
const HOST = "127.0.0.1";
const PORT = { http: 16880, https: 16843 };
const hex = randomBytes(6).toString("hex");
const marker = `swarmtest_${hex}`;
const runPrefix = `hp_swarmtest_rt_${hex}`;
const STACK = `stk_swarmtest_${hex}`;
const proxyName = `${runPrefix}_proxy`;
const testNet = `${runPrefix}_net`;
const BACKENDS = { web: [8080], api: [8080, 9090] };
const cName = (key) => appStackContainerName(STACK, key);
const ours = (s) => s.includes(marker) || s.includes(runPrefix);
const OURS_FILTER = ["--filter", `name=${marker}`, "--filter", `name=${runPrefix}`];

// ---- the addresses (the maximum an application can have) ----
const h = (label) => `${label}-${hex}.hp-route.test`;
const NAMES = ["plain", "zip", "lock", "long", "wait", "paths", "www", "svc"];
const H = Object.fromEntries(NAMES.map((n) => [n, h(n)]));
const USER = "guest.user-1_x";
const PASSWORDS = {
  // Printable ASCII with what a Basic header and a YAML string could trip over: a colon, a dollar, quotes, a backslash.
  lock: `p@ss:w0rd $1 "q" 'q' \\ {x}`,
  long: "L0ng-".repeat(25) + "end",
  wait: "exactly12chr",
};
const VERIFIERS = Object.fromEntries(Object.entries(PASSWORDS).map(([k, v]) => [k, apr1Verifier(v)]));
const protection = (k) => ({ username: USER, passwordHash: VERIFIERS[k] });
const API_STRIP = { pathPrefix: "/api", componentKey: "api", internalPort: 8080, stripPrefix: true };
const API_RAW = { pathPrefix: "/api/raw", componentKey: "api", internalPort: 9090, stripPrefix: false };
const DOCS = { pathPrefix: "/docs", componentKey: "api", internalPort: 8080, stripPrefix: false };

/**
 * What the API sends for these addresses (appStackRoutePlan): `secure` is a server with ACME and usable certificates;
 * `wait` is an address whose certificate is requested but not usable yet. `changed` is the same set after the customer
 * turned three options off.
 */
function routes(secure, changed = false) {
  const host = (name, options = {}, usable = secure) => ({ hostname: H[name], tls: secure, httpsRedirect: usable, redirectTo: null, ...options });
  return [
    {
      componentKey: "web",
      internalPort: 8080,
      hosts: [
        host("plain"),
        host("zip", changed ? {} : { compress: true }),
        host("lock", { protection: protection("lock"), compress: true, paths: [API_STRIP] }),
        host("long", changed ? {} : { protection: protection("long") }),
        host("wait", { protection: protection("wait"), paths: [DOCS] }, false),
        host("paths", { paths: changed ? [API_STRIP, API_RAW] : [API_STRIP, API_RAW, DOCS] }),
        // A redirecting address sits in the entry of its destination and carries nothing else.
        { hostname: H.www, tls: secure, httpsRedirect: secure, redirectTo: `${secure ? "https" : "http"}://${H.plain}` },
      ],
    },
    { componentKey: "api", internalPort: 9090, hosts: [host("svc")] },
  ];
}

// ---- helpers ----
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

class StepAssertionError extends Error {}
function assert(cond, expected, actual) {
  if (!cond) throw new StepAssertionError(`${expected} / got: ${String(actual)}`);
}
async function until(what, ms, fn, every = 400) {
  const deadline = Date.now() + ms;
  let last = "no answer";
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = String(err?.message ?? err);
    }
    if (Date.now() > deadline) throw new StepAssertionError(`${what} within ${String(ms / 1000)} s / ${last}`);
    await sleep(every);
  }
}

/** stdout and stderr together: the proxy may log on either. */
function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 << 20 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${cmd} ${args[0]}: ${String(stderr).trim() || err.message}`)) : resolve({ out: String(stdout), err: String(stderr) }),
    );
  });
}
/** The only docker CLI door: no hp_ name of another run, and object verbs only on this run's objects. */
async function dockerBoth(args, timeout = 120_000) {
  const foreign = args.flatMap((a) => [...a.matchAll(/hp_[A-Za-z0-9_.-]*/g)].map((t) => t[0])).filter((t) => !ours(t));
  const objectVerb = ["inspect", "logs", "rm", "stop", "run"].includes(args[0]) || (args[0] === "network" && ["inspect", "rm", "create"].includes(args[1]));
  if (foreign.length > 0 || (objectVerb && !args.some(ours))) throw new Error(`refusing docker ${args.join(" ")}`);
  return run("docker", args, timeout);
}
const docker = async (args, timeout) => (await dockerBoth(args, timeout)).out;
const lines = async (args) => (await docker(args)).split("\n").filter(Boolean).sort();
const inspectOf = async (name) => JSON.parse(await docker(["inspect", name]))[0];
/** Every container with its networks: a list call, no foreign name in the arguments. */
const containersWithNetworks = async () => {
  const rows = await lines(["ps", "-a", "--no-trunc", "--format", "{{.ID}} {{.Names}} {{.Networks}}"]);
  return new Map(rows.map((l) => l.split(" ")).map(([id, name, nets = ""]) => [id, { name, nets: nets.split(",").filter(Boolean).sort().join(",") }]));
};
const portIsFree = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port });
    socket.setTimeout(1_000, () => socket.destroy());
    socket.on("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(true));
    socket.on("close", () => resolve(true));
  });

/** One request to the throwaway proxy for a hostname; status 0 when nothing answered. Nothing is added to the headers. */
function ask(secure, hostname, urlPath = "/", { method = "GET", headers = {} } = {}) {
  return new Promise((resolve) => {
    const options = { host: HOST, port: secure ? PORT.https : PORT.http, path: urlPath, method, agent: false, headers: { Host: hostname, ...headers } };
    const onResponse = (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    };
    // The proxy answers with its default certificate: this run has no certificate authority to check it against.
    const req = secure ? https.request({ ...options, servername: hostname, rejectUnauthorized: false }, onResponse) : http.request(options, onResponse);
    req.setTimeout(5_000, () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve({ status: 0, headers: {}, body: Buffer.from(String(err.message)) }));
    req.end();
  });
}
const basic = (password, username = USER) => ({ Authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}` });
/** What a backend saw: backend, port, uri, host, auth (the Authorization header it received), prefix. */
const seen = (r) => Object.fromEntries([...r.body.toString("utf8").matchAll(/(\w+)=(?:\[([^\]]*)\]|(\S+))/g)].map((m) => [m[1], m[2] ?? m[3]]));
const show = (r) => `${String(r.status)} ${JSON.stringify(seen(r))} ${JSON.stringify({ location: r.headers.location, "www-authenticate": r.headers["www-authenticate"], "content-encoding": r.headers["content-encoding"] })}`;
const from = (r, backend, port, uri) => {
  const s = seen(r);
  return r.status === 200 && s.backend === backend && s.port === String(port) && (uri === undefined || s.uri === uri);
};

// ---- the echo backends ----
/** Above the size under which the proxy leaves an answer alone, below the longest value the backend's configuration takes. */
const BIG = "The quick brown fox jumps over the lazy dog. ".repeat(60);
const backendConf = (key) =>
  BACKENDS[key]
    .map((port) =>
      [
        "server {",
        `  listen ${String(port)};`,
        "  default_type text/plain;",
        `  location = /big { return 200 "${BIG}"; }`,
        `  location / { return 200 "backend=${key} port=$server_port uri=$request_uri host=$host auth=[$http_authorization] prefix=[$http_x_forwarded_prefix]\\n"; }`,
        "}",
        "",
      ].join("\n"),
    )
    .join("\n");

// ---- cleanup ----
let tmpDir = null;
let cleanupPromise = null;
function cleanup() {
  cleanupPromise ??= (async () => {
    for (const name of [proxyName, ...Object.keys(BACKENDS).map(cName)]) {
      await docker(["rm", "-f", "-v", name]).catch((err) => {
        if (!/No such container/i.test(err.message)) console.log(`INFO cleanup ${name}: ${err.message}`);
      });
    }
    // Fails while a container of another owner is attached: that one is reported by the last step, never detached here.
    await docker(["network", "rm", testNet]).catch((err) => {
      if (!/not found|No such network/i.test(err.message)) console.log(`INFO cleanup ${testNet}: ${err.message}`);
    });
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch((err) => console.log(`INFO cleanup ${tmpDir}: ${err.message}`));
  })();
  return cleanupPromise;
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => void cleanup().finally(() => process.exit(sig === "SIGINT" ? 130 : 143)));
}

async function main() {
  try {
    await docker(["version", "--format", "{{.Server.Version}}"]);
    if (!BACKEND_IMAGE) throw new Error("the http-cache seed names no digest-pinned web image");
    for (const image of [TRAEFIK_IMAGE, BACKEND_IMAGE]) await docker(["image", "inspect", "--format", "{{.Id}}", image]);
  } catch (err) {
    console.log(`SKIP accept-app-routing-options: no Docker Engine or an image is not local (${err.message}); nothing was created (this script never pulls)`);
    process.exit(1);
  }
  let passed = 0;
  let total = 0;
  const step = async (name, fn) => {
    total += 1;
    try {
      await fn();
      passed += 1;
      console.log(`PASS ${name}`);
      return true;
    } catch (err) {
      console.log(`FAIL ${name}: ${String(err?.message ?? err)}`);
      return false;
    }
  };
  const info = (msg) => console.log(`INFO ${msg}`);
  let before = null;

  try {
    const ready = await step("preflight", async () => {
      assert(NAMES.length <= MAX_APP_STACK_DOMAINS, "the addresses of the run fit one application", NAMES.length);
      // What the run sets is what a customer can type: the contract accepts every value.
      assert(APP_ROUTE_USERNAME_PATTERN.test(USER), "the user name is one the contract accepts", USER);
      for (const [k, v] of Object.entries(PASSWORDS)) assert(APP_ROUTE_PASSWORD_PATTERN.test(v), `the password of ${k} is one the contract accepts`, `${String(v.length)} characters`);
      const prefixes = [API_STRIP, API_RAW, DOCS].map((x) => x.pathPrefix);
      assert(prefixes.length <= MAX_APP_ROUTE_PATHS && prefixes.every((x) => APP_ROUTE_PATH_PREFIX_PATTERN.test(x)), "the paths are ones the contract accepts", prefixes.join(","));
      for (const port of Object.values(PORT)) assert(await portIsFree(port), `${HOST}:${String(port)} is free`, "in use");
      const leftovers = [...(await lines(["ps", "-aq", ...OURS_FILTER])), ...(await lines(["network", "ls", "-q", ...OURS_FILTER]))];
      assert(leftovers.length === 0, "no object of this run exists yet", leftovers.join(","));
      for (const [k, v] of Object.entries(VERIFIERS)) assert(/^\$apr1\$[./0-9A-Za-z]{8}\$[./0-9A-Za-z]{22}$/.test(v), `the API computes a verifier for ${k}`, "another shape");
    });
    if (!ready) return;

    await step("snapshot-before", async () => {
      before = await containersWithNetworks();
      info(`${String(before.size)} container(s) exist before the run; none is touched`);
    });

    tmpDir = await mkdtemp(path.join(os.tmpdir(), `${runPrefix}_`));
    const up = await step("backends-up", async () => {
      // No label at all: neither the network role a live executor looks for, nor a managed mark.
      await docker(["network", "create", "--driver", "bridge", testNet]);
      for (const key of Object.keys(BACKENDS)) {
        const conf = path.join(tmpDir, `${key}.conf`);
        await writeFile(conf, backendConf(key), { mode: 0o644 });
        await docker([
          "run", "-d", "--name", cName(key), "--network", testNet,
          "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only", "--tmpfs", "/tmp", "--pids-limit", "64", "--memory", "64m",
          "-v", `${conf}:/etc/nginx/conf.d/default.conf:ro`,
          BACKEND_IMAGE,
        ]);
      }
      for (const key of Object.keys(BACKENDS)) {
        const c = await until(`${cName(key)} runs`, 20_000, async () => {
          const i = await inspectOf(cName(key));
          return i.State.Running === true ? i : null;
        });
        assert(Object.keys(c.Config.Labels ?? {}).every((l) => !l.startsWith("io.hostingpanel")), `${cName(key)} carries no panel label`, Object.keys(c.Config.Labels ?? {}).join(","));
      }
      const labels = JSON.parse(await docker(["network", "inspect", testNet]))[0].Labels ?? {};
      assert(Object.keys(labels).length === 0, "the test network carries no label", JSON.stringify(labels));
    });
    if (!up) return;

    for (const secure of [false, true]) {
      const p = secure ? "https-" : "http-";
      const root = path.join(tmpDir, secure ? "ingress-acme" : "ingress-plain");
      const panel = secure
        ? {
            hostname: h("panel"),
            ipv4: "192.0.2.10",
            acmeEmail: "acme@hp-route.test",
            acmeStaging: false,
            acmeCaServer: "https://127.0.0.1:9/directory",
            acmeCaCertFile: null,
            upstreamPort: 9,
          }
        : null;
      const manager = new TraefikIngressFileManager(root, panel);
      const file = path.join(manager.dynamicDirPath, appStackRouteFileName(STACK));
      const content = (name, urlPath, options) => ask(secure, H[name], urlPath, options);
      let startedAt = null;

      const loaded = await step(`${p}route-file`, async () => {
        await mkdir(path.dirname(manager.staticConfigPath), { recursive: true, mode: 0o755 });
        await mkdir(manager.dynamicDirPath, { recursive: true, mode: 0o755 });
        await mkdir(manager.acmeDirPath, { recursive: true, mode: 0o700 });
        const staticYaml = buildTraefikStaticYaml(panel);
        await writeFile(manager.staticConfigPath, staticYaml, { mode: 0o644 });
        if (secure) {
          // As the product does: the proxy refuses a certificate store looser than 0600.
          const store = path.join(manager.acmeDirPath, "acme-custom.json");
          await (await open(store, "a", 0o600)).close();
          await chmod(store, 0o600);
        }
        assert(staticYaml.includes("certificatesResolvers:") === secure, `the static configuration ${secure ? "has" : "has no"} certificate resolver`, "the opposite");

        const written = await manager.writeAppStackRoutes(STACK, routes(secure));
        assert(written.changed === true && same(written.hostnames, Object.values(H).sort()), "the production writer wrote all the addresses", JSON.stringify(written));
        const text = await readFile(file, "utf8");
        assert(text.includes('"websecure"') === secure, `the file ${secure ? "has" : "has no"} HTTPS router`, "the opposite");
        for (const [k, password] of Object.entries(PASSWORDS)) {
          assert(!text.includes(password), `the password of ${k} is not in the file`, "present");
          assert(text.includes(`- "${USER}:${VERIFIERS[k]}"`), `the verifier of ${k} is in the file`, "absent");
        }
        const again = await manager.writeAppStackRoutes(STACK, routes(secure));
        assert(again.changed === false, "writing the same options again leaves the file alone", JSON.stringify(again));

        const payload = buildIngressProxyContainerPayload({
          traefikImage: TRAEFIK_IMAGE,
          httpHostPort: PORT.http,
          httpsHostPort: PORT.https,
          staticConfigHostPath: manager.staticConfigPath,
          dynamicDirHostPath: manager.dynamicDirPath,
          acmeDirHostPath: manager.acmeDirPath,
          user: `${String(process.getuid())}:${String(process.getgid())}`,
        });
        const hc = payload.HostConfig;
        await docker([
          "run", "-d", "--name", proxyName, "--network", testNet, "--user", payload.User,
          ...hc.CapDrop.flatMap((c) => ["--cap-drop", c]),
          ...hc.CapAdd.flatMap((c) => ["--cap-add", c]),
          ...hc.SecurityOpt.flatMap((o) => ["--security-opt", o]),
          "--pids-limit", String(hc.PidsLimit),
          ...hc.Binds.flatMap((b) => ["-v", b]),
          "-p", `${HOST}:${String(PORT.http)}:80`, "-p", `${HOST}:${String(PORT.https)}:443`,
          payload.Image, ...payload.Cmd,
        ]);
        const proxy = await inspectOf(proxyName);
        const bindings = Object.values(proxy.HostConfig.PortBindings ?? {}).flat();
        assert(bindings.length === 2 && bindings.every((b) => b.HostIp === HOST), "the throwaway proxy listens on loopback only", JSON.stringify(bindings));
        assert(Object.keys(proxy.Config.Labels ?? {}).every((l) => !l.startsWith("io.hostingpanel")), "the throwaway proxy carries no panel label", Object.keys(proxy.Config.Labels ?? {}).join(","));
        assert(!proxy.HostConfig.Binds.some((b) => b.includes("docker.sock")), "no Docker socket in the proxy", proxy.HostConfig.Binds.join(","));
        await until(`${H.plain} is served through the proxy`, 30_000, async () => {
          const r = await content("plain");
          return from(r, "web", 8080, "/") ? r : null;
        });
        startedAt = (await inspectOf(proxyName)).State.StartedAt;
      });

      if (loaded) {
        await step(`${p}addresses-serve`, async () => {
          const plain = await content("plain", "/hello?x=1");
          assert(from(plain, "web", 8080, "/hello?x=1") && seen(plain).host === H.plain, "an address without options reaches its component with its own name", show(plain));
          assert(plain.headers["www-authenticate"] === undefined && plain.headers["content-encoding"] === undefined, "no option leaks onto an address without options", show(plain));
          const svc = await content("svc");
          assert(from(svc, "api", 9090, "/"), "an address of the second component and port reaches it", show(svc));
          const unknown = await ask(secure, h("nobody"));
          assert(unknown.status === 404, "a name that is no address of the application is not served", show(unknown));
        });

        await step(`${p}compression`, async () => {
          const gzip = { "Accept-Encoding": "gzip" };
          const on = await content("zip", "/big", { headers: gzip });
          assert(on.status === 200 && on.headers["content-encoding"] === "gzip", "compression on: the answer is gzip", show(on));
          assert(gunzipSync(on.body).toString("utf8") === BIG && on.body.length < BIG.length / 4, "the compressed answer is the same content, smaller", `${String(on.body.length)} bytes`);
          const unasked = await content("zip", "/big");
          assert(unasked.status === 200 && unasked.headers["content-encoding"] === undefined && unasked.body.toString("utf8") === BIG, "a client that does not ask gets it uncompressed", show(unasked));
          const off = await content("plain", "/big", { headers: gzip });
          assert(off.status === 200 && off.headers["content-encoding"] === undefined && off.body.toString("utf8") === BIG, "compression off: the answer is as the application sent it", show(off));
        });

        await step(`${p}password`, async () => {
          for (const name of ["lock", "long", ...(secure ? [] : ["wait"])]) {
            const none = await content(name);
            assert(none.status === 401 && none.headers["www-authenticate"] === 'Basic realm="Restricted"', `${name}: no password, no content`, show(none));
            assert(seen(none).backend === undefined, `${name}: the refusal does not come from the application`, show(none));
            const wrong = await content(name, "/", { headers: basic(`${PASSWORDS[name]}x`) });
            assert(wrong.status === 401, `${name}: a wrong password is refused`, show(wrong));
            const stranger = await content(name, "/", { headers: basic(PASSWORDS[name], "someone") });
            assert(stranger.status === 401, `${name}: another user name is refused`, show(stranger));
            const right = await content(name, "/", { headers: basic(PASSWORDS[name]) });
            assert(from(right, "web", 8080, "/"), `${name}: the right password opens the address`, show(right));
            assert(seen(right).auth === "", `${name}: the application never receives the password`, seen(right).auth);
          }
          const other = await content("lock", "/", { headers: basic(PASSWORDS.long) });
          assert(other.status === 401, "the password of one address does not open another", show(other));
          const apiClosed = await content("lock", "/api/x");
          assert(apiClosed.status === 401, "a path of a protected address asks the same password", show(apiClosed));
          const apiOpen = await content("lock", "/api/x", { headers: basic(PASSWORDS.lock) });
          assert(from(apiOpen, "api", 8080, "/x") && seen(apiOpen).auth === "", "with the password the path reaches its component", show(apiOpen));
          const big = await content("lock", "/big", { headers: { ...basic(PASSWORDS.lock), "Accept-Encoding": "gzip" } });
          assert(big.status === 200 && big.headers["content-encoding"] === "gzip", "protection and compression work together", show(big));
        });

        await step(`${p}paths`, async () => {
          const outside = await content("paths", "/");
          assert(from(outside, "web", 8080, "/"), "outside the paths the address reaches its main component", show(outside));
          const exact = await content("paths", "/api");
          assert(from(exact, "api", 8080, "/") && seen(exact).prefix === "/api", "the path itself, prefix removed", show(exact));
          const below = await content("paths", "/api/users?x=1");
          assert(from(below, "api", 8080, "/users?x=1") && seen(below).host === H.paths, "below the path, prefix removed, query kept", show(below));
          const lookalike = await content("paths", "/apix/users");
          assert(from(lookalike, "web", 8080, "/apix/users"), "a path that only starts with the same letters is not taken", show(lookalike));
          const deeper = await content("paths", "/api/raw/users");
          assert(from(deeper, "api", 9090, "/api/raw/users") && seen(deeper).prefix === "", "the deeper path wins and keeps its prefix", show(deeper));
          const kept = await content("paths", "/docs/intro");
          assert(from(kept, "api", 8080, "/docs/intro"), "a path that keeps its prefix", show(kept));
          const elsewhere = await content("plain", "/api/users");
          assert(from(elsewhere, "web", 8080, "/api/users"), "the paths of one address do not apply to another", show(elsewhere));
        });

        await step(`${p}redirect`, async () => {
          const to = `${secure ? "https" : "http"}://${H.plain}`;
          for (const viaTls of secure ? [false, true] : [false]) {
            const get = await ask(viaTls, H.www, "/a/b?x=1");
            assert(get.status === 301 && get.headers.location === `${to}/a/b?x=1`, `a permanent redirect to the other address, path and query kept (${viaTls ? "https" : "http"})`, show(get));
            assert(seen(get).backend === undefined, "the redirecting address serves no content", show(get));
            const post = await ask(viaTls, H.www, "/form", { method: "POST" });
            assert([301, 308].includes(post.status) && post.headers.location === `${to}/form`, "other methods are redirected too", show(post));
          }
        });

        if (secure) {
          await step(`${p}plain-http-only-redirects`, async () => {
            for (const [name, urlPath] of [["plain", "/x?y=1"], ["lock", "/secret"], ["lock", "/api/x"], ["paths", "/api/users"]]) {
              const r = await ask(false, H[name], urlPath);
              assert(r.status === 301 && r.headers.location === `https://${H[name]}${urlPath}`, `${name}${urlPath} over HTTP is sent to HTTPS`, show(r));
              assert(r.headers["www-authenticate"] === undefined && seen(r).backend === undefined, `${name}${urlPath} over HTTP asks no password and serves nothing`, show(r));
            }
          });

          await step(`${p}certificate-pending`, async () => {
            // Until the certificate is usable the address is served over HTTP too, password included (runbook).
            for (const viaTls of [false, true]) {
              const none = await ask(viaTls, H.wait, "/");
              assert(none.status === 401, `no password, no content (${viaTls ? "https" : "http"})`, show(none));
              const right = await ask(viaTls, H.wait, "/", { headers: basic(PASSWORDS.wait) });
              assert(from(right, "web", 8080, "/") && seen(right).auth === "", `the right password opens the address (${viaTls ? "https" : "http"})`, show(right));
              const docs = await ask(viaTls, H.wait, "/docs/a", { headers: basic(PASSWORDS.wait) });
              assert(from(docs, "api", 8080, "/docs/a"), `its path rule is served (${viaTls ? "https" : "http"})`, show(docs));
            }
          });
        }

        await step(`${p}change-without-restart`, async () => {
          const written = await manager.writeAppStackRoutes(STACK, routes(secure, true));
          assert(written.changed === true, "the changed options rewrite the file", JSON.stringify(written));
          const opened = await until("the address without protection opens", 30_000, async () => {
            const r = await content("long");
            return from(r, "web", 8080, "/") ? r : null;
          });
          assert(opened.headers["www-authenticate"] === undefined, "protection off: no password asked", show(opened));
          const zip = await content("zip", "/big", { headers: { "Accept-Encoding": "gzip" } });
          assert(zip.status === 200 && zip.headers["content-encoding"] === undefined, "compression off takes effect", show(zip));
          const docs = await content("paths", "/docs/intro");
          assert(from(docs, "web", 8080, "/docs/intro"), "a removed path goes back to the main component", show(docs));
          const still = await content("lock");
          assert(still.status === 401, "an address that was not changed keeps its protection", show(still));
          const proxy = await inspectOf(proxyName);
          assert(proxy.State.StartedAt === startedAt && proxy.RestartCount === 0, "the proxy was neither restarted nor recreated", `${proxy.State.StartedAt} restarts=${String(proxy.RestartCount)}`);
        });

        await step(`${p}proxy-log`, async () => {
          const logs = await dockerBoth(["logs", proxyName]);
          const errors = `${logs.out}\n${logs.err}`.split("\n").filter((l) => /"level":"(error|fatal|panic)"/.test(l));
          // Expected in the second pass only: the certificate authority is a closed local port on purpose.
          const acme = errors.filter((l) => /acme/i.test(l));
          const others = errors.filter((l) => !/acme/i.test(l));
          assert(others.length === 0, "the proxy logged no error about the configuration", others.slice(0, 2).join(" | "));
          assert(secure || acme.length === 0, "no certificate request without ACME", acme.slice(0, 1).join(""));
          info(`${p.slice(0, -1)} pass: ${String(errors.length)} error line(s) in the proxy log${acme.length > 0 ? ` (${String(acme.length)} about the unreachable test certificate authority)` : ""}`);
        });
      }

      await docker(["rm", "-f", "-v", proxyName]).catch((err) => info(`proxy removal: ${err.message}`));
    }

    await step("test-network-is-ours-only", async () => {
      const attached = Object.values(JSON.parse(await docker(["network", "inspect", testNet]))[0].Containers ?? {}).map((c) => c.Name);
      assert(attached.length === Object.keys(BACKENDS).length && attached.every(ours), "only this run's containers are on the test network", attached.join(","));
    });
  } finally {
    await cleanup();
    total += 2;
    const after = await containersWithNetworks().catch(() => null);
    const moved = [];
    if (before !== null) {
      if (after === null) moved.push("listing failed");
      for (const [id, was] of before) {
        const now = after?.get(id);
        if (now === undefined) moved.push(`${was.name} is gone`);
        else if (now.nets !== was.nets) moved.push(`${was.name}: ${was.nets} -> ${now.nets}`);
      }
    }
    if (before !== null && moved.length === 0) {
      passed += 1;
      console.log("PASS foreign-containers-untouched");
    } else {
      console.log(`FAIL foreign-containers-untouched: ${before === null ? "no snapshot" : moved.join("; ")}`);
    }
    const left = [];
    for (const args of [["ps", "-aq", ...OURS_FILTER], ["network", "ls", "-q", ...OURS_FILTER], ["volume", "ls", "-q", ...OURS_FILTER]]) {
      if ((await docker(args).catch(() => "x")).trim() !== "") left.push(args[0]);
    }
    if (tmpDir && (await exists(tmpDir))) left.push(tmpDir);
    if (left.length === 0) {
      passed += 1;
      console.log("PASS nothing-left");
    } else {
      console.log(`FAIL nothing-left: ${left.join(",")}`);
    }
    const s = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`RESULT ${String(passed)}/${String(total)} passed in ${s}s`);
    process.exitCode = passed === total ? 0 : 1;
  }
}

await main();
