import { createServer } from "node:http";

import { KeyedMutex } from "../concurrency/keyedMutex.js";
import type { AbiConfig } from "../config/config.js";
import { EntryPackageCorrelationRepository } from "../correlation/entryPackageCorrelationRepository.js";
import { RestBybitAdapter } from "../exchange/bybitAdapter.js";
import { BybitInstrumentTradingRulesProvider } from "../exchange/instrumentTradingRulesProvider.js";
import { FixedMinimumPositionSizeCalculator } from "../risk/positionSizeCalculator.js";
import { EntryPackageApplicationService } from "../services/entryPackage/entryPackageApplicationService.js";
import { EntryPackageReadiness } from "./entryPackageReadiness.js";
import { writeJson } from "./http.js";
import { Journal } from "../journal/journal.js";
import { handleAccountRoutes } from "../routes/accountRoutes.js";
import { handleEntryPackageRoutes } from "../routes/entryPackageRoutes.js";
import { handleIntentRoutes } from "../routes/intentRoutes.js";
import { handleSignalRoutes } from "../routes/signalRoutes.js";
import { handleSystemRoutes } from "../routes/systemRoutes.js";

export function startServer(config: AbiConfig): void {
  const journal = new Journal(config.journalPath);
  const bybit = new RestBybitAdapter(config);

  const correlationRepository = new EntryPackageCorrelationRepository(config.entryPackageCorrelationPath);
  const rulesProvider = new BybitInstrumentTradingRulesProvider(bybit, config);
  const positionSizeCalculator = new FixedMinimumPositionSizeCalculator(rulesProvider);
  const mutex = new KeyedMutex();
  const readiness = new EntryPackageReadiness();

  const applicationService = new EntryPackageApplicationService({
    config,
    bybit,
    correlationRepository,
    positionSizeCalculator,
    mutex,
    // Blocked on the prerequisite change abi-exchange-instrument-identity-v1
    // (design.md Decision 9; tasks.md 0.1/5.3): no production
    // ExchangeSymbolResolver exists yet in this repository, so this change
    // cannot make a real Bybit call for any ticker yet. Failing closed here
    // keeps that boundary honest rather than guessing a normalization rule.
    resolveSymbol: () => {
      throw new Error(
        "entry-package symbol resolution is blocked on the abi-exchange-instrument-identity-v1 prerequisite",
      );
    },
  });

  // Correlation-store replay runs asynchronously and must not delay
  // server.listen() for legacy/account routes (design.md §13).
  void correlationRepository
    .replay()
    .then((result) => {
      if (result.ok) {
        readiness.markReady();
      } else {
        readiness.markNotReady(result.reason);
      }
    })
    .catch((error: unknown) => {
      readiness.markNotReady(error instanceof Error ? error.message : "correlation replay failed");
    });

  const server = createServer(async (request, response) => {
    if (await handleSystemRoutes({ request, response, config, entryPackageReady: readiness.isReady })) {
      return;
    }

    if (await handleAccountRoutes({ request, response, config, bybit })) {
      return;
    }

    if (
      await handleEntryPackageRoutes({
        request,
        response,
        applicationService,
        isReady: () => readiness.isReady,
      })
    ) {
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
