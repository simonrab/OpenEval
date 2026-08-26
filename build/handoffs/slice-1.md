# Handoff: slice 1

Status: passed
Next: slice 2 (started at once)

## Done-when (from BUILD.md)

- [x] `POST /v1/tools/{name}` exists. Unknown name → 404 with `next_action`
- [x] Extra input field → reject (`additionalProperties: false`)
- [x] Unbuilt registered tool → stable `code`, not a crash
- [x] Mutating call without `idempotency_key` → reject when the spec requires it

## Evidence

- Tests: `npm test` → 71 pass, 0 fail
- Demo: `POST /v1/tools/generate_eval_suite` with `unexpected_field` → 400 `INVALID_INPUT` and `next_action`. `POST /v1/tools/run_evals` (valid body) → 501 `NOT_BUILT` with `next_action.tool = run_evals`. Unknown name → 404 `UNKNOWN_TOOL` with `next_action`. Slice 0 health/auth/projects still hold.
- Reviewer: pass

## Blockers for next slice

None. Slice 2 stores customer keys (`pkr_`). Do not call OpenRouter. Do not read `OPENROUTER_API_KEY` from the server env as the customer key.

## Notes for implementer of N+1

Dispatch is live: `POST /v1/tools/:name` → Zod parse → handler. All seven names currently map to `notBuiltError` (`NOT_BUILT`, HTTP 501). Replace a handler later; do not add a new route per tool.

Mutating tools require `idempotency_key`: `generate_eval_suite`, `queue_for_labeling`, `run_evals`, `recommend_models`, `register_failure`. Read-only: `get_label_status`, `get_eval_report`.

`keys_ref` is already an optional field on `run_evals` input. Do not implement `run_evals` in slice 2. Store keys, return `pkr_`, never leak the secret. A helper that puts `keys_ref` in `suggested_args` is enough for the “missing key on a later run path” check.

Auth: Bearer `EVALROUTER_KEY` on every `/v1` call. `buildApp({ sqlitePath, apiKey })` in tests. `src/ids.ts` has `newId(prefix)` / `newProjectId()`. Add `pkr_` the same way.

Do not edit `EVALROUTER_REQUIREMENTS.md` or `spec/`.
