# EvalRouter Live — architecture notes

**Status:** research. Not product truth. Spec: [EVALROUTER_RUNTIME_REQUIREMENTS.md](../EVALROUTER_RUNTIME_REQUIREMENTS.md).  
**Date:** 26 August 2026.

## Split

v0 stays the control plane: TypeScript, Fastify, SQLite, seven tools, MCP, screens, CI. Never on live traffic.

Live is a new data plane: in-process TypeScript SDK. Optional Go sidecar is **out of v1**.

Central proxy and OpenRouter plugin are rejected. Extra hop blows the latency bar. Outage coupling. Dashboard gravity.

## Hot path

Memory pointer → sticky hash if canary on → vendor call with `timeout_ms` → on 5xx/429/timeout before first token, one backup → fail-open.

Never on this path: `run_evals`, `recommend_models`, person marks, LLM-as-judge, fixture exec, SQLite, cheap program checks (v1), policy compile.

Cheap checks after a buffered body were considered. Cut from v1 so “a cheap check” cannot become a suite on the request. Score samples in the background.

## Policy

Signed immutable JSON: `pol_`, `rec_`, `ste_`, primary, backups, `max_wait_ms`, canary permille, capture flags, HMAC.

Publish by background GET with ETag. Atomic pointer swap. Keep N−1 for rollback.

Control plane down: serve last-known. Spool samples. Do not 5xx the user.

## Bars (spec)

- p99 added ≤ 5 ms (target ≪ 1 ms in-process)
- 0 extra network hops on the happy path
- At most one extra model call per request
- Rollback = pointer swap, no eval run
