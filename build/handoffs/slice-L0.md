# Handoff: slice L0

Status: passed
Next: slice L1 (started at once)

## Done-when (from RUNTIME_BUILD.md)

- [x] Policy schema
- [x] HMAC seal
- [x] `pol_` row
- [x] `GET` with ETag

## Evidence

- Tests: `npm test` — 326 pass, 0 fail. `test/runtime-policy.test.ts` covers sign/verify, tamper, GET 200/304/401/404.
- Demo: `GET /v1/runtime/policies/:project_id` with Bearer. Signed JSON. `ETag`. `If-None-Match` → 304. Unknown project → `PROJECT_NOT_FOUND`. No row → `NO_LAST_KNOWN_POLICY`.
- Reviewer: pass ([Review](d3f2dd65-385a-409b-8245-adfa981bf8a1))

## Blockers for next slice

None.

## Notes for implementer of L1

Reuse `signPolicy` / `putPolicy` in `src/policy.ts`. The seal key is the EvalRouter Bearer API key. Do not UPDATE a published `pol_` row. Insert a new row.

L0 GET uses the latest signed row (`getLatestSignedPolicy`). Spec: first compile approve is last full at 100 percent. A later compile approve must not change GET. Add a last-full pointer (or role). GET must return last full, not the newest draft.

`NO_LAST_KNOWN_POLICY.next_action` is `tool: null`. Point it at `compile_policy` when that tool exists.

Do not add a proxy, dashboard, or learned picker.
