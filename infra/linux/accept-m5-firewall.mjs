#!/usr/bin/env node
/**
 * Real-kernel acceptance check for M5d (the firewall, D28, R198 2.3 and 2.6).
 *
 * Loads the shipped infra/linux/nftables-dedicated.conf with a real nft inside a throw-away
 * container's own network namespace and drives the agent's built code (buildFirewallSetsProgram,
 * parseFirewallListing, validateFirewallSets from apps/host-agent/dist) against real connections
 * from a second container.
 *
 * Machine safety: everything is named hp_swarmtest_m5f_<hex>_{net,server,client}, made from the
 * local alpine:3 (never pulled), the server with NET_ADMIN only (never privileged, never the host
 * network), no published port, no bind mount; nft runs only through `docker exec` in the server.
 * Removed by exact name in `finally` and on SIGINT/SIGTERM; no other name is ever listed or touched.
 */

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const dist = (f) => pathToFileURL(path.resolve(repoRoot, "apps/host-agent/dist", f)).href;
const { buildFirewallSetsProgram, parseFirewallListing, validateFirewallSets } = await import(dist("firewall-sets.js"));
const { DEDICATED_NFTABLES_RULESET_SHA256 } = await import(dist("nftables-baseline.js"));

const IMAGE = "alpine:3";
const RULESET = path.resolve(here, "nftables-dedicated.conf");
const hex = randomBytes(4).toString("hex");
const prefix = `hp_swarmtest_m5f_${hex}`;
const NET = `${prefix}_net`;
const SERVER = `${prefix}_server`;
const CLIENT = `${prefix}_client`;
const V6_SUBNET = `2001:db8:${randomBytes(2).toString("hex")}::/64`;
const SAFE_PORT = 8080; // http_alt, on the safe list
const OTHER_PORT = 9999; // on no list
const LISTEN_PORTS = [22, 80, 443, SAFE_PORT, OTHER_PORT];

const containers = [];
let networkCreated = false;
let nftRuns = 0;

/** docker with an argument list (no shell); never rejects. */
function docker(args, input) {
  return new Promise((resolve) => {
    const child = execFile("docker", args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input ?? "");
  });
}

/** nft inside the server container only; counted so a refusal can prove nothing ran. */
function nft(args, input) {
  nftRuns += 1;
  return docker(["exec", ...(input === undefined ? [] : ["-i"]), SERVER, "nft", ...args], input);
}

let cleanupPromise = null;
function cleanup() {
  cleanupPromise ??= (async () => {
    for (const name of containers) await docker(["rm", "-f", "-v", name]);
    if (networkCreated) await docker(["network", "rm", NET]);
  })();
  return cleanupPromise;
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => void cleanup().finally(() => process.exit(sig === "SIGINT" ? 130 : 143)));
}

class StepAssertionError extends Error {}
function assert(cond, expected, actual) {
  if (!cond) throw new StepAssertionError(`${expected} / ${actual}`);
}
const sorted = (sets) => ({
  baseRules: "current",
  openedPorts: [...sets.openedPorts].sort((a, b) => a - b),
  blockedV4: [...sets.blockedV4].sort(),
  blockedV6: [...sets.blockedV6].sort(),
});

/** True when a TCP connect from the client to host:port completes within 2 s. */
async function answers(host, port) {
  return (await docker(["exec", CLIENT, "nc", "-z", "-w", "2", host, String(port)])).code === 0;
}

async function main() {
  let passed = 0;
  let total = 0;
  let setupFailed = false;
  let v6 = false;
  const ip = { server4: "", server6: "", client4: "", client6: "", net4: "" };
  const empty = { openedPorts: [], blockedV4: [], blockedV6: [] };

  const step = async (name, fn, { needsV6 = false } = {}) => {
    total += 1;
    if (setupFailed) return void console.log(`FAIL ${name}: skipped after setup failure`);
    if (needsV6 && !v6) return void console.log(`NOT RUN ${name}: the Docker daemon gave no IPv6 network`);
    try {
      await fn();
      passed += 1;
      console.log(`PASS ${name}`);
    } catch (err) {
      console.log(`FAIL ${name}: ${String(err?.message ?? err)}`);
      if (name.startsWith("01-") || name.startsWith("02-")) setupFailed = true;
    }
  };
  // Sends the lists through the agent's builder, then asserts the agent's parser reads them back.
  const apply = async (sets) => {
    const r = await nft(["-f", "-"], buildFirewallSetsProgram(sets));
    assert(r.code === 0, "nft -f - exits 0", r.stderr.trim());
    const listed = await nft(["-j", "list", "table", "inet", "hp_dedicated_filter"]);
    assert(listed.code === 0, "listing exits 0", listed.stderr.trim());
    const got = parseFirewallListing(listed.stdout);
    assert(JSON.stringify(got) === JSON.stringify(sorted(sets)), JSON.stringify(sorted(sets)), JSON.stringify(got));
  };
  const expectPorts = async (host, open, closed) => {
    for (const p of open) assert(await answers(host, p), `${host}:${p} answers`, "no answer");
    for (const p of closed) assert(!(await answers(host, p)), `${host}:${p} does not answer`, "answered");
  };

  try {
    await step("01-ruleset-pin", async () => {
      const sha = createHash("sha256").update(await readFile(RULESET)).digest("hex");
      assert(sha === DEDICATED_NFTABLES_RULESET_SHA256, DEDICATED_NFTABLES_RULESET_SHA256, sha);
    });

    await step("02-setup", async () => {
      const img = await docker(["image", "inspect", "--format", "{{.Id}}", IMAGE]);
      assert(img.code === 0, `${IMAGE} present locally`, img.stderr.trim());
      let net = await docker(["network", "create", "--ipv6", "--subnet", V6_SUBNET, NET]);
      v6 = net.code === 0;
      if (!v6) net = await docker(["network", "create", NET]);
      assert(net.code === 0, "network created", net.stderr.trim());
      networkCreated = true;
      for (const [name, extra] of [[SERVER, ["--cap-add", "NET_ADMIN"]], [CLIENT, []]]) {
        containers.push(name);
        const run = await docker(["run", "-d", "--pull", "never", "--network", NET, ...extra, "--name", name, IMAGE, "sleep", "3600"]);
        assert(run.code === 0, `${name} started`, run.stderr.trim());
      }
      const apk = await docker(["exec", SERVER, "apk", "add", "--no-cache", "nftables"]);
      assert(apk.code === 0, "nftables installed in the server", apk.stderr.trim().slice(-200));
      for (const p of LISTEN_PORTS) {
        const l = await docker(["exec", "-d", SERVER, "nc", "-lk", "-p", String(p), "-e", "true"]);
        assert(l.code === 0, `listener on ${p}`, l.stderr.trim());
      }
      const fmt = "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{.GlobalIPv6Address}}{{end}}";
      for (const [who, name] of [["server", SERVER], ["client", CLIENT]]) {
        const [a4, a6] = (await docker(["inspect", "-f", fmt, name])).stdout.trim().split(" ");
        ip[`${who}4`] = a4 ?? "";
        ip[`${who}6`] = a6 ?? "";
      }
      const subnet = await docker(["network", "inspect", "-f", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", NET]);
      ip.net4 = subnet.stdout.trim().split(" ").find((s) => s.includes(".")) ?? "";
      assert(/^\d+\.\d+\.\d+\.\d+$/.test(ip.server4) && /^\d+\.\d+\.\d+\.\d+$/.test(ip.client4) && ip.net4, "IPv4 addresses", JSON.stringify(ip));
      if (v6 && !(ip.server6 && ip.client6)) v6 = false;
      // Before any rule: every listener answers, so a later silence is the firewall's.
      await expectPorts(ip.server4, LISTEN_PORTS, []);
      if (v6) await expectPorts(ip.server6, LISTEN_PORTS, []);
    });

    await step("03-load-twice", async () => {
      const cp = await docker(["cp", RULESET, `${SERVER}:/tmp/nftables-dedicated.conf`]);
      assert(cp.code === 0, "ruleset copied", cp.stderr.trim());
      for (const n of [1, 2]) {
        const r = await nft(["-f", "/tmp/nftables-dedicated.conf"]);
        assert(r.code === 0, `load ${n} exits 0`, r.stderr.trim());
      }
      await apply(empty);
    });

    await step("04-static-ports-v4", () => expectPorts(ip.server4, [22, 80, 443], [SAFE_PORT, OTHER_PORT]));
    await step("05-static-ports-v6", () => expectPorts(ip.server6, [22, 80, 443], [SAFE_PORT, OTHER_PORT]), { needsV6: true });

    await step("06-open-safe-port", async () => {
      await apply({ ...empty, openedPorts: [SAFE_PORT] });
      await expectPorts(ip.server4, [SAFE_PORT], [OTHER_PORT]);
    });
    await step("07-close-safe-port", async () => {
      await apply(empty);
      await expectPorts(ip.server4, [80], [SAFE_PORT]);
    });

    await step("08-block-v4-address", async () => {
      await apply({ ...empty, blockedV4: [ip.client4] });
      await expectPorts(ip.server4, [22], [80, 443]);
    });
    await step("09-block-v4-network", async () => {
      await apply({ ...empty, blockedV4: [ip.net4] });
      await expectPorts(ip.server4, [22], [80]);
    });
    await step("10-block-v6-address", async () => {
      await apply({ ...empty, blockedV6: [ip.client6] });
      await expectPorts(ip.server6, [22], [80]);
      await expectPorts(ip.server4, [80], []);
    }, { needsV6: true });
    await step("11-block-v6-network-keeps-nd-and-22", async () => {
      await apply({ ...empty, blockedV6: [V6_SUBNET] });
      // Forget the neighbours, so the reply to 22 needs a neighbour advert from the blocked client.
      const flush = await docker(["exec", SERVER, "ip", "-6", "neigh", "flush", "all"]);
      assert(flush.code === 0, "neighbour cache flushed", flush.stderr.trim());
      await expectPorts(ip.server6, [22], [80]);
    }, { needsV6: true });

    await step("12-unblock", async () => {
      await apply(empty);
      await expectPorts(ip.server4, [80], []);
      if (v6) await expectPorts(ip.server6, [80], []);
    });

    await step("13-hostile-refused-before-nft", async () => {
      await apply({ ...empty, openedPorts: [SAFE_PORT] });
      const before = (await nft(["-j", "list", "table", "inet", "hp_dedicated_filter"])).stdout;
      const runs = nftRuns;
      const hostile = [
        { ...empty, blockedV4: ["203.0.113.7 } ; flush ruleset"] },
        { ...empty, blockedV4: ["999.1.1.1"] },
        { ...empty, blockedV4: ["example.test"] },
        { ...empty, blockedV6: ["fe80::1%eth0"] },
        { ...empty, blockedV6: ["2001:DB8::1"] },
        { ...empty, blockedV4: ["2001:db8::1"] },
        { ...empty, openedPorts: [22] },
      ];
      for (const sets of hostile) {
        let code = "accepted";
        try {
          validateFirewallSets(sets);
        } catch (err) {
          code = err?.code;
        }
        assert(code === "HOST_POLICY_DENIED", `refused ${JSON.stringify(sets)}`, String(code));
      }
      assert(nftRuns === runs, "no nft call during the refusals", `${nftRuns - runs} calls`);
      const after = (await nft(["-j", "list", "table", "inet", "hp_dedicated_filter"])).stdout;
      assert(JSON.stringify(parseFirewallListing(after)) === JSON.stringify(parseFirewallListing(before)), "listing unchanged", after.slice(0, 200));
      await expectPorts(ip.server4, [SAFE_PORT, 22], []);
    });
  } finally {
    await cleanup();
    total += 1;
    const count = async (args) => {
      const r = await docker(args);
      return r.code === 0 ? r.stdout.split("\n").filter(Boolean).length : -1;
    };
    const left = {
      containers: await count(["ps", "-a", "--filter", `name=${prefix}`, "-q"]),
      networks: await count(["network", "ls", "--filter", `name=${prefix}`, "-q"]),
      volumes: await count(["volume", "ls", "--filter", `name=${prefix}`, "-q"]),
    };
    const line = `containers=${left.containers} networks=${left.networks} volumes=${left.volumes}`;
    if (Object.values(left).every((n) => n === 0)) {
      passed += 1;
      console.log(`PASS nothing-left ${line}`);
    } else {
      console.log(`FAIL nothing-left ${line}`);
    }
    console.log(`RESULT ${String(passed)}/${String(total)} passed (prefix ${prefix}, IPv6 ${v6 ? "run" : "not run"})`);
    process.exitCode = passed === total ? 0 : 1;
  }
}

await main();
