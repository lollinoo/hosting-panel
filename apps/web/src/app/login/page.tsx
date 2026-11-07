import { fetchServerPersonas } from "@/lib/server-api";
import { PersonaSelector } from "@/components/auth/persona-selector";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { ShieldCheck, Lock, Terminal, Cpu } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const personas = await fetchServerPersonas();

  return (
    <div className="min-h-screen bg-muted/30 flex flex-col justify-center py-12 px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-4xl space-y-8">
        {/* Header */}
        <div className="text-center space-y-3">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium">
            <ShieldCheck className="h-4 w-4" />
            <span>Piattaforma Hosting Docker-Native — Fase 1 (HCP-SPEC-002)</span>
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
            Accesso Autorità & Selettore Personae
          </h1>
          <p className="text-sm text-muted-foreground max-w-2xl mx-auto">
            Scegli un profilo verificato per simulare le 3 distinte autorità di gestione:
            Infrastruttura di Sistema, Hosting Multi-Tenant e Amministrazione Cliente.
          </p>
        </div>

        {/* Phase 1 Trust Boundaries Card */}
        <Card className="border-blue-500/20 bg-blue-500/5">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-blue-600" />
              <CardTitle className="text-sm font-semibold text-blue-900 dark:text-blue-100">
                Confini Architetturali e Sicurezza Fase 1 (HCP-SPEC-002 §1.3 & §5.2)
              </CardTitle>
            </div>
            <CardDescription className="text-xs text-blue-800/80 dark:text-blue-200/80">
              Isolamento deterministico dei layer di esecuzione e assenza di canali non autorizzati
            </CardDescription>
          </CardHeader>
          <CardContent className="text-xs text-blue-950 dark:text-blue-100 space-y-2">
            <div className="grid sm:grid-cols-3 gap-3 pt-1">
              <div className="rounded-md border border-blue-200 bg-background/80 p-2.5">
                <div className="font-semibold text-foreground flex items-center gap-1.5 mb-1">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                  <span>Sessione JWE HttpOnly</span>
                </div>
                <p className="text-muted-foreground text-[11px]">
                  Cifratura A256GCM (`dir`), token di accesso mai esposti al browser, CSRF timing-safe con double-submit.
                </p>
              </div>

              <div className="rounded-md border border-blue-200 bg-background/80 p-2.5">
                <div className="font-semibold text-foreground flex items-center gap-1.5 mb-1">
                  <Cpu className="h-3.5 w-3.5 text-blue-600" />
                  <span>Zero Docker Socket</span>
                </div>
                <p className="text-muted-foreground text-[11px]">
                  `/var/run/docker.sock` inaccessibile. Nessuna invocazione shell o CLI arbitraria sul daemon Linux.
                </p>
              </div>

              <div className="rounded-md border border-blue-200 bg-background/80 p-2.5">
                <div className="font-semibold text-foreground flex items-center gap-1.5 mb-1">
                  <Terminal className="h-3.5 w-3.5 text-amber-600" />
                  <span>Segregazione Ruoli</span>
                </div>
                <p className="text-muted-foreground text-[11px]">
                  Hosting Admin segregato da permessi host (AC-F1-03); Customer delimitato dalla propria organizzazione.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Persona Selector Grid */}
        <PersonaSelector personas={personas} />
      </div>
    </div>
  );
}
