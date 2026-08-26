# Handoff: slice L4

Status: passed
Next: slice L5 (started at once)

## Done-when (from RUNTIME_BUILD.md)

- [x] Async redacted samples
- [x] `PII_BLOCKED`
- [x] Disk spool
- [x] R3

## Evidence

- Tests: `npm test` — 390 pass, 0 fail.
- Demo: Vendor miss queues a sample after return. Success does not ingest. Secrets are stripped. SSN drops with `PII_BLOCKED`. Control plane down writes a spool. `POST /v1/runtime/samples` stores `smp_`.
- Reviewer: pass ([Review](ea454ba1-d962-468d-90fb-e2893c1f8202))

## Blockers for next slice

None.

## Notes for implementer of L5

R4: `promote_live_sample` plus a sample screen. A sample becomes a v0 failure. J5 holds. New `ste_`. Old evals copy. Previous `ste_` does not change. Live policy does not change.

`next_action` is `run_evals` or `queue_for_labeling`. Same `idempotency_key` does not make a duplicate.

The sample screen shows one redacted sample. Promote or drop. The developer can paste a program check. This screen is not a traffic explorer.

Reuse v0 `register_failure` / eval-set copy. Do not fork scoring. Do not add `get_live_report` (L7). Do not add canary (L6).
