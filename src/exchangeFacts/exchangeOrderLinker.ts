import type { ExchangeFactsStoreState } from "../app/exchangeFactsStartup.js";
import { buildEntryPackageOrderLinkId, type EntryPackageOrderRole } from "../domain/entryPackageOrderIdentity.js";
import { emitEvent, type EventLevel } from "../observability/events.js";
import {
  ExchangeFactsWriteError,
  type ChildOrderLinkInput,
  type ExchangeFactsStore,
  type LinkInput,
  type LinkOutcome,
  type OwnOrderLinkInput,
  type StoredFact,
} from "./exchangeFactsStore.js";

// Links exchange orders to strategy instances and trade cycles from ABI's own
// order labels (abi-exchange-order-linker-v1). Nobody in trading calls it: it
// runs on its own timer, only reads the in-memory correlation records and
// the facts, and writes only order_links. Linking depends only on what is in
// the database, so it converges whatever the order or source of the records
// (design D4); no failure leaves it.

const OWN_LABEL_PREFIX = "abi-ep-";
const LABEL_ROLES: readonly EntryPackageOrderRole[] = ["entry", "close"];

const CHILD_ROLES: Readonly<Record<string, ChildOrderLinkInput["role"]>> = {
  PartialStopLoss: "stop_loss",
  StopLoss: "stop_loss",
  PartialTakeProfit: "take_profit",
  TakeProfit: "take_profit",
};

export type WaitingReason = "own_label_unknown" | "parent_not_found";
export type NotLinkableReason =
  | "foreign_label"
  | "no_label"
  | "child_type_unknown"
  | "parent_ambiguous"
  | "own_label_ambiguous"
  | "link_conflict"
  | "invalid_link";

export type ExchangeLinkerState = "disabled" | "waiting_for_correlation" | "running" | "stopped";

export type ExchangeLinkerStatus = {
  state: ExchangeLinkerState;
  reason?: string;
  lastTickAtMs?: number;
  linksWritten: number;
  waitingOrders: Partial<Record<WaitingReason, number>>;
  notLinkableOrders: Partial<Record<NotLinkableReason, number>>;
  lastError?: string;
};

export function disabledLinkerStatus(reason: string): ExchangeLinkerStatus {
  return { state: "disabled", reason, linksWritten: 0, waitingOrders: {}, notLinkableOrders: {} };
}

// The fields of a correlation record the label index needs.
export type LabelSourceRecord = {
  strategy_instance_id: string;
  trade_cycle_id: string;
  generation: number;
};

export type LinkerFactsStore = Pick<ExchangeFactsStore, "readFactsAfter" | "readLinksAfter" | "writeLinks">;

type EmitLike = (level: EventLevel, event: string, fields?: Record<string, unknown>) => void;

export type ExchangeOrderLinkerOptions = {
  store: LinkerFactsStore;
  // Read-only listing of every correlation record, open and closed.
  listRecords: () => readonly LabelSourceRecord[];
  isCorrelationReady: () => boolean;
  emit?: EmitLike;
  now?: () => number;
  tickIntervalMs?: number;
  maxFactsPerTick?: number;
};

type LabelOwner = {
  strategyInstanceId: string;
  tradeCycleId: string;
  role: EntryPackageOrderRole;
  generation: number;
};

// label -> the instance, cycle, role and generation that produced it. The
// label is a pure function of those four values, so every generation of
// every record can be recomputed; binding_history is not needed (design D2).
export class LabelIndex {
  private readonly owners = new Map<string, LabelOwner | "ambiguous">();
  private readonly indexedGeneration = new Map<string, number>();

  refresh(records: readonly LabelSourceRecord[]): void {
    for (const record of records) {
      const pairKey = JSON.stringify([record.strategy_instance_id, record.trade_cycle_id]);
      const from = (this.indexedGeneration.get(pairKey) ?? 0) + 1;
      for (let generation = from; generation <= record.generation; generation += 1) {
        for (const role of LABEL_ROLES) {
          this.add(
            buildEntryPackageOrderLinkId(record.strategy_instance_id, record.trade_cycle_id, role, generation),
            { strategyInstanceId: record.strategy_instance_id, tradeCycleId: record.trade_cycle_id, role, generation },
          );
        }
      }
      if (record.generation >= from) {
        this.indexedGeneration.set(pairKey, record.generation);
      }
    }
  }

  resolve(label: string): LabelOwner | "ambiguous" | undefined {
    return this.owners.get(label);
  }

  private add(label: string, owner: LabelOwner): void {
    const existing = this.owners.get(label);
    if (existing === undefined) {
      this.owners.set(label, owner);
    } else if (existing !== "ambiguous" && !sameOwner(existing, owner)) {
      this.owners.set(label, "ambiguous");
    }
  }
}

type Candidate =
  | { kind: "own"; orderId: string; label: string; reason: WaitingReason }
  | { kind: "child"; orderId: string; parentLabel: string; role: ChildOrderLinkInput["role"]; reason: WaitingReason };

export class ExchangeOrderLinker {
  private readonly emit: EmitLike;
  private readonly now: () => number;
  private readonly tickIntervalMs: number;
  private readonly maxFactsPerTick: number;
  private readonly index = new LabelIndex();

  private state: ExchangeLinkerState = "waiting_for_correlation";
  private timer: NodeJS.Timeout | undefined;
  private announced = false;
  private linksLoaded = false;
  private cursor = 0;
  private linksWritten = 0;
  private lastTickAtMs: number | undefined;
  private lastError: string | undefined;

  private readonly linked = new Set<string>();
  // Entry labels that have at least one entry link: a child is tried only
  // when its parent can be found, so a waiting child costs no write.
  private readonly linkedEntryLabels = new Set<string>();
  private readonly waiting = new Map<string, Candidate>();
  private readonly notLinkable = new Map<string, NotLinkableReason>();

  constructor(private readonly options: ExchangeOrderLinkerOptions) {
    this.emit = options.emit ?? emitEvent;
    this.now = options.now ?? Date.now;
    this.tickIntervalMs = options.tickIntervalMs ?? 1_000;
    this.maxFactsPerTick = options.maxFactsPerTick ?? 1_000;
  }

  start(): void {
    if (this.timer !== undefined || this.state === "stopped") {
      return;
    }
    this.timer = setInterval(() => this.tick(), this.tickIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.state = "stopped";
  }

  status(): ExchangeLinkerStatus {
    const waitingOrders: Partial<Record<WaitingReason, number>> = {};
    for (const candidate of this.waiting.values()) {
      waitingOrders[candidate.reason] = (waitingOrders[candidate.reason] ?? 0) + 1;
    }
    const notLinkableOrders: Partial<Record<NotLinkableReason, number>> = {};
    for (const reason of this.notLinkable.values()) {
      notLinkableOrders[reason] = (notLinkableOrders[reason] ?? 0) + 1;
    }
    return {
      state: this.state,
      ...(this.lastTickAtMs !== undefined ? { lastTickAtMs: this.lastTickAtMs } : {}),
      linksWritten: this.linksWritten,
      waitingOrders,
      notLinkableOrders,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    };
  }

  // One synchronous, bounded pass (design D1, D6). Never throws.
  tick(): void {
    if (this.state === "stopped") {
      return;
    }
    try {
      if (!this.options.isCorrelationReady()) {
        this.state = "waiting_for_correlation";
        return;
      }
      this.state = "running";
      if (!this.announced) {
        this.announced = true;
        this.emit("info", "exchange_order_linker_started", {});
      }
      if (!this.linksLoaded) {
        this.loadLinks();
      }
      this.index.refresh(this.options.listRecords());

      const facts = this.options.store.readFactsAfter(this.cursor, this.maxFactsPerTick);
      for (const fact of facts) {
        this.classify(fact);
      }
      if (facts.length > 0) {
        this.cursor = facts[facts.length - 1].eventSeq;
      }

      this.linkWaiting();
      this.lastTickAtMs = this.now();
      this.lastError = undefined;
    } catch (error) {
      const code = errorCode(error);
      if (this.lastError !== code) {
        this.emit("error", "exchange_order_linker_tick_failed", { errorCode: code });
      }
      this.lastError = code;
    }
  }

  private loadLinks(): void {
    let after = 0;
    for (;;) {
      const page = this.options.store.readLinksAfter(after, 1_000);
      for (const link of page) {
        this.linked.add(link.orderId);
        if (link.role === "entry" && link.orderLinkId !== null) {
          this.linkedEntryLabels.add(link.orderLinkId);
        }
      }
      if (page.length < 1_000) {
        break;
      }
      after = page[page.length - 1].linkSeq;
    }
    this.linksLoaded = true;
  }

  // Design D3. Labels and stopOrderType of an order never change, so one
  // fact per orderId decides; later facts of the same order are skipped.
  private classify(fact: StoredFact): void {
    if (fact.kind !== "order_state" || fact.orderId === null) {
      return;
    }
    const orderId = fact.orderId;
    if (this.linked.has(orderId) || this.waiting.has(orderId) || this.notLinkable.has(orderId)) {
      return;
    }

    if (fact.orderLinkId !== null) {
      if (fact.orderLinkId.startsWith(OWN_LABEL_PREFIX)) {
        this.waiting.set(orderId, { kind: "own", orderId, label: fact.orderLinkId, reason: "own_label_unknown" });
      } else {
        this.notLinkable.set(orderId, "foreign_label");
      }
      return;
    }
    if (fact.parentOrderLinkId === null) {
      // Bybit REST order history carries no parentOrderLinkId: an unlabeled
      // REST state does not decide the order, a later WS or labelled fact
      // does (abi-exchange-rest-reconciliation-v1 D5).
      if (fact.source !== "rest") {
        this.notLinkable.set(orderId, "no_label");
      }
      return;
    }
    const role = CHILD_ROLES[stopOrderType(fact.rawJson)];
    if (role === undefined) {
      this.notLinkable.set(orderId, "child_type_unknown");
      return;
    }
    this.waiting.set(orderId, {
      kind: "child",
      orderId,
      parentLabel: fact.parentOrderLinkId,
      role,
      reason: "parent_not_found",
    });
  }

  // Every waiting order is tried on every tick, without deadline (design D4).
  // Entries go first so a child of an entry linked in this call finds it.
  private linkWaiting(): void {
    const own: OwnOrderLinkInput[] = [];
    const ownLabels: string[] = [];
    const establishedAtMs = this.now();
    for (const candidate of this.waiting.values()) {
      if (candidate.kind !== "own") {
        continue;
      }
      const owner = this.index.resolve(candidate.label);
      if (owner === undefined) {
        candidate.reason = "own_label_unknown";
        continue;
      }
      if (owner === "ambiguous") {
        this.markNotLinkable(candidate.orderId, "own_label_ambiguous");
        continue;
      }
      own.push({
        kind: "own",
        orderId: candidate.orderId,
        strategyInstanceId: owner.strategyInstanceId,
        tradeCycleId: owner.tradeCycleId,
        role: owner.role,
        generation: owner.generation,
        orderLinkId: candidate.label,
        evidence: "own_order_link_id_lookup",
        establishedAtMs,
      });
      if (owner.role === "entry") {
        ownLabels.push(candidate.label);
      }
    }

    const reachableEntries = new Set([...this.linkedEntryLabels, ...ownLabels]);
    const children: ChildOrderLinkInput[] = [];
    for (const candidate of this.waiting.values()) {
      if (candidate.kind !== "child") {
        continue;
      }
      if (!reachableEntries.has(candidate.parentLabel)) {
        candidate.reason = "parent_not_found";
        continue;
      }
      children.push({
        kind: "child",
        orderId: candidate.orderId,
        role: candidate.role,
        parentOrderLinkId: candidate.parentLabel,
        establishedAtMs,
      });
    }

    const links: LinkInput[] = [...own, ...children];
    if (links.length === 0) {
      return;
    }

    let outcomes: LinkOutcome[];
    try {
      outcomes = this.options.store.writeLinks(links);
    } catch (error) {
      if (!(error instanceof ExchangeFactsWriteError)) {
        throw error;
      }
      // One refused order must not block the others (design D3).
      this.linkOneByOne(links);
      return;
    }
    links.forEach((link, position) => this.apply(link, outcomes[position]));
  }

  private linkOneByOne(links: readonly LinkInput[]): void {
    for (const link of links) {
      let outcome: LinkOutcome;
      try {
        [outcome] = this.options.store.writeLinks([link]);
      } catch (error) {
        if (!(error instanceof ExchangeFactsWriteError)) {
          throw error;
        }
        if (error.code === "link_conflict") {
          this.markNotLinkable(link.orderId, "link_conflict");
          this.emit("error", "exchange_order_linker_link_conflict", { orderId: link.orderId, role: link.role });
        } else {
          this.markNotLinkable(link.orderId, "invalid_link");
        }
        continue;
      }
      this.apply(link, outcome);
    }
  }

  private apply(link: LinkInput, outcome: LinkOutcome): void {
    switch (outcome) {
      case "inserted":
      case "duplicate":
        if (outcome === "inserted") {
          this.linksWritten += 1;
        }
        this.waiting.delete(link.orderId);
        this.linked.add(link.orderId);
        if (link.kind === "own" && link.role === "entry") {
          this.linkedEntryLabels.add(link.orderLinkId);
        }
        return;
      case "parent_not_found": {
        const candidate = this.waiting.get(link.orderId);
        if (candidate !== undefined) {
          candidate.reason = "parent_not_found";
        }
        return;
      }
      case "parent_ambiguous":
        this.markNotLinkable(link.orderId, "parent_ambiguous");
        return;
    }
  }

  private markNotLinkable(orderId: string, reason: NotLinkableReason): void {
    this.waiting.delete(orderId);
    this.notLinkable.set(orderId, reason);
  }
}

export type ExchangeOrderLinkerHandle = {
  start(): void;
  stop(): void;
  status(): ExchangeLinkerStatus;
};

// Created only with an enabled store (design D6); otherwise a no-op handle
// reports why.
export function createExchangeOrderLinker(
  exchangeFacts: ExchangeFactsStoreState,
  deps: Omit<ExchangeOrderLinkerOptions, "store">,
): ExchangeOrderLinkerHandle {
  if (exchangeFacts.status !== "enabled") {
    const status = disabledLinkerStatus("store_not_enabled");
    return { start: () => undefined, stop: () => undefined, status: () => status };
  }
  return new ExchangeOrderLinker({ ...deps, store: exchangeFacts.store });
}

function sameOwner(a: LabelOwner, b: LabelOwner): boolean {
  return (
    a.strategyInstanceId === b.strategyInstanceId &&
    a.tradeCycleId === b.tradeCycleId &&
    a.role === b.role &&
    a.generation === b.generation
  );
}

function stopOrderType(rawJson: string): string {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (typeof parsed === "object" && parsed !== null) {
      const value = (parsed as Record<string, unknown>).stopOrderType;
      return typeof value === "string" ? value : "";
    }
  } catch {
    // A stored fact is valid JSON; an unreadable one is simply not a child.
  }
  return "";
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") {
      return code;
    }
  }
  return error instanceof Error ? error.name : "unknown_error";
}
