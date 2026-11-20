import { randomBytes } from "node:crypto";
import { signIpcRequest, type IpcSigningKey, type IpcVerificationKey } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  DockerExecutorIpcServer,
  InMemoryDockerSimulatorAdapter,
  SignedDockerExecutorIpcClient,
} from "../src/index.js";

const HMAC_SECRET = "0123456789abcdef0123456789abcdef-dns-provider-ipc";
const HMAC_SIGNING_KEY: IpcSigningKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: HMAC_SECRET };
const HMAC_VERIFICATION_KEY: IpcVerificationKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: HMAC_SECRET };
const ROUTE = "/v1/ingress/dns-provider/apply";

describe("DNS provider IPC", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanupTasks.length > 0) {
      await cleanupTasks.pop()?.();
    }
  });

  const config = {
    provider: "cloudflare" as const,
    credentials: { CLOUDFLARE_DNS_API_TOKEN: "cf-token-canary-123" },
  };

  async function serve(simulator: InMemoryDockerSimulatorAdapter) {
    const server = new DockerExecutorIpcServer({
      executor: simulator,
      keyring: { "hmac-v1": HMAC_VERIFICATION_KEY },
      transport: "loopback-test",
    });
    cleanupTasks.push(() => server.stop());
    const bound = await server.start();
    const client = new SignedDockerExecutorIpcClient({
      signingKey: HMAC_SIGNING_KEY,
      transport: "loopback-test",
      port: bound.port,
    });
    const raw = async (body: unknown, signed = true) => {
      const text = JSON.stringify(body);
      const headers = signed
        ? signIpcRequest({
            method: "POST",
            pathWithQuery: ROUTE,
            body: text,
            key: HMAC_SIGNING_KEY,
            nonce: randomBytes(8).toString("hex"),
          })
        : {};
      const res = await fetch(`http://127.0.0.1:${String(bound.port)}${ROUTE}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: text,
      });
      return { status: res.status, text: await res.text() };
    };
    return { client, raw };
  }

  it("client applies a provider through the signed route and the simulator stores it", async () => {
    const simulator = new InMemoryDockerSimulatorAdapter();
    const { client, raw } = await serve(simulator);
    await client.applyDnsProvider(config);
    expect(simulator.dnsProvider).toEqual(config);
    expect(simulator.dnsProviderApplies).toBe(1);
    const res = await raw({ config });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ data: { applied: true } });
  });

  it("null clears it", async () => {
    const simulator = new InMemoryDockerSimulatorAdapter();
    const { client, raw } = await serve(simulator);
    await client.applyDnsProvider(config);
    await client.applyDnsProvider(null);
    expect(simulator.dnsProvider).toBeNull();
    expect(simulator.dnsProviderApplies).toBe(2);
    const res = await raw({ config: null });
    expect(JSON.parse(res.text)).toEqual({ data: { applied: false } });
  });

  it("an unknown provider or field is refused with VALIDATION_ERROR and the value is not echoed", async () => {
    const simulator = new InMemoryDockerSimulatorAdapter();
    const { raw } = await serve(simulator);
    const bodies = [
      { config: { provider: "route53", credentials: { AWS_SECRET_ACCESS_KEY: "canary-secret-1" } } },
      {
        config: {
          provider: "cloudflare",
          credentials: { ...config.credentials, CF_API_KEY: "canary-secret-2" },
        },
      },
      { config: { provider: "cloudflare", credentials: { CLOUDFLARE_DNS_API_TOKEN: "canary\nsecret-3" } } },
    ];
    for (const body of bodies) {
      const res = await raw(body);
      expect(res.status).toBe(400);
      expect(JSON.parse(res.text).error.code).toBe("VALIDATION_ERROR");
      expect(res.text).not.toContain("canary");
      expect(res.text).not.toContain("cf-token");
    }
    expect(simulator.dnsProviderApplies).toBe(0);
  });

  it("an unsigned request is refused", async () => {
    const simulator = new InMemoryDockerSimulatorAdapter();
    const { raw } = await serve(simulator);
    const res = await raw({ config }, false);
    expect(res.status).toBe(401);
    expect(JSON.parse(res.text).error.code).toBe("UNAUTHENTICATED");
    expect(res.text).not.toContain("cf-token");
    expect(simulator.dnsProvider).toBeNull();
    expect(simulator.dnsProviderApplies).toBe(0);
  });
});
