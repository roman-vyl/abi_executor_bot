import type { Protection } from "../../domain/executionPlan.js";
import type { BybitOrderSide } from "../../exchange/bybitOrderMapper.js";

export type ProtectionCheckStatus =
  | "not_run_dry_run"
  | "pending_order_verified"
  | "pending_order_not_found"
  | "pre_existing_position_found"
  | "position_open_no_stop_requested"
  | "position_open_stop_not_breached"
  | "position_open_stop_breached"
  | "emergency_close_sent"
  | "emergency_close_failed"
  | "unsafe_manual_required"
  | "exchange_query_failed";

export type ProtectionCheckAction = "none" | "close_position_market_reduce_only";

export type ProtectionCheckContext = {
  signalId: string;
  instanceId: string;
  symbol: string;
  side: "long" | "short";
  orderLinkId: string;
  protection: Protection;
  dryRun: boolean;
};

export type ProtectionPositionSnapshot = {
  queryOk: boolean;
  found: boolean;
  size?: string;
  side?: BybitOrderSide | "None";
  positionIdx?: number;
  error?: OperatorSafeError;
};

export type ProtectionCheckAttempts = {
  orderQueries: number;
  positionQueries: number;
  priceQueries: number;
  emergencyCloseAttempts: number;
};

export type EmergencyCloseMetadata = {
  sent: boolean;
  order?: unknown;
  bybitResponse?: unknown;
};

export type OperatorSafeError = {
  message: string;
  source?: string;
};

export type ProtectionCheckResult = {
  status: ProtectionCheckStatus;
  action: ProtectionCheckAction;
  signal_id: string;
  instance_id: string;
  symbol: string;
  side: "long" | "short";
  orderLinkId: string;
  requestedProtection: Protection;
  preCreatePositionFound: boolean;
  preCreatePositionSize?: string;
  preCreatePositionSide?: BybitOrderSide | "None";
  orderFound?: boolean;
  postCreatePositionFound?: boolean;
  postCreatePositionSize?: string;
  postCreatePositionSide?: BybitOrderSide | "None";
  stopLoss?: string;
  observedPrice?: string;
  reason: string;
  attempts: ProtectionCheckAttempts;
  emergencyCloseOrder?: EmergencyCloseMetadata;
  error?: OperatorSafeError;
};

export type ProtectionDecisionInput = {
  context: ProtectionCheckContext;
  preCreatePosition: ProtectionPositionSnapshot;
  orderFound?: boolean;
  postCreatePosition?: ProtectionPositionSnapshot;
  observedPrice?: string;
  priceError?: OperatorSafeError;
  attempts: ProtectionCheckAttempts;
  emergencyClose?: {
    attempted: boolean;
    accepted: boolean;
    order?: unknown;
    bybitResponse?: unknown;
    error?: OperatorSafeError;
  };
};

export function emptyProtectionCheckAttempts(): ProtectionCheckAttempts {
  return {
    orderQueries: 0,
    positionQueries: 0,
    priceQueries: 0,
    emergencyCloseAttempts: 0,
  };
}
