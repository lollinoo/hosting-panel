import type { AdminBackupTargetDto } from "@hosting-panel/contracts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { format, type Messages } from "@/i18n";

const BACKUP_KEY_PATH = "/etc/hosting-panel/backup.key";

/** `--prefix` with nothing after it is dropped: a destination without a path takes no such flag. */
const withoutEmptyPrefix = (command: string) => command.replace(/\s+--prefix\s*$/, "");

function Command({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded bg-muted px-3 py-2 text-sm">{children}</pre>;
}

/** The Lost-server tab: text only, with the real destination details filled into each command. */
export function BackupDisasterRecovery({ m, targets }: { m: Messages; targets: AdminBackupTargetDto[] }) {
  const t = m.admin.backups.recovery;
  const live = targets.filter((x) => !x.archivedAt);
  const s3 = live.filter((x) => x.kind === "s3" && x.s3);
  const local = live.filter((x) => x.kind === "local");
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t.title}</h2>
        <p className="text-sm text-muted-foreground">{t.intro}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t.key.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm">{format(t.key.body, { backupKeyPath: BACKUP_KEY_PATH })}</p>
        </CardContent>
      </Card>
      {s3.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.s3.empty}</p>
      ) : (
        s3.map((x) => (
          <Card key={x.id}>
            <CardHeader>
              <CardTitle>{format(t.s3.title, { targetId: x.id })}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p>{t.s3.body}</p>
              <Command>
                {withoutEmptyPrefix(
                  format(t.s3.command, {
                    endpoint: x.s3!.endpoint,
                    region: x.s3!.region,
                    bucket: x.s3!.bucket,
                    prefix: x.s3!.prefix,
                  }),
                )}
              </Command>
              {x.s3!.prefix === "" && <p>{t.s3.noPrefix}</p>}
            </CardContent>
          </Card>
        ))
      )}
      {local.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.local.empty}</p>
      ) : (
        local.map((x) => (
          <Card key={x.id}>
            <CardHeader>
              <CardTitle>{format(t.local.title, { targetId: x.id })}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p>{t.local.body}</p>
              <Command>{format(t.local.command, { root: x.local?.root ?? "<root>", targetId: x.id })}</Command>
              <p>{t.local.exits}</p>
              <p>{t.local.lostDisk}</p>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
