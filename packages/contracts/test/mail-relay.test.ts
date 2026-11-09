import { describe, expect, it } from "vitest";
import {
  ApprovedServiceSpecWireSchema,
  MAIL_RELAY_PORTS,
  MailRelayApplyRequestSchema,
  MailRelayHostSchema,
  MailRelayPasswordSchema,
  MailRelaySettingsInputSchema,
  MailRelayUsernameSchema,
  SiteDomainsDtoSchema,
  mailSenderAddress,
} from "../src/index.js";

const base = { host: "smtp.example.com", port: 587, username: "u", senderDomain: "example.com" };

describe("mail relay contracts", () => {
  it("password rules accept punctuation and inner spaces but not newlines or edge whitespace", () => {
    for (const ok of [`p:a#s$s"w'o rd`, "pässwörd€", "x".repeat(256)]) {
      expect(MailRelayPasswordSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of ["a\nb", "a\rb", "a\0b", " lead", "trail ", "", "x".repeat(257)]) {
      const r = MailRelayPasswordSchema.safeParse(bad);
      expect(r.success).toBe(false);
      if (!r.success && bad.length > 0) {
        expect(JSON.stringify(r.error.issues)).not.toContain(bad);
      }
    }
  });

  it("username refuses a colon or whitespace", () => {
    expect(MailRelayUsernameSchema.safeParse("apikey-1@x").success).toBe(true);
    for (const bad of ["a:b", "a b", "a\tb", "a\u0000b", "a\u007fb", ""]) {
      expect(MailRelayUsernameSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("host accepts a hostname only", () => {
    expect(MailRelayHostSchema.parse("SMTP.Example.com ")).toBe("smtp.example.com");
    for (const bad of ["203.0.113.5", "smtp.example.com:587", "[smtp.example.com]", "http://x"]) {
      expect(MailRelayHostSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("port is one of 25, 465, 587, 2525", () => {
    for (const port of MAIL_RELAY_PORTS) {
      expect(MailRelaySettingsInputSchema.safeParse({ ...base, port }).success).toBe(true);
    }
    expect(MailRelaySettingsInputSchema.safeParse({ ...base, port: 2526 }).success).toBe(false);
  });

  it("settings input without a password is valid (keep the stored one)", () => {
    expect(MailRelaySettingsInputSchema.safeParse(base).success).toBe(true);
  });

  it("apply request requires the password", () => {
    expect(MailRelayApplyRequestSchema.safeParse(base).success).toBe(false);
    expect(MailRelayApplyRequestSchema.safeParse({ ...base, password: "pw" }).success).toBe(true);
  });

  it("ApprovedServiceSpecWireSchema accepts siteMail", () => {
    const spec = {
      serviceInstanceId: "s",
      siteId: "s",
      organizationId: "o",
      image: "i",
      containerName: "c",
      siteMail: true,
    };
    expect(ApprovedServiceSpecWireSchema.parse(spec).siteMail).toBe(true);
  });

  it("SiteDomainsDtoSchema accepts mail", () => {
    const dto = { serverIpv4: "1.2.3.4", routesPending: false, domains: [] };
    const mail = { configured: true, fromAddress: "noreply@example.com" };
    expect(SiteDomainsDtoSchema.parse({ ...dto, mail }).mail).toEqual(mail);
  });

  it("mailSenderAddress prefixes noreply@", () => {
    expect(mailSenderAddress("example.com")).toBe("noreply@example.com");
  });
});

it("sender domain failure uses a key, not English text", () => {
  const r = MailRelaySettingsInputSchema.safeParse({ ...base, senderDomain: "nope" });
  expect(r.success ? [] : r.error.issues.map((i) => i.message)).toEqual(["sender_domain_invalid"]);
});
