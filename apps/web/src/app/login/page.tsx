import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/login-form";
import { getServerSession } from "@/lib/server-session";
import { fetchServerMe } from "@/lib/server-api";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getServerSession()) {
    await fetchServerMe(); // dead API session: clears the cookie and comes back here instead of bouncing to "/"
    redirect("/");
  }
  return (
    <main className="min-h-screen flex items-center justify-center bg-muted/30 px-6 py-12">
      <LoginForm />
    </main>
  );
}
