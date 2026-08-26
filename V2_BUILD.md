# EvalRouter V2 build order

Product truth lives in [EVALROUTER_V2_REQUIREMENTS.md](EVALROUTER_V2_REQUIREMENTS.md).
This file is the build order only.
If this file and the V2 requirements disagree, the requirements win.

Do not edit v0 or Live v1 product truth for V2 work.
Do not put this build order inside a spec.

## Slice V2-0: Stabilize Live v1

Make the TypeScript build pass.
Make all tests pass.
Finish Live v1 L8 if it is not complete.
Prove p99 added wait is 5 ms or less.
Prove a control-plane outage serves last-known policy.
Store a primary failure sample when backup succeeds.
Block stale rollout approval from a newer policy.
Validate sample policy ownership.
Include live report assets in the build.

## Slice V2-1: Product Contract

Add V2 product truth.
Add this V2 build file.
Add three V2 tool schemas.
Expose the same schema over HTTP and MCP.
Extend `get_live_report` with automation fields.

## Slice V2-2: Evidence Store

Add sample groups.
Add sample group states.
Add sample flood quarantine.
Add runtime stats event rows.
Keep project, policy, model, and feature on stats rows when known.

## Slice V2-3: Eval Candidates

Turn sample groups into draft eval candidates.
Prefer deterministic code evals.
Use person marks when code cannot score.
Do not trust model-only checks.
Stop the cycle when marks are required.

## Slice V2-4: Decision Cycle

Run one guarded decision cycle from an agent call.
Promote safe samples into v0 failures.
Run evals only in background work.
Call `recommend_models` from eval evidence.
Compile a signed policy from a recommendation.
Write append-only audit events.

## Slice V2-5: Guarded Policy Updates

Add automation rules.
Add kill switch.
Add freeze control.
Check allowed models and spend caps.
Check eval pass requirements.
Check live fallback, miss, and error limits.

## Slice V2-6: Auto-Canary

Publish a signed sticky 5 percent canary when guards pass.
Return an approval URL when guards do not allow auto-canary.
Keep live traffic unchanged from propose tools.

## Slice V2-7: Auto-Full And Rollback

Rollback immediately on safety breach.
Run rollback before full rollout.
Promote to full only after eval and live evidence pass.
Use the policy stored on the decision.

## Slice V2-8: Optional Proxy

Add OpenAI-compatible chat completions.
Add streaming pass-through.
Use the SDK policy engine.
Do not run evals on proxy requests.

## Slice V2-9: Agent Contract And Demo

Add an end-to-end demo.
Show miss to eval.
Show recommendation to auto-canary.
Show auto-full.
Show auto-rollback.
Verify MCP and HTTP parity.

