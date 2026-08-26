# Handoff: slice 3

Status: passed
Next: slice 4 (stopped — needs OpenRouter key)

## Done-when (from BUILD.md)

- [x] Given a JSON-object job description. When `generate_eval_suite`. Then `ste_` exists, at least one eval, each tagged `draft`, counts for code vs person, `next_action` set.
- [x] Given a vague description. When generate. Then `JOB_UNCLEAR`, `ask_human: "what good means"`.
- [x] Given `what_good_means` after that. When generate again. Then draft pass/fail checks, still not trusted.
- [x] Given drafts on the accept screen. When the developer accepts code evals and rejects others. Then kept code evals are trusted. Rejected drafts are gone. No model was run.

## Evidence

- Tests: `npm test` → 95 pass, 0 fail
- Demo: `POST /v1/tools/generate_eval_suite` with “Return JSON with `line_items[]` and `total_cents`.” → `ste_`, version 1, code drafts, `next_action.tool = run_evals`. Vague description → `JOB_UNCLEAR`. Accept HTML at `GET /accept?eval_set_id=&token=` (HMAC). After accept, kept code evals are trusted; rejected membership is gone. No models run. Idempotency returns the same `ste_` / `cas_` ids. Extra fields still fail closed. Slices 0–2 still hold.
- Reviewer: pass

## Blockers for next slice

Needs OpenRouter key. Slice 4 is `run_evals` + program scoring + cost cap + `get_eval_report`. It calls OpenRouter for eval calls only (customer `pkr_`, never live traffic). Do not start slice 4 until that key is present. Write it into a `pkr_` via `POST /v1/keys`; do not put it in the server env as `OPENROUTER_API_KEY` for customer calls.

## Notes for implementer of N+1

Do not start until the orchestrator confirms an OpenRouter key exists.

`generate_eval_suite` is live. Other tools are still `NOT_BUILT`. Dispatch ctx now has `db` (and related fields). Eval-set schema is already the J5 shape: `eval_sets` + `evals` + `eval_set_members`. Do not parent evals only by `eval_set_id`. Do not edit frozen `ste_` rows in place.

Accept HMAC: `HMAC-SHA256("accept:{eval_set_id}")` with `EVALROUTER_KEY`. Trusted code evals exist only after accept.

JSON-object library already emits `json_valid`, `field_equals` (`line_items`, `total_cents`), `must_not_contain`. Score those with programs. Do not sit code evals in a mark queue.

`run_evals` is async: return `run_id` at once. Poll `get_eval_report`. Honor `max_eval_spend_usd`. Partial is not a pass. `live_traffic_changed` is always false. Include `ci_exit` now (`0` only on a complete pass). Accept `intent: "recheck"` and `named_model` on input; full recheck behavior is slice 10.

Customer keys: `keys_ref` (`pkr_`) or the project key. Decrypt via `readSecret` in `src/keys.ts`. Never log the raw key. Never send live user traffic.

Do not edit `EVALROUTER_REQUIREMENTS.md` or `spec/`.
