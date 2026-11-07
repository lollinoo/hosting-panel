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

export interface NewSiteDialogProps {
  orgId: string;
  csrfToken?: string;
  defaultHostAllocationId?: string;
}

export function NewSiteDialog({
  orgId,
  csrfToken,
  defaultHostAllocationId = "",
}: NewSiteDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [hostAllocationId, setHostAllocationId] = React.useState(defaultHostAllocationId);
  const [initialDomain, setInitialDomain] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [errorResult, setErrorResult] = React.useState<{
    code: string;
    message: string;
  } | null>(null);
  const [success, setSuccess] = React.useState(false);

  const handleNameChange = (val: string) => {
    setName(val);
    if (!slug || slug === name.toLowerCase().replace(/[^a-z0-9_-]/g, "-")) {
      setSlug(val.toLowerCase().replace(/[^a-z0-9_-]/g, "-"));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!csrfToken || !name.trim() || !slug.trim()) return;

    setLoading(true);
    setErrorResult(null);
    setSuccess(false);

    const idempotencyKey = `create-site-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    try {
      const res = await fetch(`/api/bff/orgs/${orgId}/sites`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          name: name.trim(),
          slug: slug.trim(),
          hostAllocationId: hostAllocationId.trim() || "alloc-default",
          initialDomain: initialDomain.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setErrorResult({
          code: data.error?.code || "ERROR",
          message: data.error?.message || "Impossibile creare il nuovo sito.",
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
        message: "Errore di connessione durante la richiesta di creazione sito.",
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
          <span>Crea Nuovo Sito</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">
              Crea Nuovo Sito & Stack Applicativo
            </DialogTitle>
            <DialogDescription className="text-xs">
              Configura un contenitore logico di servizi collegato a un'allocazione host dedicata.
            </DialogDescription>
          </DialogHeader>

          {errorResult && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle className="text-xs font-mono">[{errorResult.code}]</AlertTitle>
              <AlertDescription className="text-xs">
                {errorResult.message}
              </AlertDescription>
            </Alert>
          )}

          {success && (
            <Alert variant="info">
              <CheckCircle2 className="h-4 w-4" />
              <AlertTitle className="text-xs">Sito Creato</AlertTitle>
              <AlertDescription className="text-xs">
                Lo stack è stato registrato nel piano di controllo.
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-3 text-xs">
            <div className="space-y-1.5">
              <Label htmlFor="siteName" className="text-xs">Nome Sito</Label>
              <Input
                id="siteName"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="es. Portale Web E-commerce"
                required
                className="text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="siteSlug" className="text-xs">Slug URL</Label>
              <Input
                id="siteSlug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="es. ecommerce-web"
                required
                className="text-xs font-mono"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="hostAllocId" className="text-xs">Allocazione Host ID</Label>
              <Input
                id="hostAllocId"
                value={hostAllocationId}
                onChange={(e) => setHostAllocationId(e.target.value)}
                placeholder="es. alloc-dedicated-01"
                className="text-xs font-mono"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="initialDomain" className="text-xs">Dominio Iniziale (Opzionale)</Label>
              <Input
                id="initialDomain"
                value={initialDomain}
                onChange={(e) => setInitialDomain(e.target.value)}
                placeholder="es. www.acme.it"
                className="text-xs"
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
              disabled={loading || !name.trim() || !slug.trim()}
              className="text-xs gap-1.5"
            >
              {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>Crea Sito</span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
