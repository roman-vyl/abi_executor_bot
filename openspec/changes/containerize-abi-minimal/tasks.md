## 1. Runtime Entry Review

- [x] 1.1 Review current `package.json` scripts and confirm whether `npm start` is sufficient for container production startup.
- [x] 1.2 Add `start:prod` only if it improves clarity for running the compiled `dist/app/index.js` entrypoint without changing behavior.

## 2. Docker Packaging

- [x] 2.1 Add a Dockerfile that installs dependencies, builds TypeScript, and starts the compiled Abi service.
- [x] 2.2 Ensure the Docker image build does not depend on host `node_modules` or host `dist`.
- [x] 2.3 Add `.dockerignore` excluding `.env`, `.env.*`, `var/`, `archives/`, `node_modules/`, `dist/`, logs, and local OS/editor noise.

## 3. Compose Runtime

- [x] 3.1 Add `docker-compose.yml` with safe defaults: `ABI_DRY_RUN=true`, `ABI_LIVE_TRADING_ENABLED=false`, and `BYBIT_ENV=testnet`.
- [x] 3.2 Configure the base Compose service to expose Abi locally and run without Bybit API keys.
- [x] 3.3 Mount `./var:/app/var` so journal state remains outside the image.
- [x] 3.4 Add `docker-compose.demo.yml` for the explicit `.env.demo.local` demo runtime path.
- [x] 3.5 Ensure the demo override does not enable or document mainnet live execution.

## 4. Documentation

- [x] 4.1 Add `docs/DOCKER.md` with image build instructions.
- [x] 4.2 Document safe dry-run container startup.
- [x] 4.3 Document `/health` and `/execution/mode` checks against the container.
- [x] 4.4 Document demo startup with `docker compose -f docker-compose.yml -f docker-compose.demo.yml up --build`.
- [x] 4.5 Document running `smoke:sandbox:read` against `ABI_BASE_URL=http://127.0.0.1:8787`.
- [x] 4.6 Document running `smoke:sandbox:contract` against `ABI_BASE_URL=http://127.0.0.1:8787` for explicit demo/testnet live mode.
- [x] 4.7 Document that `.env.demo.local` is not committed and secrets are supplied only at runtime.
- [x] 4.8 Document that containerization does not include mainnet deployment.
- [x] 4.9 Update `README.md` with one short Docker section linking to `docs/DOCKER.md`.

## 5. Verification

- [ ] 5.1 Run `npm test`.
- [ ] 5.2 Run `npm run build`.
- [ ] 5.3 Run `npm run smoke:contract:fake`.
- [ ] 5.4 Run `docker build` from the project root.
- [ ] 5.5 Start the base Compose stack and verify `GET /health` returns ok.
- [ ] 5.6 Verify `GET /execution/mode` reports safe default mode with live execution disabled.
- [ ] 5.7 Verify `./var:/app/var` is mounted for journal persistence.
- [ ] 5.8 Do not run real Bybit write smoke unless separately authorized.
