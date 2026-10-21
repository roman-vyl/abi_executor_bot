## 1. Store

- [ ] 1.1 Optional `mutation_fenced` boolean on the correlation record; replay normalizes a
  missing key to `false`; validation accepts only booleans.

## 2. Entry package

- [ ] 2.1 `persistAbsentNoHistory` writes `mutation_fenced: true`.
- [ ] 2.2 Non-null PUT on a fenced pair → `internal_error`, diagnostic `fenced_pair`, no
  exchange call, no write.
- [ ] 2.3 Repeat CANCEL on a fenced pair → `entry_package_absent`, no write.

## 3. Tests

- [ ] 3.1 Mandatory: delayed non-null PUT after CANCEL creates no order (sequential and
  queued on the pair lock).
- [ ] 3.2 Ordinary `absent` still allows a new generation.
- [ ] 3.3 Recovery-state on a tombstone → `terminal_without_fill`, no exchange query.
- [ ] 3.4 Replay of rows without the field.
- [ ] 3.5 `npm test` and `npm run typecheck`.
