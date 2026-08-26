# Handoff: slice L6

Status: passed
Next: slice L7 (started at once)

## Done-when (from RUNTIME_BUILD.md)

- [x] `propose_rollout`
- [x] Rollout screen
- [x] Canary 5 percent
- [x] Full
- [x] Rollback
- [x] Sticky hash
- [x] Intended vs observed
- [x] R5 and R6

## Evidence

- Tests: `npm test` — 436 pass, 0 fail.
- Demo: Propose returns `approve_url` and does not apply. Canary approve is sticky 5 percent. Missing ids stay on last full. Full makes the canary `pol_` last full. Rollback restores the target with no eval run.
- Reviewer: pass ([Review](c585073d-0f0e-4fce-baf7-7e7fafd98667))

## Blockers for next slice

None.

## Notes for implementer of L7

`get_live_report` plus a read-only report URL. MCP schemas for the four Live tools: `compile_policy`, `get_live_report`, `promote_live_sample`, `propose_rollout`.

The report has live `pol_`, canary on or off, intended split, observed split, fallback rate, sample counts, last-known age, `report_url`. Paginate samples. No traces. The payload must fit in context.

The HTML page shows counts only. It is not a dashboard. It is not a traffic table.

This tool is read-only. It does not need `idempotency_key`. `live_traffic_changed` is false.

Do not add a demo harness (L8).
