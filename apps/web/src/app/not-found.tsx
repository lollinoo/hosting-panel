import Link from "next/link";

export default function NotFoundPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 text-center">
      <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-xs">
        <p className="text-xs font-bold tracking-wider text-indigo-600 uppercase">
          Errore 404
        </p>
        <h1 className="mt-2 text-xl font-bold text-slate-900">
          Risorsa o organizzazione non trovata
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          La pagina richiesta non esiste oppure il tuo account non dispone dell&apos;accesso
          necessario per visualizzarla.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link
            href="/"
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            Torna alla console
          </Link>
        </div>
      </div>
    </main>
  );
}
