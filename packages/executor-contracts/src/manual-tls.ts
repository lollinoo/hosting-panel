import type { ManualTlsAction, ManualTlsIpcRequest, ManualTlsResultByAction } from "@hosting-panel/contracts";

// Wire schemas (ManualTlsIpcRequestSchema, MANUAL_TLS_RESULT_SCHEMAS) live in @hosting-panel/contracts: this package has no zod.
export type ManualTlsRequest = ManualTlsIpcRequest;
export type ManualTlsResult<A extends ManualTlsAction = ManualTlsAction> = ManualTlsResultByAction[A];
export type {
  ManualTlsAction,
  ManualTlsPublishOutcome,
  SniViolation,
} from "@hosting-panel/contracts";
