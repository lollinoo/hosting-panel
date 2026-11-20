import type { SiteHostRoute } from "@hosting-panel/contracts";
import { createApprovedServiceSpec } from "@hosting-panel/executor-contracts";
import { describe, expect, it } from "vitest";
import { InMemoryDockerSimulatorAdapter } from "../src/index.js";

const SINCE = "1970-01-01T00:00:00.000Z";
const config = () => ({ provider: "cloudflare" as const, credentials: { CLOUDFLARE_DNS_API_TOKEN: "tok" } });
const host = (hostname: string, challenge: SiteHostRoute["challenge"]): SiteHostRoute => ({
  hostname,
  tls: true,
  httpsRedirect: true,
  redirectTo: null,
  challenge,
});

describe("simulator DNS provider", () => {
  it("applyDnsProvider stores the config and the report shows dnsChallenge", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    expect((await sim.getCertificateStatus({ failuresSince: SINCE })).dnsChallenge).toBe(false);
    const req = config();
    await sim.applyDnsProvider(req);
    req.credentials.CLOUDFLARE_DNS_API_TOKEN = "changed";
    expect(sim.dnsProvider).toEqual(config());
    expect(sim.dnsProviderApplies).toBe(1);
    expect((await sim.getCertificateStatus({ failuresSince: SINCE })).dnsChallenge).toBe(true);
  });

  it("null clears it", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    await sim.applyDnsProvider(config());
    await sim.applyDnsProvider(null);
    expect(sim.dnsProvider).toBeNull();
    expect(sim.dnsProviderApplies).toBe(2);
    expect((await sim.getCertificateStatus({ failuresSince: SINCE })).dnsChallenge).toBe(false);
  });

  it("dnsChallenge is false while acme is disabled", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    sim.acmeEnabled = false;
    await sim.applyDnsProvider(config());
    expect((await sim.getCertificateStatus({ failuresSince: SINCE })).dnsChallenge).toBe(false);
  });

  it("failNextDnsProviderApply fails once", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    sim.failNextDnsProviderApply();
    await expect(sim.applyDnsProvider(config())).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    expect(sim.dnsProvider).toBeNull();
    expect(sim.dnsProviderApplies).toBe(0);
    await sim.applyDnsProvider(config());
    expect(sim.dnsProvider).toEqual(config());
    expect(sim.dnsProviderApplies).toBe(1);
  });

  it("applied routes keep the dns-01 challenge", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    const spec = createApprovedServiceSpec({
      serviceInstanceId: "svc_1",
      siteId: "site_1",
      organizationId: "org_1",
      image: "wordpress:7.1.4-php8.4-apache",
      containerName: "hp_svc_svc_1",
      hostRoutes: [host("a.example.com", "dns-01")],
    });
    await sim.deployService(spec);
    expect(sim.appliedRoutes.get("site_1")?.hosts[0]?.challenge).toBe("dns-01");

    await sim.applySiteRoutes({
      siteId: "site_1",
      serviceInstanceId: "svc_1",
      containerName: "hp_svc_svc_1",
      internalPort: 80,
      hosts: [host("a.example.com", "http-01"), host("b.example.com", "dns-01")],
    });
    expect(sim.appliedRoutes.get("site_1")?.hosts.map((h) => h.challenge)).toEqual(["http-01", "dns-01"]);
  });
});
