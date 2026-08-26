# Handoff: slice 2

Status: passed
Next: slice 3 (started at once)

## Done-when (from BUILD.md)

- [x] `POST /v1/keys` stores a key and returns `pkr_...`
- [x] Fetch by id never returns the secret in JSON
- [x] Missing key on a later run path will be `suggested_args.keys_ref`

## Evidence

- Tests: `npm test` → 82 pass, 0 fail
- Demo: `POST /v1/keys` with `{ project_id, secret }` → `{ "keys_ref": "pkr_..." }`. `GET /v1/keys/:id` returns metadata only. `GET /v1/projects/:id` lists `keys_refs` without secrets. SQLite `keys_refs.ciphertext` is AES-256-GCM, not plaintext. `missingKeysRefError` sets `suggested_args.keys_ref`. `run_evals` is still `NOT_BUILT`.
- Reviewer: pass

## Blockers for next slice

None. Slice 3 is `generate_eval_suite` + draft accept (J1). It does not call OpenRouter. Do not run models.

## Notes for implementer of N+1

Dispatch currently maps every tool to `NOT_BUILT`. Replace the `generate_eval_suite` handler only. Keep one `POST /v1/tools/:name` route.

`registerTools` does not yet pass `db` into `dispatch`. Thread SQLite (and whatever else you need) through `ToolContext`. Do not open a second sqlite file.

Input/output Zod for `generate_eval_suite` already exists in `src/tools/schema.ts`. Ids: `src/ids.ts` has `newId(prefix)`. Add `job_`, `ste_`, `cas_`.

Schema must already be the J5 tables even though copy-forward lands later:

- `eval_sets(id, project_id, version, previous_eval_set_id, frozen_at)` — rows never updated in place
- `evals(id, …)` — example identity, not parented only by `eval_set_id`
- `eval_set_members(eval_set_id, eval_id)`

Version 1 is a real version. Do not implement `intent: "add_feature"` copy-forward (slice 9). `new_feature` is this slice.

Accept is HTML, not an agent tool. Computer-made evals stay `draft` until accept. Accepting a code eval makes it trusted. Rejected drafts are dropped. Do not run models.

Same `idempotency_key` must return the same `ste_` / `cas_` ids. Add an `idempotency` table if needed.

Do not edit `EVALROUTER_REQUIREMENTS.md` or `spec/`.
