# Handoff: slice L1

Status: passed
Next: slice L2 (started at once)

## Done-when (from RUNTIME_BUILD.md)

- [x] `compile_policy`
- [x] Compile approve screen
- [x] R1: first approve is last full; later approve is draft only

## Evidence

- Tests: `npm test` — 350 pass, 0 fail.
- Demo: `compile_policy` → `approve_url`. First POST `/compile-approve` → GET policy 200. Later compile+approve → GET still first `pol_`. Reject → GET 404.
- Reviewer: pass ([Review](6b1a2249-d489-4b1c-a4dc-28899a991fa4))

## Blockers for next slice

None.

## Notes for implementer of L2

GET last full: `getLastFullPolicy`. Draft rows must not be served.

SDK is a library in this repo (`src/live/` or similar). It polls `GET /v1/runtime/policies/:project_id` on a timer (≤ 30 s), never on the user request. Verify seal with the Live API key (EvalRouter Bearer). Vendor calls use the **app** OpenRouter key, not `pkr_`.

If GET seal fails: keep last-known. If last-known file seal fails at start: do not send. Fail-open needs a verified last-known.

L2: primary call only. No backup (L3). No canary (L6). No samples (L4).
