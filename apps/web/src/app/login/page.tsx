import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/login-form";
import { getServerSession } from "@/lib/server-session";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getServerSession()) redirect("/");
  return (
    <main className="min-h-screen flex items-center justify-center bg-muted/30 px-6 py-12">
      <LoginForm />
    </main>
  );
}
