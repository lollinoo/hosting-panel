import type { operations } from "@hosting-panel/database";
import type { AppStackRuntimeDeps } from "./app-stack-runtime.js";

/** Read-only: one getAppStackStatus, a pure verdict, one settle transaction. Never a mutating StackExecutorPort call. */
export async function recoverAppStackOperation(
  _deps: AppStackRuntimeDeps,
  _op: typeof operations.$inferSelect,
): Promise<"pending" | "settled"> {
  // Placeholder until RT4: every stack operation stays unknown, the safe default.
  return "pending";
}
