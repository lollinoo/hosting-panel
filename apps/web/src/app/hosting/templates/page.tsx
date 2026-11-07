import { fetchServerTemplates } from "@/lib/server-api";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Box, Cpu, Activity, XCircle } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function HostingTemplatesPage() {
  const templates = await fetchServerTemplates();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Catalogo Service Template Approvati</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Modelli di servizio standardizzati e validati per l'esecuzione in stack applicativi dedicati (AC-F1-04).
          </p>
        </div>
        <Badge variant="outline" className="text-xs">
          {templates.length} Template Certificati
        </Badge>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {templates.length === 0 ? (
          <div className="col-span-full py-12 text-center text-sm text-muted-foreground">
            Nessun template di servizio registrato nel catalogo.
          </div>
        ) : (
          templates.map((tpl) => (
            <Card key={tpl.id} className="flex flex-col justify-between">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Box className="h-5 w-5 text-primary" />
                    <Badge variant="secondary" className="text-[10px] capitalize">
                      {tpl.category}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1">
                    {tpl.approvedForDedicated ? (
                      <Badge variant="success" className="text-[10px]">
                        Approvato Dedicated
                      </Badge>
                    ) : (
                      <Badge variant="destructive" className="text-[10px]">
                        Non Approvato
                      </Badge>
                    )}
                  </div>
                </div>
                <CardTitle className="text-base mt-2">{tpl.name}</CardTitle>
                <CardDescription className="text-xs line-clamp-2">
                  {tpl.description || "Nessuna descrizione specificata"}
                </CardDescription>
              </CardHeader>

              <CardContent className="space-y-3 text-xs pt-0">
                <div className="rounded-md border bg-muted/30 p-2.5 font-mono text-[11px] space-y-1">
                  <div className="text-muted-foreground">Immagine Container Predefinita:</div>
                  <div className="font-semibold text-foreground truncate">{tpl.defaultImage}</div>
                  {tpl.defaultPort && (
                    <div className="text-muted-foreground pt-1">
                      Porta di ascolto: <span className="font-semibold text-foreground">{tpl.defaultPort}</span>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div className="rounded border p-2 flex items-center gap-2">
                    <Cpu className="h-3.5 w-3.5 text-blue-500" />
                    <div>
                      <div className="text-muted-foreground">Min CPU</div>
                      <div className="font-semibold">{tpl.minCpuMilli} m</div>
                    </div>
                  </div>
                  <div className="rounded border p-2 flex items-center gap-2">
                    <Activity className="h-3.5 w-3.5 text-emerald-500" />
                    <div>
                      <div className="text-muted-foreground">Min RAM</div>
                      <div className="font-semibold">
                        {(Number(tpl.minMemoryBytes) / (1024 * 1024)).toFixed(0)} MB
                      </div>
                    </div>
                  </div>
                </div>

                <div className="pt-2 border-t flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">Supporto Multi-Tenant Shared:</span>
                  <span className="inline-flex items-center gap-1 text-destructive font-medium">
                    <XCircle className="h-3.5 w-3.5" />
                    <span>Shared disabilitato in MVP</span>
                  </span>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
