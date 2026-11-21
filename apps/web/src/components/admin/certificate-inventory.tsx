"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Clock, Search } from "lucide-react";
import {
  TLS_INVENTORY_FILTERS,
  type AdminTlsInventoryItemDto,
  type SiteDomainDto,
  type TlsCertificateDto,
  type TlsInventoryFilter,
} from "@hosting-panel/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TlsImportDialog } from "@/components/customer/tls-import-dialog";
import { format } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import { expiryView, type ExpiryIcon } from "@/lib/tls-view";

export interface InventoryQuery {
  filter: TlsInventoryFilter;
  q: string;
}
export interface InventorySite {
  id: string;
  name: string;
  owner: string | null;
}

const PAGE = "/admin/certificates";
const ICONS = { ok: CheckCircle2, clock: Clock, alert: AlertTriangle } as const satisfies Record<ExpiryIcon, unknown>;

/** The inventory URL for a filter, search text and chosen site; defaults are left out. */
export function inventoryHref(query: InventoryQuery, siteId: string | null): string {
  const qs = new URLSearchParams();
  if (query.filter !== "all") qs.set("filter", query.filter);
  if (query.q) qs.set("q", query.q);
  if (siteId) qs.set("site", siteId);
  return qs.size > 0 ? `${PAGE}?${qs}` : PAGE;
}

const siteDomainsHref = (siteId: string) => `/admin/sites/${siteId}/domains`;

function Expiry({ notAfter, now }: { notAfter: string | null; now: Date }) {
  const t = useMessages().admin.certificates.inventory;
  const locale = useLocale();
  if (notAfter === null) return <span className="text-muted-foreground">{t.expiry.unknown}</span>;
  const v = expiryView(notAfter, now);
  const Icon = ICONS[v.icon];
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(notAfter));
  return (
    <Badge variant={v.variant} className="gap-1 whitespace-nowrap">
      <Icon aria-hidden className="h-3 w-3" />
      {format(t.expiry[v.textKey], { date, n: v.daysLeft })}
    </Badge>
  );
}

function RowDetails({ row, cert }: { row: AdminTlsInventoryItemDto; cert: TlsCertificateDto | undefined }) {
  const t = useMessages().admin.certificates.inventory;
  const locale = useLocale();
  const day = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));
  const current = cert ? (cert.versions.find((v) => v.id === cert.activeVersionId) ?? cert.versions.at(-1)) : undefined;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">{t.details.summary}</summary>
      <dl className="mt-2 grid gap-x-4 gap-y-2 sm:grid-cols-[max-content_1fr]">
        {current && (
          <>
            <dt className="font-medium">{t.details.names}</dt>
            <dd className="font-mono">{current.sanDns.join(", ")}</dd>
            <dt className="font-medium">{t.details.fingerprint}</dt>
            <dd className="break-all font-mono">{current.fingerprintSha256}</dd>
            <dt className="font-medium">{t.details.serial}</dt>
            <dd className="break-all font-mono">{current.serialNumber}</dd>
            <dt className="font-medium">{t.details.key}</dt>
            <dd className="font-mono">{`${current.keyType.toUpperCase()} ${current.keyBits}`}</dd>
          </>
        )}
        {cert && (
          <>
            <dt className="font-medium">{t.details.versions}</dt>
            <dd>
              <ul>
                {cert.versions.map((v) => (
                  <li key={v.id}>{format(t.details.versionLine, { status: t.state[v.status], from: day(v.notBefore), to: day(v.notAfter) })}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
        <dt className="font-medium">{t.details.hosts}</dt>
        <dd>
          {row.hostnames.length === 0 ? (
            t.details.noHosts
          ) : (
            <ul className="font-mono">
              {row.hostnames.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          )}
          {row.siteId ? (
            <Link href={siteDomainsHref(row.siteId)} className="mt-1 inline-block underline">
              {format(t.details.openSite, { site: row.siteName ?? "" })}
            </Link>
          ) : (
            <span className="text-muted-foreground">{t.details.noSite}</span>
          )}
        </dd>
      </dl>
    </details>
  );
}

/** The administrator's certificate inventory: filters in the URL, a table with details per row, and import for one site. */
export function CertificateInventory({
  items,
  sites,
  siteId,
  domains,
  certificates,
  query,
  manualAvailable,
  csrfToken,
  now,
}: {
  items: AdminTlsInventoryItemDto[];
  sites: InventorySite[];
  /** The chosen site (from the URL), or null. */
  siteId: string | null;
  /** Domains of the chosen site, for the wizard's review step. */
  domains: SiteDomainDto[];
  /** Imported certificates of the chosen site: they add versions, fingerprint, serial and key to their rows. */
  certificates: TlsCertificateDto[];
  query: InventoryQuery;
  manualAvailable: boolean;
  csrfToken: string;
  /** ISO time the page was rendered at, so server and browser agree on the expiry texts. */
  now: string;
}) {
  const t = useMessages().admin.certificates.inventory;
  const router = useRouter();
  const [importing, setImporting] = React.useState(false);
  const at = new Date(now);
  const canImport = manualAvailable && siteId !== null;

  return (
    <section className="space-y-4" aria-labelledby="tls-inventory-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="tls-inventory-title" className="text-lg font-semibold">
          {t.title}
        </h2>
        <span className="text-xs text-muted-foreground">{format(t.total, { n: items.length })}</span>
      </div>

      <nav aria-label={t.filterLabel} className="flex flex-wrap gap-2">
        {TLS_INVENTORY_FILTERS.map((f) => (
          <Link
            key={f}
            href={inventoryHref({ ...query, filter: f }, siteId)}
            aria-current={f === query.filter ? "page" : undefined}
            className={`rounded-md border px-3 py-1 text-sm ${f === query.filter ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
          >
            {t.filters[f]}
          </Link>
        ))}
      </nav>

      <form method="get" action={PAGE} className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
        <input type="hidden" name="filter" value={query.filter} />
        <div className="relative flex-1">
          <Search aria-hidden className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input name="q" type="search" defaultValue={query.q} maxLength={128} aria-label={t.searchLabel} placeholder={t.searchPlaceholder} className="pl-8 text-xs" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tls-site">{t.siteLabel}</Label>
          <select
            id="tls-site"
            name="site"
            value={siteId ?? ""}
            onChange={(e) => router.push(inventoryHref(query, e.target.value || null))}
            className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
          >
            <option value="">{t.chooseSite}</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.owner ? `${s.name} (${s.owner})` : s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex gap-2">
          <Button type="submit" size="sm">
            {t.searchSubmit}
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href={inventoryHref({ filter: query.filter, q: "" }, siteId)}>{t.searchClear}</Link>
          </Button>
        </div>
      </form>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" disabled={!canImport} onClick={() => setImporting(true)}>
          {t.importFor}
        </Button>
        <span className="text-xs text-muted-foreground">{manualAvailable ? (siteId === null ? t.importHint : "") : t.importUnavailable}</span>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.columns.name}</TableHead>
              <TableHead>{t.columns.source}</TableHead>
              <TableHead>{t.columns.site}</TableHead>
              <TableHead>{t.columns.hostnames}</TableHead>
              <TableHead>{t.columns.issuer}</TableHead>
              <TableHead>{t.columns.wildcard}</TableHead>
              <TableHead>{t.columns.expiry}</TableHead>
              <TableHead>{t.columns.state}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-6 text-center text-xs text-muted-foreground">
                  {t.empty}
                </TableCell>
              </TableRow>
            ) : (
              items.map((row, i) => (
                <React.Fragment key={`${row.certificateId ?? row.source}:${row.siteId ?? ""}:${i}`}>
                  <TableRow className="border-b-0">
                    <TableCell className="text-xs font-medium">{row.name ?? row.hostnames[0] ?? ""}</TableCell>
                    <TableCell className="text-xs">{row.source === "manual" ? t.source.manual : t.source.acme}</TableCell>
                    <TableCell className="text-xs">{row.siteName ?? ""}</TableCell>
                    <TableCell className="font-mono text-xs">{row.hostnames.join(", ")}</TableCell>
                    <TableCell className="text-xs">{row.issuer ?? ""}</TableCell>
                    <TableCell className="text-xs">{row.wildcard ? t.wildcard.yes : t.wildcard.no}</TableCell>
                    <TableCell className="text-xs">
                      <Expiry notAfter={row.notAfter} now={at} />
                    </TableCell>
                    <TableCell className="text-xs">{t.state[row.status]}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell colSpan={8} className="pt-0">
                      <RowDetails row={row} cert={certificates.find((c) => c.id === row.certificateId)} />
                    </TableCell>
                  </TableRow>
                </React.Fragment>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {importing && siteId !== null && (
        <TlsImportDialog
          basePath={`/api/admin/sites/${siteId}`}
          csrfToken={csrfToken}
          domains={domains}
          onDone={() => router.refresh()}
          onClose={() => setImporting(false)}
        />
      )}
    </section>
  );
}
