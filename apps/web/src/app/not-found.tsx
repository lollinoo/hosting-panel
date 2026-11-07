import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFoundPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4 text-center">
      <div className="max-w-md rounded-xl border bg-card p-8 shadow-sm">
        <p className="text-xs font-bold tracking-wider text-primary uppercase">
          Errore 404
        </p>
        <h1 className="mt-2 text-xl font-bold tracking-tight text-card-foreground">
          Risorsa o Organizzazione Non Trovata
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          La pagina richiesta non esiste oppure il tuo account non dispone dell&apos;accesso
          necessario per visualizzarla.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Button asChild size="sm">
            <Link href="/">
              Torna alla console
            </Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
