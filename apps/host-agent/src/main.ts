import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getWorkspaceMetadata } from "@hosting-panel/config";
import type { IpcVerificationKeyring, RuntimeBackend } from "@hosting-panel/contracts";
import { HOST_AGENT_VERSION, LinuxSystemHostAdapter } from "./linux-adapter.js";
import { HostPolicyDeniedError } from "./nftables-baseline.js";
import {
  DEFAULT_HOST_AGENT_SOCKET_PATH,
  HostAgentIpcServer,
  type HostAgentTransportConfig,
} from "./server.js";
import { InMemoryHostSimulatorAdapter } from "./simulator-adapter.js";

export interface BootstrapHostAgentEnv {
  readonly HP_RUNTIME_BACKEND?: string;
  readonly HP_IPC_TRANSPORT?: string;
  readonly HP_HOST_AGENT_SOCKET_PATH?: string;
  readonly HP_HOST_AGENT_SOCKET?: string;
  readonly HP_HOST_AGENT_PIPE?: string;
  readonly HP_IPC_KEY_ID?: string;
  readonly HP_IPC_KEY_FILE?: string;
  readonly HP_IPC_HMAC_SECRET?: string;
  readonly HP_NFTABLES_RULESET_PATH?: string;
  readonly HP_STORAGE_PATH?: string;
}

async function loadIpcKeyringFromEnv(
  env: BootstrapHostAgentEnv,
): Promise<IpcVerificationKeyring> {
  const keyId = (env.HP_IPC_KEY_ID ?? "ipc-v1").trim() || "ipc-v1";
  const keyFile = env.HP_IPC_KEY_FILE?.trim();

  let secret: string;
  if (keyFile) {
    const raw = await readFile(keyFile, "utf8");
    secret = raw.trim();
  } else if (env.HP_IPC_HMAC_SECRET) {
    secret = env.HP_IPC_HMAC_SECRET.trim();
  } else {
    const raw = await readFile("/etc/hosting-panel/ipc.key", "utf8");
    secret = raw.trim();
  }

  if (!secret || Buffer.byteLength(secret, "utf8") < 16) {
    throw new HostPolicyDeniedError("IPC HMAC key material must be at least 16 bytes");
  }

  return {
    [keyId]: {
      keyId,
      algorithm: "hmac-sha256",
      secret,
    },
  };
}

function buildTransportConfigFromEnv(env: BootstrapHostAgentEnv): HostAgentTransportConfig {
  const transport = (env.HP_IPC_TRANSPORT ?? "uds").trim();
  if (transport === "uds") {
    return {
      transport: "uds",
      socketPath:
        env.HP_HOST_AGENT_SOCKET_PATH?.trim() ||
        env.HP_HOST_AGENT_SOCKET?.trim() ||
        DEFAULT_HOST_AGENT_SOCKET_PATH,
    };
  }
  if (transport === "pipe") {
    const pipePath = env.HP_HOST_AGENT_PIPE?.trim() ?? "";
    return {
      transport: "pipe",
      pipePath,
    };
  }
  if (transport === "loopback-test") {
    return {
      transport: "loopback-test",
      host: "127.0.0.1",
      port: 0,
    };
  }

  throw new HostPolicyDeniedError(
    `Unsupported HP_IPC_TRANSPORT '${transport}'; expected uds, pipe, or loopback-test`,
  );
}

export async function createHostAgentDaemonFromEnv(
  env: BootstrapHostAgentEnv = process.env,
): Promise<HostAgentIpcServer> {
  const rawBackend = (env.HP_RUNTIME_BACKEND ?? "linux-systemd").trim();
  if (rawBackend !== "linux-systemd" && rawBackend !== "local-simulator") {
    throw new HostPolicyDeniedError(
      `Unsupported HP_RUNTIME_BACKEND '${rawBackend}' for host-agent daemon`,
    );
  }
  const runtimeBackend: RuntimeBackend = rawBackend;
  const keyring = await loadIpcKeyringFromEnv(env);
  const transportConfig = buildTransportConfigFromEnv(env);

  const adapter =
    runtimeBackend === "local-simulator"
      ? new InMemoryHostSimulatorAdapter({
          nftablesRulesetPath: env.HP_NFTABLES_RULESET_PATH?.trim() || undefined,
        })
      : new LinuxSystemHostAdapter({
          storagePath: env.HP_STORAGE_PATH?.trim() || undefined,
          nftablesRulesetPath: env.HP_NFTABLES_RULESET_PATH?.trim() || undefined,
        });

  return new HostAgentIpcServer({
    adapter,
    keyring,
    runtimeBackend,
    transportConfig,
  });
}

async function runMain(): Promise<void> {
  const metadata = getWorkspaceMetadata("phase-2");
  const server = await createHostAgentDaemonFromEnv(process.env);
  const endpoint = await server.start();

  console.info(
    JSON.stringify({
      event: "host_agent.started",
      specId: metadata.specId,
      phase: metadata.phase,
      version: HOST_AGENT_VERSION,
      transport: endpoint.transport,
      timestamp: new Date().toISOString(),
    }),
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void server
      .stop()
      .then(() => {
        console.info(
          JSON.stringify({
            event: "host_agent.stopped",
            signal,
            timestamp: new Date().toISOString(),
          }),
        );
        process.exit(0);
      })
      .catch(() => {
        process.exit(1);
      });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

const currentFilePath = fileURLToPath(import.meta.url);
const entryArgPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryArgPath === currentFilePath) {
  runMain().catch((err: unknown) => {
    console.error(
      JSON.stringify({
        event: "host_agent.fatal",
        reason: err instanceof Error ? err.message : "Failed to initialize host-agent",
        timestamp: new Date().toISOString(),
      }),
    );
    process.exit(1);
  });
}
