#!/usr/bin/env node
/**
 * Interactive Full-Stack Launcher (Real Linux Docker Engine + Signed UDS Daemons)
 *
 * Starts in a single terminal with clean Ctrl+C shutdown:
 *   1. hp-docker-executor (signed UDS -> /var/run/docker.sock + Traefik zero-sock config)
 *   2. hp-host-agent      (signed UDS -> Linux /proc telemetry + allowlisted maintenance)
 *   3. hp-api             (127.0.0.1:4000, HP_RUNTIME_BACKEND=linux-systemd)
 *   4. hp-web             (127.0.0.1:3000, Next.js BFF Console)
 */

import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { access, chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");

const RUNTIME_DIR = process.env["HP_LIVE_DIR"]?.trim() || "/tmp/hp-live";
const SOCKETS_DIR = path.join(RUNTIME_DIR, "sockets");
const SECRETS_DIR = path.join(RUNTIME_DIR, "secrets");
const INGRESS_DIR = path.join(RUNTIME_DIR, "ingress");

const IPC_KEY_FILE = path.join(RUNTIME_DIR, "ipc.key");
const MASTER_KEY_FILE = path.join(RUNTIME_DIR, "secrets-master.key");
const BREAKGLASS_KEY_FILE = path.join(RUNTIME_DIR, "breakglass-jwt.key");
const JWT_KEY_FILE = path.join(RUNTIME_DIR, "jwt-signing.pem");
const ENV_SH_FILE = path.join(RUNTIME_DIR, "env.sh");

const EXECUTOR_SOCK = path.join(SOCKETS_DIR, "executor.sock");
const HOST_AGENT_SOCK = path.join(SOCKETS_DIR, "host-agent.sock");

const API_PORT = process.env["API_PORT"]?.trim() || "4000";
const WEB_PORT = process.env["WEB_PORT"]?.trim() || "3000";
const INGRESS_HTTP_PORT = process.env["HP_INGRESS_HTTP_PORT"]?.trim() || "18080";

/** Dev-only temporary RSA key (PKCS#8) for the API JWT signing key; reused while the file exists. */
async function ensureJwtKeyFile(filePath) {
  try {
    if ((await readFile(filePath, "utf8")).trim().length > 0) return;
  } catch {
    // Generate fresh key below
  }
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  await writeFile(filePath, pem, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

async function ensureSecretKeyFile(filePath) {
  try {
    const existing = (await readFile(filePath, "utf8")).trim();
    if (existing.length >= 64) {
      return existing;
    }
  } catch {
    // Generate fresh key below
  }
  const generated = randomBytes(32).toString("hex");
  await writeFile(filePath, `${generated}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
  return generated;
}

async function waitForFile(filePath, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(filePath);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  throw new Error(`Timed out waiting for socket ${filePath}`);
}

function pipePrefixed(stream, prefix, target) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length > 0) {
        target.write(`${prefix} ${line}\n`);
      }
    }
  });
  stream.on("end", () => {
    if (buffer.trim().length > 0) {
      target.write(`${prefix} ${buffer}\n`);
    }
  });
}

async function main() {
  const executorEntry = path.join(REPO_ROOT, "apps/docker-executor/dist/main.js");
  const hostAgentEntry = path.join(REPO_ROOT, "apps/host-agent/dist/main.js");
  const apiEntry = path.join(REPO_ROOT, "apps/api/dist/main.js");
  const nextBin = path.join(REPO_ROOT, "apps/web/node_modules/next/dist/bin/next");

  for (const requiredFile of [executorEntry, hostAgentEntry, apiEntry]) {
    try {
      await access(requiredFile);
    } catch {
      console.error(
        `[dev:docker] Missing build artifact (${requiredFile}). Run 'pnpm run build' first.`,
      );
      process.exit(1);
    }
  }

  await mkdir(SOCKETS_DIR, { recursive: true, mode: 0o700 });
  await mkdir(SECRETS_DIR, { recursive: true, mode: 0o700 });
  await chmod(SECRETS_DIR, 0o700);

  const ingressStaticDir = path.join(INGRESS_DIR, "static");
  const ingressDynamicDir = path.join(INGRESS_DIR, "dynamic");
  const ingressStaticFile = path.join(ingressStaticDir, "traefik.yml");
  await mkdir(ingressStaticDir, { recursive: true, mode: 0o755 });
  await mkdir(ingressDynamicDir, { recursive: true, mode: 0o755 });
  try {
    const st = await stat(ingressStaticFile);
    if (st.isDirectory()) {
      await rm(ingressStaticFile, { recursive: true, force: true });
    }
  } catch {
    // Will write traefik.yml below
  }
  await writeFile(
    ingressStaticFile,
    [
      "# Managed by hp-docker-executor — Zero-Sock Static Configuration (HCP-SPEC-003 §4.2)",
      "api:",
      "  dashboard: false",
      "  insecure: false",
      "",
      "entryPoints:",
      "  web:",
      '    address: ":80"',
      "",
      "providers:",
      "  file:",
      '    directory: "/etc/traefik/dynamic"',
      "    watch: true",
      "",
    ].join("\n"),
    { mode: 0o644 },
  );

  await rm(EXECUTOR_SOCK, { force: true });
  await rm(HOST_AGENT_SOCK, { force: true });

  const ipcKey = await ensureSecretKeyFile(IPC_KEY_FILE);
  const masterKey = await ensureSecretKeyFile(MASTER_KEY_FILE);
  const breakglassKey = await ensureSecretKeyFile(BREAKGLASS_KEY_FILE);
  await ensureJwtKeyFile(JWT_KEY_FILE);

  const nftablesRulesetPath = path.join(REPO_ROOT, "infra/linux/nftables-dedicated.conf");

  const envScript = [
    "# Source this file if you run individual Hosting Panel daemons in separate terminals:",
    `#   source ${ENV_SH_FILE}`,
    `export HP_RUNTIME_BACKEND="linux-systemd"`,
    `export HP_IPC_KEY_FILE="${IPC_KEY_FILE}"`,
    `export HP_IPC_KEY="${ipcKey}"`,
    `export HP_SECRETS_MASTER_KEY_FILE="${MASTER_KEY_FILE}"`,
    `export HP_SECRETS_MASTER_KEY="${masterKey}"`,
    `export HP_BREAKGLASS_KEY_FILE="${BREAKGLASS_KEY_FILE}"`,
    `export HP_BREAKGLASS_KEY="${breakglassKey}"`,
    `export HP_JWT_SIGNING_KEY_FILE="${JWT_KEY_FILE}"`,
    `export ENABLE_DEV_OIDC="true"`,
    `export HP_SEED_DEMO="true"`,
    `export HP_EXECUTOR_SOCKET_PATH="${EXECUTOR_SOCK}"`,
    `export HP_HOST_AGENT_SOCKET_PATH="${HOST_AGENT_SOCK}"`,
    `export HP_SECRETS_ROOT_DIR="${SECRETS_DIR}"`,
    `export HP_INGRESS_ROOT_DIR="${INGRESS_DIR}"`,
    `export HP_INGRESS_HTTP_PORT="${INGRESS_HTTP_PORT}"`,
    `export HP_NFTABLES_RULESET_PATH="${nftablesRulesetPath}"`,
    "",
  ].join("\n");
  await writeFile(ENV_SH_FILE, envScript, { mode: 0o600 });

  const sharedEnv = {
    ...process.env,
    HP_RUNTIME_BACKEND: "linux-systemd",
    HP_IPC_KEY_FILE: IPC_KEY_FILE,
    HP_IPC_KEY: ipcKey,
    HP_SECRETS_MASTER_KEY_FILE: MASTER_KEY_FILE,
    HP_SECRETS_MASTER_KEY: masterKey,
    HP_BREAKGLASS_KEY_FILE: BREAKGLASS_KEY_FILE,
    HP_BREAKGLASS_KEY: breakglassKey,
    HP_JWT_SIGNING_KEY_FILE: JWT_KEY_FILE,
    // Dev launcher only: explicit opt-in to dev OIDC and the demo dataset.
    ENABLE_DEV_OIDC: "true",
    HP_SEED_DEMO: "true",
    HP_EXECUTOR_SOCKET_PATH: EXECUTOR_SOCK,
    HP_HOST_AGENT_SOCKET_PATH: HOST_AGENT_SOCK,
    HP_SECRETS_ROOT_DIR: SECRETS_DIR,
    HP_INGRESS_ROOT_DIR: INGRESS_DIR,
    HP_INGRESS_HTTP_PORT: INGRESS_HTTP_PORT,
    HP_NFTABLES_RULESET_PATH: nftablesRulesetPath,
    API_HOST: "127.0.0.1",
    API_PORT,
    API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}`,
    WEB_ORIGIN: `http://127.0.0.1:${WEB_PORT}`,
  };

  /** @type {import("node:child_process").ChildProcess[]} */
  const children = [];
  let shuttingDown = false;

  const shutdownAll = (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`\n[dev:docker] Caught ${signal} — stopping daemons, API, and Web...`);
    for (const child of children) {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    }
    setTimeout(() => {
      for (const child of children) {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }
      process.exit(0);
    }, 2_500).unref();
  };

  process.on("SIGINT", () => shutdownAll("SIGINT"));
  process.on("SIGTERM", () => shutdownAll("SIGTERM"));

  const spawnService = (label, cmd, args, cwd = REPO_ROOT) => {
    const child = spawn(cmd, args, {
      cwd,
      env: sharedEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    pipePrefixed(child.stdout, `[${label}]`, process.stdout);
    pipePrefixed(child.stderr, `[${label}]`, process.stderr);
    child.on("exit", (code, sig) => {
      if (!shuttingDown && code !== 0) {
        console.error(
          `[dev:docker] Process '${label}' exited unexpectedly (code=${String(code)}, signal=${String(sig)})`,
        );
        shutdownAll("SIGTERM");
      }
    });
    children.push(child);
    return child;
  };

  console.log(`[dev:docker] Runtime workspace prepared in ${RUNTIME_DIR}`);
  console.log(`[dev:docker] Shell env helper written to ${ENV_SH_FILE}`);

  spawnService("executor", process.execPath, [executorEntry]);
  spawnService("host-agent", process.execPath, [hostAgentEntry]);

  await Promise.all([waitForFile(EXECUTOR_SOCK), waitForFile(HOST_AGENT_SOCK)]);

  spawnService("api", process.execPath, [apiEntry]);
  spawnService(
    "web",
    process.execPath,
    [nextBin, "dev", "--port", WEB_PORT],
    path.join(REPO_ROOT, "apps/web"),
  );

  console.log(
    `[dev:docker] Stack starting -> Web UI: http://127.0.0.1:${WEB_PORT} | API: http://127.0.0.1:${API_PORT} | Traefik HTTP: :${INGRESS_HTTP_PORT} (Ctrl+C to stop)`,
  );
}

main().catch((err) => {
  console.error("[dev:docker] Startup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
