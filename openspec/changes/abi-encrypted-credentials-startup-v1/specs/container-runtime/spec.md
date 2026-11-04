## MODIFIED Requirements

### Requirement: Docker image excludes secrets and local runtime state
Abi SHALL keep secrets, local environment files, local correlation-store state, archives, dependencies, and host build output out of the Docker image build context.

#### Scenario: Environment files are excluded
- **WHEN** `.dockerignore` is evaluated for a Docker build
- **THEN** `.env` is excluded
- **AND** `.env.*` is excluded
- **AND** `.env.demo.local` is excluded

#### Scenario: Local state and generated output are excluded
- **WHEN** `.dockerignore` is evaluated for a Docker build
- **THEN** `var/` is excluded from the image context
- **AND** `archives/` is excluded from the image context
- **AND** `node_modules/` is excluded from the image context
- **AND** `dist/` is excluded from the image context

#### Scenario: Secrets enter only at runtime
- **WHEN** Abi is run in Docker
- **THEN** Bybit API credentials enter at runtime through the existing environment path or the explicit protected startup path
- **AND** the Docker image does not contain API keys or local `.env` files

## ADDED Requirements

### Requirement: Protected startup requires a complete credential pair
В защищённом режиме ABI SHALL прочитать и проверить оба файла до запуска HTTP-сервера. После загрузки ABI SHALL удалить временные файлы перед открытием порта.

#### Scenario: Complete pair is consumed once
- **WHEN** команда разблокировки полностью передала и опубликовала пару в tmpfs
- **THEN** ABI загружает оба значения в память и удаляет оба файла до запуска сервера

#### Scenario: Partial or invalid handoff fails closed
- **WHEN** пароль неверен, передача оборвалась, истёк срок ожидания, один из файлов отсутствует, пуст или недоступен, либо очистка не удалась
- **THEN** сервер не запускается, попытка завершается, а контейнер с временными данными останавливается и удаляется
- **AND** ABI не подставляет значения из окружения и не выводит содержимое секрета в диагностике

### Requirement: Protected Docker startup requires manual unlock
Защищённый запуск SHALL использовать зашифрованный файл на диске и пароль, который оператор вводит для каждого запуска. Расшифровка SHALL выполняться на Mac вне ABI, а открытые значения SHALL передаваться через stdin в tmpfs.

#### Scenario: Protected container receives credentials at runtime
- **WHEN** оператор запускает защищённый ABI
- **THEN** пароль не сохраняется, открытые значения не передаются через аргументы или окружение и не записываются в образ, постоянный том или логи
- **AND** до передачи проверяется `memory.swap.max=0` внутри контейнера
- **AND** контейнер запускается без привилегированного режима и Docker socket

#### Scenario: Restart requires a new unlock
- **WHEN** защищённый ABI завершился или оператор перезапустил контейнер либо Mac
- **THEN** действует политика перезапуска `no`, а попытка запуска без новой разблокировки завершается без открытия порта

#### Scenario: Demo deployment targets only the existing Demo stack
- **WHEN** существующий Demo workflow выполняет обычный Compose up с удалением orphan-контейнеров
- **THEN** защищённый ABI не создаётся, не пересоздаётся и не удаляется этим запуском
- **AND** текущий Demo продолжает получать учётные данные прежним способом
