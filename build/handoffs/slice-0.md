# Handoff: slice 0

Status: passed
Next: slice 1 (started at once)

## Done-when (from BUILD.md)

- [x] `GET /health` returns 200 with no key
- [x] `POST /v1/projects` with a Bearer key returns `{ "project_id": "prj_..." }`
- [x] A bad or missing key returns 401
- [x] `npm start` creates SQLite on disk

## Evidence

- Tests: `npm test` → 11 pass, 0 fail (Node 22, `node --import tsx --test test/*.test.ts`)
- Demo: `GET /health` → 200 `{"ok":true}` with no key. `POST /v1/projects` with `Authorization: Bearer <EVALROUTER_KEY>` → `{"project_id":"prj_..."}`. Missing or bad key → 401. `npm start` creates WAL SQLite at `EVALROUTER_SQLITE` (default `data/evalrouter.sqlite`) with tables `api_keys` and `projects` only. Raw key is SHA-256 hashed; never stored.
- Reviewer: pass

## Blockers for next slice

None.

## Notes for implementer of N+1

Slice 0 already has Fastify, hashed Bearer on every `/v1` route, `buildApp({ sqlitePath, apiKey })`, and empty `dispatch` (`src/dispatch.ts`). Auth lives on a `/v1` plugin prefix; add `POST /v1/tools/:name` there so it gets the same key check.

Env: `EVALROUTER_KEY` required to start. Tests use `app.inject` plus a temp sqlite file. Keep that pattern.

`src/errors.ts` has unused `AgentError` / `NextAction` stubs. Replace them with the real envelope from requirements §12. Do not keep a second error shape.

Slice 1 is the tool contract only. Register all seven names. Unbuilt handlers return one stable not-built envelope with `next_action`. Do not implement generate/run/mark/MCP. Do not add OpenRouter. Do not add later tables.

Add Zod. `additionalProperties: false` on every tool input. Mutating tools take `idempotency_key` (reject when missing). Error codes must be a typed enum even if no handler returns them yet: `need_more_evals`, `does_not_work`, `need_new_model`, `evals_missing_new_failures`, `COST_CAP_EXCEEDED`, `JOB_UNCLEAR`, `PROJECT_NOT_FOUND`, `SUITE_NOT_FOUND`, `NAMED_MODEL_MISMATCH`, `COST_CAP_REQUIRED`.

Do not edit `EVALROUTER_REQUIREMENTS.md` or `spec/`.
