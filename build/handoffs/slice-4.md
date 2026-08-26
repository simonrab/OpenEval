# Handoff: slice 4

Status: passed
Next: slice 5 (started at once)

## Done-when (from BUILD.md)

- [x] J2: trusted code evals scored by a program; never in mark queue
- [x] J8: `get_eval_report` short summary, pagination, no traces; poll while `queued`/`running`
- [x] Immediate `run_id` from `run_evals`
- [x] Cap mid-run → `partial` with scored vs not scored; `COST_CAP_EXCEEDED`
- [x] `live_traffic_changed: false`; `ci_exit` on report
- [x] `intent: "recheck"` and `named_model` accepted on input (full recheck behavior is slice 10)

## Evidence

- Tests: `npm test` → 121 pass, 0 fail
- Demo (mocked OpenRouter): five trusted code evals, two models, $1 cap → `succeeded`; $0.01 cap → `partial` + `COST_CAP_EXCEEDED` + readable partial `run_id`
- Reviewer: pass

## Blockers for next slice

None.

## Notes for implementer of N+1

`run_evals` and `get_eval_report` are live. Other tools still `NOT_BUILT` except `generate_eval_suite`.

Customer keys: `run_evals` requires `keys_ref` (`pkr_` from `POST /v1/keys`). Never read `OPENROUTER_API_KEY` from server env for eval calls. Decrypt via `readSecret` in `src/keys.ts`.

Worker: in-process loop in `serve`. OpenRouter chat completions in `src/runner/openrouter.ts`. Tests mock OpenRouter; no live calls in CI.

Scoring: `json_valid`, `field_equals`, `must_not_contain`, `tool_name` live. `fixture` is a stub (always passes).

Env: `npm start` and tests load `.env` via Node `--env-file` / `test/load-env.ts`. User `.env` has `EVALROUTER_KEY` and `OPENROUTER_API_KEY`. Store OpenRouter key as `pkr_` before running evals.

Slice 5 is `recommend_models` + named-model approve page (J4). CI must not call recommend. Approve does not write `.env`. `live_traffic_changed` stays false.

Do not edit `EVALROUTER_REQUIREMENTS.md` or `spec/`.
