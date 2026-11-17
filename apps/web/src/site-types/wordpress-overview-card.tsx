import type { SiteWordpressDto } from "@hosting-panel/contracts";
import Link from "next/link";
import { format, type Messages } from "@/i18n";
import { serverGet } from "@/lib/server-api";
import { pendingWordpressUpdates, wordpressOverviewKey } from "@/lib/site-wordpress";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** The WordPress card of a site's overview: its update state and the link to its tab. */
export async function WordpressOverviewCard({ orgId, siteId, m, when }: { orgId: string; siteId: string; m: Messages; when: Intl.DateTimeFormat }) {
  const wpRes = await serverGet<SiteWordpressDto>(
    `v1/organizations/${encodeURIComponent(orgId)}/managed-sites/${encodeURIComponent(siteId)}/wordpress`,
    { timeoutMs: 20_000 },
  );
  const wp = wpRes.ok ? wpRes.data : null;
  const wpKey = wordpressOverviewKey(wp);
  const wpText =
    wpKey === "wordpressUpToDate" && wp?.state
      ? format(m.site.overview.wordpressUpToDate, { date: when.format(new Date(wp.state.checkedAt)) })
      : wpKey === "wordpressCount" && wp?.state
        ? format(m.site.overview.wordpressCount, { count: pendingWordpressUpdates(wp.state) })
        : m.site.overview[wpKey];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{m.site.overview.wordpressTitle}</CardTitle>
      </CardHeader>
      <CardContent>
        <CardDescription role={wpKey === "wordpressLoadFailed" ? "alert" : undefined}>{wpText}</CardDescription>
        <Link
          href={`/sites/${siteId}/wordpress`}
          className="mt-3 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          {m.site.overview.wordpressLink}
        </Link>
      </CardContent>
    </Card>
  );
}
