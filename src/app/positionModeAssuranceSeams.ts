import {
  positionBindingGeometry,
  resolveRecordPhysicalPositionBinding,
  type EntryPackageExecutionRecord,
} from "../correlation/entryPackageExecutionRecord.js";
import { instrumentPositionScopeKey, type InstrumentPositionScope, type PositionBindingGeometry } from "../domain/positionScope.js";
import type { BybitAdapter } from "../exchange/bybitAdapter.js";
import { assureBybitPositionMode } from "../exchange/bybitPositionModeAssurance.js";

// Controlled composition seam for the later activation. It is deliberately
// not imported by current server startup and receives no deployment config.
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

// Future admission must call this while holding the instrument mutex. The
// seam itself owns no lock and performs no durable write, preventing it from
// becoming an accidental activation path in this readiness-only change.
export async function assureBindingBeforeAdmission(input: {
  bybit: BybitAdapter;
  instrumentScope: InstrumentPositionScope;
  expected: PositionBindingGeometry;
}): Promise<boolean> {
  return (await assureBybitPositionMode(input)).kind === "verified";
}

function sameGeometry(a: PositionBindingGeometry, b: PositionBindingGeometry): boolean {
  return a.mode === b.mode && (a.mode === "one_way" || (b.mode === "hedge" && a.direction === b.direction));
}
