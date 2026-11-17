import { HostOsPackagesWireSchema } from "@hosting-panel/contracts";
import {
  HOST_JOB_UNITS,
  HOST_SERVICE_UNITS,
  hostAgentError,
  type HostJob,
  type HostJobState,
  type HostJournalLine,
  type HostOsPackage,
  type HostServiceState,
} from "@hosting-panel/host-agent-contracts";

// Fixed sentences: the text of a program never crosses the socket.
export const HOST_TOOL_FAILED = "A host tool failed or gave an answer the agent cannot read";
export const HOST_JOB_UNITS_MISSING = "The host job units are not installed or not active";
export const HOST_JOB_RUNNING = "Host job is already running";

/** NOT_SUPPORTED error with the fixed tool sentence. */
export function hostToolFailed(): Error & { code: string } {
  return hostAgentError("NOT_SUPPORTED", HOST_TOOL_FAILED);
}

/** Splits `systemctl show` output into property blocks keyed by Id. */
export function parseSystemctlShow(stdout: string): Map<string, Record<string, string>> {
  const blocks = new Map<string, Record<string, string>>();
  for (const chunk of stdout.split(/\n\s*\n/)) {
    if (chunk.trim() === "") continue;
    const props: Record<string, string> = {};
    for (const line of chunk.split("\n")) {
      if (line === "") continue;
      const eq = line.indexOf("=");
      if (eq < 1) throw hostToolFailed();
      props[line.slice(0, eq)] = line.slice(eq + 1);
    }
    if (!props.Id) throw hostToolFailed();
    blocks.set(props.Id, props);
  }
  return blocks;
}

/** `@<epoch s>` → ISO instant, empty → null. */
function unixTime(value: string | undefined): string | null {
  if (value === "") return null;
  const m = (value ?? "").match(/^@(\d{1,12})$/);
  if (!m) throw hostToolFailed();
  return new Date(Number(m[1]) * 1000).toISOString();
}

function block(blocks: Map<string, Record<string, string>>, id: string): Record<string, string> {
  const b = blocks.get(id);
  if (!b) throw hostToolFailed();
  return b;
}

/** The four panel services from the fixed systemctl services form. */
export function parseHostServices(stdout: string): HostServiceState[] {
  const blocks = parseSystemctlShow(stdout);
  return HOST_SERVICE_UNITS.map((unit) => {
    const b = block(blocks, `${unit}.service`);
    const activeState = b.ActiveState ?? "";
    if (!/^[a-z-]{1,32}$/.test(activeState) || !/^\d{1,9}$/.test(b.NRestarts ?? "")) throw hostToolFailed();
    return { unit, active: activeState === "active", activeState, since: unixTime(b.ActiveEnterTimestamp), restarts: Number(b.NRestarts) };
  });
}

function exitStatus(value: string | undefined): number {
  if (!/^\d{1,3}$/.test(value ?? "") || Number(value) > 255) throw hostToolFailed();
  return Number(value);
}

/** Job state from its .service and .path blocks and the trigger file, rules applied in order. */
export function hostJobState(job: HostJob, blocks: Map<string, Record<string, string>>, triggerExists: boolean): HostJobState {
  const unit = HOST_JOB_UNITS[job];
  const svc = block(blocks, `${unit}.service`);
  const path = block(blocks, `${unit}.path`);
  if (svc.LoadState !== "loaded" || path.LoadState !== "loaded") throw hostAgentError("NOT_SUPPORTED", HOST_JOB_UNITS_MISSING);
  const startedAt = unixTime(svc.ExecMainStartTimestamp);
  const endedAt = unixTime(svc.ExecMainExitTimestamp);
  if (path.ActiveState === "failed" && triggerExists) return { job, state: "failed", exitStatus: null, startedAt, endedAt };
  if (triggerExists || svc.ActiveState === "activating" || svc.ActiveState === "deactivating")
    return { job, state: "running", exitStatus: null, startedAt, endedAt: null };
  if (svc.ActiveState === "failed")
    return { job, state: "failed", exitStatus: endedAt ? exitStatus(svc.ExecMainStatus) : null, startedAt, endedAt };
  if (svc.Result === "success" && endedAt) return { job, state: "succeeded", exitStatus: exitStatus(svc.ExecMainStatus), startedAt, endedAt };
  return { job, state: "never_run", exitStatus: null, startedAt: null, endedAt: null };
}

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** journalctl --output=json lines → wire lines (control characters replaced, cut at 4096). */
export function parseJournalJson(stdout: string): HostJournalLine[] {
  return stdout.split("\n").filter((l) => l.trim() !== "").map((line) => {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      throw hostToolFailed();
    }
    const { __REALTIME_TIMESTAMP: us, MESSAGE: msg } = (entry ?? {}) as Record<string, unknown>;
    if (typeof us !== "string" || !/^\d{1,17}$/.test(us)) throw hostToolFailed();
    let message: string;
    if (typeof msg === "string") message = msg;
    else if (msg === null) message = "(line too long to show)";
    else if (Array.isArray(msg) && msg.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) message = Buffer.from(msg as number[]).toString("utf8");
    else throw hostToolFailed();
    return {
      at: new Date(Number(BigInt(us) / 1000n)).toISOString(),
      message: message.replace(CONTROL_CHARS, "\uFFFD").slice(0, 4096),
    };
  });
}

// The origins group takes no bracket: with `.+` before " [" a hostile line backtracks quadratically (R201 1.4).
const INST_LINE = /^Inst (\S+) \[([^\]]+)\] \((\S+) ([^[\]]+) \[([^\]]+)\]\)( \[[^\]]*\])?$/;
const PackageSchema = HostOsPackagesWireSchema.shape.packages.element;

/** `apt-get -s upgrade` → packages; the Inst count must match the "N upgraded" line. */
export function parseAptUpgradeSimulation(stdout: string): HostOsPackage[] {
  const count = stdout.match(/^(\d+) upgraded, /m);
  if (!count) throw hostToolFailed();
  const packages = stdout.split("\n").filter((l) => l.startsWith("Inst ")).map((line) => {
    const m = line.match(INST_LINE);
    if (!m) throw hostToolFailed();
    const origins = m[4]!.split(", ").map((o) => ({ label: o.slice(0, o.indexOf(":")), archive: o.slice(o.lastIndexOf("/") + 1) }));
    const origin = origins.some((o) => o.archive.endsWith("-security"))
      ? "security"
      : origins.some((o) => o.label === "Ubuntu" || o.label === "Debian") ? "distribution" : "other";
    const p = PackageSchema.safeParse({ name: m[1], installedVersion: m[2], newVersion: m[3], origin });
    if (!p.success) throw hostToolFailed();
    return p.data;
  });
  if (packages.length !== Number(count[1])) throw hostToolFailed();
  return packages;
}
