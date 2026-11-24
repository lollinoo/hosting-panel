// ADR-0040 N7: which addresses the API may call, and how it calls them. The one module that makes outbound requests.
import { createServer as createPlainServer, type Server as PlainServer } from "node:net";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createOutboundHttp, isPublicAddress, type OutboundHttpTestOptions, type RecordedAddresses } from "../src/notifications/outbound-http.js";
import type { DnsLookup } from "../src/sites/dns-check.js";
import { issuePki } from "./fixtures/tls-certgen.js";

const NAME = "hook.example.test";
const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V6 = "2606:2800:220:1:248:1893:25c8:1946";
// The addresses of a server behind address translation and of someone else: documentation ranges, taken as public.
const SELF_V4 = "203.0.113.10";
const SELF_V6 = "2001:db8::10";
const OTHER_V4 = "198.51.100.20";
const OTHER_V6 = "2001:db8::20";

/** A panel whose host rows record no address (a fresh install). */
const nothingRecorded: RecordedAddresses = async () => [];
const unreadable: RecordedAddresses = async () => {
  throw new Error("database down");
};

/** A resolver that answers from a table and remembers what it was asked. */
function resolver(table: Record<string, { a?: string[]; aaaa?: string[] } | Error>): DnsLookup & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async lookup(hostname) {
      asked.push(hostname);
      const row = table[hostname];
      if (row instanceof Error) throw row;
      return { a: row?.a ?? [], aaaa: row?.aaaa ?? [] };
    },
  };
}

describe("isPublicAddress", () => {
  it("accepts public unicast addresses", () => {
    for (const address of ["1.1.1.1", "8.8.8.8", PUBLIC_V4, "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "198.17.255.255", "198.20.0.1", "223.255.255.255", PUBLIC_V6, "2a00:1450:4002:410::200e", "2001:4860:4860::8888"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it("refuses private, loopback, link-local, shared, documentation, multicast and reserved IPv4", () => {
    for (const address of [
      "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254",
      "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255", "192.0.0.8", "192.0.2.1", "192.88.99.1",
      "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.7", "224.0.0.1", "239.255.255.255",
      "240.0.0.1", "255.255.255.255",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("refuses every IPv6 that is not public unicast, and every IPv4 written inside an IPv6", () => {
    for (const address of [
      "::", "::1", "::ffff:8.8.8.8", "::ffff:127.0.0.1", "::ffff:7f00:1", "::8.8.8.8", "64:ff9b::808:808", "64:ff9b:1::1",
      "100::1", "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:db8::1", "2002:7f00:1::1", "2002:808:808::1",
      "3fff::1", "fc00::1", "fd00:ec2::254", "fe80::1", "fec0::1", "ff02::1", "4000::1", "e000::1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("refuses what is not an address", () => {
    for (const text of ["", "example.com", "1.2.3", "1.2.3.4.5", "0x7f.0.0.1", "127.1", "2130706433", "fe80::1%eth0", " 8.8.8.8", "8.8.8.8 "]) {
      expect(isPublicAddress(text), JSON.stringify(text)).toBe(false);
    }
  });
});

describe("the address check", () => {
  const none = { localAddresses: () => [] } satisfies OutboundHttpTestOptions;

  it("accepts an https address whose name resolves only to public addresses", async () => {
    const dns = resolver({ [NAME]: { a: [PUBLIC_V4], aaaa: [PUBLIC_V6] } });
    expect(await createOutboundHttp(dns, nothingRecorded, none).check(`https://${NAME}/in/abc?x=1`)).toBeNull();
    expect(dns.asked).toEqual([NAME]);
  });

  it("refuses, without asking the resolver, what is not https to a DNS name", async () => {
    const dns = resolver({});
    const out = createOutboundHttp(dns, nothingRecorded, none);
    for (const url of [
      "not a url", "http://hook.example.test/", "ftp://hook.example.test/", "https://user:pw@hook.example.test/",
      "https://user@hook.example.test/", "https://127.0.0.1/", "https://8.8.8.8/", "https://[::1]/",
      "https://[2606:2800:220:1:248:1893:25c8:1946]/", "https://2130706433/", "https://0x7f.0.0.1/", "https://127.1/",
      "https://localhost/", "https://intranet/",
    ]) {
      expect(await out.check(url), url).toBe("address_not_allowed");
    }
    expect(dns.asked).toEqual([]);
  });

  it("refuses a name when any of its addresses is not public", async () => {
    const cases: Array<{ a?: string[]; aaaa?: string[] }> = [
      { a: ["10.0.0.5"] },
      { a: ["127.0.0.1"] },
      { a: ["169.254.169.254"] },
      { a: [PUBLIC_V4, "192.168.1.10"] },
      { a: [PUBLIC_V4], aaaa: ["::1"] },
      { a: [PUBLIC_V4], aaaa: ["fd00:ec2::254"] },
      { aaaa: ["::ffff:10.0.0.1"] },
      { a: ["not-an-address"] },
    ];
    for (const answer of cases) {
      const out = createOutboundHttp(resolver({ [NAME]: answer }), nothingRecorded, none);
      expect(await out.check(`https://${NAME}/`), JSON.stringify(answer)).toBe("address_not_allowed");
    }
  });

  it("refuses a name that resolves to one of this server's own addresses", async () => {
    const dns = resolver({ [NAME]: { a: [PUBLIC_V4] }, "six.example.test": { aaaa: [PUBLIC_V6] } });
    const out = createOutboundHttp(dns, nothingRecorded, { localAddresses: () => ["10.0.0.2", PUBLIC_V4, "2606:2800:220:1:248:1893:25c8:1946"] });
    expect(await out.check(`https://${NAME}/`)).toBe("address_not_allowed");
    // The same address spelled another way is still this server's.
    expect(await out.check("https://six.example.test/")).toBe("address_not_allowed");
    expect(await createOutboundHttp(dns, nothingRecorded, { localAddresses: () => ["10.0.0.2"] }).check(`https://${NAME}/`)).toBeNull();
  });

  it("refuses a name that resolves to an address the panel records for this server, also when no interface has it", async () => {
    const documentation = { treatAsPublic: () => true, localAddresses: () => [] } satisfies OutboundHttpTestOptions;
    const dns = resolver({
      [NAME]: { a: [SELF_V4] },
      "six.example.test": { aaaa: [SELF_V6] },
      "both.example.test": { a: [OTHER_V4, SELF_V4] },
      "mixed.example.test": { a: [OTHER_V4], aaaa: [SELF_V6] },
      "other.example.test": { a: [OTHER_V4], aaaa: [OTHER_V6] },
    });
    // The row may write an address otherwise than the resolver does: long form, capitals, an IPv4 inside an IPv6.
    for (const row of [[SELF_V4, SELF_V6], ["::ffff:203.0.113.10", "2001:DB8:0:0:0:0:0:10"]]) {
      const out = createOutboundHttp(dns, async () => row, documentation);
      for (const name of [NAME, "six.example.test", "both.example.test", "mixed.example.test"]) {
        expect(await out.check(`https://${name}/`), `${name} ${row.join(" ")}`).toBe("address_not_allowed");
      }
      expect(await out.check("https://other.example.test/")).toBeNull();
    }
    // Read at every call: an address the installer records again counts at once.
    let recorded: string[] = [];
    const out = createOutboundHttp(dns, async () => recorded, documentation);
    expect(await out.check("https://other.example.test/")).toBeNull();
    recorded = [OTHER_V6];
    expect(await out.check("https://other.example.test/")).toBe("address_not_allowed");
    // What is not an address is ignored.
    const odd = createOutboundHttp(dns, async () => ["", " ", "not-an-address", "203.0.113.0/24"], documentation);
    expect(await odd.check(`https://${NAME}/`)).toBeNull();
  });

  it("calls nothing while the addresses the panel records cannot be read", async () => {
    const dns = resolver({ "other.example.test": { a: [OTHER_V4] } });
    const documentation = { treatAsPublic: () => true, localAddresses: () => [] } satisfies OutboundHttpTestOptions;
    expect(await createOutboundHttp(dns, unreadable, documentation).check("https://other.example.test/")).toBe("unreachable");
    const stuck = createOutboundHttp(dns, () => new Promise(() => undefined), { ...documentation, timeoutMs: 300 });
    const started = Date.now();
    expect(await stuck.check("https://other.example.test/")).toBe("unreachable");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("reads this server's interfaces when nothing replaces them: loopback is one of them", async () => {
    const out = createOutboundHttp(resolver({ [NAME]: { a: ["127.0.0.1"] } }), nothingRecorded, { treatAsPublic: () => true });
    expect(await out.check(`https://${NAME}/`)).toBe("address_not_allowed");
  });

  it("calls a name that does not resolve, or a resolver that fails, unreachable", async () => {
    const dns = resolver({ "gone.example.test": {}, "down.example.test": new Error("ETIMEOUT") });
    const out = createOutboundHttp(dns, nothingRecorded, none);
    expect(await out.check("https://gone.example.test/")).toBe("unreachable");
    expect(await out.check("https://down.example.test/")).toBe("unreachable");
    expect(await out.postJson("https://down.example.test/", "{}")).toEqual({ problem: "unreachable", httpStatus: null });
  });

  it("gives up after its time on a resolver that never answers", async () => {
    const silent: DnsLookup = { lookup: () => new Promise(() => undefined) };
    const out = createOutboundHttp(silent, nothingRecorded, { ...none, timeoutMs: 300 });
    const started = Date.now();
    expect(await out.postJson(`https://${NAME}/`, "{}")).toEqual({ problem: "unreachable", httpStatus: null });
    expect(await out.check(`https://${NAME}/`)).toBe("unreachable");
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("the request", () => {
  const pki = issuePki({ leaf: { dns: [NAME] } });
  const seen: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string; servername: string | false }> = [];
  let server: Server | null = null;
  let plain: PlainServer | null = null;

  /** A TLS server on loopback that answers `status` and records what it got. */
  async function listen(status: number, extra: { location?: string; cert?: ReturnType<typeof issuePki>; silent?: boolean; body?: string } = {}): Promise<number> {
    const use = extra.cert ?? pki;
    server = createServer({ key: use.leaf.keyPem, cert: `${use.leaf.pem}${use.chainPem}` }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const socket = req.socket as unknown as { servername?: string | false };
        seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8"), servername: socket.servername ?? false });
        if (extra.silent) return;
        res.writeHead(status, extra.location ? { Location: extra.location } : {});
        res.end(extra.body ?? "ok");
      });
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    return (server.address() as AddressInfo).port;
  }

  const outbound = (extra: OutboundHttpTestOptions = {}, recorded: RecordedAddresses = nothingRecorded) =>
    createOutboundHttp(resolver({ [NAME]: { a: ["127.0.0.1"] } }), recorded, { treatAsPublic: () => true, localAddresses: () => [], ca: pki.root.pem, ...extra });

  async function stop(): Promise<void> {
    const running = server;
    server = null;
    if (!running) return;
    const closed = new Promise<void>((done) => running.close(() => done()));
    running.closeAllConnections();
    await closed;
  }

  afterEach(async () => {
    seen.length = 0;
    await stop();
    await new Promise<void>((done) => (plain ? plain.close(() => done()) : done()));
    plain = null;
  });

  it("posts the JSON body to the checked address, with the name for the certificate and in the Host header", async () => {
    const port = await listen(200);
    const body = JSON.stringify({ hello: "è" });
    const result = await outbound().postJson(`https://${NAME}:${String(port)}/in/abc?x=1`, body, { "X-Hosting-Panel-Signature": "t=1,v1=ab" });
    expect(result).toEqual({ problem: null, httpStatus: 200 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/in/abc?x=1", body, servername: NAME });
    expect(seen[0]!.headers).toMatchObject({
      host: `${NAME}:${String(port)}`,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      "user-agent": "hosting-panel",
      "x-hosting-panel-signature": "t=1,v1=ab",
    });
  });

  it("a caller's header cannot replace Host, the content type or the length", async () => {
    const port = await listen(204);
    const result = await outbound().postJson(`https://${NAME}:${String(port)}/`, "{}", { host: "other.example.test", "content-type": "text/plain", "Content-Length": "999", "Transfer-Encoding": "chunked" });
    expect(result).toEqual({ problem: null, httpStatus: 204 });
    expect(seen[0]!.headers).toMatchObject({ host: `${NAME}:${String(port)}`, "content-type": "application/json", "content-length": "2" });
  });

  it("says by the class of the status how it went, and never follows a redirect", async () => {
    for (const [status, problem] of [[301, "redirect"], [302, "redirect"], [307, "redirect"], [400, "rejected"], [401, "rejected"], [404, "rejected"], [429, "rejected"], [500, "server_error"], [503, "server_error"]] as const) {
      const port = await listen(status, { location: `https://${NAME}/elsewhere` });
      expect(await outbound().postJson(`https://${NAME}:${String(port)}/`, "{}"), String(status)).toEqual({ problem, httpStatus: status });
      expect(seen).toHaveLength(1);
      seen.length = 0;
      await stop();
    }
  });

  it("does not wait for a long answer: the status is enough", async () => {
    const port = await listen(200, { body: "x".repeat(4 * 1024 * 1024) });
    expect(await outbound().postJson(`https://${NAME}:${String(port)}/`, "{}")).toEqual({ problem: null, httpStatus: 200 });
  });

  it("refuses a certificate that is not for the name, or from an authority it does not trust", async () => {
    const other = issuePki({ leaf: { dns: ["other.example.test"] } });
    let port = await listen(200, { cert: other });
    expect(await outbound({ ca: other.root.pem }).postJson(`https://${NAME}:${String(port)}/`, "{}")).toEqual({ problem: "unreachable", httpStatus: null });
    expect(seen).toEqual([]);
    await stop();
    port = await listen(200);
    const untrusting = createOutboundHttp(resolver({ [NAME]: { a: ["127.0.0.1"] } }), nothingRecorded, { treatAsPublic: () => true, localAddresses: () => [] });
    expect(await untrusting.postJson(`https://${NAME}:${String(port)}/`, "{}")).toEqual({ problem: "unreachable", httpStatus: null });
    expect(seen).toEqual([]);
  });

  it("gives up after its time on a side that accepts and says nothing", async () => {
    const port = await listen(200, { silent: true });
    const started = Date.now();
    expect(await outbound({ timeoutMs: 300 }).postJson(`https://${NAME}:${String(port)}/`, "{}")).toEqual({ problem: "unreachable", httpStatus: null });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  /** Answers the loopback address after `ms`. */
  const slowResolver = (ms: number): DnsLookup => ({
    lookup: () => new Promise((done) => setTimeout(() => done({ a: ["127.0.0.1"], aaaa: [] }), ms)),
  });
  const slow = (ms: number, timeoutMs: number) =>
    createOutboundHttp(slowResolver(ms), nothingRecorded, { treatAsPublic: () => true, localAddresses: () => [], ca: pki.root.pem, timeoutMs });

  it("counts the resolution in its time: a slow resolver leaves only the rest to a side that says nothing", async () => {
    const port = await listen(200, { silent: true });
    const started = Date.now();
    expect(await slow(800, 1_000).postJson(`https://${NAME}:${String(port)}/`, "{}")).toEqual({ problem: "unreachable", httpStatus: null });
    // One time for both: not the resolution and then the whole time again.
    expect(Date.now() - started).toBeLessThan(1_400);
  });

  it("connects to nothing once its time ran out during the resolution", async () => {
    const port = await listen(200);
    const started = Date.now();
    expect(await slow(600, 300).postJson(`https://${NAME}:${String(port)}/`, "{}")).toEqual({ problem: "unreachable", httpStatus: null });
    expect(Date.now() - started).toBeLessThan(600);
    // The answer that comes late leads nowhere.
    await new Promise((done) => setTimeout(done, 600));
    expect(seen).toEqual([]);
  });

  it("calls unreachable a port nobody listens on and a port that does not speak TLS", async () => {
    // It reads what arrives, or it would never see the other side leave.
    plain = createPlainServer((socket) => {
      socket.on("error", () => undefined);
      socket.resume();
      socket.end("HTTP/1.1 200 OK\r\n\r\n");
    });
    await new Promise<void>((done) => plain!.listen(0, "127.0.0.1", done));
    const plainPort = (plain.address() as AddressInfo).port;
    expect(await outbound().postJson(`https://${NAME}:${String(plainPort)}/`, "{}")).toEqual({ problem: "unreachable", httpStatus: null });
    await new Promise<void>((done) => plain!.close(() => done()));
    plain = null;
    expect(await outbound().postJson(`https://${NAME}:${String(plainPort)}/`, "{}")).toEqual({ problem: "unreachable", httpStatus: null });
  });

  it("sends nothing to an address it refuses", async () => {
    const port = await listen(200);
    const guarded = createOutboundHttp(resolver({ [NAME]: { a: ["127.0.0.1"] } }), nothingRecorded, { localAddresses: () => [], ca: pki.root.pem });
    expect(await guarded.postJson(`https://${NAME}:${String(port)}/`, "{}")).toEqual({ problem: "address_not_allowed", httpStatus: null });
    expect(await guarded.postJson(`http://${NAME}:${String(port)}/`, "{}")).toEqual({ problem: "address_not_allowed", httpStatus: null });
    expect(seen).toEqual([]);
  });

  it("sends nothing to an address the panel records for this server, nor while those addresses cannot be read", async () => {
    const port = await listen(200);
    const url = `https://${NAME}:${String(port)}/`;
    // The test server stands for this server: its address is recorded and is on no interface (none is read here).
    expect(await outbound({}, async () => ["127.0.0.1"]).postJson(url, "{}")).toEqual({ problem: "address_not_allowed", httpStatus: null });
    expect(await outbound({}, unreadable).postJson(url, "{}")).toEqual({ problem: "unreachable", httpStatus: null });
    const started = Date.now();
    expect(await outbound({ timeoutMs: 300 }, () => new Promise(() => undefined)).postJson(url, "{}")).toEqual({ problem: "unreachable", httpStatus: null });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(seen).toEqual([]);
    // Readable, and not this server's: it goes.
    expect(await outbound({}, async () => [SELF_V4, SELF_V6]).postJson(url, "{}")).toEqual({ problem: null, httpStatus: 200 });
    expect(seen).toHaveLength(1);
  });
});
