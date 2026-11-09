import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import http from "node:http";
import type { DockerContainerInspectPayload } from "../src/index.js";

export interface MockDockerContainerRecord {
  id: string;
  name: string;
  image: string;
  cmd?: string[];
  user?: string;
  env: string[];
  labels: Record<string, string>;
  running: boolean;
  status: string;
  restartCount: number;
  hostConfig: NonNullable<DockerContainerInspectPayload["HostConfig"]>;
  networks: Record<string, unknown>;
}

export interface MockDockerDaemon {
  readonly socketPath: string;
  readonly createdNetworks: Array<{
    Name: string;
    Internal?: boolean;
    Driver?: string;
    Labels?: Record<string, string>;
    IPAM?: { Config?: Array<{ Subnet?: string }> };
  }>;
  readonly createdVolumes: string[];
  readonly volumeLabels: Map<string, Record<string, string>>;
  readonly deletedVolumes: string[];
  readonly deletedNetworks: string[];
  readonly networkConnectCalls: Array<{ network: string; container: string; aliases?: string[] }>;
  readonly networkDisconnectCalls: Array<{ network: string; container: string }>;
  /** Connecting one of these containers answers 404. */
  readonly missingContainers: Set<string>;
  /** Connects to these networks answer 404 (removed between list and connect). */
  readonly vanishedNetworks: Set<string>;
  readonly containers: Map<string, MockDockerContainerRecord>;
  readonly requestedPaths: string[];
  /** POST /containers/<ref>/exec calls, by the ref used in the path. */
  readonly execCalls: Array<{ container: string; Cmd: string[] }>;
  /** The next `remaining` container restarts answer 500. */
  readonly failRestarts: { remaining: number };
  close(): Promise<void>;
}

export async function startMockDockerDaemon(options?: {
  readonly rejectVersionedPrefix?: boolean;
  /** Image inspect answers 404 and /images/create answers 200 with this body. */
  readonly pullBody?: string;
  readonly logsBody?: Buffer;
  /** POST /containers/<id>/wait answers this StatusCode (default 0); "hang" never answers. */
  readonly waitStatusCode?: number | "hang";
  /** GET /exec/<id>/json answers this ExitCode (default 0). */
  readonly execExitCode?: number;
}): Promise<MockDockerDaemon> {
  const socketPath = `/tmp/hp-mock-docker-${randomBytes(5).toString("hex")}.sock`;
  const createdNetworks: Array<{
    Name: string;
    Internal?: boolean;
    Driver?: string;
    Labels?: Record<string, string>;
    IPAM?: { Config?: Array<{ Subnet?: string }> };
  }> = [];
  const networkNames = new Set<string>();
  const createdVolumes: string[] = [];
  const volumeLabels = new Map<string, Record<string, string>>();
  const deletedVolumes: string[] = [];
  const deletedNetworks: string[] = [];
  const networkConnectCalls: Array<{ network: string; container: string; aliases?: string[] }> = [];
  const networkDisconnectCalls: Array<{ network: string; container: string }> = [];
  const missingContainers = new Set<string>();
  const vanishedNetworks = new Set<string>();
  const containers = new Map<string, MockDockerContainerRecord>();
  const requestedPaths: string[] = [];
  const execCalls: Array<{ container: string; Cmd: string[] }> = [];
  const failRestarts = { remaining: 0 };
  let seq = 1;

  const findByRef = (ref: string): MockDockerContainerRecord | undefined => {
    const byId = containers.get(ref);
    if (byId) {
      return byId;
    }
    for (const c of containers.values()) {
      if (c.name === ref || c.name === `/${ref}`) {
        return c;
      }
    }
    return undefined;
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const rawUrl = req.url ?? "/";
      requestedPaths.push(rawUrl);
      const bodyStr = Buffer.concat(chunks).toString("utf8");
      const parsedUrl = new URL(rawUrl, "http://docker");

      if (options?.rejectVersionedPrefix && parsedUrl.pathname.startsWith("/v1.45/")) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            message: "client version 1.45 is too new. Maximum supported API version is 1.43",
          }),
        );
        return;
      }

      const routePath = parsedUrl.pathname.replace(/^\/v1\.\d+/, "");
      const method = req.method ?? "GET";

      if (method === "GET" && routePath === "/_ping") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
        return;
      }

      if (method === "POST" && routePath === "/images/create" && options?.pullBody !== undefined) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(options.pullBody);
        return;
      }

      const logsMatch = /^\/containers\/([^/]+)\/logs$/.exec(routePath);
      if (method === "GET" && logsMatch && options?.logsBody) {
        res.writeHead(200, { "Content-Type": "application/vnd.docker.raw-stream" });
        res.end(options.logsBody);
        return;
      }

      if (method === "GET" && logsMatch) {
        res.writeHead(200, { "Content-Type": "application/vnd.docker.raw-stream" });
        res.end();
        return;
      }

      const execCreateMatch = /^\/containers\/([^/]+)\/exec$/.exec(routePath);
      if (method === "POST" && execCreateMatch && execCreateMatch[1]) {
        const container = decodeURIComponent(execCreateMatch[1]);
        if (!findByRef(container)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "No such container" }));
          return;
        }
        execCalls.push({ container, Cmd: (JSON.parse(bodyStr) as { Cmd: string[] }).Cmd });
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Id: `exec_${String(execCalls.length)}` }));
        return;
      }

      const execMatch = /^\/exec\/([^/]+)\/(start|json)$/.exec(routePath);
      if (execMatch && ((method === "POST" && execMatch[2] === "start") || method === "GET")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          execMatch[2] === "start"
            ? undefined
            : JSON.stringify({ Running: false, ExitCode: options?.execExitCode ?? 0 }),
        );
        return;
      }

      const waitMatch = /^\/containers\/([^/]+)\/(wait|kill)$/.exec(routePath);
      if (method === "POST" && waitMatch) {
        if (waitMatch[2] === "kill") {
          res.writeHead(204);
          res.end();
          return;
        }
        if (options?.waitStatusCode === "hang") {
          return; // left open; close() drops it
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ StatusCode: options?.waitStatusCode ?? 0 }));
        return;
      }

      if (method === "GET" && routePath.startsWith("/images/") && routePath.endsWith("/json")) {
        if (options?.pullBody !== undefined) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "No such image" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Id: "sha256:mockimage" }));
        return;
      }

      if (method === "GET" && routePath === "/networks") {
        const rawFilters = parsedUrl.searchParams.get("filters");
        const filterLabels: string[] = rawFilters
          ? ((JSON.parse(rawFilters) as { label?: string[] }).label ?? [])
          : [];
        const matches = createdNetworks.filter((n) =>
          filterLabels.every((expr) => {
            const [k = "", v] = expr.split("=");
            return v === undefined ? k in (n.Labels ?? {}) : n.Labels?.[k] === v;
          }),
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(matches.map((n) => ({ Name: n.Name, Labels: n.Labels ?? {} }))));
        return;
      }

      if (method === "GET" && routePath.startsWith("/networks/")) {
        const netName = decodeURIComponent(routePath.slice("/networks/".length));
        if (networkNames.has(netName)) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ Name: netName }));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "network not found" }));
        }
        return;
      }

      if (method === "POST" && routePath === "/networks/create") {
        const body = JSON.parse(bodyStr) as {
          Name: string;
          Internal?: boolean;
          Driver?: string;
          Labels?: Record<string, string>;
          IPAM?: { Config?: Array<{ Subnet?: string }> };
        };
        networkNames.add(body.Name);
        createdNetworks.push(body);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Id: `net_${body.Name}` }));
        return;
      }

      const netConnectMatch = /^\/networks\/([^/]+)\/(connect|disconnect)$/.exec(routePath);
      if (method === "POST" && netConnectMatch && netConnectMatch[1] && netConnectMatch[2]) {
        const netName = decodeURIComponent(netConnectMatch[1]);
        const action = netConnectMatch[2];
        const body = JSON.parse(bodyStr) as {
          Container: string;
          EndpointConfig?: { Aliases?: string[] };
        };
        const target = findByRef(body.Container);
        if (action === "connect") {
          networkConnectCalls.push({
            network: netName,
            container: body.Container,
            ...(body.EndpointConfig?.Aliases ? { aliases: body.EndpointConfig.Aliases } : {}),
          });
          if (missingContainers.has(body.Container)) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ message: `No such container: ${body.Container}` }));
            return;
          }
          if (vanishedNetworks.has(netName)) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ message: `network ${netName} not found` }));
            return;
          }
          if (target) {
            target.networks[netName] = body.EndpointConfig ?? {};
          }
        } else {
          networkDisconnectCalls.push({ network: netName, container: body.Container });
          if (target) {
            delete target.networks[netName];
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({}));
        return;
      }

      if (method === "POST" && routePath === "/volumes/create") {
        const body = JSON.parse(bodyStr) as { Name: string; Labels?: Record<string, string> };
        createdVolumes.push(body.Name);
        volumeLabels.set(body.Name, body.Labels ?? {});
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Name: body.Name }));
        return;
      }

      if (method === "GET" && routePath === "/volumes") {
        const rawFilters = parsedUrl.searchParams.get("filters");
        const filterLabels: string[] = rawFilters
          ? ((JSON.parse(rawFilters) as { label?: string[] }).label ?? [])
          : [];
        const Volumes = [...volumeLabels]
          .filter(([, labels]) =>
            filterLabels.every((expr) => {
              const [k = "", v] = expr.split("=");
              return v === undefined ? k in labels : labels[k] === v;
            }),
          )
          .map(([Name, Labels]) => ({ Name, Labels }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Volumes, Warnings: null }));
        return;
      }

      const resourceDeleteMatch = /^\/(volumes|networks)\/([^/]+)$/.exec(routePath);
      if (method === "DELETE" && resourceDeleteMatch && resourceDeleteMatch[2]) {
        const name = decodeURIComponent(resourceDeleteMatch[2]);
        const isVolume = resourceDeleteMatch[1] === "volumes";
        const exists = isVolume ? volumeLabels.has(name) : networkNames.has(name);
        if (exists) {
          (isVolume ? deletedVolumes : deletedNetworks).push(name);
          if (isVolume) {
            volumeLabels.delete(name);
          } else {
            networkNames.delete(name);
          }
        }
        res.writeHead(exists ? 204 : 404, { "Content-Type": "application/json" });
        res.end(exists ? undefined : JSON.stringify({ message: "not found" }));
        return;
      }

      if (method === "GET" && routePath === "/containers/json") {
        const rawFilters = parsedUrl.searchParams.get("filters");
        const filterLabels: string[] = rawFilters
          ? ((JSON.parse(rawFilters) as { label?: string[] }).label ?? [])
          : [];

        const matches = [...containers.values()]
          .filter((c) =>
            filterLabels.every((expr) => {
              const eq = expr.indexOf("=");
              if (eq < 0) {
                return expr in c.labels;
              }
              const k = expr.slice(0, eq);
              const v = expr.slice(eq + 1);
              return c.labels[k] === v;
            }),
          )
          .map((c) => ({
            Id: c.id,
            Names: [`/${c.name}`],
            Labels: c.labels,
          }));

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(matches));
        return;
      }

      if (method === "POST" && routePath === "/containers/create") {
        const name = parsedUrl.searchParams.get("name") ?? `ctr_${String(seq)}`;
        const payload = JSON.parse(bodyStr) as {
          Image: string;
          Cmd?: string[];
          User?: string;
          Env?: string[];
          Labels?: Record<string, string>;
          HostConfig: NonNullable<DockerContainerInspectPayload["HostConfig"]>;
          NetworkingConfig?: { EndpointsConfig?: Record<string, unknown> };
        };

        const id = `${String(seq).padStart(8, "0")}abcdef0123456789abcdef0123456789abcdef0123456789abcdef01`;
        seq += 1;
        containers.set(id, {
          id,
          name,
          image: payload.Image,
          ...(payload.Cmd ? { cmd: payload.Cmd } : {}),
          ...(payload.User ? { user: payload.User } : {}),
          env: [...(payload.Env ?? [])],
          labels: { ...(payload.Labels ?? {}) },
          running: false,
          status: "created",
          restartCount: 0,
          hostConfig: payload.HostConfig,
          networks: { ...(payload.NetworkingConfig?.EndpointsConfig ?? {}) },
        });
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Id: id, Warnings: [] }));
        return;
      }

      const inspectMatch = /^\/containers\/([^/]+)\/json$/.exec(routePath);
      if (method === "GET" && inspectMatch && inspectMatch[1]) {
        const ref = decodeURIComponent(inspectMatch[1]);
        const target = findByRef(ref);
        if (!target) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "No such container" }));
          return;
        }
        const inspectPayload: DockerContainerInspectPayload = {
          Id: target.id,
          Name: `/${target.name}`,
          RestartCount: target.restartCount,
          State: {
            Status: target.status,
            Running: target.running,
            Restarting: false,
            OOMKilled: false,
            Dead: false,
          },
          Config: {
            Image: target.image,
            ...(target.cmd ? { Cmd: target.cmd } : {}),
            ...(target.user ? { User: target.user } : {}),
            Env: target.env,
            Labels: target.labels,
          },
          HostConfig: target.hostConfig,
          NetworkSettings: {
            Networks: target.networks,
          },
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(inspectPayload));
        return;
      }

      const lifecycleMatch = /^\/containers\/([^/]+)\/(start|stop|restart)$/.exec(routePath);
      if (method === "POST" && lifecycleMatch && lifecycleMatch[1] && lifecycleMatch[2]) {
        const ref = decodeURIComponent(lifecycleMatch[1]);
        const action = lifecycleMatch[2];
        const target = findByRef(ref);
        if (!target) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "No such container" }));
          return;
        }
        if (action === "restart" && failRestarts.remaining > 0) {
          failRestarts.remaining -= 1;
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "restart failed" }));
          return;
        }
        if (action === "start" || action === "restart") {
          target.running = true;
          target.status = "running";
        } else {
          target.running = false;
          target.status = "exited";
        }
        res.writeHead(204);
        res.end();
        return;
      }

      const deleteMatch = /^\/containers\/([^/]+)$/.exec(routePath);
      if (method === "DELETE" && deleteMatch && deleteMatch[1]) {
        const ref = decodeURIComponent(deleteMatch[1]);
        const target = findByRef(ref);
        if (target) {
          containers.delete(target.id);
        }
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: `Unhandled mock route: ${method} ${routePath}` }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  return {
    socketPath,
    createdNetworks,
    createdVolumes,
    volumeLabels,
    deletedVolumes,
    deletedNetworks,
    networkConnectCalls,
    networkDisconnectCalls,
    missingContainers,
    vanishedNetworks,
    containers,
    requestedPaths,
    execCalls,
    failRestarts,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(socketPath, { force: true });
    },
  };
}
