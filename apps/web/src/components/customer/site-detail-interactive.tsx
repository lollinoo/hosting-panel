"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  PlusCircle,
  Play,
  RotateCw,
  Loader2,
  CheckCircle2,
  ShieldAlert,
  Info,
} from "lucide-react";

export interface SiteDetailInteractiveProps {
  orgId: string;
  siteId: string;
  csrfToken?: string;
  services: Array<{
    id: string;
    name: string;
    desiredStatus: string;
    currentRevisionId: string | null;
  }>;
}

export function SiteDetailInteractive({
  orgId,
  siteId,
  csrfToken,
  services,
}: SiteDetailInteractiveProps) {
  const router = useRouter();

  // Add Service Dialog State
  const [openAddService, setOpenAddService] = React.useState(false);
  const [serviceName, setServiceName] = React.useState("");
  const [serviceTemplateId, setServiceTemplateId] = React.useState("tpl-node-app");
  const [cpuMilli, setCpuMilli] = React.useState("500");
  const [includeUnsafePrivileged, setIncludeUnsafePrivileged] = React.useState(false);
  const [loadingAdd, setLoadingAdd] = React.useState(false);
  const [addError, setAddError] = React.useState<{ code: string; message: string } | null>(null);
  const [addSuccess, setAddSuccess] = React.useState(false);

  // Lifecycle Action State
  const [loadingLifecycle, setLoadingLifecycle] = React.useState<string | null>(null);
  const [lifecycleResult, setLifecycleResult] = React.useState<{
    serviceId: string;
    code: string;
    message: string;
  } | null>(null);

  const handleAddService = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!csrfToken || !serviceName.trim()) return;

    setLoadingAdd(true);
    setAddError(null);
    setAddSuccess(false);

    const idempotencyKey = `add-svc-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    const configuration: Record<string, unknown> = {
      NODE_ENV: "production",
      PORT: 3000,
    };

    if (includeUnsafePrivileged) {
      // Intentionally insert unsafe flag to demonstrate policy rejection (AC-F1-04)
      configuration["privileged"] = true;
    }

    try {
      const res = await fetch(`/api/bff/orgs/${orgId}/sites/${siteId}/services`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          name: serviceName.trim(),
          serviceTemplateId,
          desiredStatus: "running",
          configuration,
          resourceLimits: {
            cpuMilli: parseInt(cpuMilli, 10) || 500,
            memoryBytes: "536870912", // 512 MB
          },
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setAddError({
          code: data.error?.code || "ERROR",
          message:
            data.error?.message ||
            "Validazione policy o creazione servizio fallita (AC-F1-04).",
        });
      } else {
        setAddSuccess(true);
        setTimeout(() => {
          setOpenAddService(false);
          router.refresh();
        }, 1200);
      }
    } catch {
      setAddError({
        code: "NETWORK_ERROR",
        message: "Errore di connessione durante la creazione del servizio.",
      });
    } finally {
      setLoadingAdd(false);
    }
  };

  const handleLifecycleAction = async (serviceId: string, action: "deploy" | "restart" | "stop") => {
    if (!csrfToken) return;
    setLoadingLifecycle(serviceId);
    setLifecycleResult(null);

    try {
      const res = await fetch(`/api/bff/orgs/${orgId}/services/${serviceId}/lifecycle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          action,
          reason: `Azione manuale ${action} da console cliente`,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setLifecycleResult({
          serviceId,
          code: data.error?.code || "NOT_SUPPORTED",
          message:
            data.error?.message ||
            "Runtime Docker Executor non attivo in Fase 1 (AC-F1-10). La revisione è salvata in modo immutabile; l'esecuzione del demone è prevista in Fase 2.",
        });
      } else {
        setLifecycleResult({
          serviceId,
          code: "ACCEPTED",
          message: "Operazione di lifecycle accettata.",
        });
      }
    } catch {
      setLifecycleResult({
        serviceId,
        code: "NETWORK_ERROR",
        message: "Errore di connessione con il BFF.",
      });
    } finally {
      setLoadingLifecycle(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Lifecycle Action Feedback Alert */}
      {lifecycleResult && (
        <Alert variant={lifecycleResult.code === "NOT_SUPPORTED" ? "info" : "default"}>
          <Info className="h-4 w-4" />
          <AlertTitle className="text-xs font-mono">
            Confine Fase 1 AC-F1-10: [{lifecycleResult.code}]
          </AlertTitle>
          <AlertDescription className="text-xs">
            {lifecycleResult.message}
          </AlertDescription>
        </Alert>
      )}

      {/* Action Bar */}
      <div className="flex justify-between items-center">
        <h3 className="text-sm font-semibold">Istanze di Servizio Attive nello Stack</h3>

        <Dialog open={openAddService} onOpenChange={setOpenAddService}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-2 text-xs">
              <PlusCircle className="h-4 w-4" />
              <span>Aggiungi Servizio allo Stack</span>
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <form onSubmit={handleAddService} className="space-y-4">
              <DialogHeader>
                <DialogTitle className="text-base font-semibold">
                  Aggiungi Servizio allo Stack
                </DialogTitle>
                <DialogDescription className="text-xs">
                  Crea una nuova istanza con revisione immutabile #1 protetta da convalida di policy (AC-F1-04).
                </DialogDescription>
              </DialogHeader>

              {addError && (
                <Alert variant="destructive">
                  <ShieldAlert className="h-4 w-4" />
                  <AlertTitle className="text-xs font-mono">
                    [{addError.code}] Rifiuto Policy Stack
                  </AlertTitle>
                  <AlertDescription className="text-xs">
                    {addError.message}
                  </AlertDescription>
                </Alert>
              )}

              {addSuccess && (
                <Alert variant="info">
                  <CheckCircle2 className="h-4 w-4" />
                  <AlertTitle className="text-xs">Servizio Registrato</AlertTitle>
                  <AlertDescription className="text-xs">
                    Istanza creata con Revisione #1 immutabile associata.
                  </AlertDescription>
                </Alert>
              )}

              <div className="space-y-3 text-xs">
                <div className="space-y-1.5">
                  <Label htmlFor="svcName" className="text-xs">Nome Servizio</Label>
                  <Input
                    id="svcName"
                    value={serviceName}
                    onChange={(e) => setServiceName(e.target.value)}
                    placeholder="es. frontend-app"
                    required
                    className="text-xs"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="svcTemplate" className="text-xs">Template di Servizio Approvato</Label>
                  <Input
                    id="svcTemplate"
                    value={serviceTemplateId}
                    onChange={(e) => setServiceTemplateId(e.target.value)}
                    placeholder="tpl-node-app"
                    required
                    className="text-xs font-mono"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="cpuLimit" className="text-xs">Limite CPU (Millicores)</Label>
                  <Input
                    id="cpuLimit"
                    type="number"
                    value={cpuMilli}
                    onChange={(e) => setCpuMilli(e.target.value)}
                    min="100"
                    max="8000"
                    className="text-xs font-mono"
                  />
                </div>

                {/* Interactive Unsafe Flag Toggle for AC-F1-04 demonstration */}
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="unsafeCheck" className="text-xs font-semibold text-amber-900 dark:text-amber-200">
                      Test Reiezione Policy Sicurezza (AC-F1-04)
                    </Label>
                    <input
                      type="checkbox"
                      id="unsafeCheck"
                      checked={includeUnsafePrivileged}
                      onChange={(e) => setIncludeUnsafePrivileged(e.target.checked)}
                      className="rounded border-gray-300"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Se selezionato, inietta la configurazione insicura <code className="font-mono">privileged: true</code>.
                    Il Policy Engine respingerà la creazione prevenendo l'escalation di privilegi sul nodo host.
                  </p>
                </div>
              </div>

              <DialogFooter className="pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setOpenAddService(false)}
                  disabled={loadingAdd}
                  className="text-xs"
                >
                  Annulla
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={loadingAdd || !serviceName.trim()}
                  className="text-xs gap-1.5"
                >
                  {loadingAdd && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  <span>Salva Servizio</span>
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Services List with Lifecycle buttons */}
      <div className="space-y-3">
        {services.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
            Nessun servizio registrato nello stack. Usa il pulsante in alto per aggiungere un'istanza.
          </div>
        ) : (
          services.map((svc) => (
            <div
              key={svc.id}
              className="flex items-center justify-between rounded-lg border p-4 bg-card"
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm">{svc.name}</span>
                  <Badge variant={svc.desiredStatus === "running" ? "success" : "secondary"} className="text-[10px]">
                    {svc.desiredStatus}
                  </Badge>
                  {svc.currentRevisionId && (
                    <Badge variant="outline" className="font-mono text-[10px]">
                      Rev: {svc.currentRevisionId}
                    </Badge>
                  )}
                </div>
                <p className="text-xs font-mono text-muted-foreground mt-0.5">
                  ID: {svc.id}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs gap-1"
                  disabled={loadingLifecycle === svc.id}
                  onClick={() => handleLifecycleAction(svc.id, "deploy")}
                  title="Test Deploy Runtime (Confine Fase 1 AC-F1-10)"
                >
                  {loadingLifecycle === svc.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5 text-emerald-600" />
                  )}
                  <span>Deploy</span>
                </Button>

                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs gap-1"
                  disabled={loadingLifecycle === svc.id}
                  onClick={() => handleLifecycleAction(svc.id, "restart")}
                  title="Test Riavvio (Confine Fase 1 AC-F1-10)"
                >
                  <RotateCw className="h-3.5 w-3.5 text-blue-600" />
                  <span>Riavvia</span>
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
