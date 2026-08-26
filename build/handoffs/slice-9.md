# Handoff: slice 9

Status: passed
Next: slice 10 (started at once)

## Done-when (from BUILD.md)

- [x] add_feature → new drafts, old evals stay, new version, old versions stay
- [x] recommend add_feature does not name model failing old trusted eval

## Evidence

- Tests: `npm test` → 188 pass, 0 fail
- Reviewer: pass

## Blockers for next slice

None. Customer OpenRouter key in user `.env` (store as pkr_ for runs).

## Notes for implementer of N+1

Slice 10 (J7): CI recheck. `examples/ci-recheck.sh` — POST run_evals intent recheck, poll get_eval_report, exit ci_exit. Must NOT call recommend_models. Must NOT write .env. Frozen ste_ not mutated. Partial/queued/running → non-zero. Named model fail → need_new_model, build fails.

Wire full recheck validation: NAMED_MODEL_MISMATCH, COST_CAP_REQUIRED, evals_missing_new_failures path.

Stop chain after slice-10.md passes review.

Do not edit spec or spec/.
