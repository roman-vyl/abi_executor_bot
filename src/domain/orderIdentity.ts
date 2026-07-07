import { createHash } from "node:crypto";

export type PlannedOrderKind = "entry" | "sl" | "tp";

export function buildOrderLinkId(instanceId: string, kind: PlannedOrderKind): string {
  const digest = createHash("sha256").update(instanceId).digest("hex").slice(0, 20);
  return `abi-${kind}-${digest}`;
}
