import { readFileSync } from "node:fs";
import type { PathLike } from "node:fs";
import {
  PANEL_CHECK_MAX_BYTES,
  PANEL_CHECK_TIMEOUT_MS,
  PANEL_RELEASE_LATEST_URL,
  PANEL_RELEASE_TAG_RE,
  type PANEL_CHECK_STATES,
} from "@hosting-panel/contracts";

type PanelCheckState = (typeof PANEL_CHECK_STATES)[number];

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
// From apps/api/{src,dist}/updates/ to the release root; Node resolves the `current` symlink to its own release.
const RELEASE_FILE = new URL("../../../../RELEASE.json", import.meta.url);

/** The `version` of a RELEASE.json, or null when missing, not JSON or not x.y.z. */
export function readReleaseVersion(file: PathLike): string | null {
  try {
    const version: unknown = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown } | null)?.version;
    return typeof version === "string" && SEMVER_RE.test(version) ? version : null;
  } catch {
    return null;
  }
}

let installed: string | null | undefined;

/** The panel version this process runs, read once per process. */
export function installedPanelVersion(): string | null {
  if (installed === undefined) installed = readReleaseVersion(RELEASE_FILE);
  return installed;
}

/** Port of release.sh version_gt: true when a > b, false unless both are x.y.z. */
export function versionGt(a: string, b: string): boolean {
  if (!SEMVER_RE.test(a) || !SEMVER_RE.test(b)) return false;
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (x[i]! > y[i]!) return true;
    if (x[i]! < y[i]!) return false;
  }
  return false;
}

export interface PanelReleaseCheck {
  readonly state: Exclude<PanelCheckState, "never_checked">;
  readonly latestVersion: string | null;
}

const FAILED: PanelReleaseCheck = { state: "failed", latestVersion: null };

// Reads at most `max` bytes; null when the body is larger.
async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** One request for the latest release; it names neither the server nor its administrator. */
export async function checkPanelRelease(installedVersion: string | null, fetchFn: typeof fetch = fetch): Promise<PanelReleaseCheck> {
  try {
    const res = await fetchFn(PANEL_RELEASE_LATEST_URL, {
      redirect: "error",
      signal: AbortSignal.timeout(PANEL_CHECK_TIMEOUT_MS),
      headers: { accept: "application/vnd.github+json", "user-agent": "hosting-panel-update-check" },
    });
    if (res.status === 404) return { state: "no_release", latestVersion: null };
    if (!res.ok) return FAILED;
    const text = await readCapped(res, PANEL_CHECK_MAX_BYTES);
    if (text === null) return FAILED;
    const tag: unknown = (JSON.parse(text) as { tag_name?: unknown } | null)?.tag_name;
    const latest = typeof tag === "string" ? PANEL_RELEASE_TAG_RE.exec(tag)?.[1] : undefined;
    if (!latest) return FAILED;
    const newer = installedVersion === null || versionGt(latest, installedVersion);
    return { state: newer ? "newer" : "up_to_date", latestVersion: latest };
  } catch {
    return FAILED;
  }
}
