import {
  positionBindingGeometry,
  resolveRecordPhysicalPositionBinding,
  type EntryPackageExecutionRecord,
} from "../correlation/entryPackageExecutionRecord.js";
import { instrumentPositionScopeKey, type InstrumentPositionScope, type PositionBindingGeometry } from "../domain/positionScope.js";
import type { BybitAdapter } from "../exchange/bybitAdapter.js";
import { assureBybitPositionMode } from "../exchange/bybitPositionModeAssurance.js";
import { effectivePositionBindingMode, type LinearPositionBindingPolicy } from "../domain/positionBindingPolicy.js";

// Startup assurance for explicit active bindings. The caller first checks
// deployment-policy compatibility; this seam proves current exchange
// geometry without mutating Bybit.
export async function assureReplayedActiveBindings(input: {
  bybit: BybitAdapter;
  activeRecords: EntryPackageExecutionRecord[];
}): Promise<{ ok: true } | { ok: false }> {
  const expectedByScope = new Map<string, { scope: InstrumentPositionScope; bindings: PositionBindingGeometry[] }>();

  for (const record of input.activeRecords) {
    const physical = resolveRecordPhysicalPositionBinding(record);
    if (physical === undefined) return { ok: false };
    const scope = physical.mode === "one_way" ? physical.instrumentScope : physical.slot.instrumentScope;
    const key = instrumentPositionScopeKey(scope);
    const entry = expectedByScope.get(key) ?? { scope, bindings: [] };
    const binding = positionBindingGeometry(physical);
    if (entry.bindings.some((existing) => existing.mode !== binding.mode)) return { ok: false };
    if (!entry.bindings.some((existing) => sameGeometry(existing, binding))) entry.bindings.push(binding);
    expectedByScope.set(key, entry);
  }

  for (const { scope, bindings } of expectedByScope.values()) {
    for (const expected of bindings) {
      if ((await assureBybitPositionMode({ bybit: input.bybit, instrumentScope: scope, expected })).kind !== "verified") {
        return { ok: false };
      }
    }
  }
  return { ok: true };
}

// Admission calls this while holding the instrument mutex. The seam itself
// owns no lock and performs no durable write.
export async function assureBindingBeforeAdmission(input: {
  bybit: BybitAdapter;
  instrumentScope: InstrumentPositionScope;
  expected: PositionBindingGeometry;
}): Promise<boolean> {
  return (await assureBybitPositionMode(input)).kind === "verified";
}

export async function assureConfiguredActiveBindings(input: {
  bybit: BybitAdapter;
  activeRecords: EntryPackageExecutionRecord[];
  linearPolicy: LinearPositionBindingPolicy;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (const record of input.activeRecords) {
    if (record.position_binding_mode === null) {
      return { ok: false, reason: "active_legacy_one_way_record_requires_drain" };
    }
    if (record.exchange_category !== "linear" && record.exchange_category !== "spot") {
      return { ok: false, reason: "active_record_has_no_exchange_binding" };
    }
    const expectedMode = effectivePositionBindingMode(record.exchange_category, input.linearPolicy);
    if (record.position_binding_mode !== expectedMode) {
      return {
        ok: false,
        reason: `active_binding_incompatible_with_configured_policy:${record.exchange_category}:${record.exchange_symbol}`,
      };
    }
  }

  // The one-way default deliberately preserves the prior startup behavior:
  // production Hedge Mode activation alone introduces the exchange-read
  // readiness dependency.
  if (input.linearPolicy === "one_way") {
    return { ok: true };
  }

  const result = await assureReplayedActiveBindings({ bybit: input.bybit, activeRecords: input.activeRecords });
  return result.ok ? result : { ok: false, reason: "active_binding_position_mode_assurance_failed" };
}

function sameGeometry(a: PositionBindingGeometry, b: PositionBindingGeometry): boolean {
  return a.mode === b.mode && (a.mode === "one_way" || (b.mode === "hedge" && a.direction === b.direction));
}
