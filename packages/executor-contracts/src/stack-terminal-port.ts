import type { AppStackTerminalOpenIpcRequest } from "@hosting-panel/contracts";
import type { TerminalOpenResult } from "./port.js";

/**
 * Terminal in one component of an application (ADR-0041). Optional beside DockerExecutorPort and StackExecutorPort:
 * feature-detect with isAppStackTerminalExecutor. The request names the application, its customer and the component
 * and nothing else: the executor derives the container's name, re-checks its labels and sets no user and no folder.
 * The session then lives with the sites' ones: writeTerminal, readTerminal, closeTerminal and listTerminals serve it.
 */
export interface AppStackTerminalPort {
  openAppStackTerminal(req: AppStackTerminalOpenIpcRequest): Promise<TerminalOpenResult>;
}

export function isAppStackTerminalExecutor(value: unknown): value is AppStackTerminalPort {
  return typeof value === "object" && value !== null &&
    typeof (value as Record<string, unknown>).openAppStackTerminal === "function";
}
