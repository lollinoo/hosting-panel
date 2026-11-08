import { redirect } from "next/navigation";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { getServerSession } from "@/lib/server-session";

export const dynamic = "force-dynamic";

export default async function ChangePasswordPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  return (
    <main className="min-h-screen flex items-center justify-center bg-muted/30 px-6 py-12">
      <ChangePasswordForm csrfToken={session.csrfToken} />
    </main>
  );
}
