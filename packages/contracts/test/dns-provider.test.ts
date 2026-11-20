import { describe, expect, it } from "vitest";
import {
  DNS_PROVIDERS,
  DNS_PROVIDER_FIELDS,
  DnsProviderApplyIpcRequestSchema,
  DnsProviderApplyRequestSchema,
  DnsProviderSettingsDtoSchema,
  DnsProviderSettingsInputSchema,
  findForbiddenPublicDtoKeys,
} from "../src/index.js";

function issues(result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  return (result.error?.issues ?? []).map((i) => ({ path: i.path.join("."), message: i.message }));
}

describe("dns provider", () => {
  it("the provider table pins the lego env names", () => {
    expect(DNS_PROVIDERS).toEqual(["cloudflare", "digitalocean", "gandiv5", "hetzner", "httpreq", "ionos", "ovh"]);
    expect(DNS_PROVIDER_FIELDS).toEqual({
      cloudflare: [{ name: "CLOUDFLARE_DNS_API_TOKEN", required: true }],
      digitalocean: [{ name: "DO_AUTH_TOKEN", required: true }],
      gandiv5: [{ name: "GANDIV5_PERSONAL_ACCESS_TOKEN", required: true }],
      hetzner: [{ name: "HETZNER_API_TOKEN", required: true }],
      httpreq: [
        { name: "HTTPREQ_ENDPOINT", required: true },
        { name: "HTTPREQ_USERNAME", required: false },
        { name: "HTTPREQ_PASSWORD", required: false },
      ],
      ionos: [{ name: "IONOS_API_KEY", required: true }],
      ovh: [
        { name: "OVH_ENDPOINT", required: true },
        { name: "OVH_APPLICATION_KEY", required: true },
        { name: "OVH_APPLICATION_SECRET", required: true },
        { name: "OVH_CONSUMER_KEY", required: true },
      ],
    });
  });

  it("input without credentials is valid (keep stored)", () => {
    expect(DnsProviderSettingsInputSchema.parse({ provider: "ovh" })).toEqual({ provider: "ovh", credentials: {} });
    expect(DnsProviderSettingsInputSchema.safeParse({ provider: "route53" }).success).toBe(false);
  });

  it("unknown field is refused with field_unknown", () => {
    const r = DnsProviderSettingsInputSchema.safeParse({ provider: "cloudflare", credentials: { CF_DNS_API_TOKEN: "x" } });
    expect(issues(r)).toEqual([{ path: "credentials.CF_DNS_API_TOKEN", message: "field_unknown" }]);
  });

  it("httpreq needs both username and password or neither in the full set, not in a partial input", () => {
    const one = DnsProviderApplyRequestSchema.safeParse({
      provider: "httpreq",
      credentials: { HTTPREQ_ENDPOINT: "https://dns.example.test/acme", HTTPREQ_USERNAME: "u" },
    });
    expect(issues(one)).toEqual([{ path: "credentials.HTTPREQ_PASSWORD", message: "credentials_pair" }]);
    const other = DnsProviderApplyRequestSchema.safeParse({
      provider: "httpreq",
      credentials: { HTTPREQ_ENDPOINT: "https://dns.example.test/acme", HTTPREQ_PASSWORD: "p" },
    });
    expect(issues(other)).toEqual([{ path: "credentials.HTTPREQ_USERNAME", message: "credentials_pair" }]);
    // A partial input may rotate one half: the service checks the merged set.
    expect(DnsProviderSettingsInputSchema.safeParse({ provider: "httpreq", credentials: { HTTPREQ_PASSWORD: "p" } }).success).toBe(true);
    expect(
      DnsProviderSettingsInputSchema.safeParse({
        provider: "httpreq",
        credentials: { HTTPREQ_ENDPOINT: "https://dns.example.test/acme", HTTPREQ_USERNAME: "u", HTTPREQ_PASSWORD: "p" },
      }).success,
    ).toBe(true);
    const bad = DnsProviderSettingsInputSchema.safeParse({ provider: "httpreq", credentials: { HTTPREQ_ENDPOINT: "ftp://x" } });
    expect(issues(bad)).toEqual([{ path: "credentials.HTTPREQ_ENDPOINT", message: "endpoint_invalid" }]);
  });

  it("the httpreq endpoint takes printable ASCII only", () => {
    for (const c of ["\u0000", "\u001b", "\u007f", "\u0085", "\u00a0", " ", "\u00e9"]) {
      const r = DnsProviderSettingsInputSchema.safeParse({ provider: "httpreq", credentials: { HTTPREQ_ENDPOINT: `https://a${c}b/` } });
      expect(issues(r), JSON.stringify(c)).toEqual([{ path: "credentials.HTTPREQ_ENDPOINT", message: "endpoint_invalid" }]);
    }
    const ok = "http://10.0.0.1:8080/a-b_c.d~e?f=1&g=%20#h";
    expect(DnsProviderSettingsInputSchema.safeParse({ provider: "httpreq", credentials: { HTTPREQ_ENDPOINT: ok } }).success).toBe(true);
  });

  it("ovh endpoint must be ovh-eu, ovh-ca or ovh-us", () => {
    for (const ok of ["ovh-eu", "ovh-ca", "ovh-us"]) {
      expect(DnsProviderSettingsInputSchema.safeParse({ provider: "ovh", credentials: { OVH_ENDPOINT: ok } }).success).toBe(true);
    }
    const r = DnsProviderSettingsInputSchema.safeParse({ provider: "ovh", credentials: { OVH_ENDPOINT: "kimsufi-eu" } });
    expect(issues(r)).toEqual([{ path: "credentials.OVH_ENDPOINT", message: "ovh_endpoint_invalid" }]);
  });

  it("a value with a newline or edge spaces is refused and the message never echoes it", () => {
    for (const bad of ["tok\nen", " token", "token ", "tok\u007fen", "", "x".repeat(513)]) {
      const r = DnsProviderSettingsInputSchema.safeParse({ provider: "hetzner", credentials: { HETZNER_API_TOKEN: bad } });
      expect(issues(r), JSON.stringify(bad)).toEqual([{ path: "credentials.HETZNER_API_TOKEN", message: "value_invalid" }]);
    }
    const r = DnsProviderSettingsInputSchema.safeParse({ provider: "hetzner", credentials: { HETZNER_API_TOKEN: "s3cr3t-v4lue " } });
    expect(JSON.stringify(r.error?.issues)).not.toContain("s3cr3t");
  });

  it("apply request requires every required field", () => {
    const r = DnsProviderApplyRequestSchema.safeParse({ provider: "ovh", credentials: { OVH_ENDPOINT: "ovh-eu" } });
    expect(issues(r)).toEqual([
      { path: "credentials.OVH_APPLICATION_KEY", message: "field_required" },
      { path: "credentials.OVH_APPLICATION_SECRET", message: "field_required" },
      { path: "credentials.OVH_CONSUMER_KEY", message: "field_required" },
    ]);
    expect(
      DnsProviderApplyRequestSchema.safeParse({ provider: "httpreq", credentials: { HTTPREQ_ENDPOINT: "http://10.0.0.1:8080" } })
        .success,
    ).toBe(true);
    expect(DnsProviderApplyIpcRequestSchema.parse({ config: null })).toEqual({ config: null });
    expect(DnsProviderApplyIpcRequestSchema.safeParse({ config: { provider: "ionos", credentials: {} } }).success).toBe(false);
  });

  it("the settings DTO has no forbidden public key", () => {
    const dto = DnsProviderSettingsDtoSchema.parse({
      provider: "cloudflare",
      fieldsSet: ["CLOUDFLARE_DNS_API_TOKEN"],
      updatedAt: "2026-11-20T12:00:00.000Z",
      applied: true,
      ready: null,
    });
    expect(findForbiddenPublicDtoKeys(dto)).toEqual([]);
    expect(Object.keys(DnsProviderSettingsDtoSchema.shape).sort()).toEqual(
      ["applied", "fieldsSet", "provider", "ready", "updatedAt"],
    );
  });
});
