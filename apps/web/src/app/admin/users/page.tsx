import { redirect } from "next/navigation";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getServerSession } from "@/lib/server-session";
import { fetchServerAdminUsers } from "@/lib/server-api";
import { Card, CardContent } from "@/components/ui/card";
import { UsersTable } from "@/components/admin/users-table";
import { CreateCustomerDialog } from "@/components/admin/create-customer-dialog";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const [m, users] = await Promise.all([getRequestLocale().then(getMessages), fetchServerAdminUsers()]);
  const t = m.admin.users;
  const hasCustomer = users.some((u) => u.role === "customer");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t.title}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t.subtitle}</p>
        </div>
        {!hasCustomer && <CreateCustomerDialog csrfToken={session.csrfToken} />}
      </div>
      <Card>
        <CardContent className="pt-6">
          <UsersTable users={users} csrfToken={session.csrfToken} />
        </CardContent>
      </Card>
    </div>
  );
}
