import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getWorkspaceMetadata } from "@hosting-panel/config";
import type { IpcVerificationKey, RuntimeBackend } from "@hosting-panel/contracts";
import {
  DEFAULT_DOCKER_SOCKET_PATH,
  DEFAULT_SECRETS_ROOT_DIR,
  DockerEngineSocketAdapter,
} from "./docker-engine-adapter.js";
import {
  DEFAULT_EXECUTOR_SOCKET_PATH,
  DEFAULT_EXECUTOR_VERSION,
  DockerExecutorIpcServer,
  type IngressCapableDockerExecutor,
  type IpcTransportMode,
} from "./server.js";
import { InMemoryDockerSimulatorAdapter } from "./simulator-adapter.js";
import {
  DEFAULT_INGRESS_HTTP_PORT,
  DEFAULT_INGRESS_ROOT_DIR,
  DEFAULT_TRAEFIK_IMAGE,
  ExecutorCodedError,
  buildPanelDynamicYaml,
  buildTraefikStaticYaml,
  type PanelIngressConfig,
} from "./traefik-config.js";

const PANEL_INGRESS_RETRY_MS = 60_000;

/** Empty HP_PANEL_HOSTNAME ⇒ null (panel ingress disabled). Invalid values are logged and disable it too. */
export function parsePanelIngressConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PanelIngressConfig | null {
  const hostname = env.HP_PANEL_HOSTNAME?.trim() ?? "";
  if (hostname.length === 0) {
    return null;
  }
  const panel: PanelIngressConfig = {
    hostname,
    ipv4: env.HP_PANEL_IPV4?.trim() ?? "",
    acmeEmail: env.HP_ACME_EMAIL?.trim() || null,
    acmeStaging: env.HP_ACME_STAGING?.trim().toLowerCase() === "true",
    upstreamPort: Number(env.HP_PANEL_UPSTREAM_PORT?.trim() || 3000),
  };
  try {
    // Fail here rather than inside ensureIngressProxy, which would also block site ingress.
    buildPanelDynamicYaml(panel);
    buildTraefikStaticYaml(panel);
  } catch (err) {
    console.error(
      JSON.stringify({
        component: "hp-docker-executor",
        status: "panel_ingress_config_invalid",
        code: (err as { code?: string } | null)?.code ?? "VALIDATION_ERROR",
        timestamp: new Date().toISOString(),
      }),
    );
    return null;
  }
  return panel;
}

const DEFAULT_IPC_KEY_FILE = "/etc/hosting-panel/ipc.key";

export async function loadExecutorVerificationKeyringFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Readonly<Record<string, IpcVerificationKey>>> {
  const explicitKeyId = env.HP_IPC_KEY_ID?.trim();
  const primaryKeyId = explicitKeyId && explicitKeyId.length > 0 ? explicitKeyId : "ipc-v1";

  let rawMaterial: string | null = null;
  const inlineEd25519Pem = env.HP_IPC_ED25519_PUBLIC_KEY_PEM?.trim();
  const ed25519File = env.HP_IPC_ED25519_PUBLIC_KEY_FILE?.trim();
  const inlineSecret = (
    env.HP_IPC_KEY ??
    env.HP_IPC_HMAC_SECRET ??
    env.HP_IPC_SECRET
  )?.trim();
  const keyFile = env.HP_IPC_KEY_FILE?.trim();

  if (inlineEd25519Pem) {
    rawMaterial = inlineEd25519Pem;
  } else if (ed25519File) {
    rawMaterial = (await readFile(ed25519File, "utf8")).trim();
  } else if (inlineSecret) {
    rawMaterial = inlineSecret;
  } else {
    const targetFile = keyFile && keyFile.length > 0 ? keyFile : DEFAULT_IPC_KEY_FILE;
    try {
      rawMaterial = (await readFile(targetFile, "utf8")).trim();
    } catch {
      throw new ExecutorCodedError(
        "Failed to load required IPC authentication key material",
        "UNAUTHENTICATED",
      );
    }
  }

  if (!rawMaterial || rawMaterial.length === 0) {
    throw new ExecutorCodedError(
      "Configured IPC authentication key material is empty",
      "UNAUTHENTICATED",
    );
  }

  const buildKey = (keyId: string): IpcVerificationKey => {
    if (rawMaterial.startsWith("-----BEGIN PUBLIC KEY-----")) {
      return {
        keyId,
        algorithm: "ed25519",
        publicKey: rawMaterial,
      };
    }
    return {
      keyId,
      algorithm: "hmac-sha256",
      secret: rawMaterial,
    };
  };

  const keyring: Record<string, IpcVerificationKey> = {
    [primaryKeyId]: buildKey(primaryKeyId),
  };

  if (!explicitKeyId && primaryKeyId !== "default") {
    keyring.default = buildKey("default");
  }

  return Object.freeze(keyring);
}

export async function bootstrapDockerExecutorDaemon(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DockerExecutorIpcServer> {
  const metadata = getWorkspaceMetadata("phase-2");
  const keyring = await loadExecutorVerificationKeyringFromEnv(env);

  const rawBackend = (env.HP_EXECUTOR_BACKEND ?? env.HP_RUNTIME_BACKEND ?? "linux-systemd")
    .trim()
    .toLowerCase();
  const useSimulator = rawBackend === "simulator" || rawBackend === "local-simulator";
  const runtimeBackend: RuntimeBackend = useSimulator ? "local-simulator" : "linux-systemd";

  const secretsRootDir =
    env.HP_SECRETS_ROOT_DIR?.trim() ||
    env.HP_SECRETS_TMPFS_DIR?.trim() ||
    DEFAULT_SECRETS_ROOT_DIR;
  const legacyDynamicDir = env.HP_TRAEFIK_DYNAMIC_DIR?.trim();
  const resolvedLegacyIngressRoot =
    legacyDynamicDir && legacyDynamicDir.length > 0
      ? path.basename(path.resolve(legacyDynamicDir)) === "dynamic"
        ? path.dirname(path.resolve(legacyDynamicDir))
        : path.resolve(legacyDynamicDir)
      : "";
  const ingressRootDir =
    env.HP_INGRESS_ROOT_DIR?.trim() ||
    resolvedLegacyIngressRoot ||
    DEFAULT_INGRESS_ROOT_DIR;
  const traefikImage = env.HP_TRAEFIK_IMAGE?.trim() || DEFAULT_TRAEFIK_IMAGE;
  const rawIngressPort = env.HP_INGRESS_HTTP_PORT ?? env.HP_TRAEFIK_HTTP_PORT;
  const ingressHttpPort = rawIngressPort
    ? Number(rawIngressPort)
    : DEFAULT_INGRESS_HTTP_PORT;
  const rawIngressHttpsPort = env.HP_INGRESS_HTTPS_PORT?.trim();
  const panel = parsePanelIngressConfigFromEnv(env);

  const dockerAdapter = useSimulator
    ? null
    : new DockerEngineSocketAdapter({
        dockerSocketPath: env.HP_DOCKER_SOCKET_PATH?.trim() || DEFAULT_DOCKER_SOCKET_PATH,
        secretsRootDir,
        ingressRootDir,
        traefikImage,
        ingressHttpPort,
        ...(rawIngressHttpsPort ? { ingressHttpsPort: Number(rawIngressHttpsPort) } : {}),
        panel,
      });
  const executor: IngressCapableDockerExecutor =
    dockerAdapter ??
    new InMemoryDockerSimulatorAdapter({
      secretsRootDir,
      ingressRootDir,
      traefikImage,
      ingressHttpPort,
      panel,
    });

  const transport = ((env.HP_IPC_TRANSPORT ?? "uds").trim() as IpcTransportMode);
  const socketPath =
    transport === "loopback-test"
      ? undefined
      : env.HP_EXECUTOR_SOCKET_PATH?.trim() ||
        env.HP_EXECUTOR_SOCKET?.trim() ||
        env.HP_IPC_SOCKET_PATH?.trim() ||
        DEFAULT_EXECUTOR_SOCKET_PATH;

  const server = new DockerExecutorIpcServer({
    executor,
    keyring,
    transport,
    ...(socketPath !== undefined ? { socketPath } : {}),
    runtimeBackend,
    version: DEFAULT_EXECUTOR_VERSION,
  });

  const endpoint = await server.start();
  console.info(
    JSON.stringify({
      component: "hp-docker-executor",
      specId: metadata.specId,
      phase: metadata.phase,
      runtimeBackend,
      transport: endpoint.transport,
      status: "listening",
      startedAt: new Date().toISOString(),
    }),
  );

  if (panel && dockerAdapter) {
    // Never crashes the executor: failures are logged and retried until the proxy is up.
    const ensurePanelIngress = async (): Promise<void> => {
      try {
        await dockerAdapter.ensureIngressProxy();
        console.info(
          JSON.stringify({ component: "hp-docker-executor", status: "panel_ingress_ready" }),
        );
      } catch (err) {
        console.error(
          JSON.stringify({
            component: "hp-docker-executor",
            status: "panel_ingress_failed",
            code: (err as { code?: string } | null)?.code ?? "INTERNAL_ERROR",
            retryInMs: PANEL_INGRESS_RETRY_MS,
            timestamp: new Date().toISOString(),
          }),
        );
        setTimeout(() => void ensurePanelIngress(), PANEL_INGRESS_RETRY_MS).unref();
      }
    };
    await ensurePanelIngress();
  }

  return server;
}

async function runMain(): Promise<void> {
  const server = await bootstrapDockerExecutorDaemon(process.env);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void server
      .stop()
      .then(() => {
        console.info(
          JSON.stringify({
            component: "hp-docker-executor",
            signal,
            status: "stopped",
            stoppedAt: new Date().toISOString(),
          }),
        );
        process.exit(0);
      })
      .catch(() => {
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  runMain().catch((err: unknown) => {
    const code = (err as { code?: string } | null)?.code ?? "INTERNAL_ERROR";
    console.error(
      JSON.stringify({
        component: "hp-docker-executor",
        status: "fatal",
        code,
        timestamp: new Date().toISOString(),
      }),
    );
    process.exit(1);
  });
}
