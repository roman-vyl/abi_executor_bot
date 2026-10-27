// Private WS frames shaped after the stage 0 Bybit Demo probe
// (2026-10-27): XRPUSDT stop loss of trade cycle 3dfc2594 at 12:47:54.2Z and
// the entry create/cancel of cycle 5bf9afc0 at 19:30-19:35Z. Identifiers,
// prices, quantities and fees are the observed values; fields not reported by
// the probe are filled with Bybit's documented shapes.

export const ENTRY_LINK = "abi-ep-eb7c6a056f7831a4a6a8";
export const SL_ORDER_ID = "777e37ed-2865-40c3-bea4-6ef56db4765a";
export const TP_ORDER_ID = "f11f36c2-9420-4519-a54c-e5d0b8e1cf54";
export const SL_EXEC_ID = "e10b5b04-b0a5-4e29-add4-ca81a314c5da";

const T = 1_793_105_274_202;

function child(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    category: "linear",
    symbol: "XRPUSDT",
    orderLinkId: "",
    parentOrderLinkId: ENTRY_LINK,
    side: "Sell",
    orderType: "Market",
    price: "0",
    qty: "3.9",
    triggerBy: "LastPrice",
    leavesQty: "3.9",
    cumExecQty: "0",
    cumExecValue: "0",
    cumExecFee: "0",
    avgPrice: "",
    cancelType: "UNKNOWN",
    rejectReason: "EC_NoError",
    createType: "CreateByStopLoss",
    reduceOnly: true,
    createdTime: String(T - 3_600_000),
    ...fields,
  };
}

export const SL_TRIGGERED_FRAME = {
  id: "574434240_XRPUSDT_140698842507864",
  topic: "order",
  creationTime: T,
  data: [
    child({
      orderId: SL_ORDER_ID,
      orderStatus: "Triggered",
      stopOrderType: "PartialStopLoss",
      triggerPrice: "1.3181",
      updatedTime: String(T),
    }),
  ],
};

export const SL_EXECUTION_FRAME = {
  id: "574434240_XRPUSDT_140698842507865",
  topic: "execution",
  creationTime: T,
  data: [
    {
      category: "linear",
      symbol: "XRPUSDT",
      orderId: SL_ORDER_ID,
      orderLinkId: "",
      side: "Sell",
      orderType: "Market",
      stopOrderType: "PartialStopLoss",
      createType: "CreateByStopLoss",
      execId: SL_EXEC_ID,
      execType: "Trade",
      execPrice: "1.3181",
      execQty: "3.9",
      execValue: "5.14059",
      execFee: "0.00282733",
      feeRate: "0.00055",
      execPnl: "-0.04056",
      closedSize: "3.9",
      isMaker: false,
      seq: 140698842507865,
      execTime: String(T),
    },
  ],
};

export const SL_FILLED_AND_TP_DEACTIVATED_FRAME = {
  id: "574434240_XRPUSDT_140698842507866",
  topic: "order",
  creationTime: T + 1,
  data: [
    child({
      orderId: SL_ORDER_ID,
      orderStatus: "Filled",
      stopOrderType: "PartialStopLoss",
      triggerPrice: "1.3181",
      leavesQty: "0",
      cumExecQty: "3.9",
      cumExecValue: "5.14059",
      cumExecFee: "0.00282733",
      avgPrice: "1.3181",
      closedPnl: "-0.044302",
      updatedTime: String(T + 1),
    }),
    child({
      orderId: TP_ORDER_ID,
      orderStatus: "Deactivated",
      stopOrderType: "PartialTakeProfit",
      triggerPrice: "1.3729",
      cancelType: "CancelByTpSlTsClear",
      createType: "CreateByTakeProfit",
      updatedTime: String(T + 1),
    }),
  ],
};

export const POSITION_FRAME = {
  id: "574434240_position_1",
  topic: "position",
  creationTime: T + 2,
  data: [
    {
      category: "linear",
      symbol: "XRPUSDT",
      side: "",
      size: "0",
      positionIdx: 0,
      avgPrice: "0",
      seq: 140698842507866,
      updatedTime: String(T + 2),
    },
  ],
};

export const WALLET_FRAME = {
  id: "574434240_wallet_1",
  topic: "wallet",
  creationTime: T + 3,
  data: [{ accountType: "UNIFIED", totalEquity: "99876.5", totalWalletBalance: "99880.1", coin: [] }],
};

// Entry conditional order of cycle 5bf9afc0 placed at 19:30:12Z, cancelled by
// Runtime at 19:35:06Z and replaced by cycle 17d1af99 at 19:35:07Z.
function entry(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    category: "linear",
    symbol: "XRPUSDT",
    parentOrderLinkId: "",
    side: "Buy",
    orderType: "Market",
    price: "0",
    triggerPrice: "1.3032",
    triggerDirection: 2,
    triggerBy: "LastPrice",
    timeInForce: "IOC",
    stopOrderType: "Stop",
    createType: "CreateByStopOrder",
    reduceOnly: false,
    leavesQty: "0",
    cumExecQty: "0",
    cumExecValue: "0",
    cumExecFee: "0",
    avgPrice: "",
    ...fields,
  };
}

export const ENTRY_PLACED_FRAME = {
  id: "574434240_XRPUSDT_entry_1",
  topic: "order",
  creationTime: 1_793_129_412_956,
  data: [
    entry({
      orderId: "d4dfa8dc-746f-4e10-b2ee-add14140386a",
      orderLinkId: "abi-ep-83cad3aac49ae65dd040",
      orderStatus: "Untriggered",
      qty: "77663.5",
      cancelType: "UNKNOWN",
      createdTime: "1793129412956",
      updatedTime: "1793129412956",
    }),
  ],
};

export const ENTRY_CANCELLED_FRAME = {
  id: "574434240_XRPUSDT_entry_2",
  topic: "order",
  creationTime: 1_793_129_706_439,
  data: [
    entry({
      orderId: "d4dfa8dc-746f-4e10-b2ee-add14140386a",
      orderLinkId: "abi-ep-83cad3aac49ae65dd040",
      orderStatus: "Deactivated",
      qty: "77663.5",
      cancelType: "CancelByUser",
      createdTime: "1793129412956",
      updatedTime: "1793129706439",
    }),
  ],
};

export const ENTRY_REPLACED_FRAME = {
  id: "574434240_XRPUSDT_entry_3",
  topic: "order",
  creationTime: 1_793_129_707_748,
  data: [
    entry({
      orderId: "db0d9263-6bfc-47d8-82f5-937f254c1000",
      orderLinkId: "abi-ep-a27fe7e24358bf883925",
      orderStatus: "Untriggered",
      qty: "79866.5",
      cancelType: "UNKNOWN",
      createdTime: "1793129707748",
      updatedTime: "1793129707748",
    }),
  ],
};
