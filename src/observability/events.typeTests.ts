// Compile-time-only proof that emitEvent()'s reserved envelope fields and
// each operation's outcome union cannot be bypassed at a call site. This
// file has no runtime behavior and is never imported from the app entry —
// its only purpose is to fail `tsc` (npm run typecheck / npm run build) if
// any of these constraints regress. Each `@ts-expect-error` documents
// exactly which call must not compile; if the error stops occurring, tsc
// itself flags the now-unused directive.
import { emitEvent, withOperationEvents } from "./events.js";
import type {
  CloseOperationOutcome,
  EntryPackageOperationOutcome,
  OpenPositionOperationOutcome,
  ProtectionOperationOutcome,
} from "./events.js";

function reservedEnvelopeFieldsAreRejected(): void {
  // @ts-expect-error timestamp is a reserved envelope field
  emitEvent("info", "some_event", { timestamp: "2020-01-01T00:00:00.000Z" });
  // @ts-expect-error level is a reserved envelope field
  emitEvent("info", "some_event", { level: "error" });
  // @ts-expect-error service is a reserved envelope field
  emitEvent("info", "some_event", { service: "not_abi_executor_bot" });
  // @ts-expect-error event is a reserved envelope field
  emitEvent("info", "some_event", { event: "hijacked" });
}

function outcomeUnionsAreOperationSpecific(): void {
  // @ts-expect-error "position_open" is not a valid entry_package outcome
  const badEntryPackageOutcome: EntryPackageOperationOutcome = "position_open";
  // @ts-expect-error "entry_package_applied" is not a valid open_position outcome
  const badOpenPositionOutcome: OpenPositionOperationOutcome = "entry_package_applied";
  // @ts-expect-error "trade_cycle_closed" is not a valid protection outcome
  const badProtectionOutcome: ProtectionOperationOutcome = "trade_cycle_closed";
  // @ts-expect-error "protection_applied" is not a valid close_position outcome
  const badCloseOutcome: CloseOperationOutcome = "protection_applied";

  void badEntryPackageOutcome;
  void badOpenPositionOutcome;
  void badProtectionOutcome;
  void badCloseOutcome;
}

async function crossOperationClassifierOutcomeIsRejected(): Promise<void> {
  await withOperationEvents(
    { operation: "entry_package", strategyInstanceId: "s", tradeCycleId: "t" },
    async () => ({ statusCode: 200 as const }),
    // @ts-expect-error "protection_applied" is not a valid entry_package outcome
    () => ({ outcome: "protection_applied" as const, failed: false }),
  );

  await withOperationEvents(
    { operation: "open_position", strategyInstanceId: "s", tradeCycleId: "t" },
    async () => ({ statusCode: 200 as const }),
    // @ts-expect-error "trade_cycle_closed" is not a valid open_position outcome
    () => ({ outcome: "trade_cycle_closed" as const, failed: false }),
  );
}

void reservedEnvelopeFieldsAreRejected;
void outcomeUnionsAreOperationSpecific;
void crossOperationClassifierOutcomeIsRejected;
