# Handoff: slice L5

Status: passed
Next: slice L6 (started at once)

## Done-when (from RUNTIME_BUILD.md)

- [x] `promote_live_sample`
- [x] Sample screen
- [x] v0 J5
- [x] R4

## Evidence

- Tests: `npm test` — 407 pass, 0 fail.
- Demo: Promote with a program check makes a new `ste_` and copies old evals. Live last full stays. Screen promote or drop. Drop then promote returns `NOT_A_SAMPLE`.
- Reviewer: pass ([Review](3caad424-40fd-40b1-984c-3783ca11f0de))

## Blockers for next slice

None.

## Notes for implementer of L6

R5 and R6: `propose_rollout` plus a rollout screen. Intent is `canary`, `full`, or `rollback`. The tool does not apply. The tool returns `approve_url`. `live_traffic_changed` is false on the tool call.

Canary is 5 percent. Sticky hash of `user_id`, or `request_id` if there is no `user_id`. If both ids are missing, send last full. Do not send canary. If percent parse fails, stay on last full. Do not set 50.

Full: the canary policy becomes last full at 100 percent.

Rollback: last full at 100 percent. No eval run. The SDK loads on the next timer, in 30 seconds or less.

CI must not apply. There is no `apply_live_policy`.

`get_live_report` is L7. Still count intended vs observed and fallback on the hop and on the rollout screen. Do not add that tool yet.
