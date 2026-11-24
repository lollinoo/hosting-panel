import type { AppStackDockerRequest } from "../../src/app-stacks/index.js";

type Labels = Record<string, string>;

export interface FakeImage {
  repoDigests: string[];
}
export interface FakeNetwork {
  Id: string;
  Name: string;
  Driver: string;
  Internal: boolean;
  Labels: Labels;
  Options: Record<string, string>;
  index: number;
  /** container names */
  members: Set<string>;
}
export interface FakeVolume {
  Name: string;
  Driver: string;
  Labels: Labels;
  Options: Record<string, string> | null;
}
export interface FakeContainer {
  Id: string;
  Name: string;
  Image: string;
  Labels: Labels;
  /** Config.Env of an inspect: the create body's Env. */
  Env: string[];
  body: unknown;
  State: {
    Status: string;
    Running: boolean;
    Restarting: boolean;
    ExitCode: number;
    OOMKilled: boolean;
    StartedAt: string;
  };
  RestartCount: number;
  index: number;
  /** network name -> IPAddress */
  networks: Map<string, string>;
  /** volume names */
  mounts: string[];
  /** Raw frame payloads of GET /logs, newest last ("<timestamp> <text>\n"; no "\n" = a frame Docker split). */
  logs: Array<{ stream: "stdout" | "stderr"; payload: string }>;
}

export interface AppStackFakeEngine {
  readonly request: AppStackDockerRequest;
  /** "METHOD path" of every request, bodies excluded. */
  readonly log: string[];
  /** "METHOD path" -> bodies sent. */
  readonly bodies: Map<string, unknown[]>;
  readonly images: Map<string, FakeImage>;
  /** Refs a pull succeeds for (RepoDigests = [ref]); any other pull answers 200 with an "error" line. */
  readonly pullable: Set<string>;
  /** GET /distribution/<reference>/json: reference -> the body answered with 200; any other reference answers 404. */
  readonly registry: Map<string, unknown>;
  readonly networks: Map<string, FakeNetwork>;
  readonly volumes: Map<string, FakeVolume>;
  /** By container name. */
  readonly containers: Map<string, FakeContainer>;
  /** GET /info. */
  readonly info: { NCPU: number };
  /** The next request whose "METHOD path" matches answers this status without effect. */
  failNext(match: RegExp, status: number, body?: string): void;
  /** The next matching request waits until released. */
  hold(match: RegExp): { release(): void };
}

const reply = (statusCode: number, body?: unknown) => ({
  statusCode,
  body: Buffer.from(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)),
});

function labelFilter(url: URL): (labels: Labels) => boolean {
  const raw = url.searchParams.get("filters");
  const wanted = raw === null ? [] : ((JSON.parse(raw) as { label?: string[] }).label ?? []);
  return (labels) =>
    wanted.every((entry) => {
      const eq = entry.indexOf("=");
      return eq < 0 ? entry in labels : labels[entry.slice(0, eq)] === entry.slice(eq + 1);
    });
}

export function createAppStackFakeEngine(): AppStackFakeEngine {
  const log: string[] = [];
  const bodies = new Map<string, unknown[]>();
  const images = new Map<string, FakeImage>();
  const pullable = new Set<string>();
  const registry = new Map<string, unknown>();
  const networks = new Map<string, FakeNetwork>();
  const volumes = new Map<string, FakeVolume>();
  const containers = new Map<string, FakeContainer>();
  const info = { NCPU: 16 };
  const fails: Array<{ match: RegExp; status: number; body?: string }> = [];
  const holds: Array<{ match: RegExp; released: Promise<void> }> = [];
  let counter = 0;

  const findNetwork = (ref: string) => networks.get(ref) ?? [...networks.values()].find((n) => n.Id === ref);
  const findContainer = (ref: string) => containers.get(ref) ?? [...containers.values()].find((c) => c.Id === ref);
  const connect = (network: FakeNetwork, container: FakeContainer) => {
    network.members.add(container.Name);
    container.networks.set(network.Name, `10.${network.index}.0.${container.index}`);
  };
  const networkView = (n: FakeNetwork) => ({ Id: n.Id, Name: n.Name, Driver: n.Driver, Internal: n.Internal, Labels: n.Labels, Options: n.Options });
  const volumeView = (v: FakeVolume) => ({ Name: v.Name, Driver: v.Driver, Labels: v.Labels, Options: v.Options, Scope: "local" });

  function route(method: string, url: URL, body: unknown) {
    const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
    const [kind, ref = "", action] = parts;
    const input = (body ?? {}) as Record<string, unknown>;

    if (kind === "info" && method === "GET") return reply(200, info);

    if (kind === "distribution" && method === "GET" && action === "json" && parts.length === 3) {
      return registry.has(ref) ? reply(200, registry.get(ref)) : reply(404, { message: "manifest unknown" });
    }

    if (kind === "images") {
      if (method === "GET" && action === "json") {
        const image = images.get(ref);
        return image ? reply(200, { Id: "sha256:fake", RepoDigests: image.repoDigests }) : reply(404, { message: "No such image" });
      }
      if (method === "POST" && ref === "create") {
        const image = url.searchParams.get("fromImage") ?? "";
        if (!pullable.has(image)) {
          return reply(200, '{"status":"Pulling"}\n{"errorDetail":{"message":"manifest unknown"},"error":"manifest unknown"}\n');
        }
        images.set(image, { repoDigests: [image] });
        return reply(200, '{"status":"Pulling"}\n{"status":"Downloaded newer image"}\n');
      }
    }

    if (kind === "networks") {
      if (method === "GET" && parts.length === 1) {
        const matches = labelFilter(url);
        return reply(200, [...networks.values()].filter((n) => matches(n.Labels)).map(networkView));
      }
      if (method === "POST" && ref === "create") {
        const name = String(input.Name);
        if (networks.has(name)) return reply(409, { message: `network with name ${name} already exists` });
        counter += 1;
        networks.set(name, {
          Id: `net${counter}`,
          Name: name,
          Driver: String(input.Driver ?? "bridge"),
          Internal: input.Internal === true,
          Labels: { ...((input.Labels as Labels | undefined) ?? {}) },
          Options: { ...((input.Options as Record<string, string> | undefined) ?? {}) },
          index: counter,
          members: new Set(),
        });
        return reply(201, { Id: `net${counter}` });
      }
      const network = findNetwork(ref);
      if (!network) return reply(404, { message: `network ${ref} not found` });
      if (method === "GET" && action === undefined) return reply(200, networkView(network));
      if (method === "DELETE" && action === undefined) {
        if (network.members.size > 0) return reply(409, { message: `network ${network.Name} has active endpoints` });
        networks.delete(network.Name);
        return reply(204);
      }
      const container = findContainer(String(input.Container));
      if (method === "POST" && (action === "connect" || action === "disconnect")) {
        if (!container) return reply(404, { message: "No such container" });
        if (action === "disconnect") {
          network.members.delete(container.Name);
          container.networks.delete(network.Name);
          return reply(200);
        }
        if (network.members.has(container.Name)) {
          return reply(403, { message: `endpoint with name ${container.Name} already exists in network ${network.Name}` });
        }
        connect(network, container);
        return reply(200);
      }
    }

    if (kind === "volumes") {
      if (method === "GET" && parts.length === 1) {
        const matches = labelFilter(url);
        return reply(200, { Volumes: [...volumes.values()].filter((v) => matches(v.Labels)).map(volumeView), Warnings: null });
      }
      if (method === "POST" && ref === "create") {
        const name = String(input.Name);
        const existing = volumes.get(name);
        if (existing) return reply(200, volumeView(existing));
        const volume = { Name: name, Driver: String(input.Driver ?? "local"), Labels: { ...((input.Labels as Labels | undefined) ?? {}) }, Options: null };
        volumes.set(name, volume);
        return reply(201, volumeView(volume));
      }
      const volume = volumes.get(ref);
      if (!volume) return reply(404, { message: "no such volume" });
      if (method === "GET") return reply(200, volumeView(volume));
      if (method === "DELETE") {
        if ([...containers.values()].some((c) => c.mounts.includes(volume.Name))) return reply(409, { message: "volume is in use" });
        volumes.delete(volume.Name);
        return reply(204);
      }
    }

    if (kind === "containers") {
      if (method === "GET" && ref === "json") {
        const matches = labelFilter(url);
        return reply(
          200,
          [...containers.values()]
            .filter((c) => matches(c.Labels))
            .map((c) => ({ Id: c.Id, Names: [`/${c.Name}`], Image: c.Image, Labels: c.Labels, State: c.State.Status })),
        );
      }
      if (method === "POST" && ref === "create") {
        const name = url.searchParams.get("name") ?? "";
        if (containers.has(name)) return reply(409, { message: `Conflict. The container name "/${name}" is already in use` });
        if (!images.has(String(input.Image))) return reply(404, { message: "No such image" });
        const host = (input.HostConfig ?? {}) as { NetworkMode?: string; Mounts?: Array<{ Source: string }> };
        const endpoints = Object.keys(
          ((input.NetworkingConfig as { EndpointsConfig?: Record<string, unknown> } | undefined)?.EndpointsConfig) ?? {},
        );
        const joined = [...new Set([...(host.NetworkMode ? [host.NetworkMode] : []), ...endpoints])];
        const missing = joined.find((n) => !findNetwork(n));
        if (missing !== undefined) return reply(404, { message: `network ${missing} not found` });
        counter += 1;
        const container: FakeContainer = {
          Id: `ctr${counter}`,
          Name: name,
          Image: String(input.Image),
          Labels: { ...((input.Labels as Labels | undefined) ?? {}) },
          Env: [...((input.Env as string[] | undefined) ?? [])],
          body,
          State: { Status: "created", Running: false, Restarting: false, ExitCode: 0, OOMKilled: false, StartedAt: "0001-01-01T00:00:00Z" },
          RestartCount: 0,
          index: counter,
          networks: new Map(),
          mounts: (host.Mounts ?? []).map((m) => m.Source),
          logs: [],
        };
        containers.set(name, container);
        for (const n of joined) connect(findNetwork(n) as FakeNetwork, container);
        return reply(201, { Id: container.Id, Warnings: [] });
      }
      const container = findContainer(ref);
      if (!container) return reply(404, { message: `No such container: ${ref}` });
      if (method === "GET" && action === "json") {
        return reply(200, {
          Id: container.Id,
          Name: `/${container.Name}`,
          Config: { Image: container.Image, Labels: container.Labels, Env: container.Env },
          State: container.State,
          RestartCount: container.RestartCount,
          NetworkSettings: {
            Networks: Object.fromEntries([...container.networks].map(([n, ip]) => [n, { IPAddress: ip }])),
          },
        });
      }
      if (method === "GET" && action === "logs") {
        const tail = Number(url.searchParams.get("tail") ?? container.logs.length);
        return {
          statusCode: 200,
          body: Buffer.concat(
            container.logs.slice(-tail).flatMap(({ stream, payload }) => {
              const header = Buffer.alloc(8);
              header[0] = stream === "stderr" ? 2 : 1;
              header.writeUInt32BE(Buffer.byteLength(payload), 4);
              return [header, Buffer.from(payload)];
            }),
          ),
        };
      }
      const run = () => {
        container.State = { ...container.State, Status: "running", Running: true, Restarting: false, StartedAt: new Date().toISOString() };
      };
      if (method === "POST" && action === "start") {
        if (container.State.Running) return reply(304);
        run();
        return reply(204);
      }
      if (method === "POST" && action === "stop") {
        if (!container.State.Running) return reply(304);
        container.State = { ...container.State, Status: "exited", Running: false, Restarting: false, ExitCode: 0 };
        return reply(204);
      }
      if (method === "POST" && action === "restart") {
        run();
        return reply(204);
      }
      if (method === "DELETE" && action === undefined) {
        for (const n of container.networks.keys()) networks.get(n)?.members.delete(container.Name);
        containers.delete(container.Name);
        return reply(204);
      }
    }

    return reply(404, { message: "Unhandled fake route" });
  }

  const request: AppStackDockerRequest = async (method, endpointPath, body, options) => {
    const line = `${method} ${endpointPath}`;
    log.push(line);
    if (body !== undefined) bodies.set(line, [...(bodies.get(line) ?? []), body]);
    const held = holds.findIndex((h) => h.match.test(line));
    if (held >= 0) await holds.splice(held, 1)[0]?.released;
    const failed = fails.findIndex((f) => f.match.test(line));
    if (failed >= 0) {
      const [fail] = fails.splice(failed, 1);
      return reply(fail?.status ?? 500, fail?.body ?? { message: "fake failure" });
    }
    const res = route(method, new URL(endpointPath, "http://docker"), body);
    return options?.maxBodyBytes === undefined ? res : { ...res, body: res.body.subarray(0, options.maxBodyBytes) };
  };

  return {
    request,
    log,
    bodies,
    images,
    pullable,
    registry,
    networks,
    volumes,
    containers,
    info,
    failNext(match, status, body) {
      fails.push({ match, status, ...(body === undefined ? {} : { body }) });
    },
    hold(match) {
      let release = () => {};
      holds.push({ match, released: new Promise<void>((resolve) => (release = resolve)) });
      return { release: () => release() };
    },
  };
}
