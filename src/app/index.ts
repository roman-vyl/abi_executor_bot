import { loadConfig } from "../config/config.js";
import { startServer } from "./server.js";

const config = loadConfig();

console.log("Abi service skeleton started");
console.log(
  JSON.stringify(
    {
      host: config.host,
      port: config.port,
      dryRun: config.dryRun,
      liveTradingEnabled: config.liveTradingEnabled,
      allowedSymbols: config.allowedSymbols,
      journalPath: config.journalPath,
      fixedSmokeQty: config.fixedSmokeQty,
      bybitEnvironment: config.bybitEnvironment,
      bybitTestnet: config.bybitTestnet,
      bybitAccountType: config.bybitAccountType,
      bybitRecvWindow: config.bybitRecvWindow,
      bybitCategory: config.bybitCategory,
      bybitSettleCoin: config.bybitSettleCoin,
      bybitTriggerBy: config.bybitTriggerBy,
      bybitApiKeyConfigured: config.bybitApiKey !== "",
    },
    null,
    2,
  ),
);

startServer(config);
