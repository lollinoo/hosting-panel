"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type {
  DriftStatus,
  EncryptedSecretMetadataDto,
  OperationStatus,
  RuntimeBackend,
} from "@hosting-panel/contracts";
import { OperationTimeline } from "@/components/operations/operation-timeline";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  PlusCircle,
  Play,
  RotateCw,
  Square,
  Loader2,
  CheckCircle2,
  ShieldAlert,
  Info,
  KeyRound,
  Trash2,
  Lock,
} from "lucide-react";

const SECRET_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export interface SiteServiceItem {
  id: string;
  name: string;
  desiredStatus: string;
  currentRevisionId: string | null;
  driftStatus?: DriftStatus;
}

export interface SiteDetailInteractiveProps {
  orgId: string;
  siteId: string;
  csrfToken?: string;
  runtimeBackend?: RuntimeBackend;
  initialSecrets?: EncryptedSecretMetadataDto[];
  services: SiteServiceItem[];
}

function getDriftBadge(driftStatus: DriftStatus = "unknown") {
  switch (driftStatus) {
    case "in_sync":
      return (
        <Badge variant="success" className="text-[10px]">
          In Sync
        </Badge>
      );
    case "drifted":
      return (
        <Badge variant="warning" className="text-[10px]">
          Drifted
        </Badge>
      );
    case "unknown":
    default:
      return (
        <Badge variant="secondary" className="text-[10px]">
          Unknown
        </Badge>
      );
  }
}

function makeClientIdempotencyKey(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function SiteDetailInteractive({
  orgId,
  siteId,
  csrfToken,
  runtimeBackend = "disabled",
  initialSecrets = [],
  services,
}: SiteDetailInteractiveProps) {
  const router = useRouter();

  // Add Service Dialog State
  const [openAddService, setOpenAddService] = React.useState(false);
  const [serviceName, setServiceName] = React.useState("");
  const [serviceTemplateId, setServiceTemplateId] = React.useState("tpl-node-app");
  const [cpuMilli, setCpuMilli] = React.useState("500");
  const [selectedSecretId, setSelectedSecretId] = React.useState("");
  const [includeUnsafePrivileged, setIncludeUnsafePrivileged] = React.useState(false);
  const [loadingAdd, setLoadingAdd] = React.useState(false);
  const [addError, setAddError] = React.useState<{ code: string; message: string } | null>(null);
  const [addSuccess, setAddSuccess] = React.useState(false);

  // Lifecycle Action & Async Operation Timeline State
  const [loadingLifecycle, setLoadingLifecycle] = React.useState<string | null>(null);
  const [lifecycleError, setLifecycleError] = React.useState<{
    serviceId: string;
    code: string;
    message: string;
  } | null>(null);
  const [activeOperation, setActiveOperation] = React.useState<{
    operationId: string;
    status: OperationStatus;
    serviceName: string;
  } | null>(null);

  // Write-Only Encrypted Secrets (AES-256-GCM) State
  const [secrets, setSecrets] = React.useState<EncryptedSecretMetadataDto[]>(initialSecrets);
  const [secretKeyInput, setSecretKeyInput] = React.useState("");
  const [secretPlaintextInput, setSecretPlaintextInput] = React.useState("");
  const [loadingSecretSave, setLoadingSecretSave] = React.useState(false);
  const [deletingSecretId, setDeletingSecretId] = React.useState<string | null>(null);
  const [secretFeedback, setSecretFeedback] = React.useState<{
    variant: "info" | "destructive";
    title: string;
    message: string;
  } | null>(null);

  React.useEffect(() => {
    setSecrets(initialSecrets);
  }, [initialSecrets]);

  const refreshSecretsList = async () => {
    try {
      const res = await fetch(
        `/api/bff/orgs/${orgId}/secrets?siteId=${encodeURIComponent(siteId)}`,
        {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
        }
      );
      if (res.ok) {
        const json = (await res.json()) as { data?: EncryptedSecretMetadataDto[] };
        if (Array.isArray(json.data)) {
          setSecrets(json.data);
        }
      }
    } catch {
      // Ignore background refresh error
    }
  };

  const handleAddService = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!csrfToken || !serviceName.trim()) return;

    setLoadingAdd(true);
    setAddError(null);
    setAddSuccess(false);

    const idempotencyKey = makeClientIdempotencyKey("add-svc");

    const configuration: Record<string, unknown> = {
      NODE_ENV: "production",
      PORT: 3000,
    };

    if (includeUnsafePrivileged) {
      configuration["privileged"] = true;
    }

    let secretRefs: Record<string, string> | undefined;
    if (selectedSecretId) {
      const matched = secrets.find((s) => s.id === selectedSecretId);
      if (matched) {
        secretRefs = { [matched.secretKey]: matched.id };
      }
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
          ...(secretRefs ? { secretRefs } : {}),
          resourceLimits: {
            cpuMilli: parseInt(cpuMilli, 10) || 500,
            memoryBytes: "536870912",
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
          setServiceName("");
          setSelectedSecretId("");
          router.refresh();
        }, 1000);
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

  const handleLifecycleAction = async (
    serviceId: string,
    serviceLabel: string,
    action: "deploy" | "restart" | "stop"
  ) => {
    if (!csrfToken) return;
    setLoadingLifecycle(`${serviceId}:${action}`);
    setLifecycleError(null);

    const idempotencyKey = makeClientIdempotencyKey(`lc-${action}`);

    try {
      const res = await fetch(`/api/bff/orgs/${orgId}/services/${serviceId}/lifecycle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          action,
          reason: `Azione manuale ${action} da console cliente`,
        }),
      });

      const data = (await res.json()) as {
        data?: { operationId?: string; status?: OperationStatus };
        error?: { code?: string; message?: string };
      };

      if (res.status === 202 && data.data?.operationId) {
        setActiveOperation({
          operationId: data.data.operationId,
          status: data.data.status ?? "queued",
          serviceName: `${serviceLabel} (${action})`,
        });
      } else if (!res.ok) {
        setLifecycleError({
          serviceId,
          code: data.error?.code || "NOT_SUPPORTED",
          message:
            data.error?.message ||
            "Runtime Docker Executor disabilitato (runtimeBackend=disabled). La revisione resta immutabile; attivare linux-systemd o local-simulator per eseguire il job.",
        });
      }
    } catch {
      setLifecycleError({
        serviceId,
        code: "NETWORK_ERROR",
        message: "Errore di connessione con il BFF.",
      });
    } finally {
      setLoadingLifecycle(null);
    }
  };

  const handleUpsertSecret = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!csrfToken) return;

    const normalizedKey = secretKeyInput.trim();
    const transientValue = secretPlaintextInput;
    // Immediately wipe plaintext secret from React state (write-only invariant F1-012 / AC-F2-05)
    setSecretPlaintextInput("");

    if (!SECRET_KEY_REGEX.test(normalizedKey)) {
      setSecretFeedback({
        variant: "destructive",
        title: "Chiave Segreto Non Valida",
        message:
          "Il nome della chiave deve iniziare con una lettera o underscore e contenere solo caratteri alfanumerici o '_' (max 128 caratteri).",
      });
      return;
    }

    if (!transientValue || transientValue.length === 0) {
      setSecretFeedback({
        variant: "destructive",
        title: "Valore Segreto Mancante",
        message: "Inserire un valore non vuoto da cifrare con AES-256-GCM.",
      });
      return;
    }

    setLoadingSecretSave(true);
    setSecretFeedback(null);

    try {
      const res = await fetch(`/api/bff/orgs/${orgId}/secrets`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
          "Idempotency-Key": makeClientIdempotencyKey("secret-upsert"),
        },
        body: JSON.stringify({
          secretKey: normalizedKey,
          value: transientValue,
          siteId,
        }),
      });

      const payload = (await res.json()) as {
        data?: EncryptedSecretMetadataDto;
        error?: { code?: string; message?: string };
      };

      if (!res.ok || !payload.data) {
        setSecretFeedback({
          variant: "destructive",
          title: `Errore Salvataggio Segreto [${payload.error?.code || "ERROR"}]`,
          message:
            payload.error?.message ||
            "Impossibile cifrare o registrare il segreto nell'organizzazione.",
        });
        return;
      }

      const savedMeta = payload.data;
      setSecretKeyInput("");
      setSecrets((prev) => {
        const filtered = prev.filter((item) => item.id !== savedMeta.id);
        return [savedMeta, ...filtered];
      });
      setSecretFeedback({
        variant: "info",
        title: "Segreto Cifrato Registrato (Write-Only)",
        message: `Metadato '${savedMeta.secretKey}' salvato (versione v${savedMeta.version}). Il valore in chiaro è stato cifrato in AES-256-GCM e non sarà mai più esposto dalle API.`,
      });
      router.refresh();
    } catch {
      setSecretFeedback({
        variant: "destructive",
        title: "Errore di Rete",
        message: "Impossibile contattare il perimetro BFF per il salvataggio del segreto.",
      });
    } finally {
      setLoadingSecretSave(false);
    }
  };

  const handleDeleteSecret = async (secretId: string, secretKey: string) => {
    if (!csrfToken) return;
    setDeletingSecretId(secretId);
    setSecretFeedback(null);

    try {
      const res = await fetch(`/api/bff/orgs/${orgId}/secrets/${secretId}`, {
        method: "DELETE",
        headers: {
          "X-CSRF-Token": csrfToken,
        },
      });

      const payload = (await res.json()) as {
        data?: { deleted?: boolean };
        error?: { code?: string; message?: string };
      };

      if (!res.ok) {
        setSecretFeedback({
          variant: "destructive",
          title: `Eliminazione Rifiutata [${payload.error?.code || "ERROR"}]`,
          message:
            payload.error?.message ||
            "Impossibile rimuovere il segreto (potrebbe essere referenziato o non autorizzato).",
        });
        return;
      }

      setSecrets((prev) => prev.filter((item) => item.id !== secretId));
      await refreshSecretsList();
      setSecretFeedback({
        variant: "info",
        title: "Segreto Eliminato",
        message: `Il riferimento cifrato '${secretKey}' è stato rimosso dallo store.`,
      });
      router.refresh();
    } catch {
      setSecretFeedback({
        variant: "destructive",
        title: "Errore di Rete",
        message: "Impossibile completare la richiesta di eliminazione del segreto.",
      });
    } finally {
      setDeletingSecretId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Live 202 Accepted Operation Timeline */}
      {activeOperation && (
        <OperationTimeline
          pollUrl={`/api/bff/orgs/${orgId}/operations/${activeOperation.operationId}`}
          operationId={activeOperation.operationId}
          initialStatus={activeOperation.status}
          title={`Esecuzione Lifecycle: ${activeOperation.serviceName}`}
          onDismiss={() => setActiveOperation(null)}
        />
      )}

      {/* Lifecycle Error / Phase 1 Disabled Boundary Alert */}
      {lifecycleError && (
        <Alert variant={lifecycleError.code === "NOT_SUPPORTED" ? "info" : "destructive"}>
          <Info className="h-4 w-4" />
          <AlertTitle className="text-xs font-mono">
            Risposta Lifecycle Servizio: [{lifecycleError.code}]
          </AlertTitle>
          <AlertDescription className="text-xs">
            {lifecycleError.message}
          </AlertDescription>
        </Alert>
      )}

      {/* Action Bar */}
      <div className="flex flex-wrap justify-between items-center gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Istanze di Servizio Attive nello Stack</h3>
          <Badge variant="outline" className="font-mono text-[10px]">
            backend: {runtimeBackend}
          </Badge>
        </div>

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

                {secrets.length > 0 && (
                  <div className="space-y-1.5">
                    <Label htmlFor="svcSecretRef" className="text-xs">
                      Associa SecretRef Cifrato (Opzionale)
                    </Label>
                    <select
                      id="svcSecretRef"
                      value={selectedSecretId}
                      onChange={(e) => setSelectedSecretId(e.target.value)}
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-xs font-mono"
                    >
                      <option value="">-- Nessun segreto associato --</option>
                      {secrets.map((sec) => (
                        <option key={sec.id} value={sec.id}>
                          {sec.secretKey} (v{sec.version} • {sec.id})
                        </option>
                      ))}
                    </select>
                  </div>
                )}

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
                    Il Policy Engine respingerà la creazione prevenendo l&apos;escalation di privilegi sul nodo host.
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

      {/* Services List with Drift Badge & Deploy / Riavvia / Arresta buttons */}
      <div className="space-y-3">
        {services.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
            Nessun servizio registrato nello stack. Usa il pulsante in alto per aggiungere un&apos;istanza.
          </div>
        ) : (
          services.map((svc) => {
            const isBusy = loadingLifecycle?.startsWith(`${svc.id}:`) ?? false;
            return (
              <div
                key={svc.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border p-4 bg-card"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-sm">{svc.name}</span>
                    <Badge
                      variant={svc.desiredStatus === "running" ? "success" : "secondary"}
                      className="text-[10px]"
                    >
                      Desired: {svc.desiredStatus}
                    </Badge>
                    {getDriftBadge(svc.driftStatus)}
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

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs gap-1"
                    disabled={isBusy}
                    onClick={() => handleLifecycleAction(svc.id, svc.name, "deploy")}
                    title="Avvia deploy asincrono della revisione corrente (202 Accepted)"
                  >
                    {loadingLifecycle === `${svc.id}:deploy` ? (
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
                    disabled={isBusy}
                    onClick={() => handleLifecycleAction(svc.id, svc.name, "restart")}
                    title="Riavvia container del servizio (202 Accepted)"
                  >
                    {loadingLifecycle === `${svc.id}:restart` ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RotateCw className="h-3.5 w-3.5 text-blue-600" />
                    )}
                    <span>Riavvia</span>
                  </Button>

                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs gap-1 text-destructive hover:text-destructive"
                    disabled={isBusy}
                    onClick={() => handleLifecycleAction(svc.id, svc.name, "stop")}
                    title="Arresta istanza del servizio (202 Accepted)"
                  >
                    {loadingLifecycle === `${svc.id}:stop` ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Square className="h-3.5 w-3.5 text-destructive" />
                    )}
                    <span>Arresta</span>
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <Separator />

      {/* Write-Only Encrypted Secrets Section (AES-256-GCM / AC-F2-05 / F1-012) */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold">
                Segreti Cifrati dello Stack (`AES-256-GCM` &bull; Write-Only)
              </h3>
              <Badge variant="outline" className="text-[10px] font-mono">
                AC-F2-05 / F1-012
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              I valori inseriti vengono cifrati con AAD vincolato al tenant e montati a runtime su{" "}
              <code className="font-mono">tmpfs</code> (<code className="font-mono">0400 :ro</code>, pattern{" "}
              <code className="font-mono">*_FILE</code>). Nessun valore viene mai riletto o mostrato in chiaro.
            </p>
          </div>
        </div>

        {secretFeedback && (
          <Alert variant={secretFeedback.variant} className="text-xs">
            <Lock className="h-4 w-4" />
            <AlertTitle className="text-xs font-semibold">{secretFeedback.title}</AlertTitle>
            <AlertDescription className="text-xs">{secretFeedback.message}</AlertDescription>
          </Alert>
        )}

        <form
          onSubmit={handleUpsertSecret}
          className="grid gap-3 sm:grid-cols-12 items-end rounded-lg border bg-muted/20 p-4"
        >
          <div className="sm:col-span-5 space-y-1.5">
            <Label htmlFor="secretKeyInput" className="text-xs">
              Nome Chiave (`SecretKey`)
            </Label>
            <Input
              id="secretKeyInput"
              value={secretKeyInput}
              onChange={(e) => setSecretKeyInput(e.target.value)}
              placeholder="es. WORDPRESS_DB_PASSWORD"
              pattern="^[A-Za-z_][A-Za-z0-9_]{0,127}$"
              required
              className="text-xs font-mono"
            />
          </div>

          <div className="sm:col-span-5 space-y-1.5">
            <Label htmlFor="secretPlaintextInput" className="text-xs">
              Valore Segreto (Write-Only, mai riecheggiato)
            </Label>
            <Input
              id="secretPlaintextInput"
              type="password"
              autoComplete="new-password"
              value={secretPlaintextInput}
              onChange={(e) => setSecretPlaintextInput(e.target.value)}
              placeholder="Inserisci o ruota il valore cifrato..."
              required
              className="text-xs"
            />
          </div>

          <div className="sm:col-span-2">
            <Button
              type="submit"
              size="sm"
              disabled={loadingSecretSave || !csrfToken}
              className="w-full text-xs gap-1.5"
            >
              {loadingSecretSave ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Lock className="h-3.5 w-3.5" />
              )}
              <span>Cifra / Ruota</span>
            </Button>
          </div>
        </form>

        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Chiave (`secretKey`)</TableHead>
                <TableHead>Riferimento (`SecretRef`)</TableHead>
                <TableHead>Ambito</TableHead>
                <TableHead>Versione</TableHead>
                <TableHead>Valore</TableHead>
                <TableHead>Aggiornato il</TableHead>
                <TableHead className="text-right">Azioni</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {secrets.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-6 text-xs text-muted-foreground">
                    Nessun segreto cifrato registrato per questo sito.
                  </TableCell>
                </TableRow>
              ) : (
                secrets.map((sec) => (
                  <TableRow key={sec.id}>
                    <TableCell className="font-mono text-xs font-semibold">
                      {sec.secretKey}
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">
                      {sec.id}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px]">
                        {sec.siteId ? "Sito" : "Organizzazione"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="font-mono text-[10px]">
                        v{sec.version} ({sec.keyVersion})
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">
                      •••••••• (AES-256-GCM)
                    </TableCell>
                    <TableCell className="text-xs font-mono text-muted-foreground">
                      {new Date(sec.updatedAt).toLocaleString("it-IT")}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={deletingSecretId === sec.id || !csrfToken}
                        onClick={() => handleDeleteSecret(sec.id, sec.secretKey)}
                        className="h-7 px-2 text-xs text-destructive hover:text-destructive gap-1"
                        title="Elimina metadato segreto cifrato"
                      >
                        {deletingSecretId === sec.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                        <span>Elimina</span>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
