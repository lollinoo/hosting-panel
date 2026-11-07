import { fetchServerMe, fetchServerOrgMembers } from "@/lib/server-api";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Users, UserCheck } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function OrgMembersPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const me = await fetchServerMe();
  const membership = me?.memberships.find((m) => m.organizationSlug === orgSlug);
  const orgId = membership?.organizationId || orgSlug;
  const members = await fetchServerOrgMembers(orgId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Membri & Ruoli Organizzazione</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Gestione degli account autorizzati e controllo degli accessi basato su ruoli (AC-F1-02).
          </p>
        </div>
        <Badge variant="outline" className="text-xs">
          {members.length} Membri
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Utenti Registrati</CardTitle>
              <CardDescription className="text-xs">
                La distinzione tra CustomerOwner e CustomerCollaborator garantisce il principio di minimo privilegio.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome & Cognome</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Ruolo Assegnato</TableHead>
                <TableHead>Data Inserimento</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-6 text-muted-foreground text-xs">
                    Nessun membro trovato per questa organizzazione.
                  </TableCell>
                </TableRow>
              ) : (
                members.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell className="font-semibold text-xs">
                      <div className="flex items-center gap-2">
                        {member.role === "customer_owner" ? (
                          <UserCheck className="h-4 w-4 text-amber-500" />
                        ) : (
                          <Users className="h-4 w-4 text-purple-500" />
                        )}
                        <span>{member.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground font-mono">
                      {member.email}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={member.role === "customer_owner" ? "warning" : "secondary"}
                        className="text-[10px]"
                      >
                        {member.role}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground font-mono">
                      {new Date(member.createdAt).toLocaleDateString("it-IT")}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
