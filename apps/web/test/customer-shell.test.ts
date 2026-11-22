import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SITE_STATUSES } from "@hosting-panel/contracts";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { toSiteStatusView } from "@/components/customer/status-pill";
import { SITE_TABS } from "@/components/customer/site-tabs";

const fetchUpstream = vi.fn();
const getServerSession = vi.fn();
vi.mock("@/lib/upstream", () => ({ fetchUpstream: (...a: unknown[]) => fetchUpstream(...a) }));
vi.mock("@/lib/server-session", () => ({ getServerSession: () => getServerSession() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  usePathname: () => "/",
}));

import HomePage from "@/app/page";
import SitesPage from "@/app/sites/page";

describe("customer shell", () => {
  it("toSiteStatusView maps every SiteStatus to a known label key", () => {
    for (const status of SITE_STATUSES) {
      const { labelKey, tone } = toSiteStatusView(status);
      expect(Object.hasOwn(en.site.status, labelKey), status).toBe(true);
      expect(Object.hasOwn(itMsgs.site.status, labelKey), status).toBe(true);
      expect(["ok", "warn", "error", "muted"]).toContain(tone);
    }
  });

  it("toSiteStatusView flags a ready site whose settings are out of step as a problem", () => {
    const drifted = {
      totalServices: 1,
      inSyncCount: 0,
      driftedCount: 1,
      unknownCount: 0,
      overallDriftStatus: "drifted" as const,
    };
    expect(toSiteStatusView("ready").labelKey).toBe("online");
    expect(toSiteStatusView("ready", drifted).labelKey).toBe("problem");
  });

  it("SITE_TABS has overview first", () => {
    expect(SITE_TABS[0]?.key).toBe("overview");
    expect(SITE_TABS[0]?.href("s1")).toBe("/sites/s1");
  });

  it("/sites and a customer's landing go to the one list of applications", async () => {
    expect(() => SitesPage()).toThrow("REDIRECT /apps");
    getServerSession.mockResolvedValue({ activeConsole: "customer", user: { mustChangePassword: false } });
    await expect(HomePage()).rejects.toThrow("REDIRECT /apps");
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("deleting a site returns to the list of applications", () => {
    const code = fs.readFileSync(path.resolve(__dirname, "../src/components/customer/site-actions.tsx"), "utf-8");
    expect(code).toContain('router.push("/apps")');
    expect(code).not.toContain('"/sites"');
  });
});
