## Why

ABI уже умеет сохранять directional physical slots и выполнять entry, protection, close и recovery по durable binding, но production composition всё ещё принудительно выбирает one-way geometry и блокирует mixed-side state. Нужен минимальный атомарный activation cutover, который подключит готовый slot-aware lifecycle к проверенному вручную Bybit Hedge Mode без изменения публичных контрактов и без автоматического переключения режима биржи.

## What Changes

- Добавить внутреннюю deployment policy для ожидаемой geometry линейных Bybit-инструментов с безопасным default `one_way`; spot остаётся one-way.
- До первого production hedge write потребовать завершения real-flat Hedge Mode evidence tasks 1.1, 1.2 и 3.2 из `abi-hedge-lifecycle-readiness-v1`.
- Подключить replay/startup и lazy first-admission position-mode assurance так, чтобы mismatch, unavailable evidence или несовместимые active bindings fail-closed блокировали readiness/admission.
- Создавать новые production linear bindings в geometry, выбранной deployment policy, и использовать именно durable binding для entry mapping и всего последующего lifecycle.
- Сделать admission binding-aware: разрешить explicit hedge owners в обоих directional slots одного instrument, сохранить same-slot multi-owner и продолжить запрещать legacy/one-way/hedge geometry mixtures.
- Снять retained mixed-side production policy gate только для structurally valid explicit hedge records; сохранить replay, recovery, durable-before-exchange, pair attribution и mainnet/live guards.
- Зафиксировать обязательные drain, external Bybit mode switch, verification, staged rollout и безопасный rollback. ABI проверяет режим read-only и никогда не переключает его.
- Не менять Strategy Runtime, Strategy Engine, публичные ABI contracts, risk sizing и не выводить `positionIdx` за exchange boundary.

## Capabilities

### New Capabilities

- `hedge-production-activation`: Deployment policy, prerequisites, readiness/admission assurance, activation sequencing и rollback для первого production Hedge Mode write.

### Modified Capabilities

- `entry-package-execution`: Новые linear production bindings выбирают configured geometry и entry использует durable binding вместо hard-coded one-way geometry.
- `position-scope-exclusivity`: Admission разрешает противоположные explicit hedge slots при instrument-scoped serialization, сохраняя same-slot multi-owner и fail-closed geometry isolation.
- `entry-cycle-recovery-resolution`: Structurally valid simultaneous hedge slots перестают блокировать production readiness после policy/mode validation.

## Impact

Изменения затронут внутреннюю конфигурацию и composition root, startup replay/readiness orchestration, correlation repository queries/replay policy, entry-package provisional creation/admission и существующие read-only Bybit position-mode assurance seams. Публичные HTTP request/response schemas и `positionIdx` не меняются; dry-run и demo/testnet live guards сохраняются, mainnet execution остаётся запрещённым. Deploy требует заранее завершённого `abi-hedge-lifecycle-readiness-v1` (включая его tasks 1.1, 1.2 и 3.2), полного drain one-way/legacy active state, подтверждённой flatness и внешнего operator-controlled переключения Bybit в Hedge Mode.
