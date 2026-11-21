import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { PhpSettingsSchema } from "@hosting-panel/contracts";
import { assertSafeIdentifier, ExecutorCodedError, writeFileAtomically } from "./traefik-config.js";

export const DEFAULT_SITE_PHP_DIR = "/var/lib/hosting-panel/site-php" as const;
/** Sorts after zz-hp-mail.ini; the two files never set the same key. */
export const SITE_PHP_INI_TARGET = "/usr/local/etc/php/conf.d/zz-hp-site.ini" as const;

/** Header plus one `key = value` line per setting, keys sorted. Re-validated here, so no value can carry a newline or a directive. */
export function renderPhpIni(settings: Readonly<Record<string, string>>): string {
  const parsed = PhpSettingsSchema.safeParse(settings);
  if (!parsed.success) {
    throw new ExecutorCodedError(parsed.error.issues[0]?.message ?? "Invalid PHP settings", "VALIDATION_ERROR");
  }
  const lines = Object.entries(parsed.data)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key} = ${value}\n`);
  return `; Managed by the hosting panel; read-only.\n${lines.join("")}`;
}

export function sitePhpIniPath(dir: string, serviceInstanceId: string): string {
  return path.join(dir, `${assertSafeIdentifier(serviceInstanceId, "serviceInstanceId")}.ini`);
}

/** Exactly one entry: this service's own file, read-only. */
export function sitePhpBinds(dir: string, serviceInstanceId: string): readonly string[] {
  return [`${sitePhpIniPath(dir, serviceInstanceId)}:${SITE_PHP_INI_TARGET}:ro`];
}

/**
 * Temp file plus rename, so a symlink planted at the target is replaced, never followed. 0644
 * because the executor runs with UMask=0007 and the site's PHP user must read the file.
 */
export async function writeSitePhpIni(
  dir: string,
  serviceInstanceId: string,
  settings: Readonly<Record<string, string>>,
): Promise<void> {
  const target = sitePhpIniPath(dir, serviceInstanceId);
  const content = renderPhpIni(settings);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  await chmod(dir, 0o755);
  await writeFileAtomically(target, content, 0o644);
}

/** Best effort: a missing file, directory or an unsafe id is not an error. */
export async function removeSitePhpIni(dir: string, serviceInstanceId: string): Promise<void> {
  try {
    await rm(sitePhpIniPath(dir, serviceInstanceId), { force: true });
  } catch {
    // The file is only read when bound; a leftover is harmless.
  }
}
