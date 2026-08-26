# Handoff: slice L2

Status: passed
Next: slice L3 (started at once)

## Done-when (from RUNTIME_BUILD.md)

- [x] TypeScript SDK
- [x] Memory policy
- [x] Primary call
- [x] Fail-open
- [x] Last-known file
- [x] R2 with no backup

## Evidence

- Tests: `npm test` — 358 pass, 0 fail.
- Demo: `createLiveSdk` GETs on start. `complete()` POSTs the primary with the vendor key. A tampered GET keeps last-known. No last-known plus GET fail does not send.
- Reviewer: pass ([Review](a02a55a5-1c72-42a2-ba26-79d8c727b1d2))

## Blockers for next slice

None.

## Notes for implementer of L3

Extend `src/live/sdk.ts`. Keep GET off `complete()`.

Timeout is `timeout_ms` on the model (from `max_wait_ms`). Abort before the first token. Then try one backup.

Retry on 5xx, 429, or timeout. Do not retry 4xx from bad input. Do not try a second backup. After the first token, do not try a backup.

Stream: send tokens as the vendor sends them. Do not hold the full body before the first token.

Fallback rate: count requests that used a backup. Expose the count on the SDK. `get_live_report` is L7.

No samples. No canary. No control-plane GET on the request. Mock fetch in tests.
