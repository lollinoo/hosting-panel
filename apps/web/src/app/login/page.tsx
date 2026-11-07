import { ServerCrash, Shield } from "lucide-react";
import { redirect } from "next/navigation";
import { LoginPersonaList } from "@/components/login-form";
import { fetchDevPersonas, fetchMe } from "@/lib/bff-client";
import { readServerSession } from "@/lib/server-session";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const existingSession = await readServerSession();
  if (existingSession) {
    const meCheck = await fetchMe(existingSession.accessToken);
    if (meCheck.ok) {
      redirect("/");
    }
  }

  const personasResult = await fetchDevPersonas();

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-4 py-12">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs sm:p-8">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-xs">
            <Shield className="h-6 w-6" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">
              Accesso al Control Plane Hosting
            </h1>
            <p className="text-sm text-slate-600">
              Seleziona un profilo dimostrativo OIDC per avviare una sessione sicura BFF
              con cookie <code>HttpOnly</code>.
            </p>
          </div>
        </div>

        <div className="mt-6">
          {!personasResult.ok ? (
            <div
              role="alert"
              className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-amber-950"
            >
              <div className="flex items-start gap-3">
                <ServerCrash
                  className="mt-0.5 h-5 w-5 shrink-0 text-amber-700"
                  aria-hidden="true"
                />
                <div className="space-y-1.5 text-sm">
                  <p className="font-semibold">
                    Servizio API Control Plane temporaneamente offline
                  </p>
                  <p className="text-xs leading-relaxed text-amber-900">
                    {personasResult.error.error.message} Avvia il backend con{" "}
                    <code>corepack pnpm run dev:api</code> e ricarica questa pagina.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <LoginPersonaList personas={personasResult.data.data} />
          )}
        </div>

        <p className="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-500">
          Sicurezza perimetrale: nessun token JWT, credenziale Coolify o URL interno viene
          mai esposto al browser.
        </p>
      </div>
    </main>
  );
}
