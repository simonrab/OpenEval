# Handoff: slice L7

Status: passed
Next: slice L8 (started at once)

## Done-when (from RUNTIME_BUILD.md)

- [x] `get_live_report`
- [x] Read-only report URL
- [x] MCP schemas for the four Live tools

## Evidence

- Tests: `npm test` — 448 pass, 0 fail.
- Demo: `get_live_report` returns live `pol_`, canary, splits, fallback rate, sample counts, last-known age, `report_url`. HTML shows counts only. HMAC. Four Live tools are on MCP.
- Reviewer: pass ([Review](e21bf67d-cec9-40fa-968f-26375cc17326))

## Blockers for next slice

None. Mock OpenRouter. Do not wait for a live vendor key.

## Notes for implementer of L8

Demo harness for spec sections 13 and 14. This is the last Live slice.

Measure p99 **added** latency. Do not count vendor time. The bar is 5 ms or less on the usual path.

If you stop the control plane, the app still answers from last-known policy that passed the seal check.

Walk the north-star loop with mocks: compile, approve, live send, one backup, app-reported miss, promote, new `ste_`, canary 5 percent, 100 percent, rollback.

Do not add a hosted proxy, a dashboard, or a learned picker.
