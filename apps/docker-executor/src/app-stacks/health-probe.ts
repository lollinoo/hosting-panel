import http from "node:http";
import net from "node:net";
import { APP_STACK_KEY_PATTERN, APP_TEMPLATE_LIMITS, appStackHealthPathProblem } from "@hosting-panel/contracts";
import type { AppStackHealthLabel } from "./container-payload.js";

export const APP_STACK_HTTP_PROBE_BODY_MAX_BYTES = 65_536;
export type AppStackProbeTarget = {
  readonly address: string;
  readonly componentKey: string;
  readonly health: Exclude<AppStackHealthLabel, { kind: "none" }>;
};
export type AppStackHealthProbe = (target: AppStackProbeTarget) => Promise<"passed" | "failed">;

/** Plain unicast IPv4 (no leading zeros, so no name lookup) and a target a valid `app_health` label can produce. */
function probeAllowed({ address, componentKey, health }: AppStackProbeTarget): boolean {
  const first = Number(address.split(".")[0]);
  return (
    net.isIPv4(address) &&
    first !== 0 &&
    !address.startsWith("169.254.") &&
    first < 224 &&
    APP_STACK_KEY_PATTERN.test(componentKey) &&
    Number.isInteger(health.port) &&
    health.port >= 1 &&
    health.port <= 65_535 &&
    Number.isInteger(health.timeoutSeconds) &&
    health.timeoutSeconds >= APP_TEMPLATE_LIMITS.healthTimeoutMin &&
    health.timeoutSeconds <= APP_TEMPLATE_LIMITS.healthTimeoutMax &&
    (health.kind === "tcp" || appStackHealthPathProblem(health.path) === null)
  );
}

export const probeAppStackHealth: AppStackHealthProbe = (target) =>
  new Promise((resolve) => {
    if (!probeAllowed(target)) {
      resolve("failed");
      return;
    }
    const { address, componentKey, health } = target;
    let connection: { destroy(): unknown } | undefined;
    const settle = (outcome: "passed" | "failed"): void => {
      clearTimeout(timer);
      connection?.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => settle("failed"), health.timeoutSeconds * 1000);
    if (health.kind === "tcp") {
      const socket = net.connect({ host: address, port: health.port, family: 4 });
      connection = socket;
      socket.on("error", () => settle("failed"));
      socket.once("connect", () => settle("passed"));
      return;
    }
    const request = http.request({
      host: address,
      port: health.port,
      path: health.path,
      method: "GET",
      agent: false,
      headers: { Host: componentKey, "User-Agent": "hp-docker-executor-health", Accept: "*/*", Connection: "close" },
    });
    connection = request;
    request.on("error", () => settle("failed"));
    // The status decides; the body is never read (settle destroys the socket).
    request.once("response", (response) => {
      const status = response.statusCode ?? 0;
      settle(status >= 200 && status <= 399 ? "passed" : "failed");
    });
    request.end();
  });
