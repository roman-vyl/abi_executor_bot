## Why

Текущий canonical `container-runtime` уже покрывает базовую контейнеризацию, но не фиксирует несколько production-critical runtime semantics. Из-за этого контейнерный запуск может выглядеть healthy при неготовом ABI execution recovery, неявно принимать невалидную конфигурацию или вести себя по-разному между локальным и container запуском.

Этот change добавляет только недостающие runtime guarantees для production/container readiness без изменения business semantics, execution core или публичных HTTP контрактов.

## What Changes

В `container-runtime` добавляются четыре правила: строгий fail-fast для явно невалидной runtime-конфигурации, container readiness поверх уже существующей ABI execution readiness, graceful shutdown по `SIGTERM`/`SIGINT`, и loopback-host по умолчанию для standalone/local запуска при явном `0.0.0.0` в container deployment.

Non-goals: compose-мультисервисная оркестрация, observability/logging redesign, retry/recovery redesign, execution core changes, test/doc/OpenAPI cleanup и новые публичные HTTP contracts.

## Impact

Trading-safety и mainnet guards не меняются: change уточняет только startup, readiness и process lifecycle semantics. Dry-run и successful live behavior сохраняются, а recovery/idempotency semantics не расширяются и не перепроектируются.
