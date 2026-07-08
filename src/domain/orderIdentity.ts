import { createHash } from "node:crypto";

export type OrderKind = "entry";

export function buildOrderLinkId(instanceId: string, kind: OrderKind): string {
  const digest = createHash("sha256").update(instanceId).digest("hex").slice(0, 20);
  return `abi-${kind}-${digest}`;
}
