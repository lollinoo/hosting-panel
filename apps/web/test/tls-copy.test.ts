import { describe, expect, it } from "vitest";
import { CERTIFICATE_PROBLEM_REASONS, PEM_SHAPE_REASONS, TLS_INVENTORY_FILTERS } from "@hosting-panel/contracts";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";

const locales = [
  ["en", en],
  ["it", itMsgs],
] as const;

const leaves = (o: object): string[] => Object.values(o).flatMap((v) => (typeof v === "string" ? [v] : leaves(v)));

describe("manual TLS copy", () => {
  it.each(locales)("%s: pemReason covers every PEM_SHAPE_REASONS value with its own text", (_n, m) => {
    const pem = m.site.domains.tls.pemReason as Record<string, string>;
    expect(Object.keys(pem).sort()).toEqual([...PEM_SHAPE_REASONS].sort());
    for (const r of PEM_SHAPE_REASONS) expect(pem[r], r).toBeTruthy();
  });

  it.each(locales)("%s: reason covers the validation, assignment and apply reasons", (_n, m) => {
    const reason = m.site.domains.tls.reason as Record<string, string>;
    const rest = CERTIFICATE_PROBLEM_REASONS.filter((r) => !(PEM_SHAPE_REASONS as readonly string[]).includes(r));
    expect(Object.keys(reason).sort()).toEqual([...rest].sort());
    for (const r of rest) expect(reason[r], r).toBeTruthy();
  });

  it("every customer TLS text differs between Italian and English", () => {
    const e = leaves(en.site.domains.tls);
    const i = leaves(itMsgs.site.domains.tls);
    expect(e).toHaveLength(i.length);
    for (const [k, text] of Object.entries(en.site.domains.tls.pemReason)) {
      expect(text, k).not.toBe((itMsgs.site.domains.tls.pemReason as Record<string, string>)[k]);
    }
  });

  it.each(locales)("%s: the wizard never mentions PFX or passwords", (_n, m) => {
    for (const text of leaves(m.site.domains.tls.wizard)) expect(text).not.toMatch(/pfx|p12|pkcs12|password/i);
    for (const text of leaves(m.site.domains.tls)) expect(text).not.toMatch(/pfx|p12|pkcs12|password/i);
  });

  it.each(locales)("%s: review and done copy never says the certificate is active", (_n, m) => {
    const w = m.site.domains.tls.wizard as Record<string, string>;
    const keys = Object.keys(w).filter((k) => /^(review|done|warning)/.test(k));
    expect(keys.length).toBeGreaterThan(10);
    for (const k of keys) expect(w[k], k).not.toMatch(/\b(attivo|active)\b/i);
    for (const text of [m.site.domains.tls.applying, m.site.domains.tls.confirmBodyManual, m.site.domains.state.applyingCertificate]) {
      expect(text).not.toMatch(/\b(attivo|active)\b/i);
    }
  });

  it.each(locales)("%s: the inventory has a label for every filter and no PFX wording", (_n, m) => {
    const inv = m.admin.certificates.inventory;
    expect(Object.keys(inv.filters).sort()).toEqual([...TLS_INVENTORY_FILTERS].sort());
    for (const text of leaves(inv)) expect(text).not.toMatch(/pfx|p12|pkcs12|password/i);
  });
});
