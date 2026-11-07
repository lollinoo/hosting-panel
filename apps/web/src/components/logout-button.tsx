"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function LogoutButton({ csrfToken }: { readonly csrfToken: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const handleLogout = async (): Promise<void> => {
    if (loading) {
      return;
    }
    setLoading(true);
    try {
      await fetch("/api/session/logout", {
        method: "POST",
        headers: {
          "X-CSRF-Token": csrfToken,
        },
      });
    } finally {
      router.push("/login");
      router.refresh();
    }
  };

  return (
    <button
      type="button"
      disabled={loading}
      onClick={() => {
        void handleLogout();
      }}
      className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
    >
      <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
      {loading ? "Disconnessione..." : "Esci dalla sessione"}
    </button>
  );
}
