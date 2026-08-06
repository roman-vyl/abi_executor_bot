import { createServer } from "node:http";

import { KeyedMutex } from "../concurrency/keyedMutex.js";
import type { AbiConfig } from "../config/config.js";
import { EntryPackageCorrelationRepository } from "../correlation/entryPackageCorrelationRepository.js";
import { RestBybitAdapter } from "../exchange/bybitAdapter.js";
import { BybitExchangeInstrumentResolver } from "../exchange/exchangeInstrumentResolver.js";
import { BybitInstrumentTradingRulesProvider } from "../exchange/instrumentTradingRulesProvider.js";
import { FixedMinimumPositionSizeCalculator } from "../risk/positionSizeCalculator.js";
import { EntryPackageApplicationService } from "../services/entryPackage/entryPackageApplicationService.js";
import { OpenPositionResolutionService } from "../services/openPosition/openPositionResolutionService.js";
import { EntryPackageReadiness } from "./entryPackageReadiness.js";
import { writeJson } from "./http.js";
import { handleAccountRoutes } from "../routes/accountRoutes.js";
import { handleEntryPackageRoutes } from "../routes/entryPackageRoutes.js";
import { handleOpenPositionRoutes } from "../routes/openPositionRoutes.js";
import { handlePositionManagementRoutes } from "../routes/positionManagementRoutes.js";
import { handleSystemRoutes } from "../routes/systemRoutes.js";

export function startServer(config: AbiConfig): void {
  const bybit = new RestBybitAdapter(config);

  const correlationRepository = new EntryPackageCorrelationRepository(config.entryPackageCorrelationPath);
  const rulesProvider = new BybitInstrumentTradingRulesProvider(bybit, config);
  const positionSizeCalculator = new FixedMinimumPositionSizeCalculator(rulesProvider);
  const mutex = new KeyedMutex();
  const readiness = new EntryPackageReadiness();
  const exchangeInstrumentResolver = new BybitExchangeInstrumentResolver();

  const applicationService = new EntryPackageApplicationService({
    config,
    bybit,
    correlationRepository,
    positionSizeCalculator,
    mutex,
    exchangeInstrumentResolver,
  });

  const openPositionResolutionService = new OpenPositionResolutionService({
    correlationRepository,
    bybit,
  });

  // Correlation-store replay runs asynchronously and must not delay
  // server.listen() for account routes (design.md §13).
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

    if (
      await handleOpenPositionRoutes({
        request,
        response,
        resolutionService: openPositionResolutionService,
        isReady: () => readiness.isReady,
      })
    ) {
      return;
    }

    if (await handlePositionManagementRoutes({ request, response })) {
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
