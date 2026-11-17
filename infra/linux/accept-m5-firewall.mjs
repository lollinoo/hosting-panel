#!/usr/bin/env node
/**
 * Real-kernel acceptance check for M5d (the firewall, D28, R198 2.3 and 2.6).
 *
 * Loads the shipped infra/linux/nftables-dedicated.conf with a real nft inside a throw-away
 * container's own network namespace and drives the agent's built code (buildFirewallSetsProgram,
 * parseFirewallListing, validateFirewallSets from apps/host-agent/dist) against real connections
 * from a second container. R207 host.1: the server forwards between two networks of its own, and the
 * forward chain drops what comes in on an interface named like a bridge towards the metadata address,
 * except DNS (addendum 2 A). Addendum 1 B: a press of Apply base rules on a table of release 0.5.0.
 *
 * Machine safety: everything is named hp_swarmtest_m5f_<hex>_{net,metanet,server,client,meta}, made from
 * the local alpine:3 (never pulled), with NET_ADMIN only (never privileged, never the host network), no
 * published port, no bind mount; nft runs only through `docker exec` in the server.
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
const NET2 = `${prefix}_metanet`;
const META = `${prefix}_meta`;
const METADATA = "169.254.169.254";
const OUTSIDE = "192.0.2.80"; // a forwarded address the chain must not drop
const METADATA6 = "fd00:ec2::254";
const OUTSIDE6 = "2001:db8:ffff::80";
// The base rules of release 0.5.0 (e627c60) are today's file without the forward chain's block.
const OLD_RULESET_SHA256 = "80c56bc1101e13b8e858fd0cf5f26bb74684f637050656bd0ef8372284011651";
const BRIDGE_NAME = "br-hpswarmtest"; // the server's interface on NET, renamed to match "br-*"
// A group with no leading zero, so the subnet is written as nft lists it back.
const group = () => (0x1000 + (randomBytes(2).readUInt16BE() % 0xefff)).toString(16);
const V6_SUBNET = `2001:db8:${group()}::/64`;
const V6_SUBNET2 = `2001:db8:${group()}::/64`;
const SAFE_PORT = 8080; // http_alt, on the safe list
const OTHER_PORT = 9999; // on no list
const LISTEN_PORTS = [22, 80, 443, SAFE_PORT, OTHER_PORT];

const containers = [];
const networks = [];
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
    for (const name of networks) await docker(["network", "rm", name]);
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
      networks.push(NET);
      // The client adds routes through the server, so it needs NET_ADMIN too; the server forwards.
      // keep_addr_on_down: step 16 renames the interface, and a link going down drops its IPv6 address.
      const fwd6 = v6 ? ["--sysctl", "net.ipv6.conf.all.forwarding=1", "--sysctl", "net.ipv6.conf.all.keep_addr_on_down=1"] : [];
      for (const [name, extra] of [[SERVER, ["--cap-add", "NET_ADMIN", "--sysctl", "net.ipv4.ip_forward=1", ...fwd6]], [CLIENT, ["--cap-add", "NET_ADMIN"]]]) {
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

    await step("14-forward-chain-listed", async () => {
      const r = await nft(["list", "chain", "inet", "hp_dedicated_filter", "forward"]);
      assert(r.code === 0, "nft list chain forward exits 0", r.stderr.trim());
      for (const want of ["hook forward priority filter; policy accept;",
        "ip daddr 169.254.0.0/16 udp dport 53 accept", "ip daddr 169.254.0.0/16 tcp dport 53 accept",
        'iifname "docker0" ip daddr 169.254.0.0/16 drop', 'iifname "br-*" ip daddr 169.254.0.0/16 drop',
        'iifname "docker0" ip6 daddr fd00:ec2::254 drop', 'iifname "br-*" ip6 daddr fd00:ec2::254 drop'])
        assert(r.stdout.includes(want), want, r.stdout.trim());
      const json = await nft(["-j", "list", "chain", "inet", "hp_dedicated_filter", "forward"]);
      console.log(`  the forward chain item as nft lists it: ${JSON.stringify(JSON.parse(json.stdout).nftables.find((i) => i.chain)?.chain)}`);
    });

    // Addendum 1 B: an updated server still runs the 0.5.0 table; the press is the two commands it sends.
    await step("15-press-on-a-0.5.0-table", async () => {
      const text = await readFile(RULESET, "utf8");
      const old = text.replace(/\n(?: {2}# [^\n]*\n)+ {2}chain forward \{\n[\s\S]*?\n {2}\}\n/, "");
      assert(createHash("sha256").update(old).digest("hex") === OLD_RULESET_SHA256, OLD_RULESET_SHA256, "another file");
      const stored = { openedPorts: [SAFE_PORT], blockedV4: ["192.0.2.7"], blockedV6: ["2001:db8:ffff::7"] };
      const listedRaw = async () => {
        const l = await nft(["-j", "list", "table", "inet", "hp_dedicated_filter"]);
        assert(l.code === 0, "listing exits 0", l.stderr.trim());
        return l.stdout;
      };
      for (const program of [old, buildFirewallSetsProgram(validateFirewallSets(stored))]) {
        const r = await nft(["-f", "-"], program);
        assert(r.code === 0, "0.5.0 table and its sets loaded", r.stderr.trim());
      }
      const before = await listedRaw();
      const read = parseFirewallListing(before);
      assert(read.baseRules === "outdated" && read.openedPorts.length === 0, "0.5.0 table reads outdated", JSON.stringify(read));
      for (const el of [`${SAFE_PORT}`, "192.0.2.7", "2001:db8:ffff::7"]) assert(before.includes(el), `${el} still in the running table`, before.slice(0, 300));
      await expectPorts(ip.server4, [SAFE_PORT], [OTHER_PORT]);
      // First command of the press (linux-adapter.ts, apply_dedicated_nftables_22_80_443): the file.
      const press = await nft(["-f", "/tmp/nftables-dedicated.conf"]);
      assert(press.code === 0, "the press loads the file", press.stderr.trim());
      const between = parseFirewallListing(await listedRaw());
      assert(JSON.stringify(between) === JSON.stringify(sorted(empty)), "the window: current, empty sets", JSON.stringify(between));
      await expectPorts(ip.server4, [22, 80], [SAFE_PORT]);
      // Second command (FirewallService sync after the operation): the stored lists.
      await apply(stored);
      const chain = await nft(["list", "chain", "inet", "hp_dedicated_filter", "forward"]);
      assert(chain.code === 0, "the forward chain is there after the press", chain.stderr.trim());
      await expectPorts(ip.server4, [SAFE_PORT, 22, 80], [OTHER_PORT]);
    });

    // client -> server (forwards) -> meta, which holds the metadata address and an ordinary one.
    await step("16-bridge-to-metadata-dropped-dns-passes", async () => {
      const net = await docker(["network", "create", ...(v6 ? ["--ipv6", "--subnet", V6_SUBNET2] : []), NET2]);
      assert(net.code === 0, "second network created", net.stderr.trim());
      networks.push(NET2);
      containers.push(META);
      const run = await docker(["run", "-d", "--pull", "never", "--network", NET2, "--cap-add", "NET_ADMIN", "--name", META, IMAGE, "sleep", "3600"]);
      assert(run.code === 0, `${META} started`, run.stderr.trim());
      const conn = await docker(["network", "connect", NET2, SERVER]);
      assert(conn.code === 0, "server joined the second network", conn.stderr.trim());
      const on = async (name, field = "IPAddress") => (await docker(["inspect", "-f", `{{(index .NetworkSettings.Networks "${NET2}").${field}}}`, name])).stdout.trim();
      const [server2, meta2] = [await on(SERVER), await on(META)];
      const [server26, meta26] = v6 ? [await on(SERVER, "GlobalIPv6Address"), await on(META, "GlobalIPv6Address")] : ["", ""];
      const ifaces = (await docker(["exec", SERVER, "ip", "-o", "-4", "addr", "show"])).stdout;
      const netIface = ifaces.split("\n").find((l) => l.includes(` ${ip.server4}/`))?.split(/\s+/)[1] ?? "";
      assert(server2 && meta2 && netIface, "addresses on the second network", JSON.stringify({ server2, meta2, netIface }));
      for (const [name, args] of [
        [META, ["ip", "addr", "add", `${METADATA}/32`, "dev", "eth0"]], [META, ["ip", "addr", "add", `${OUTSIDE}/32`, "dev", "eth0"]],
        [META, ["ip", "route", "add", `${ip.client4}/32`, "via", server2]],
        [SERVER, ["ip", "route", "add", `${METADATA}/32`, "via", meta2]], [SERVER, ["ip", "route", "add", `${OUTSIDE}/32`, "via", meta2]],
        [CLIENT, ["ip", "route", "add", `${METADATA}/32`, "via", ip.server4]], [CLIENT, ["ip", "route", "add", `${OUTSIDE}/32`, "via", ip.server4]],
        ...(v6 && server26 && meta26 ? [
          [META, ["ip", "addr", "add", `${METADATA6}/128`, "dev", "eth0"]], [META, ["ip", "addr", "add", `${OUTSIDE6}/128`, "dev", "eth0"]],
          [META, ["ip", "route", "add", `${ip.client6}/128`, "via", server26]],
          [SERVER, ["ip", "route", "add", `${METADATA6}/128`, "via", meta26]], [SERVER, ["ip", "route", "add", `${OUTSIDE6}/128`, "via", meta26]],
          [CLIENT, ["ip", "route", "add", `${METADATA6}/128`, "via", ip.server6]], [CLIENT, ["ip", "route", "add", `${OUTSIDE6}/128`, "via", ip.server6]],
        ] : []),
      ]) {
        const r = await docker(["exec", name, ...args]);
        assert(r.code === 0, `${name}: ${args.join(" ")}`, r.stderr.trim());
      }
      for (const args of [["-lk", "-p", "80", "-e", "true"], ["-lk", "-p", "53", "-e", "true"],
        ...[METADATA, OUTSIDE].map((a) => ["-u", "-l", "-s", a, "-p", "53", "-e", "cat"])]) {
        const l = await docker(["exec", "-d", META, "nc", ...args]);
        assert(l.code === 0, `listener on the metadata side: ${args.join(" ")}`, l.stderr.trim());
      }
      v6 &&= Boolean(server26 && meta26);
      // Control: the interface is not named like a bridge yet, so all answer through the server.
      await expectPorts(METADATA, [80, 53], []);
      await expectPorts(OUTSIDE, [80], []);
      // A new IPv6 address answers only once duplicate address detection is over (about a second).
      for (let i = 0; v6 && i < 5 && !(await answers(METADATA6, 80)); i += 1) await new Promise((r) => setTimeout(r, 1000));
      if (v6) await expectPorts(METADATA6, [80], []);
      if (v6) await expectPorts(OUTSIDE6, [80], []);
      for (const args of [["down"], ["name", BRIDGE_NAME]]) {
        const r = await docker(["exec", SERVER, "ip", "link", "set", "dev", netIface, ...args]);
        assert(r.code === 0, `ip link set ${netIface} ${args.join(" ")}`, r.stderr.trim());
      }
      const up = await docker(["exec", SERVER, "ip", "link", "set", "dev", BRIDGE_NAME, "up"]);
      assert(up.code === 0, `ip link set ${BRIDGE_NAME} up`, up.stderr.trim());
      await expectPorts(OUTSIDE, [80], []);
      await expectPorts(METADATA, [53], [80]);
    });

    // One datagram to udp 53 comes back through the bridge-named interface: control first, then the metadata address.
    await step("17-udp-dns-passes", async () => {
      for (const host of [OUTSIDE, METADATA]) {
        const r = await docker(["exec", "-i", CLIENT, "nc", "-u", "-w", "2", host, "53"], "hp-dns-probe\n");
        assert(r.stdout.includes("hp-dns-probe"), `udp ${host}:53 echoed back`, JSON.stringify(r));
      }
    });

    await step("18-bridge-to-metadata6-dropped", async () => {
      await expectPorts(OUTSIDE6, [80], []);
      await expectPorts(METADATA6, [], [80]);
    }, { needsV6: true });
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
