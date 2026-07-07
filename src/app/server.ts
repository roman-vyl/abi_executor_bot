import { createServer } from "node:http";

import type { AbiConfig } from "../config/config.js";
import { RestBybitAdapter } from "../exchange/bybitAdapter.js";
import { writeJson } from "./http.js";
import { Journal } from "../journal/journal.js";
import { handleAccountRoutes } from "../routes/accountRoutes.js";
import { handleIntentRoutes } from "../routes/intentRoutes.js";
import { handleSignalRoutes } from "../routes/signalRoutes.js";
import { handleSystemRoutes } from "../routes/systemRoutes.js";

export function startServer(config: AbiConfig): void {
  const journal = new Journal(config.journalPath);
  const bybit = new RestBybitAdapter(config);

  const server = createServer(async (request, response) => {
    if (await handleSystemRoutes({ request, response, config })) {
      return;
    }

    if (await handleAccountRoutes({ request, response, config, bybit })) {
      return;
    }

    if (await handleSignalRoutes({ request, response, config, bybit, journal })) {
      return;
    }

    if (await handleIntentRoutes({ request, response, config, bybit, journal })) {
      return;
    }

    writeJson(response, 404, {
      error: "not_found",
    });
  });

  server.listen(config.port, config.host, () => {
    console.log(`Abi service listening on ${config.host}:${config.port}`);
  });
}
