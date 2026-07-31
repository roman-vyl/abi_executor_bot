export type EntryOrderSemantics = {
  exchangeSide: "Buy" | "Sell";
  triggerDirection: "rises_to" | "falls_to";
};

// V1 mapping is scoped to the currently supported EMA-pullback entry geometry
// (long enters on a pullback down to the planned price, short enters on a
// pullback up to it). No market-price parameter is accepted: the mapping is
// a pure table lookup and must never depend on current price, and it is not
// guaranteed to generalize to a future, differently shaped entry geometry.
export function mapEntryOrderSemantics(side: "long" | "short"): EntryOrderSemantics {
  if (side === "long") {
    return { exchangeSide: "Buy", triggerDirection: "falls_to" };
  }

  return { exchangeSide: "Sell", triggerDirection: "rises_to" };
}
