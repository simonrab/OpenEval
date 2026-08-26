# EvalRouter V2 requirements

This file is V2 product truth.

V2 adds Guarded Autopilot to EvalRouter Live.
V2 does not change v0 product truth.
V2 does not change Live v1 product truth.

A **sample group** is a set of safe live samples with the same redacted shape.
A **decision cycle** is one background pass over samples, eval evidence, and live evidence.
An **automation rule** is a human-approved limit for one project.
An **audit event** is an append-only record of a decision.

## 1. Product shape

EvalRouter remains an agent tool and an HTTP API.
The SDK remains the first runtime path.
An optional proxy can use the same policy engine.

The product must not sit in front of live traffic by default.
The product must not use a learned per-request picker.
The product must not run evals on a live user request.
The product must not rewrite prompts.
The product must not store raw live user text.

## 2. Autonomy

The default automation mode is `manual`.
Manual mode never changes live policy.
Guarded mode can act only inside approved automation rules.

The system can run `auto_canary` when guard rules pass.
The system can run `auto_full` when guard rules pass.
The system can run `auto_rollback` when guard rules pass.

Rollback has priority over full rollout.
Rollback has priority over canary promotion.
Rollback must be easier than promotion.

## 3. Trust

V2 reuses v0 eval trust rules.
A code eval can become trusted by program score.
A person eval needs a person mark.
A model-only check is never trusted.

Sample groups can create draft eval candidates.
A draft eval candidate is not trusted.
A decision cycle stops when person marks are required.

## 4. Guard Rules

Automation rules can limit allowed models.
Automation rules can limit eval spend.
Automation rules can require an eval pass rate.
Automation rules can limit live error rate.
Automation rules can limit fallback rate.
Automation rules can limit miss rate.
Automation rules can require canary age.
Automation rules can require canary traffic.
Automation rules can expire.

A kill switch blocks all promotion.
A freeze control blocks canary and full rollout.
Rollback can still run when freeze is active.

## 5. Public Tools

V2 adds these tools:

- `configure_live_automation`
- `run_live_decision_cycle`
- `get_decision_cycle_status`

All tools use the same JSON over MCP and HTTP.
All input schemas use `additionalProperties: false`.
Mutating tools require `idempotency_key`.
All tool results include `next_action`.

`get_live_report` must include automation mode.
`get_live_report` must include last cycle.
`get_live_report` must include pending action.
`get_live_report` must include blocked reason.
`get_live_report` must include decision ids.
`get_live_report` must include audit ids.

## 6. Runtime Evidence

Runtime samples must use a policy from the same project.
Runtime samples must store redacted text only.
Sample flood must go to quarantine.

Runtime stats must keep event rows.
Stats event rows must include project, policy, model, and feature when known.
Reports can use recent windows from event rows.

## 7. Policy Updates

Auto-canary publishes a signed sticky 5 percent canary.
Auto-canary can run only when guard rules pass.

Auto-full can run only after eval evidence passes.
Auto-full can run only after live canary evidence passes.
Auto-full must use the policy stored on the decision.

Auto-rollback runs on a safety breach.
Auto-rollback must not run evals first.
Auto-rollback clears the canary.

Approval URLs must apply only the stored target.
A stale approval URL must not apply a newer policy.

## 8. Proxy

The proxy is optional.
The proxy must use the same policy choice as the SDK.
The proxy must not run evals on the request path.
The proxy must stream tokens when the upstream stream is active.

## 9. Done When

Manual mode never changes live policy.
Guarded mode acts only inside approved limits.
A failed trusted eval blocks canary.
A P0 live miss blocks full rollout.
Auto-rollback beats auto-full.
Sample flood is quarantined.
PII sample stores no raw text.
A stale approval URL cannot apply a newer policy.
The SDK request path does not call the control plane.
The SDK request path does not run evals.
The proxy and SDK make the same policy choice.
MCP and HTTP return the same JSON.

