"use client";

import { useState } from "react";
import Link from "next/link";
import type { CustomerAppTemplateSummaryDto } from "@hosting-panel/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { format, type Messages } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { formatCpu, formatMemory } from "./app-stack-view";

export function filterCatalog(entries: readonly CustomerAppTemplateSummaryDto[], category: string | null): CustomerAppTemplateSummaryDto[] {
  return entries.filter((e) => category === null || e.category === category);
}

export function categoryLabel(m: Messages, category: string): string {
  const labels: Record<string, string> = m.apps.category;
  return Object.hasOwn(labels, category) ? labels[category]! : category;
}

export function AppCatalog({ entries, categories }: { entries: CustomerAppTemplateSummaryDto[]; categories: string[] }) {
  const m = useMessages();
  const [category, setCategory] = useState<string | null>(null);
  const t = m.apps.catalog;
  const shown = filterCatalog(entries, category);
  const filter = (value: string | null, label: string) => (
    <Button
      key={value ?? ""}
      type="button"
      size="sm"
      variant={category === value ? "default" : "outline"}
      aria-pressed={category === value}
      onClick={() => setCategory(value)}
    >
      {label}
    </Button>
  );

  return (
    <div className="space-y-6">
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.empty}</p>
      ) : (
        <>
          <div role="group" aria-label={t.filterLabel} className="flex flex-wrap gap-2">
            {filter(null, t.all)}
            {categories.map((c) => filter(c, categoryLabel(m, c)))}
          </div>
          {shown.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.noMatch}</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {shown.map((e) => (
                <Card key={e.id} className="flex flex-col">
                  <CardHeader>
                    <CardTitle>{e.name}</CardTitle>
                    {e.description && <CardDescription>{e.description}</CardDescription>}
                  </CardHeader>
                  <CardContent className="flex-1 space-y-1 text-sm">
                    <Badge variant="outline">{categoryLabel(m, e.category)}</Badge>
                    <ul className="space-y-1 pt-2">
                      <li>{format(t.components, { n: e.componentCount })}</li>
                      <li>{format(t.resources, { cpu: formatCpu(e.cpuMilli), memory: formatMemory(e.memoryBytes) })}</li>
                      <li>{e.volumeCount > 0 ? t.keepsData : t.noData}</li>
                      <li>{e.hasIngress ? t.web : t.noWeb}</li>
                      <li>{format(t.version, { n: e.versionNumber })}</li>
                    </ul>
                    <p className="pt-2 text-xs text-muted-foreground">{t.isolation}</p>
                  </CardContent>
                  <CardFooter>
                    <Button asChild size="sm">
                      <Link href={"/apps/new/" + encodeURIComponent(e.id)} aria-label={format(t.chooseNamed, { name: e.name })}>
                        {t.choose}
                      </Link>
                    </Button>
                  </CardFooter>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
