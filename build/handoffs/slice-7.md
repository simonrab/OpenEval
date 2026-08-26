# Handoff: slice 7

Status: passed
Next: slice 8 (started at once)

## Done-when (from BUILD.md)

- [x] Skip: code evals never in queue/mark screen
- [x] Mark: person evals only; two people mark independently
- [x] Disagreement: third person decides; mark trusted
- [x] Unfinished queue + too few trusted → need_more_evals + mark link (run_evals/recommend, not get_label_status)
- [x] Cannot-mark → eval not trusted

## Evidence

- Tests: `npm test` → 175 pass, 0 fail
- Reviewer: pass

## Blockers for next slice

None.

## Notes for implementer of N+1

Slice 8: `register_failure` + copy-forward new `ste_` (J5). Use eval-set-copy primitive. Code path with program_check → trusted, next_action run_evals. Person path → draft, queue_for_labeling. Idempotency same ste_/cas_. Old ste_ unchanged.

All tools live except register_failure still NOT_BUILT.

Do not edit spec or spec/.
