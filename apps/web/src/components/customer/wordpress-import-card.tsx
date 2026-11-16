"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { SiteWordpressImportDto } from "@hosting-panel/contracts";
import { ImportProgress, useImportFollow } from "@/components/customer/wordpress-import";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { format } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { formatDate } from "@/lib/file-browser";

/** "Import a site" in the WordPress tab: the way in, the last outcome, or the running import. */
export function WordpressImportCard({
  basePath,
  importHref,
  initial,
}: {
  basePath: string;
  importHref: string;
  initial: SiteWordpressImportDto;
}) {
  const router = useRouter();
  const { data, slow, pageError } = useImportFollow(basePath, initial);
  const op = data.runningOperation;
  const wasRunning = useRef(initial.runningOperation !== null);

  // At the end the tab loads again, with the WordPress state the import left.
  useEffect(() => {
    if (wasRunning.current && op === null) {
      wasRunning.current = false;
      router.refresh();
    }
  }, [op, router]);

  return <WordpressImportCardView data={data} slow={slow} pageError={pageError} importHref={importHref} />;
}

/** The card as shown; `slow` and `pageError` are the wizard's own sentences (R171.2). */
export function WordpressImportCardView({
  data,
  slow,
  pageError,
  importHref,
}: {
  data: SiteWordpressImportDto;
  slow: boolean;
  pageError: string | null;
  importHref: string;
}) {
  const m = useMessages();
  const t = m.site.wordpress.import;
  const op = data.runningOperation;
  const last = data.lastImport;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t.card.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {pageError && (
          <Alert variant="destructive">
            <AlertDescription>{pageError}</AlertDescription>
          </Alert>
        )}
        {op ? (
          <>
            <p>{t.card.running}</p>
            <ImportProgress operation={op} />
            {slow && <p className="text-muted-foreground">{t.progress.slow}</p>}
            <Link href={importHref} className={buttonVariants({ variant: "outline", size: "sm" })}>
              {t.card.follow}
            </Link>
          </>
        ) : (
          <>
            <p>{t.card.body}</p>
            {last && (
              <p>{format(t.card.last, { date: formatDate(last.finishedAt, m.common.dateLocale), result: t.card.result[last.outcome] })}</p>
            )}
            <Link href={importHref} className={buttonVariants({ size: "sm" })}>
              {t.card.start}
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  );
}
