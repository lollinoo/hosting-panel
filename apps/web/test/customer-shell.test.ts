import { describe, expect, it } from "vitest";
import { SITE_STATUSES, type SiteSummaryDto } from "@hosting-panel/contracts";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { toSiteStatusView } from "@/components/customer/status-pill";
import { SITE_TABS } from "@/components/customer/site-tabs";
import { pickLandingSite } from "@/app/sites/landing";

const site = (id: string) => ({ id, name: id }) as SiteSummaryDto;

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

  it("pickLandingSite returns last-used site if present, else first, else null", () => {
    expect(pickLandingSite([site("a"), site("b")], "b")).toBe("b");
    expect(pickLandingSite([site("a"), site("b")], "gone")).toBe("a");
    expect(pickLandingSite([site("a")], undefined)).toBe("a");
    expect(pickLandingSite([], "b")).toBeNull();
  });
});
