# EvalRouter Live — how to build

Product truth lives in [EVALROUTER_RUNTIME_REQUIREMENTS.md](EVALROUTER_RUNTIME_REQUIREMENTS.md). This file is the build order only. If this file and the Live requirements disagree, the requirements win.

v0 stays frozen in [EVALROUTER_REQUIREMENTS.md](EVALROUTER_REQUIREMENTS.md) and [BUILD.md](BUILD.md). Do not rewrite v0 into a proxy. Do not add Live jobs to v0’s seven tools.

Do not put this build order inside the Live spec.

**Do not auto-start Live slices.** v0’s slice chain is done. Wait for the user before slice L0.

Research that fed the spec (not product truth): [build/pm-runtime-brief.md](build/pm-runtime-brief.md), [build/runtime-user-research.md](build/runtime-user-research.md), [build/runtime-competitive.md](build/runtime-competitive.md), [build/runtime-architecture.md](build/runtime-architecture.md).

An **eval** is a product check on one example. Evals are not unit tests. TDD covers the Live API, the SDK hop, and HMAC policy bytes.

A **policy** is compiled live instructions. A **sample** is a redacted live miss. A **live hop** is the SDK in the app.

---

## 1. Language and split

**Control plane:** stay TypeScript on Node 22. Same `evalrouter serve` process. Add Live tools, compile, HMAC, sample ingest, tiny HTML screens. Do not send live user traffic through this process.

**Hop:** TypeScript SDK in the app process. Memory lookup, sticky hash, timeout, one backup, fail-open, async spool.

**Not in v1:** Go sidecar, Python SDK, Rust proxy, hosted reverse proxy, WASM checks.

The hop must feel fast. Product bar: p99 added latency ≤ 5 ms. Target ≪ 1 ms before the vendor call.

---

## 2. Architecture

```
Agent/MCP/CI ──► evalrouter serve (v0 + Live tools, SQLite)
                      │
                      │ background GET signed pol_  (never on the user request)
                      ▼
App process: Live SDK ──► OpenRouter / Ramp ──► model
     │
     └── spool samples ──► serve ──► register_failure (v0 J5)
```

All four Live tools go through existing `dispatch(name, body, ctx)`. Zod schema per tool. `additionalProperties: false`. Mutating tools take `idempotency_key`. Always `next_action`.

Screens that mutate (compile approve, sample promote/drop, rollout approve) are HTML handlers. They are not agent tools.

Store: same SQLite writer. New tables for `policies` and `samples`. Do not open SQLite from the SDK.

---

## 3. Slice order

| Slice | Ships | Jobs |
| --- | --- | --- |
| L0 | Policy schema, HMAC, `pol_` row, `GET` with ETag | shared |
| L1 | `compile_policy` + compile approve screen | **R1** |
| L2 | TypeScript SDK: memory policy, primary call, fail-open, last-known file | **R2** (no backup yet) |
| L3 | Timeout, one backup, streaming pass-through, fallback rate | **R2** complete |
| L4 | Async redacted samples, `PII_BLOCKED`, spool | **R3** |
| L5 | `promote_live_sample` + sample screen → v0 J5 | **R4** |
| L6 | `propose_rollout` + rollout screen: canary 5%, full, rollback; sticky hash; intended vs observed | **R5, R6** |
| L7 | `get_live_report` + read-only report URL; MCP schemas for the four tools | report + agent path |
| L8 | Demo harness: p99 ≤ 5 ms, kill control plane, north-star loop | done-when |

Shared from L0: `additionalProperties: false`, `next_action`, idempotency, truncate, no full traces, `live_traffic_changed` false on propose tools.

TDD on C-L0 through C-L8: HMAC verify, fail-open, one-backup cap, redact, sticky 5%, no default-50, CI must not call `propose_rollout`.

---

## 4. Done when (whole Live v1, not L2)

See Live spec section 13. The north-star demo is spec section 14.

Stop. Do not add a proxy, a dashboard, or a learned picker because a slice has spare time.
