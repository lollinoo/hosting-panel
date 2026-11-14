import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_SFTP_PORT,
  SFTP_IMAGE,
  SftpAccessApplyIpcRequestSchema,
  type SftpAccessApplyRequest,
  type SftpAccessUser,
} from "@hosting-panel/contracts";
import { SHARED_DB_CONFIG_SHA256_LABEL } from "./shared-database.js";
import {
  ExecutorCodedError,
  assertSafeIdentifier,
  writeFileAtomically,
  writeFileIfChanged,
} from "./traefik-config.js";

export const DEFAULT_SFTP_STATE_DIR = "/var/lib/hosting-panel/sftp" as const;
export const SFTP_CONTAINER_NAME = "hp_sftp" as const;
export const SFTP_NETWORK_NAME = "hp_sftp_net" as const;
export const SFTP_VOLUME_PREFIX = "hp_vol_" as const;
export const SFTP_INTERNAL_PORT = 2222 as const;
export const SFTP_CONFIG_SHA256_LABEL = SHARED_DB_CONFIG_SHA256_LABEL;

const SFTP_MEMORY_BYTES = 268_435_456;
const SFTP_STATE_FILE = "state.json" as const;
const SFTP_HOST_KEY_FILE = "ssh_host_ed25519_key" as const;
const SFTP_HOST_PUB_FILE = "ssh_host_ed25519_key.pub" as const;

export interface SftpRenderedUserFiles {
  readonly passwd: string;
  readonly group: string;
  readonly shadow: string;
}

export interface SftpContainerSiteMount {
  readonly siteId: string;
  readonly volume: string;
}

export interface SftpContainerInput {
  readonly image?: string;
  readonly stateDir: string;
  readonly hostIp?: string;
  readonly port?: number;
  readonly network?: string;
  readonly sites: readonly SftpContainerSiteMount[];
  readonly sshdConfig?: string;
}

export interface SftpContainerCreatePayload {
  readonly Image: string;
  readonly Entrypoint: readonly ["/usr/sbin/sshd.pam"];
  readonly Cmd: readonly ["-D", "-e", "-f", "/etc/hp-sftp/sshd_config"];
  readonly ExposedPorts: Readonly<Record<string, Record<string, never>>>;
  readonly Labels: Readonly<Record<string, string>>;
  readonly HostConfig: {
    readonly Privileged: false;
    readonly CapDrop: readonly ["ALL"];
    readonly CapAdd: readonly ["SETGID", "SETUID", "SYS_CHROOT"];
    readonly SecurityOpt: readonly ["no-new-privileges:true"];
    readonly ReadonlyRootfs: true;
    readonly PidsLimit: number;
    readonly NanoCpus: number;
    readonly Memory: number;
    readonly MemorySwap: number;
    readonly RestartPolicy: { readonly Name: "unless-stopped" };
    readonly LogConfig: {
      readonly Type: "json-file";
      readonly Config: { readonly "max-size": "10m"; readonly "max-file": "3" };
    };
    readonly NetworkMode: string;
    readonly PortBindings: Readonly<
      Record<string, readonly { readonly HostIp: string; readonly HostPort: string }[]>
    >;
    readonly Binds: readonly string[];
  };
}

export interface SftpStateFilesResult {
  readonly publicKeyLine: string;
}

export interface EnsureSftpStateFilesOptions {
  readonly stateUsers?: readonly SftpAccessUser[];
  readonly writeState?: boolean;
}

export type SftpUserFileName = keyof SftpRenderedUserFiles;
export type SftpUserFileChangeKind = "unchanged" | "append" | "replace";

export interface SftpUserFileUpdate {
  readonly name: SftpUserFileName;
  readonly targetPath: string;
  readonly action: SftpUserFileChangeKind;
  readonly newContent: string;
  readonly newBuffer: Buffer;
  readonly appendOffset: number;
  readonly appendTail: Buffer;
  readonly diskMode: number | null;
}

export interface SftpStatePlan {
  readonly stateDir: string;
  readonly users: readonly SftpAccessUser[];
  readonly etcReady: boolean;
  readonly keyExists: boolean;
  readonly pubReady: boolean;
  readonly pubMode: number | null;
  readonly derivedPublicKeyLine: string | null;
  readonly userChangeKind: SftpUserFileChangeKind;
  readonly userFiles: readonly SftpUserFileUpdate[];
}

export function renderSftpSshdConfig(): string {
  return [
    `Port ${String(SFTP_INTERNAL_PORT)}`,
    "ListenAddress 0.0.0.0",
    "HostKey /etc/hp-sftp/ssh_host_ed25519_key",
    "PidFile none",
    "UsePAM no",
    "AuthenticationMethods password",
    "PasswordAuthentication yes",
    "PermitEmptyPasswords no",
    "PubkeyAuthentication no",
    "KbdInteractiveAuthentication no",
    "HostbasedAuthentication no",
    "AuthorizedKeysFile none",
    "PermitRootLogin no",
    "AllowGroups hpsftp",
    "ChrootDirectory %h",
    "ForceCommand internal-sftp -d /files -u 0022",
    "Subsystem sftp internal-sftp",
    "DisableForwarding yes",
    "AllowTcpForwarding no",
    "AllowStreamLocalForwarding no",
    "AllowAgentForwarding no",
    "X11Forwarding no",
    "PermitTunnel no",
    "PermitTTY no",
    "GatewayPorts no",
    "PermitUserRC no",
    "PermitUserEnvironment no",
    "UseDNS no",
    "PrintMotd no",
    "MaxAuthTries 3",
    "LoginGraceTime 20",
    "MaxStartups 10:30:60",
    "PerSourceMaxStartups 10",
    "MaxSessions 4",
    "ClientAliveInterval 60",
    "ClientAliveCountMax 3",
    "ChannelTimeout session=30m",
    "UnusedConnectionTimeout 10m",
    "PerSourcePenalties authfail:10s crash:90s noauth:1s grace-exceeded:20s max:600s min:15s",
    "LogLevel INFO",
    "",
  ].join("\n");
}

function validateSftpUsers(users: readonly SftpAccessUser[]): readonly SftpAccessUser[] {
  const parsed = SftpAccessApplyIpcRequestSchema.safeParse({ users });
  if (!parsed.success) {
    throw new ExecutorCodedError("Invalid SFTP access user configuration", "VALIDATION_ERROR");
  }
  return parsed.data.users;
}

const SYSTEM_PASSWD_LINES = [
  "root:x:0:0:root:/root:/bin/false",
  "sshd:x:22:22:sshd:/var/empty:/bin/false",
] as const;
const SYSTEM_GROUP_LINES = ["root:x:0:", "sshd:x:22:", "hpsftp:x:33:"] as const;
const SYSTEM_SHADOW_LINES = ["root:*:::::::", "sshd:*:::::::"] as const;

function mergeRenderedLines(
  systemLines: readonly string[],
  wantedByName: ReadonlyMap<string, string>,
  existingText: string | undefined,
): string {
  const result = [...systemLines];
  const emitted = new Set<string>();
  if (existingText) {
    for (const line of existingText.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      const colon = line.indexOf(":");
      if (colon <= 0) {
        continue;
      }
      const name = line.slice(0, colon);
      if (emitted.has(name)) {
        continue;
      }
      const wanted = wantedByName.get(name);
      if (wanted !== undefined && wanted === line) {
        result.push(line);
        emitted.add(name);
      }
    }
  }
  for (const [name, wanted] of wantedByName) {
    if (!emitted.has(name)) {
      result.push(wanted);
    }
  }
  return `${result.join("\n")}\n`;
}

export function renderSftpUserFiles(
  users: readonly SftpAccessUser[],
  existingFiles?: Partial<SftpRenderedUserFiles>,
): SftpRenderedUserFiles {
  const validUsers = validateSftpUsers(users);
  const wantedPasswd = new Map<string, string>();
  const wantedShadow = new Map<string, string>();
  for (const u of validUsers) {
    wantedPasswd.set(u.username, `${u.username}:x:33:33::/srv/sftp/${u.siteId}:/bin/false`);
    wantedShadow.set(u.username, `${u.username}:${u.passwordHash}:::::::`);
  }
  return {
    passwd: mergeRenderedLines(SYSTEM_PASSWD_LINES, wantedPasswd, existingFiles?.passwd),
    group: mergeRenderedLines(SYSTEM_GROUP_LINES, new Map(), existingFiles?.group),
    shadow: mergeRenderedLines(SYSTEM_SHADOW_LINES, wantedShadow, existingFiles?.shadow),
  };
}

function assertSafeBindSource(source: string, what: string): string {
  if (source.includes("docker.sock")) {
    throw new ExecutorCodedError(
      `Mounting docker.sock into SFTP (${what}) is strictly forbidden (TH-02)`,
      "HOST_POLICY_DENIED",
    );
  }
  if (typeof source !== "string" || source.length === 0 || /[\0\r\n:]/.test(source)) {
    throw new ExecutorCodedError(`Unsafe SFTP ${what}`, "HOST_POLICY_DENIED");
  }
  return source;
}

export function hashSftpContainerConfig(
  payload: SftpContainerCreatePayload,
  sshdConfig: string,
): string {
  const { [SFTP_CONFIG_SHA256_LABEL]: _ignored, ...labelsWithoutHash } = payload.Labels;
  return createHash("sha256")
    .update(
      JSON.stringify({
        payload: { ...payload, Labels: labelsWithoutHash },
        sshdConfig,
      }),
    )
    .digest("hex");
}

export function buildSftpContainerPayload(input: SftpContainerInput): {
  readonly payload: SftpContainerCreatePayload;
  readonly configSha256: string;
} {
  const Image = input.image ?? SFTP_IMAGE;
  if (typeof Image !== "string" || Image.trim().length === 0 || /[\s\0]/.test(Image)) {
    throw new ExecutorCodedError("Invalid SFTP container image", "VALIDATION_ERROR");
  }
  const stateDir = assertSafeBindSource(input.stateDir, "state directory");
  const hostIp = input.hostIp ?? "0.0.0.0";
  if (typeof hostIp !== "string" || hostIp.trim().length === 0 || /[\s\0]/.test(hostIp)) {
    throw new ExecutorCodedError("Invalid SFTP host IP", "VALIDATION_ERROR");
  }
  const port = input.port ?? DEFAULT_SFTP_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ExecutorCodedError(
      "SFTP port must be an integer between 1 and 65535",
      "VALIDATION_ERROR",
    );
  }
  const network = input.network ?? SFTP_NETWORK_NAME;
  assertSafeIdentifier(network, "sftpNetworkName");

  const distinctSites = new Map<string, string>();
  for (const site of input.sites) {
    assertSafeIdentifier(site.siteId, "siteId");
    const volume = assertSafeBindSource(site.volume, "site volume");
    assertSafeIdentifier(volume, "sftpVolume");
    const prev = distinctSites.get(site.siteId);
    if (prev !== undefined && prev !== volume) {
      throw new ExecutorCodedError("Conflicting volumes for the same SFTP site", "VALIDATION_ERROR");
    }
    distinctSites.set(site.siteId, volume);
  }

  const Binds = [
    `${stateDir}/etc:/etc/hp-sftp:ro`,
    `${stateDir}/users/passwd:/etc/passwd:ro`,
    `${stateDir}/users/group:/etc/group:ro`,
    `${stateDir}/users/shadow:/etc/shadow:ro`,
    ...[...distinctSites.entries()].map(
      ([siteId, volume]) => `${volume}:/srv/sftp/${siteId}/files:rw`,
    ),
  ].sort();

  const Entrypoint = ["/usr/sbin/sshd.pam"] as const;
  const Cmd = ["-D", "-e", "-f", "/etc/hp-sftp/sshd_config"] as const;
  const CapAdd = ["SETGID", "SETUID", "SYS_CHROOT"] as const;
  const SecurityOpt = ["no-new-privileges:true"] as const;
  const ReadonlyRootfs = true as const;
  const PortBindings = {
    [`${String(SFTP_INTERNAL_PORT)}/tcp`]: [{ HostIp: hostIp, HostPort: String(port) }],
  };
  const sshdConfig = input.sshdConfig ?? renderSftpSshdConfig();

  const basePayload: SftpContainerCreatePayload = {
    Image,
    Entrypoint,
    Cmd,
    ExposedPorts: { [`${String(SFTP_INTERNAL_PORT)}/tcp`]: {} },
    Labels: {
      "io.hostingpanel.managed": "true",
      "io.hostingpanel.role": "sftp",
    },
    HostConfig: {
      Privileged: false,
      CapDrop: ["ALL"],
      CapAdd,
      SecurityOpt,
      ReadonlyRootfs,
      PidsLimit: 512,
      NanoCpus: 500_000_000,
      Memory: SFTP_MEMORY_BYTES,
      MemorySwap: SFTP_MEMORY_BYTES,
      RestartPolicy: { Name: "unless-stopped" },
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
      NetworkMode: network,
      PortBindings,
      Binds,
    },
  };
  const configSha256 = hashSftpContainerConfig(basePayload, sshdConfig);

  return {
    configSha256,
    payload: {
      ...basePayload,
      Labels: {
        ...basePayload.Labels,
        [SFTP_CONFIG_SHA256_LABEL]: configSha256,
      },
    },
  };
}

function sshWireString(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

export function generateEd25519HostKey(): {
  readonly privateKeyFile: string;
  readonly publicKeyLine: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pubJwk = publicKey.export({ format: "jwk" });
  const privJwk = privateKey.export({ format: "jwk" });
  if (typeof pubJwk.x !== "string" || typeof privJwk.d !== "string") {
    throw new ExecutorCodedError("Failed to export Ed25519 host key", "INTERNAL_ERROR");
  }
  const pub = Buffer.from(pubJwk.x, "base64url");
  const seed = Buffer.from(privJwk.d, "base64url");
  const type = Buffer.from("ssh-ed25519", "ascii");
  const pubBlob = Buffer.concat([sshWireString(type), sshWireString(pub)]);
  const check = randomBytes(4);
  let priv = Buffer.concat([
    check,
    check,
    sshWireString(type),
    sshWireString(pub),
    sshWireString(Buffer.concat([seed, pub])),
    sshWireString(Buffer.from("hp_sftp", "ascii")),
  ]);
  for (let i = 1; priv.length % 8 !== 0; i += 1) {
    priv = Buffer.concat([priv, Buffer.from([i])]);
  }
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "ascii"),
    sshWireString(Buffer.from("none", "ascii")),
    sshWireString(Buffer.from("none", "ascii")),
    sshWireString(Buffer.alloc(0)),
    Buffer.from([0, 0, 0, 1]),
    sshWireString(pubBlob),
    sshWireString(priv),
  ]);
  const b64 = body.toString("base64").replace(/.{1,70}/g, "$&\n");
  return {
    privateKeyFile: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}-----END OPENSSH PRIVATE KEY-----\n`,
    publicKeyLine: `ssh-ed25519 ${pubBlob.toString("base64")} hp_sftp\n`,
  };
}

export function sshFingerprint(pubLine: string): string {
  const parts = pubLine.trim().split(/\s+/);
  const keyB64 = parts[1];
  if (!keyB64) {
    throw new ExecutorCodedError("Invalid SSH public key line", "VALIDATION_ERROR");
  }
  const blob = Buffer.from(keyB64, "base64");
  const digest = createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
  return `SHA256:${digest}`;
}

function readSshWireString(
  buf: Buffer,
  offset: number,
): { readonly value: Buffer; readonly next: number } {
  if (offset + 4 > buf.length) {
    throw new ExecutorCodedError("Invalid OpenSSH host private key", "HOST_POLICY_DENIED");
  }
  const len = buf.readUInt32BE(offset);
  const next = offset + 4 + len;
  if (next > buf.length) {
    throw new ExecutorCodedError("Invalid OpenSSH host private key", "HOST_POLICY_DENIED");
  }
  return { value: buf.subarray(offset + 4, next), next };
}

function publicKeyLineFromOpenSshPrivateKey(pem: string): string {
  const match =
    /^-----BEGIN OPENSSH PRIVATE KEY-----\r?\n([\s\S]+?)\r?\n-----END OPENSSH PRIVATE KEY-----$/.exec(
      pem.trim(),
    );
  if (!match?.[1]) {
    throw new ExecutorCodedError("Invalid OpenSSH host private key", "HOST_POLICY_DENIED");
  }
  const body = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
  const magic = Buffer.from("openssh-key-v1\0", "ascii");
  if (body.length < magic.length || !body.subarray(0, magic.length).equals(magic)) {
    throw new ExecutorCodedError("Invalid OpenSSH host private key", "HOST_POLICY_DENIED");
  }
  let offset = magic.length;
  const cipher = readSshWireString(body, offset);
  offset = cipher.next;
  const kdf = readSshWireString(body, offset);
  offset = kdf.next;
  const kdfOptions = readSshWireString(body, offset);
  offset = kdfOptions.next;
  if (
    cipher.value.toString("ascii") !== "none" ||
    kdf.value.toString("ascii") !== "none" ||
    offset + 4 > body.length
  ) {
    throw new ExecutorCodedError(
      "Unsupported or encrypted SFTP host private key",
      "HOST_POLICY_DENIED",
    );
  }
  const keyCount = body.readUInt32BE(offset);
  offset += 4;
  if (keyCount < 1) {
    throw new ExecutorCodedError("SFTP host private key contains no keys", "HOST_POLICY_DENIED");
  }
  const pubEntry = readSshWireString(body, offset);
  const pubBlob = pubEntry.value;
  const privEntry = readSshWireString(body, pubEntry.next);
  if (
    privEntry.value.length < 8 ||
    !privEntry.value.subarray(0, 4).equals(privEntry.value.subarray(4, 8))
  ) {
    throw new ExecutorCodedError("Invalid OpenSSH host private key", "HOST_POLICY_DENIED");
  }
  const keyTypeBuf = readSshWireString(pubBlob, 0);
  const keyType = keyTypeBuf.value.toString("ascii");
  if (keyType !== "ssh-ed25519" || pubBlob.length <= keyTypeBuf.next) {
    throw new ExecutorCodedError("Invalid SFTP host public key blob", "HOST_POLICY_DENIED");
  }
  return `${keyType} ${pubBlob.toString("base64")} hp_sftp\n`;
}

export async function assertSftpStateDir(
  stateDir: string,
  executorUid: number | undefined,
): Promise<void> {
  const dirStat = await lstat(stateDir).catch(() => null);
  if (
    !dirStat?.isDirectory() ||
    executorUid === undefined ||
    dirStat.uid !== executorUid ||
    (dirStat.mode & 0o077) !== 0
  ) {
    throw new ExecutorCodedError(
      "SFTP state directory missing or unsafe permissions, run bootstrap first",
      "HOST_POLICY_DENIED",
    );
  }
}

async function ensureDirWithMode(dirPath: string, mode: number): Promise<void> {
  const st = await lstat(dirPath).catch(() => null);
  if (!st) {
    await mkdir(dirPath, { recursive: true, mode });
    await chmod(dirPath, mode);
    return;
  }
  if (!st.isDirectory()) {
    throw new ExecutorCodedError("SFTP state subdirectory must be a directory", "HOST_POLICY_DENIED");
  }
  if ((st.mode & 0o777) !== mode) {
    await chmod(dirPath, mode);
  }
}

async function writeFileBufferToHandle(targetPath: string, buf: Buffer, offset: number): Promise<void> {
  const fh = await open(targetPath, "r+");
  try {
    let written = 0;
    while (written < buf.length) {
      const res = await fh.write(buf, written, buf.length - written, offset + written);
      written += res.bytesWritten;
    }
    if (offset === 0) {
      await fh.truncate(buf.length);
    }
  } finally {
    await fh.close();
  }
}

async function writeUserFileInPlace(targetPath: string, content: string): Promise<void> {
  const existing = await lstat(targetPath).catch(() => null);
  if (!existing) {
    await writeFileAtomically(targetPath, content, 0o644, 0o755);
    return;
  }
  if (!existing.isFile()) {
    throw new ExecutorCodedError("SFTP user file must be a regular file", "HOST_POLICY_DENIED");
  }
  // shortcut: every delete, new password or suspension disconnects all SFTP users for a moment, upgrade to ending only that user's sessions when customers complain
  await writeFileBufferToHandle(targetPath, Buffer.from(content, "utf8"), 0);
  if ((existing.mode & 0o777) !== 0o644) {
    await chmod(targetPath, 0o644);
  }
}

export async function writeSftpState(
  stateDir: string,
  users: readonly SftpAccessUser[],
): Promise<void> {
  const validUsers = validateSftpUsers(users);
  const targetPath = path.join(stateDir, SFTP_STATE_FILE);
  const nextContent = `${JSON.stringify({ users: validUsers })}\n`;
  const st = await lstat(targetPath).catch(() => null);
  if (st?.isFile()) {
    const existingContent = await readFile(targetPath, "utf8").catch(() => null);
    if (existingContent === nextContent) {
      if ((st.mode & 0o777) !== 0o600) {
        await chmod(targetPath, 0o600);
      }
      return;
    }
  }
  await writeFileAtomically(targetPath, nextContent, 0o600, 0o700);
}

export async function readSftpState(stateDir: string): Promise<SftpAccessApplyRequest | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(stateDir, SFTP_STATE_FILE), "utf8");
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return null;
    }
    throw new ExecutorCodedError("Failed to read SFTP state file", "HOST_POLICY_DENIED");
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch {
    throw new ExecutorCodedError("Invalid SFTP state file", "HOST_POLICY_DENIED");
  }
  const parsed = SftpAccessApplyIpcRequestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new ExecutorCodedError("Invalid SFTP state file", "HOST_POLICY_DENIED");
  }
  return parsed.data;
}

export async function readSftpHostKeyFingerprint(stateDir: string): Promise<string | null> {
  const pubPath = path.join(stateDir, "etc", SFTP_HOST_PUB_FILE);
  const pubLine = await readFile(pubPath, "utf8").catch(() => null);
  if (!pubLine) {
    return null;
  }
  try {
    return sshFingerprint(pubLine);
  } catch {
    return null;
  }
}

export async function hasSftpHostKey(stateDir: string): Promise<boolean> {
  const keyStat = await lstat(path.join(stateDir, "etc", SFTP_HOST_KEY_FILE)).catch(() => null);
  return Boolean(keyStat?.isFile());
}

const SFTP_USER_FILE_NAMES: readonly SftpUserFileName[] = ["passwd", "group", "shadow"];

async function inspectRegularDir(dirPath: string): Promise<number | null> {
  const st = await lstat(dirPath).catch(() => null);
  if (!st) {
    return null;
  }
  if (!st.isDirectory()) {
    throw new ExecutorCodedError("SFTP state subdirectory must be a directory", "HOST_POLICY_DENIED");
  }
  return st.mode & 0o777;
}

async function inspectRegularFile(
  filePath: string,
): Promise<{ readonly buffer: Buffer; readonly mode: number } | null> {
  const st = await lstat(filePath).catch(() => null);
  if (!st) {
    return null;
  }
  if (!st.isFile()) {
    throw new ExecutorCodedError("SFTP state file must be a regular file", "HOST_POLICY_DENIED");
  }
  try {
    return { buffer: await readFile(filePath), mode: st.mode & 0o777 };
  } catch {
    throw new ExecutorCodedError("Failed to read SFTP state file", "HOST_POLICY_DENIED");
  }
}

export async function prepareSftpStatePlan(
  stateDir: string,
  executorUid: number | undefined,
  users: readonly SftpAccessUser[] = [],
): Promise<SftpStatePlan> {
  await assertSftpStateDir(stateDir, executorUid);
  const validUsers = validateSftpUsers(users);

  const etcDir = path.join(stateDir, "etc");
  const usersDir = path.join(stateDir, "users");
  const etcMode = await inspectRegularDir(etcDir);
  const usersDirMode = await inspectRegularDir(usersDir);

  const sshdConfigFile = await inspectRegularFile(path.join(etcDir, "sshd_config"));
  const expectedSshdConfig = renderSftpSshdConfig();

  const keyPath = path.join(etcDir, SFTP_HOST_KEY_FILE);
  const pubPath = path.join(etcDir, SFTP_HOST_PUB_FILE);
  const keyStat = await lstat(keyPath).catch(() => null);
  if (keyStat && !keyStat.isFile()) {
    throw new ExecutorCodedError("SFTP host key must be a regular file", "HOST_POLICY_DENIED");
  }
  const keyExists = Boolean(keyStat?.isFile());
  let derivedPublicKeyLine: string | null = null;
  if (keyExists) {
    let privateKeyPem: string;
    try {
      privateKeyPem = await readFile(keyPath, "utf8");
    } catch {
      throw new ExecutorCodedError("Failed to read SFTP host private key", "HOST_POLICY_DENIED");
    }
    derivedPublicKeyLine = publicKeyLineFromOpenSshPrivateKey(privateKeyPem);
  }
  const pubFile = await inspectRegularFile(pubPath);
  const existingPub = pubFile ? pubFile.buffer.toString("utf8") : null;
  const pubReady =
    derivedPublicKeyLine !== null && existingPub !== null && existingPub === derivedPublicKeyLine;

  const etcReady =
    etcMode === 0o755 &&
    usersDirMode === 0o755 &&
    sshdConfigFile !== null &&
    sshdConfigFile.mode === 0o444 &&
    sshdConfigFile.buffer.toString("utf8") === expectedSshdConfig &&
    keyExists &&
    ((keyStat?.mode ?? 0) & 0o777) === 0o444 &&
    pubFile !== null &&
    pubFile.mode === 0o444 &&
    pubReady;

  const diskUserFiles: Partial<
    Record<SftpUserFileName, { readonly buffer: Buffer; readonly mode: number }>
  > = {};
  const existingTexts: { passwd?: string; group?: string; shadow?: string } = {};
  for (const name of SFTP_USER_FILE_NAMES) {
    const file = await inspectRegularFile(path.join(usersDir, name));
    if (file) {
      diskUserFiles[name] = file;
      existingTexts[name] = file.buffer.toString("utf8");
    }
  }

  const rendered = renderSftpUserFiles(validUsers, existingTexts);
  const userFiles: SftpUserFileUpdate[] = [];
  let hasAppend = false;
  let hasReplace = false;

  for (const name of SFTP_USER_FILE_NAMES) {
    const targetPath = path.join(usersDir, name);
    const disk = diskUserFiles[name];
    const newContent = rendered[name];
    const newBuffer = Buffer.from(newContent, "utf8");
    let action: SftpUserFileChangeKind = "replace";
    let appendOffset = 0;
    let appendTail = Buffer.alloc(0);

    if (disk && disk.buffer.equals(newBuffer)) {
      action = "unchanged";
    } else if (
      disk &&
      disk.buffer.length > 0 &&
      newBuffer.length > disk.buffer.length &&
      newBuffer.subarray(0, disk.buffer.length).equals(disk.buffer)
    ) {
      action = "append";
      appendOffset = disk.buffer.length;
      appendTail = newBuffer.subarray(disk.buffer.length);
      hasAppend = true;
    } else {
      hasReplace = true;
    }

    userFiles.push({
      name,
      targetPath,
      action,
      newContent,
      newBuffer,
      appendOffset,
      appendTail,
      diskMode: disk ? disk.mode : null,
    });
  }

  const userChangeKind: SftpUserFileChangeKind = hasReplace
    ? "replace"
    : hasAppend
      ? "append"
      : "unchanged";

  return {
    stateDir,
    users: validUsers,
    etcReady,
    keyExists,
    pubReady,
    pubMode: pubFile ? pubFile.mode : null,
    derivedPublicKeyLine,
    userChangeKind,
    userFiles,
  };
}

export async function commitSftpStatePlan(
  plan: SftpStatePlan,
  options?: EnsureSftpStateFilesOptions,
): Promise<SftpStateFilesResult> {
  const etcDir = path.join(plan.stateDir, "etc");
  const usersDir = path.join(plan.stateDir, "users");
  const keyPath = path.join(etcDir, SFTP_HOST_KEY_FILE);
  const pubPath = path.join(etcDir, SFTP_HOST_PUB_FILE);

  let publicKeyLine = plan.derivedPublicKeyLine ?? "";
  if (!plan.etcReady) {
    await ensureDirWithMode(etcDir, 0o755);
    await ensureDirWithMode(usersDir, 0o755);

    const sshdConfigPath = path.join(etcDir, "sshd_config");
    await writeFileIfChanged(sshdConfigPath, renderSftpSshdConfig(), 0o444);
    const sshdStat = await lstat(sshdConfigPath);
    if ((sshdStat.mode & 0o777) !== 0o444) {
      await chmod(sshdConfigPath, 0o444);
    }

    if (plan.keyExists && plan.derivedPublicKeyLine !== null) {
      publicKeyLine = plan.derivedPublicKeyLine;
      if (!plan.pubReady) {
        await writeFileAtomically(pubPath, publicKeyLine, 0o444, 0o755);
      } else if (plan.pubMode !== 0o444) {
        await chmod(pubPath, 0o444);
      }
      const keyStat = await lstat(keyPath);
      if ((keyStat.mode & 0o777) !== 0o444) {
        await chmod(keyPath, 0o444);
      }
    } else {
      const generated = generateEd25519HostKey();
      await writeFileAtomically(keyPath, generated.privateKeyFile, 0o444, 0o755);
      await writeFileAtomically(pubPath, generated.publicKeyLine, 0o444, 0o755);
      publicKeyLine = generated.publicKeyLine;
    }
  }

  for (const file of plan.userFiles) {
    if (file.action === "unchanged") {
      if (file.diskMode !== null && file.diskMode !== 0o644) {
        await chmod(file.targetPath, 0o644);
      }
    } else if (file.action === "append") {
      await writeFileBufferToHandle(file.targetPath, file.appendTail, file.appendOffset);
      if (file.diskMode !== null && file.diskMode !== 0o644) {
        await chmod(file.targetPath, 0o644);
      }
    } else {
      await writeUserFileInPlace(file.targetPath, file.newContent);
    }
  }

  if (options?.writeState !== false) {
    await writeSftpState(plan.stateDir, options?.stateUsers ?? plan.users);
  }

  return {
    publicKeyLine,
  };
}

export async function ensureSftpStateFiles(
  stateDir: string,
  executorUid: number | undefined,
  users: readonly SftpAccessUser[] = [],
  options?: EnsureSftpStateFilesOptions,
): Promise<SftpStateFilesResult> {
  const plan = await prepareSftpStatePlan(stateDir, executorUid, users);
  return commitSftpStatePlan(plan, options);
}
