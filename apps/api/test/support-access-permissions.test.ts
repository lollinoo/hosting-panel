import { readFileSync } from "node:fs";
import { PERMISSION_KEYS } from "@hosting-panel/contracts";
import { describe, expect, it } from "vitest";
import { SUPPORT_ACCESS_PERMISSIONS } from "../src/auth/support-access.service.js";

const SITE_CONTROLLERS = [
  "site-domains",
  "site-tls-certificates",
  "managed-sites",
  "site-files",
  "site-sftp",
  "site-databases",
  "site-backups",
  "site-wordpress",
  "site-wordpress-import",
];

describe("support visit permissions", () => {
  it("are exactly the 15 site, service and operation keys", () => {
    expect([...SUPPORT_ACCESS_PERMISSIONS]).toEqual([
      "site.read",
      "site.create",
      "site.update",
      "site.delete",
      "site.files.read",
      "site.files.write",
      "site.sftp.manage",
      "site.databases.manage",
      "site.backups.manage",
      "site.certificates.manage",
      "service.deploy",
      "service.restart",
      "service.stop",
      "service.logs.read",
      "operation.read",
    ]);
  });

  it("hold no key of the organization, quota, host, allocation, template, audit or platform families", () => {
    const forbidden = /^(organization|quota|host|allocation|template|audit|platform)\./;
    expect(SUPPORT_ACCESS_PERMISSIONS.filter((k) => forbidden.test(k))).toEqual([]);
  });

  it("cover every permission key a site controller asks for", () => {
    const known = new Set<string>(PERMISSION_KEYS);
    const asked = new Set<string>();
    for (const name of SITE_CONTROLLERS) {
      const src = readFileSync(new URL(`../src/controllers/${name}.controller.ts`, import.meta.url), "utf8");
      for (const [, key] of src.matchAll(/"([a-z.]+)"/g)) if (known.has(key!)) asked.add(key!);
    }
    expect(asked.size).toBeGreaterThan(0);
    expect([...asked].filter((k) => !(SUPPORT_ACCESS_PERMISSIONS as readonly string[]).includes(k))).toEqual([]);
  });
});
