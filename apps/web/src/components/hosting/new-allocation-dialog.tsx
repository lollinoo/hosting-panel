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
import { PlusCircle, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";

export interface NewAllocationDialogProps {
  csrfToken?: string;
  defaultHostId?: string;
}

export function NewAllocationDialog({
  csrfToken,
  defaultHostId = "",
}: NewAllocationDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [hostId, setHostId] = React.useState(defaultHostId);
  const [organizationId, setOrganizationId] = React.useState("org-acme");
  const [loading, setLoading] = React.useState(false);
  const [errorResult, setErrorResult] = React.useState<{
    code: string;
    message: string;
  } | null>(null);
  const [success, setSuccess] = React.useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!csrfToken || !hostId.trim() || !organizationId.trim()) return;

    setLoading(true);
    setErrorResult(null);
    setSuccess(false);

    try {
      const res = await fetch(`/api/bff/hosts/${encodeURIComponent(hostId.trim())}/allocations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          hostId: hostId.trim(),
          organizationId: organizationId.trim(),
          hostingMode: "dedicated",
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setErrorResult({
          code: data.error?.code || "ERROR",
          message:
            data.error?.message ||
            "Impossibile creare l'allocazione host sul server selezionato.",
        });
      } else {
        setSuccess(true);
        setTimeout(() => {
          setOpen(false);
          router.refresh();
        }, 1200);
      }
    } catch {
      setErrorResult({
        code: "NETWORK_ERROR",
        message: "Errore di connessione durante la creazione dell'allocazione.",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-2 text-xs">
          <PlusCircle className="h-4 w-4" />
          <span>Nuova Allocazione Host</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">
              Nuova Allocazione Host Dedicated (AC-F1-01)
            </DialogTitle>
            <DialogDescription className="text-xs">
              Assegna un nodo fisico a una specifica organizzazione tenant con vincolo di esclusività hardware.
            </DialogDescription>
          </DialogHeader>

          {errorResult && (
            <Alert variant={errorResult.code === "DEDICATED_HOST_OCCUPIED" ? "warning" : "destructive"}>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle className="text-xs font-mono">
                [{errorResult.code}] Vincolo AC-F1-01
              </AlertTitle>
              <AlertDescription className="text-xs">
                {errorResult.message}
              </AlertDescription>
            </Alert>
          )}

          {success && (
            <Alert variant="info">
              <CheckCircle2 className="h-4 w-4" />
              <AlertTitle className="text-xs">Allocazione Creata con Successo</AlertTitle>
              <AlertDescription className="text-xs">
                Il nodo è stato associato al tenant in modalità esclusiva dedicated.
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-3 text-xs">
            <div className="space-y-1.5">
              <Label htmlFor="hostId" className="text-xs">Host ID (Target)</Label>
              <Input
                id="hostId"
                value={hostId}
                onChange={(e) => setHostId(e.target.value)}
                placeholder="es. host-alpha-01"
                required
                className="text-xs"
              />
              <span className="text-[10px] text-muted-foreground">
                Se l'host ha già un tenant assegnato, il sistema restituirà DEDICATED_HOST_OCCUPIED.
              </span>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="organizationId" className="text-xs">Organizzazione ID (Tenant)</Label>
              <Input
                id="organizationId"
                value={organizationId}
                onChange={(e) => setOrganizationId(e.target.value)}
                placeholder="es. org-acme"
                required
                className="text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Modalità di Hosting</Label>
              <Input
                value="dedicated (esclusivo — AC-F1-01)"
                disabled
                className="text-xs font-mono bg-muted text-muted-foreground"
              />
            </div>
          </div>

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={loading}
              className="text-xs"
            >
              Annulla
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={loading || !hostId.trim() || !organizationId.trim()}
              className="text-xs gap-1.5"
            >
              {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>Conferma Allocazione</span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
