import Link from "next/link";
import type { CustomerSiteTypeDto } from "@hosting-panel/contracts";
import type { SiteLimit } from "@/components/customer/new-site";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { format, type Messages } from "@/i18n";

export function SiteTypeCards({
  m,
  types,
  limit,
}: {
  m: Messages;
  /** null = the offered types could not be read: one generic WordPress choice. */
  types: readonly (CustomerSiteTypeDto | null)[];
  limit: SiteLimit | null;
}) {
  return (
    <section className="space-y-3">
      {limit && (
        <p className="text-sm text-muted-foreground" data-site-usage>
          {format(m.site.create.usage, limit)}
        </p>
      )}
      {limit !== null && limit.used >= limit.max ? (
        <Alert variant="warning" role="status">
          <AlertDescription>{format(m.site.create.limitReached, { max: limit.max })}</AlertDescription>
        </Alert>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {types.map((type) => {
            const name = type?.name ?? m.apps.list.wordpress;
            return (
              <Card key={type?.id ?? ""} className="flex flex-col">
                <CardHeader>
                  <CardTitle>{name}</CardTitle>
                  {type?.description && <CardDescription>{type.description}</CardDescription>}
                </CardHeader>
                <CardContent className="flex-1 text-sm">
                  <Badge variant="outline">{m.apps.list.wordpress}</Badge>
                </CardContent>
                <CardFooter>
                  <Button asChild size="sm">
                    <Link
                      href={type ? `/sites/new?type=${encodeURIComponent(type.id)}` : "/sites/new"}
                      aria-label={format(m.apps.catalog.chooseNamed, { name })}
                    >
                      {m.apps.catalog.choose}
                    </Link>
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
