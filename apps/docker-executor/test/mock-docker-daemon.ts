import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import http from "node:http";
import type { Duplex } from "node:stream";
import type { DockerContainerInspectPayload } from "../src/index.js";

export interface MockDockerContainerRecord {
  id: string;
  name: string;
  image: string;
  entrypoint?: string[];
  cmd?: string[];
  user?: string;
  env: string[];
  labels: Record<string, string>;
  exposedPorts?: Record<string, unknown>;
  running: boolean;
  status: string;
  restartCount: number;
  startedAt?: string;
  dead?: boolean;
  execIds?: string[];
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
  /** Look-ups (GET) and connects of these networks answer 500. */
  readonly brokenNetworks: { readonly lookup: Set<string>; readonly connect: Set<string> };
  readonly containers: Map<string, MockDockerContainerRecord>;
  readonly requestedPaths: string[];
  /** POST /containers/<ref>/exec calls, by the ref used in the path. */
  readonly execCalls: Array<{ container: string; Cmd: string[] }>;
  /** Full exec create bodies, in call order. */
  readonly execBodies: Array<Record<string, unknown>>;
  /** With `execUpgrade`: each hijacked exec stream, by exec id. */
  readonly execStreams: Array<{ execId: string; socket: Duplex }>;
  /** While `until` is set, container restarts wait for it before answering. */
  readonly holdRestarts: { until: Promise<void> | null };
  /** The next `remaining` container restarts answer 500 (or drop the socket with `drop`). */
  readonly failRestarts: { remaining: number; drop?: boolean };
  /** The next `remaining` container creates answer 500. */
  readonly failCreates: { remaining: number };
  /** The next `remaining` container starts answer 500. */
  readonly failStarts: { remaining: number };
  /** The next `remaining` container inspects answer 500. */
  readonly failInspects: { remaining: number };
  /** With `execUpgrade`: the next `remaining` exec starts answer 500 instead of the stream. */
  readonly failExecStarts: { remaining: number };
  /** With `execScript`: ends the stream of an exec that stays open, as if its process ended (or was killed). */
  endExec(execId: string, exitCode?: number | null): void;
  /** The next `remaining` container deletes answer 409 (optionally removing from containers so inspect 404s). */
  readonly deleteConflicts: { remaining: number; removeFromMap?: boolean };
  /** The next `remaining` container deletes answer 500 and remove nothing. */
  readonly failDeletes: { remaining: number };
  close(): Promise<void>;
}

/** What one exec does, chosen by `execScript` when the exec is created. */
export interface MockExecPlan {
  /** Written when the exec starts, in this order: [1 = standard output | 2 = standard error, bytes]. */
  readonly frames?: ReadonlyArray<readonly [1 | 2, string | Buffer]>;
  /** Raw bytes written after the frames, as they are (a broken or unframed stream). */
  readonly raw?: Buffer;
  /** What GET /exec/<id>/json answers once the exec ended (default: the daemon's `execExitCode`); null = not told. */
  readonly exitCode?: number | null;
  /** The `Pid` GET /exec/<id>/json answers (0: the engine never started the process); not set = no `Pid`. */
  readonly pid?: number;
  /** Once the exec ended, GET /exec/<id>/json answers 404: the engine dropped it (its container stopped). */
  readonly forgotten?: boolean;
  /** The stream stays open and the exec stays running until `endExec`. */
  readonly stayOpen?: boolean;
  /** The exec start answers 500 instead of the stream. */
  readonly failStart?: boolean;
  /** The stream is cut without an end once the frames are written. */
  readonly cut?: boolean;
}

/** One frame of Docker's multiplexed stream. */
export function mockDockerFrame(stream: 1 | 2, data: string | Buffer): Buffer {
  const payload = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

export async function startMockDockerDaemon(options?: {
  readonly rejectVersionedPrefix?: boolean;
  /** Image inspect answers 404 and /images/create answers 200 with this body. */
  readonly pullBody?: string;
  readonly logsBody?: Buffer;
  /** Like logsBody, but evaluated per request (logs that appear later). */
  readonly logsBodyFn?: (ref: string) => Buffer;
  /** POST /containers/<id>/wait answers this StatusCode (default 0); "hang" never answers. */
  readonly waitStatusCode?: number | "hang";
  /** GET /exec/<id>/json answers this ExitCode (default 0). */
  readonly execExitCode?: number;
  /** GET /exec/<id>/json always answers Running: true. */
  readonly execStaysRunning?: boolean;
  /** Optional hook invoked right as each mock request arrives (after parsing method and routePath). */
  readonly onRequest?: (method: string, routePath: string) => void;
  /** Exec start upgrades to a raw stream; a stream whose client half-closes is ended. */
  readonly execUpgrade?: boolean;
  /**
   * With `execUpgrade`: asked at each exec create. An exec that gets a plan follows it (its stream does not end when
   * the client half-closes); one that gets none behaves as before.
   */
  readonly execScript?: (call: {
    readonly execId: string;
    readonly container: string;
    readonly Cmd: string[];
    readonly Env: string[];
  }) => MockExecPlan | undefined;
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
  const brokenNetworks = { lookup: new Set<string>(), connect: new Set<string>() };
  const containers = new Map<string, MockDockerContainerRecord>();
  const requestedPaths: string[] = [];
  const execCalls: Array<{ container: string; Cmd: string[] }> = [];
  const execBodies: Array<Record<string, unknown>> = [];
  const execStreams: Array<{ execId: string; socket: Duplex }> = [];
  const execPlans = new Map<string, { plan: MockExecPlan; ended: boolean; exitCode: number | null; socket: Duplex | null }>();
  const holdRestarts: { until: Promise<void> | null } = { until: null };
  const failRestarts: { remaining: number; drop?: boolean } = { remaining: 0 };
  const failCreates = { remaining: 0 };
  const failStarts = { remaining: 0 };
  const failInspects = { remaining: 0 };
  const failExecStarts = { remaining: 0 };
  const deleteConflicts: { remaining: number; removeFromMap?: boolean } = { remaining: 0 };
  const failDeletes = { remaining: 0 };
  const pulledImages = new Set<string>();
  let seq = 1;

  /** Application stack objects (hp_app*) get the Engine's container addresses and in-use refusals; other names keep the old answers. */
  const isStackObject = (name: string) => name.startsWith("hp_app");
  const inUse = (name: string, isVolume: boolean) =>
    isStackObject(name) &&
    [...containers.values()].some((c) =>
      isVolume
        ? ((c.hostConfig as { Mounts?: Array<{ Source?: string }> }).Mounts ?? []).some((m) => m.Source === name)
        : name in c.networks,
    );

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
      options?.onRequest?.(method, routePath);

      if (method === "GET" && routePath === "/_ping") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
        return;
      }

      if (method === "GET" && routePath === "/info") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ NCPU: 16 }));
        return;
      }

      if (method === "POST" && routePath === "/images/create" && options?.pullBody !== undefined) {
        const fromImage = parsedUrl.searchParams.get("fromImage");
        if (fromImage && !/"error"\s*:/.test(options.pullBody)) {
          pulledImages.add(fromImage);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(options.pullBody);
        return;
      }

      const logsMatch = /^\/containers\/([^/]+)\/logs$/.exec(routePath);
      if (method === "GET" && logsMatch && (options?.logsBody || options?.logsBodyFn)) {
        res.writeHead(200, { "Content-Type": "application/vnd.docker.raw-stream" });
        res.end(options.logsBodyFn ? options.logsBodyFn(decodeURIComponent(logsMatch[1] ?? "")) : options.logsBody);
        return;
      }

      if (method === "GET" && logsMatch) {
        if (!findByRef(decodeURIComponent(logsMatch[1] ?? ""))) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "No such container" }));
          return;
        }
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
        execBodies.push(JSON.parse(bodyStr) as Record<string, unknown>);
        const createdExecId = `exec_${String(execCalls.length)}`;
        const created = JSON.parse(bodyStr) as { Cmd: string[]; Env?: string[] };
        const plan = options?.execScript?.({ execId: createdExecId, container, Cmd: created.Cmd, Env: created.Env ?? [] });
        if (plan !== undefined) {
          const exitCode = plan.exitCode === undefined ? (options?.execExitCode ?? 0) : plan.exitCode;
          execPlans.set(createdExecId, { plan, ended: false, exitCode, socket: null });
        }
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Id: createdExecId }));
        return;
      }

      const execMatch = /^\/exec\/([^/]+)\/(start|json)$/.exec(routePath);
      if (execMatch && ((method === "POST" && execMatch[2] === "start") || method === "GET")) {
        const planned = execMatch[2] === "json" ? execPlans.get(decodeURIComponent(execMatch[1] ?? "")) : undefined;
        if (planned !== undefined) {
          if (planned.ended && planned.plan.forgotten === true) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ message: "No such exec instance" }));
            return;
          }
          const pid = planned.plan.pid === undefined ? {} : { Pid: planned.plan.pid };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(planned.ended ? { Running: false, ExitCode: planned.exitCode, ...pid } : { Running: true, ExitCode: null, ...pid }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          execMatch[2] === "start"
            ? undefined
            : JSON.stringify(
                options?.execStaysRunning
                  ? { Running: true, ExitCode: null }
                  : { Running: false, ExitCode: options?.execExitCode ?? 0 },
              ),
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
        const imageName = decodeURIComponent(
          routePath.slice("/images/".length, -"/json".length),
        );
        if (options?.pullBody !== undefined && !pulledImages.has(imageName)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "No such image" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Id: "sha256:mockimage", ...(imageName.includes("@sha256:") ? { RepoDigests: [imageName] } : {}) }));
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
        res.end(
          JSON.stringify(
            matches.map((n) => ({ Name: n.Name, Labels: n.Labels ?? {}, Internal: n.Internal ?? false, Driver: "bridge", Options: {} })),
          ),
        );
        return;
      }

      if (method === "GET" && routePath.startsWith("/networks/")) {
        const netName = decodeURIComponent(routePath.slice("/networks/".length));
        if (brokenNetworks.lookup.has(netName)) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "engine broke" }));
        } else if (networkNames.has(netName)) {
          const record = createdNetworks.findLast((n) => n.Name === netName);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ Name: netName, Labels: record?.Labels ?? {}, Internal: record?.Internal ?? false, Driver: "bridge", Options: {} }),
          );
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
          if (brokenNetworks.connect.has(netName)) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ message: `engine broke on ${netName}` }));
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
          .map(([Name, Labels]) => ({ Name, Labels, Driver: "local", Options: {} }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Volumes, Warnings: null }));
        return;
      }

      const volumeInspectMatch = /^\/volumes\/([^/]+)$/.exec(routePath);
      if (method === "GET" && volumeInspectMatch && volumeInspectMatch[1]) {
        const name = decodeURIComponent(volumeInspectMatch[1]);
        const labels = volumeLabels.get(name);
        if (!labels) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "no such volume" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Name: name, Labels: labels, Driver: "local", Options: {} }));
        return;
      }

      const resourceDeleteMatch = /^\/(volumes|networks)\/([^/]+)$/.exec(routePath);
      if (method === "DELETE" && resourceDeleteMatch && resourceDeleteMatch[2]) {
        const name = decodeURIComponent(resourceDeleteMatch[2]);
        const isVolume = resourceDeleteMatch[1] === "volumes";
        const exists = isVolume ? volumeLabels.has(name) : networkNames.has(name);
        if (exists && inUse(name, isVolume)) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: isVolume ? "volume is in use" : "network has active endpoints" }));
          return;
        }
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

      if (method === "POST" && routePath === "/containers/create" && failCreates.remaining > 0) {
        failCreates.remaining -= 1;
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "create failed" }));
        return;
      }

      if (method === "POST" && routePath === "/containers/create") {
        const name = parsedUrl.searchParams.get("name") ?? `ctr_${String(seq)}`;
        const payload = JSON.parse(bodyStr) as {
          Image: string;
          Entrypoint?: string[];
          Cmd?: string[];
          User?: string;
          Env?: string[];
          Labels?: Record<string, string>;
          ExposedPorts?: Record<string, unknown>;
          HostConfig: NonNullable<DockerContainerInspectPayload["HostConfig"]>;
          NetworkingConfig?: { EndpointsConfig?: Record<string, unknown> };
        };

        const id = `${String(seq).padStart(8, "0")}abcdef0123456789abcdef0123456789abcdef0123456789abcdef01`;
        seq += 1;
        containers.set(id, {
          id,
          name,
          image: payload.Image,
          ...(payload.Entrypoint ? { entrypoint: payload.Entrypoint } : {}),
          ...(payload.Cmd ? { cmd: payload.Cmd } : {}),
          ...(payload.User ? { user: payload.User } : {}),
          env: [...(payload.Env ?? [])],
          labels: { ...(payload.Labels ?? {}) },
          ...(payload.ExposedPorts ? { exposedPorts: payload.ExposedPorts } : {}),
          running: false,
          status: "created",
          restartCount: 0,
          hostConfig: payload.HostConfig,
          networks: Object.fromEntries(
            Object.entries(payload.NetworkingConfig?.EndpointsConfig ?? {}).map(([net, endpoint]) => [
              net,
              isStackObject(net) ? { ...(endpoint as object), IPAddress: "127.0.0.1" } : endpoint,
            ]),
          ),
        });
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Id: id, Warnings: [] }));
        return;
      }

      const inspectMatch = /^\/containers\/([^/]+)\/json$/.exec(routePath);
      if (method === "GET" && inspectMatch && inspectMatch[1]) {
        const ref = decodeURIComponent(inspectMatch[1]);
        const target = findByRef(ref);
        if (failInspects.remaining > 0) {
          failInspects.remaining -= 1;
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "boom" }));
          return;
        }
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
            Dead: target.dead === true,
            ...(target.startedAt !== undefined ? { StartedAt: target.startedAt } : {}),
          },
          ...(target.execIds ? { ExecIDs: target.execIds } : {}),
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
          if (failRestarts.drop) {
            req.socket.destroy();
            return;
          }
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "restart failed" }));
          return;
        }
        if (action === "restart" && holdRestarts.until) {
          void holdRestarts.until.then(() => {
            res.writeHead(204);
            res.end();
          });
          return;
        }
        if (action === "start" && failStarts.remaining > 0) {
          failStarts.remaining -= 1;
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "start failed" }));
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
        if (deleteConflicts.remaining > 0) {
          deleteConflicts.remaining -= 1;
          if (deleteConflicts.removeFromMap && target) {
            containers.delete(target.id);
          }
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "removal of container is already in progress" }));
          return;
        }
        if (failDeletes.remaining > 0) {
          failDeletes.remaining -= 1;
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "mock delete failure" }));
          return;
        }
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

  if (options?.execUpgrade) {
    server.on("upgrade", (req: http.IncomingMessage, socket: Duplex) => {
      const execId = /\/exec\/([^/]+)\/start$/.exec(req.url ?? "")?.[1] ?? "";
      socket.on("error", () => undefined);
      if (failExecStarts.remaining > 0) {
        failExecStarts.remaining -= 1;
        socket.end("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      const planned = execPlans.get(decodeURIComponent(execId));
      if (planned !== undefined) {
        if (planned.plan.failStart === true) {
          planned.ended = true;
          socket.end("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
          return;
        }
        socket.resume();
        socket.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
        for (const [stream, data] of planned.plan.frames ?? []) socket.write(mockDockerFrame(stream, data));
        if (planned.plan.raw !== undefined) socket.write(planned.plan.raw);
        execStreams.push({ execId: decodeURIComponent(execId), socket });
        if (planned.plan.cut === true) {
          // Let the frames leave before the stream is cut without an end.
          setTimeout(() => socket.destroy(), 20);
        } else if (planned.plan.stayOpen === true) {
          planned.socket = socket;
        } else {
          planned.ended = true;
          socket.end();
        }
        return;
      }
      socket.on("end", () => socket.end());
      socket.resume();
      socket.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
      execStreams.push({ execId: decodeURIComponent(execId), socket });
    });
  }

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
    brokenNetworks,
    containers,
    requestedPaths,
    execCalls,
    execBodies,
    execStreams,
    holdRestarts,
    failRestarts,
    failCreates,
    failStarts,
    failInspects,
    failExecStarts,
    endExec(execId: string, exitCode?: number | null) {
      const planned = execPlans.get(execId);
      if (planned === undefined || planned.ended) return;
      planned.ended = true;
      if (exitCode !== undefined) planned.exitCode = exitCode;
      planned.socket?.end();
    },
    deleteConflicts,
    failDeletes,
    async close() {
      for (const s of execStreams) s.socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(socketPath, { force: true });
    },
  };
}
