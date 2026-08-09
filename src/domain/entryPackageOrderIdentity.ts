import { createHash } from "node:crypto";

export type EntryPackageOrderRole = "entry";

// Bybit documents a 36-character limit on orderLinkId. The `abi-ep-` prefix
// (7 chars) + a 20-character hex digest stays comfortably under that limit,
// while keeping the identifier deterministic from pair, role, and generation.
export function buildEntryPackageOrderLinkId(
  strategyInstanceId: string,
  tradeCycleId: string,
  role: EntryPackageOrderRole,
  generation: number,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([strategyInstanceId, tradeCycleId, role, generation]))
    .digest("hex")
    .slice(0, 20);

  return `abi-ep-${digest}`;
}
