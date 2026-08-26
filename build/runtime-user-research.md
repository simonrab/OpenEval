# EvalRouter Runtime — user research brief

**Status:** synthetic research. Feeds a Runtime spec. Not product truth.  
**Date:** 26 August 2026  
**Audience:** spec writers.  
**Language:** short sentences. Everyday technical words. One idea per sentence.

v0 already names a model. Runtime would put a **live hop** on the user request path. A live hop is the code that sends a real user request to a model. **Assessment** is scoring, capture, and recommend. Assessment stays off the request.

Founder constraint: the live hop must be quick. Assessment can be high-performance. Assessment must not sit on the request.

This brief is grounded in how coding agents (Cursor, Claude Code, Codex) and app developers actually ship AI features. No named-company quotes. Patterns below are composite.

---

## 0. Words for this brief

Keep v0 words. Add only what Runtime needs.

| Term | Meaning |
| --- | --- |
| Named model | The model id already approved in v0. What the app should call. |
| Backup | 0–2 models that also passed the same trusted evals. Candidate for fallback, not a secret extra model. |
| Live hop | The path a user request takes to a model. Runtime v1 would sit here. v0 does not. |
| Live policy | Named model, backups, canary percent, rollback target. A person approves it. Software does not invent it. |
| Canary | Send a percent of live traffic to a candidate model. The rest stay on the named model. |
| Fallback | If the named model errors (timeout, 5xx, 429), try a backup that already passed evals. |
| Assessment | Capture failures, score evals, recommend. Off the live request. |
| TTFT | Time to first token. Developers feel this. They will remove anything that adds a noticeable wait. |

Do not call evals "tests." Do not call Runtime a second OpenRouter. Do not call a named model a "route."

---

## 1. Who this is for

**Primary**

- Developer who ships an AI feature. They already have a named model from v0. They own quality, latency, and the PR.
- Coding agent (Cursor, Claude Code, Codex, or a custom agent). It calls JSON tools. It writes code and config. It does not mark. It does not invent trusted answers. It does not apply live policy.

**Secondary**

- Teammate who marks fuzzy evals when a program cannot. Same mark screen as v0. Live-captured failures may land in their queue.
- CI or a timer. Rechecks a frozen eval-set version. Fails the build. Does not change live traffic. Does not name a model. Does not mark.

**Not users**

- End users of the app. They never see EvalRouter.
- An eval-research person who wants a studio of experiments.
- A crowd of markers.

---

## 2. How they work today (v0, before Runtime)

The developer does not want a dashboard. They want the feature to work, a model name they can put in `.env`, and CI that fails if that name now fails.

The agent finishes loops with seven JSON tools and `next_action`. Humans accept drafts, mark only when a program cannot, and approve the name. The agent writes the approved id into app config. Live users still go: app → OpenRouter or Ramp → model.

That loop is the trust model Runtime must keep. Runtime adds a live hop. It does not replace evals, marking, or named-model approve.

What developers already refuse:

- Software that swaps the live model with no person.
- An extra hop they can feel.
- A website of experiments they must babysit.
- A YAML file the agent silently rewrites.
- Dumping production prompts into a set with PII still in them.

What agents already do well:

- Call a small tool list.
- Branch on `code`, not on `message`.
- Follow `next_action`.
- Stop and `ask_human` when the tool says to.
- Write an SDK call or an env var into the app after a person approves.

What agents already do badly:

- Treat a draft as applied.
- Write `.env` before approve.
- Invent a second config format (YAML, Helm values, a dashboard click) and skip the screen.
- Keep going after CI is red instead of following `next_action`.

---

## 3. Jobs to be done

### 3.1 Developer shipping an AI feature that already has a named model from v0

**When:** the feature works on evals. The named model is in config. They are about to serve real users, or they already do, and they want fallbacks and failure capture.

**They want:** the live hop to call that named model. If the vendor errors, try an approved backup. If a user gets a bad answer, that example should become a draft eval, not a Slack screenshot that dies. They still approve any live change.

**They do not want:** to pick a model per request. To sit in a routing UI. To add a second gateway they have to operate. To rewrite the prompt. To wait extra milliseconds on every chat token.

**Done when:**

- The app still calls OpenRouter (or Ramp) with a model id.
- That id is the approved named model, or an approved canary, or an approved fallback after a real error.
- TTFT is not worse in a way they can feel.
- Streaming still streams.
- A live failure can become a draft eval without them building a pipeline.
- Nothing on this path swapped the model by itself.

### 3.2 Coding agent implementing or configuring the live hop

**When:** the developer asked to add Runtime, or CI / a comment said to wire the hop.

**They want:** one install path. One SDK, or one base URL, plus one env var. MCP tools that tell them the next call. A policy object they can put in a PR. A hard stop before live traffic changes.

**They do not want:** a YAML schema with twenty keys. A dashboard to click. A proxy they cannot test locally. A tool named `apply_live_policy` that they will call by accident.

**Done when:**

- The hop is in the app as a small client change.
- `next_action` pointed at a policy screen, not at a mutate-live tool.
- The PR shows the named model, backups, and canary percent as data a person can read.
- The agent did not enable the hop, raise the canary, or roll back.

### 3.3 Developer when production quality drops

**When:** users complain, or fallback rate spikes, or answers look worse, and logs are not enough.

**They want:** the bad examples already captured (redacted). A short report: what failed, which eval ids, fallback rate, canary vs named model. Then the v0 loop: accept or mark, recheck, maybe a new name. They approve the next live policy. The app does not auto-swap while they sleep.

**They do not want:** to paste traces into a chat. To open an experiment table. To have the live model change under them. To discover that fallbacks have been serving 80% of traffic all week.

**Done when:**

- Failures are draft evals on a new eval-set version. Old evals stayed.
- PII is not in the eval.
- CI is red if the named model now fails trusted evals.
- Live traffic is still on the last approved policy until they say otherwise.
- They have a rollback that does not need the control plane to be healthy.

### 3.4 Agent when CI fails a recheck after live failures were registered

**When:** live capture (or a hook) called `register_failure`. CI ran `intent: "recheck"` on a version that now includes those evals. The build is unsuccessful. Codes are `need_new_model`, `need_more_evals`, `evals_missing_new_failures`, or `does_not_work`.

**They want:** the same v0 branch table. Switch on `code`. Follow `next_action`. Ask the human to mark or to open the named-model / live-policy screen. Do not write live policy. Do not call `recommend_models` if they are the CI job (they are not; a later agent is).

**They do not want:** a new "incident" tool. A trace dump. A guessed model id in `.env`. Promoting a canary to 100% to make the build green.

**Done when:**

- If the failure needs a person: `ask_human: "open mark_url"`. Build stays red until trusted.
- If the named model fails: agent calls `recommend_models` with `intent: "after_failure"`. Name is a recommendation. Live policy unchanged.
- If backups also fail: `does_not_work` plus failing eval ids. No fake name.
- Config and live policy are untouched until a person approves.

### 3.5 Person who must approve a risky live change (canary → 100%)

**When:** a candidate has been on a small percent. Someone wants all live traffic on it. This is higher stakes than approving a name into `.env`.

**They want:** one screen. Candidate vs named model on quality, time, cost, error rate, and fallback rate. Eval ids that failed on either. The rollback target. Then promote, keep canary, or roll back. The click is theirs.

**They do not want:** the agent to promote because the report "looked good." A dashboard of every experiment. A learned router that is already sending 100% "because it is winning."

**Done when:**

- Promote is a screen, not a tool.
- 100% is explicit. It is not the default when a percent field is missing.
- Rollback is one action and does not require a new eval run first.
- The agent may write the approved policy into the app after this click. The control plane does not flip traffic by itself if the SDK already holds the last policy.

---

## 4. What they need for this to be effective

### 4.1 Install

One path. Three things, not a menu.

1. **SDK** (preferred). Same shape as the OpenAI-compatible client they already use. Policy is applied in-process. The SDK calls OpenRouter or Ramp directly. No extra network hop.
2. **One env var** for Runtime (example: `EVALROUTER_POLICY` or a signed policy blob plus `EVALROUTER_KEY`). They already have the named model in config from v0. Do not add a stack of `ROUTER_*` keys.
3. **MCP tools** for the agent loop. Same JSON as `POST /v1/tools/{name}`. Same `next_action` rules as v0.

YAML as the source of live policy will fail. Agents rewrite YAML without waiting. Dashboards as the install path will fail. These developers skipped the eval website in v0 on purpose.

A hosted reverse proxy is the fallback install, not the default. Use it only if they cannot change the client. It must stream. It must not add a noticeable TTFT. It must keep working on the last policy if the control plane is down.

### 4.2 Trust

They will not let software auto-swap the live model.

v0 already taught them: recommend, then a screen, then the agent writes config. Runtime must use the same shape for live policy.

Gates that stay human:

- Accept live-captured draft evals (existing accept screen).
- Mark when a program cannot (existing mark screen).
- Approve a new named model or backup list (existing named-model screen).
- Enable the live hop the first time.
- Change canary percent, including 0% and 100%.
- Rollback.

The agent may draft a policy. The agent may write files after approve. The agent may not apply.

`live_traffic_changed` must stay honest. If a tool cannot change traffic, it is `false`. Do not add a mutate-live tool in v1.

### 4.3 Latency

They will rip out anything that adds noticeable TTFT.

Implications:

- Do not score on the request.
- Do not call a second model as a live judge.
- Do not fetch policy from the control plane on every request.
- Cache the last approved policy in the SDK (or in the proxy process).
- Assessment is async. Sample. Queue. Cap spend. Same cost-cap idea as `run_evals`.
- Streaming is pass-through. No buffering the full answer before the first token.

A local SDK hop that reads a signed blob should be well under a millisecond. An extra 80 ms HTTP hop to a hosted router is a product bug, not a tradeoff they will accept.

### 4.4 Debuggability without an eval website

They will debug from the PR, the CI log, and one short report. Same as v0 J8.

They need, in the agent payload and on `report_url`:

- Named model, backups, canary percent (intended).
- Observed split (actual percent that hit the candidate). Intended vs observed must both be visible.
- Fallback count and rate. Which backup was used.
- Pass/fail counts, time, cost (assessment, not live).
- `failing_eval_ids` and one-line `reason_short`.
- Whether new live failures are missing from the eval set (`evals_missing_new_failures`).
- Rollback target.

They do not need: trace explorer, dataset table, experiment comparison grid, per-request model picker UI.

A live-policy JSON document in the repo or in the report is enough for "what is production doing."

### 4.5 Agent affordances

Keep the v0 contract. Small output. Enums to branch on. Always `next_action`. Truncate input/output. No full traces.

Reuse these tools:

- `register_failure` (live capture calls this, or the agent does)
- `queue_for_labeling` / `get_label_status`
- `run_evals` / `get_eval_report`
- `recommend_models` (`after_failure` when the named model now fails)

Add only a few Runtime tools (see §7.3). Do not add `compare_models`, trace ingest, or drift detect as extra tools. v0 already listed those as out.

Error codes the agent must be able to switch on (add to the closed enum, do not parse `message`):

| code | meaning | next |
| --- | --- | --- |
| `POLICY_NOT_APPROVED` | Draft live policy exists. Not live. | `ask_human` to open the policy screen |
| `CANARY_PERCENT_INVALID` | Percent missing, not 0–100, or not an integer | Fix args. Do not default to 50 |
| `LIVE_HOP_DISABLED` | SDK present, hop not enabled | Policy screen |
| `CONTROL_PLANE_UNREACHABLE` | Assessment or policy fetch failed | Live hop must still use last policy. Agent reports. Do not fail user requests |
| `PII_BLOCKED` | Capture refused to store the example | Redact or drop. Do not register raw |
| v0 codes | `need_more_evals`, `need_new_model`, `does_not_work`, `evals_missing_new_failures`, `COST_CAP_EXCEEDED` | Same as v0 |

CI still never calls `recommend_models`. CI still never writes config. CI still never changes live traffic.

### 4.6 What must stay a screen vs a tool

**Screen (person). Not a tool.**

- Accept / edit / reject draft evals, including live-captured ones.
- Mark fuzzy evals. Second person. Third if they disagree.
- Approve or reject a named model (v0).
- Approve live policy: enable hop, set canary percent, promote to 100%, roll back.

**Tool (agent or CI).**

- Read current live policy (`get_live_policy`).
- Propose a draft policy (`propose_live_policy`). Does not apply.
- Register a failure. Run evals. Get a short report. Recommend a name.
- Queue for marking. Poll mark status.

If a Runtime action can take production down, it is a screen.

---

## 5. Failure stories

These are composite. Use them as spec tests, not as anecdotes.

### 5.1 Silent quality drop

The named model still returns 200. Answers get worse over a week. Vendor weights changed, or the canary is worse and nobody looks. There is no eval website, so nobody "sees drift." Users complain late.

**Need:** sample live failures into draft evals. Recheck on a timer or on CI. Short report with fail ids. Do not auto-swap. Fail the build. Person decides.

### 5.2 Fallback storm

Named model starts returning 429. SDK falls back. Backup also 429s. Retries multiply. Traffic to both vendors spikes. Cost and errors explode. The "backup" is now the primary and it never passed as a primary under this load.

**Need:** retry budget. Circuit break. Fallback only on timeout / 5xx / 429, not on 4xx from bad input. Cap fallbacks per request (one backup, not a chain of eight). Surface fallback rate on the short report. If fallback rate is high, that is an incident, not a silent success.

### 5.3 PII leaking into evals

Live capture stores the raw prompt. A support transcript with names, emails, card-like numbers lands in the mark queue. The second marker should not see it. The eval set is now a liability.

**Need:** redact before persist. Truncate. No full traces (already v0). Prefer a program check plus a hashed or stripped input. If redaction fails, `PII_BLOCKED` and drop. Marker sees the same redacted input the eval will use.

### 5.4 Agent writes config without approval

The agent calls `propose_live_policy` with canary 100% and then edits `.env` in the same turn. The developer never opened the screen. Traffic moves.

**Need:** no apply tool. File write after approve is allowed only when the policy screen has a signed approval, same pattern as v0 named-model approve. Without that, `POLICY_NOT_APPROVED`. Review in the PR still matters, but the product must not treat propose as apply.

### 5.5 Extra hop adds 80 ms

Runtime is installed as a hosted proxy in front of OpenRouter. Every request pays an extra RTT. TTFT jumps. The team removes Runtime in a day and goes back to `MODEL=` in env.

**Need:** SDK-local policy as the default hop. Proxy is optional and must have a published TTFT budget. If the hop cannot stay in the noise, it does not ship.

### 5.6 Canary on 5% is actually 50%

Percent is stored as a string, parsed wrong, or hashing uses a constant. Half of users get the candidate. Support tickets look like "random quality." The screen still says 5%.

**Need:** integer percent 0–100. No default to 50 on parse fail. Fail closed to the named model. Hash a stable id (user if present, else session, else request). Log intended vs observed. `get_live_policy` and the short report show both. Promote to 100% is a separate approved action, not a hash bug.

### 5.7 Control plane down takes prod down

Policy is fetched on every request. EvalRouter `serve` is down. The chat feature returns 503. EvalRouter was supposed to be off the live path in v0. Runtime just became a hard dependency for the whole app.

**Need:** last approved policy lives with the app (env blob, local file, in-process cache). User requests do not require the control plane. Assessment and new approvals can wait. `CONTROL_PLANE_UNREACHABLE` is for the agent and for capture, not for the user.

### 5.8 Streaming broken by the proxy

The proxy buffers the full completion to log it or to score it. Chat UI waits for the whole answer. TTFT becomes TTFB for the full body. Developers blame Runtime and remove it.

**Need:** pass-through streaming. Capture is sampled and async after tokens are already on the wire. Scoring is never on the request. If you cannot stream, you cannot be on the hop.

---

## 6. Anti-needs

Do not build these in Runtime v1. They conflict with how these users work, and they conflict with v0 out-of-scope.

- **Dashboard of experiments.** Tables of runs, datasets, leaderboards. They already refused this. A read-only `report_url` and three small screens are enough.
- **Prompt rewrite.** The hop sends the app’s prompt. It does not improve it.
- **Learned black-box router.** No per-request model pick from a trained policy. The named model is the point of v0. Runtime applies that name, plus explicit canary and fallback.
- **Crowd labeling.** Two named people plus a third. Same as v0. Live volume is not an excuse to open a crowd.
- **Second model as live judge.** No extra model call on the user request to score the first model. A judge to create the first trusted answers is already out of v0. A live judge also blows the latency budget.

Also keep these out, as in v0:

- CI naming a model or writing config.
- CI marking.
- Auto-swap of the live model.
- Editing a frozen eval-set version in place.
- Extra agent tools for compare / traces / drift.

---

## 7. Implications for the spec

### 7.1 Must-haves in Runtime v1

1. **SDK-local live hop** that sends the approved named model to OpenRouter or Ramp. Default install. No extra hop.
2. **Live policy object:** named model, 0–2 backups, canary percent, rollback target, enabled flag. Versioned. Last approved copy cached with the app.
3. **Fallbacks** only after vendor error, with a retry budget and a visible fallback rate.
4. **Canary** with integer percent, intended vs observed, fail closed to the named model.
5. **Human gate** for enable, percent change, promote to 100%, rollback.
6. **Capture** of sampled live failures as draft evals via `register_failure`. Copy-forward eval-set versions. Old evals stay.
7. **Redaction** before persist. Truncate. `PII_BLOCKED` if it cannot store safely.
8. **Assessment off the request.** Async. Cost cap. Same runner as v0. High-performance is allowed here. It must not block TTFT.
9. **Streaming pass-through** on any hop, SDK or proxy.
10. **Control plane optional at request time.** Down does not take prod down.
11. **Same agent contract:** MCP + HTTP, `next_action`, closed error enum, short report (J8).
12. **CI unchanged in spirit:** recheck, fail the build, never change live traffic.

### 7.2 Must-nots

- Score or judge on the live request.
- Fetch policy from the control plane on every request.
- Auto-swap or auto-promote canary to 100%.
- Per-request learned routing.
- Prompt rewrite.
- Eval dashboard / experiment studio.
- Crowd marking.
- Apply-live as an agent tool.
- Default canary to 50% on bad input.
- Require Runtime availability for the app to answer.
- Buffer streams.
- Store raw PII in evals.
- Call Runtime a replacement for OpenRouter.

### 7.3 Agent tool list proposal (small)

Keep the seven v0 tools. Add three. Stop.

| Tool | Who | Does | Does not |
| --- | --- | --- | --- |
| `get_live_policy` | Agent | Read named model, backups, canary intended/observed, enabled, rollback target | Change traffic |
| `propose_live_policy` | Agent | Write a **draft** policy. Return `policy_url`. `next_action.ask_human` = open that URL | Apply |
| `get_live_report` | Agent / on-call | Short: fallback rate, canary split, capture counts, pointer to `get_eval_report` | Dump traces |

If `get_live_report` can be a view of `get_eval_report` plus a `live` block, do that instead of a third name. Prefer two new tools over three.

Capture from the SDK is not a fourth tool. The SDK POSTs `register_failure` (or an internal equivalent that ends in the same J5 rules).

No `apply_live_policy`. No `set_canary`. No `promote`. Those are the policy screen.

Happy path for "wire the hop" should be few calls: `get_live_policy` → (optional) `propose_live_policy` → `ask_human` open `policy_url`. Stop.

Happy path after CI red stays the v0 path: `get_eval_report` → maybe `queue_for_labeling` → `run_evals` → `recommend_models` with `after_failure` → `ask_human` open approve / policy URL.

### 7.4 Human gates

| Gate | Screen | After approve |
| --- | --- | --- |
| Draft evals from capture | Accept (existing) | Code evals become trusted. Fuzzy go to mark |
| Fuzzy live failures | Mark + second + third (existing) | Trusted for naming and recheck |
| New named model / backups | Named-model page (existing) | Agent may write model id into app config |
| Live policy (enable, canary %, 100%, rollback) | **New policy screen** | Agent may write the signed policy blob / env. Hop uses it |

The policy screen always shows: current named model, candidate, percent, intended vs observed, fallback rate, rollback target, failing eval ids if any. Actions: approve draft, promote, keep, roll back. Approving does not rewrite the prompt.

### 7.5 Copy / words that will confuse

| Avoid | Say instead | Why |
| --- | --- | --- |
| Router | Live hop, live policy | "Router" sounds like per-request pick, and like OpenRouter |
| Routing | Named model + canary + fallback | Same |
| OpenRouter (when you mean us) | EvalRouter Runtime, or the live hop | OpenRouter is the vendor gateway the app still uses |
| Named model vs "the route" | Named model (id to call) | v0 already defined this |
| Auto-scale / auto-tune the model | Recommend, then approve | Auto-swap is the trust break |
| Tests (for evals) | Evals | Product rule |
| Gold set / bake-off / pin | Eval set, run, named model | v0 banned undefined jargon |
| Intelligent routing | Canary percent you set | Learned black box is an anti-need |
| Proxy (as the default) | SDK | Proxy is the 80 ms and streaming story |
| Dashboard | Report URL, policy screen | They refused the website |

Product one-liner that will confuse: "We route your traffic to the best model." That is OpenRouter folklore plus auto-swap. Better: "The live hop calls the named model you approved. Fallbacks and canary are explicit. Assessment is off the request."

---

## 8. Success

### 8.1 In the developer’s week

They already have a named model from v0.

- The agent adds the SDK and one env var. The PR is readable.
- They open the policy screen. They enable the hop at 0% canary (named model only) or at a small percent they typed.
- Chat TTFT feels the same. Streaming still streams.
- Mid-week, a few bad answers show up as draft evals, redacted. They accept the code ones. A teammate marks one fuzzy eval.
- CI fails a recheck. The named model is still live. They are glad it did not silently swap.
- They open the short report. They approve a recommendation or they roll back. They do not log into an experiment studio.
- Later, a cheaper candidate sits at 5%. Observed is about 5%. They promote to 100% on the screen. Rollback is still one action.

If Runtime had added 80 ms, buffered the stream, or flipped 100% without them, they would have removed it this same week.

### 8.2 In the agent’s tool-call loop

Wire hop:

1. `get_live_policy`
2. `propose_live_policy` if a change is needed
3. Stop. `ask_human`: open `policy_url`

After CI red from live-registered failures:

1. `get_eval_report` (and `get_live_report` only if that is not the same payload)
2. If `need_more_evals`: `queue_for_labeling`, then poll `get_label_status`
3. `run_evals` if needed, poll report
4. `recommend_models` with `intent: "after_failure"`
5. Stop. `ask_human`: open named-model approve and/or `policy_url`

The agent never applies live policy. The agent never marks. The agent never invents a named model when a code fires. `next_action` is enough to finish without a dashboard.

---

## 9. What this brief is not

This file does not change `EVALROUTER_REQUIREMENTS.md`. It does not change `spec/`. v0 still forbids a live hop. Runtime is a later product. If Runtime is specified, it should take these jobs, gates, and must-nots as constraints.

Assessment stays the v0 loop (J1–J8). Runtime adds a live hop that applies an approved policy and feeds J5 without sitting on the request.
