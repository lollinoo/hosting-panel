"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Server, Layers, UserCheck, Users, Ban, ArrowRight, Loader2 } from "lucide-react";
import type { DevPersonaDto } from "@hosting-panel/contracts";

export interface PersonaSelectorProps {
  personas: DevPersonaDto[];
}

export function PersonaSelector({ personas }: PersonaSelectorProps) {
  const router = useRouter();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const handleSelect = async (persona: DevPersonaDto) => {
    setSelectedId(persona.id);
    setLoading(true);
    setErrorMessage(null);

    try {
      const res = await fetch("/api/session/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personaId: persona.id, email: persona.email }),
      });

      if (!res.ok) {
        const err = await res.json();
        setErrorMessage(err.error?.message || "Autenticazione persona fallita");
        setLoading(false);
        return;
      }

      const data = await res.json();
      if (data.activeConsole === "admin") {
        router.push("/admin/hosts");
      } else if (data.activeOrgSlug) {
        router.push(`/o/${data.activeOrgSlug}/overview`);
      } else {
        router.push("/");
      }
      router.refresh();
    } catch {
      setErrorMessage("Errore di rete durante la connessione al BFF");
      setLoading(false);
    }
  };

  const getRoleIcon = (role: string) => {
    switch (role) {
      case "infrastructure_admin":
        return <Server className="h-5 w-5 text-blue-500" />;
      case "hosting_admin":
        return <Layers className="h-5 w-5 text-emerald-500" />;
      case "customer_owner":
        return <UserCheck className="h-5 w-5 text-amber-500" />;
      case "customer_collaborator":
        return <Users className="h-5 w-5 text-purple-500" />;
      default:
        return <Ban className="h-5 w-5 text-destructive" />;
    }
  };

  const getRoleBadgeVariant = (role: string) => {
    switch (role) {
      case "infrastructure_admin":
        return "default" as const;
      case "hosting_admin":
        return "secondary" as const;
      case "customer_owner":
        return "warning" as const;
      default:
        return "outline" as const;
    }
  };

  return (
    <div className="space-y-6">
      {errorMessage && (
        <Alert variant="destructive">
          <AlertTitle>Errore di Accesso</AlertTitle>
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {personas.map((persona) => {
          const isSelected = selectedId === persona.id;
          const isSuspended = persona.id.includes("suspended");

          return (
            <Card
              key={persona.id}
              className={`flex flex-col justify-between transition-all border-2 ${
                isSelected ? "border-primary shadow-md" : "border-border hover:border-primary/50"
              }`}
            >
              <CardHeader className="space-y-2 pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {getRoleIcon(persona.role)}
                    <Badge variant={getRoleBadgeVariant(persona.role)} className="text-[10px]">
                      {persona.role}
                    </Badge>
                  </div>
                  {isSuspended && (
                    <Badge variant="destructive" className="text-[10px]">
                      Sospesa
                    </Badge>
                  )}
                </div>
                <CardTitle className="text-base font-semibold">{persona.name}</CardTitle>
                <CardDescription className="text-xs">{persona.email}</CardDescription>
              </CardHeader>

              <CardContent className="text-xs text-muted-foreground pb-4">
                <p>{persona.description}</p>
                {persona.organizationId && (
                  <p className="mt-2 text-[11px] font-mono text-foreground/80">
                    Org: {persona.organizationId}
                  </p>
                )}
              </CardContent>

              <CardFooter className="pt-0">
                <Button
                  className="w-full gap-2 text-xs"
                  variant={isSelected ? "default" : "outline"}
                  onClick={() => handleSelect(persona)}
                  disabled={loading}
                >
                  {loading && isSelected ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Autenticazione JWE...</span>
                    </>
                  ) : (
                    <>
                      <span>Accedi con questa Persona</span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </>
                  )}
                </Button>
              </CardFooter>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
