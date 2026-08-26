# Handoff: slice 8

Status: passed
Next: slice 9 (started at once)

## Done-when (from BUILD.md)

- [x] register_failure → new ste_, new eval, all old evals, previous ste_ unchanged
- [x] program_check → trusted code eval, run_evals on new ste_, no mark
- [x] person-needed → draft, mark next
- [x] idempotency same ste_/cas_

## Evidence

- Tests: `npm test` → 183 pass, 0 fail
- Reviewer: pass

## Blockers for next slice

None.

## Notes for implementer of N+1

Slice 9: `generate_eval_suite` with `intent: "add_feature"` + eval_set_id — copy-forward via eval-set-copy.ts, new drafts, old evals stay. recommend_models must not name model failing old trusted evals.

All seven tools have handlers. add_feature was NOT_BUILT on generate until now.

Do not edit spec or spec/.
