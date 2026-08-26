# EvalRouter — engineering sequence (full ship)

Product truth: [EVALROUTER_REQUIREMENTS.md](../EVALROUTER_REQUIREMENTS.md). If this file and the requirements disagree, the requirements win. [BUILD.md](../BUILD.md) is a shorter first-week cut. This file sequences the **whole v0 product**.

An **eval** is a check on one example. Input in. A score says whether the model did the job.

A **code eval** is scored by a program.

A **draft eval** is a suggested check. It is not trusted yet.

A **trusted eval** is one we will use to name a model.

An **eval set** is a versioned list of evals. New work makes a new version. Old versions stay.

A **named model** is the model id the agent should put in the app. We recommend it. We do not apply it to live traffic.

**Live traffic** is real user requests in the app. This tool never sends them and never switches the model that serves them.

**MCP** is a config file that lists tools the model may call. Same JSON body as `POST /v1/tools/{name}`.

Done-when for the product is J1–J8 in the requirements. Week 1 is a slice of that. It is not the product.

---

## 1. Language

The product surface is JSON in and JSON out. The bottleneck is model HTTP, not CPU.

### Compare

| Language | Fit | Cost |
| --- | --- | --- |
| **TypeScript (Node 22)** | Official MCP SDK. Zod maps 1:1 to tool JSON (`additionalProperties: false`, enums). Fastify for `POST /v1/tools/{name}`. One process for HTTP, runner loop, and mark HTML. Fast to ship typed JSON. Fast enough at runtime: this work is I/O wait on OpenRouter. | Single-process SQLite will need a later store if concurrent runs get large. That is a store change, not a language change. |
| **Python** | FastAPI and Pydantic are fine. Scoring scripts feel natural. Official MCP Python SDK exists. | Two habits fight: agent-tool JSON (strict schemas, enums, `next_action`) and notebook-style scoring. Typing is weaker than Zod for this contract. Cursor / Claude Code MCP is a TypeScript-first install path. Mark HTML in the same process is clumsier. |
| **Go** | Excellent HTTP and concurrency. One binary. Cost-cap accounting is easy. | MCP and JSON-schema tooling are second-class next to the TS SDK. You will rewrite every tool shape twice, or you will add a second language for MCP. Mark screens are templates plus more glue. Ship speed loses. |
| **Rust** | Fastest runtime. | Wrong problem. Runtime is model latency. Schema churn, MCP, and three small HTML screens will stall. Do not. |

### Pick

**Primary: TypeScript on Node 22.**

One language for HTTP, MCP, the runner, and the mark UI.

| Piece | How it uses TypeScript |
| --- | --- |
| **HTTP** | Fastify. `POST /v1/tools/{name}` calls `dispatch(name, body)`. |
| **MCP** | Official MCP SDK. Stdio process imports the **same** `dispatch` and the **same** Zod schemas. It does not re-declare tools. It does not HTTP-proxy the API unless you later run them on separate hosts. |
| **Runner** | In-process loop. `runs` table. No Redis. No second language. Customer keys call OpenRouter from this process. |
| **Mark / accept / approve UI** | Server-rendered HTML from the same Node process. Same SQLite. Same auth cookie or signed mark link. No React app. No separate frontend package. |

Do not add Python “just for scoring.” Code evals in v0 are small checks (`json_valid`, `field_equals`, `must_not_contain`, `tool_name`, `fixture`). Write them in TypeScript. If a later version must run a check in the customer repo, that is a subprocess with a fixed interface. It is not a reason to split the product now.

Store: SQLite (`better-sqlite3`) until concurrent runs force a move. Auth: one Bearer API key, hashed. Ids: prefix plus random suffix (`prj_`, `job_`, `ste_`, `cas_`, `run_`, `rec_`, `pkr_`).

---

## 2. Ordered slices

Eleven slices. Each one is demoable. Later slices add files. They do not rewrite the dispatch contract, the id scheme, or the eval-set version model.

Shared rules from slice 0 onward:

- `additionalProperties: false` on every tool input
- `next_action` on every success and every error
- mutating calls take `idempotency_key`
- truncate `input` / `output`; no full traces
- `live_traffic_changed` is always `false` when the field exists

### Slice 0 — Foundation (health, auth, project, store)

**Days:** 2

**Creates**

```
package.json
tsconfig.json
src/server.ts
src/auth.ts
src/ids.ts
src/db.ts
src/schema.sql
src/errors.ts
src/routes/health.ts
src/routes/projects.ts
src/dispatch.ts          # name → handler; empty map is fine
.env.example
test/health.test.ts
test/auth.test.ts
test/projects.test.ts
```

`schema.sql` holds `projects` and hashed API keys only.

**TDD**

- `GET /health` → 200, no key
- `POST /v1/projects` with Bearer key → `{ "project_id": "prj_..." }`
- missing or bad key → 401
- `npm start` creates SQLite on disk

**BDD:** none. No product job yet.

**Demo:** curl health and create a `prj_`.

**Unblocks:** every later slice. Auth and ids never change.

---

### Slice 1 — Tool registry, error envelope, `next_action`

**Days:** 2

Register all **seven** tool names now. Unbuilt tools return a single error code with `next_action`. Do not invent a second tool list for MCP later.

**Creates**

```
src/tools/schema.ts          # Zod for all seven inputs/outputs
src/tools/types.ts           # next_action union, error envelope
src/tools/not-built.ts
src/routes/tools.ts          # POST /v1/tools/:name → dispatch
test/dispatch.test.ts
test/errors.test.ts
test/tool-schema.test.ts
```

Error envelope (requirements §12):

```jsonc
{
  "code": "string",
  "message": "string",
  "retryable": true,
  "suggested_tool": "string" | null,
  "suggested_args": {},
  "next_action": { "tool": "...", "args": {}, "ask_human": null }
}
```

Wire every spec code as a typed enum even if no handler returns it yet: `need_more_evals`, `does_not_work`, `need_new_model`, `evals_missing_new_failures`, `COST_CAP_EXCEEDED`, `JOB_UNCLEAR`, `PROJECT_NOT_FOUND`, `SUITE_NOT_FOUND`, `NAMED_MODEL_MISMATCH`, `COST_CAP_REQUIRED`.

**TDD**

- unknown tool name → 404, `next_action` present
- extra input field → reject (`additionalProperties: false`)
- unbuilt registered tool → stable `code`, not a crash
- mutating call without `idempotency_key` → reject when the spec requires it

**BDD:** none. This is the contract the jobs will sit on.

**Demo:** `POST /v1/tools/generate_eval_suite` with an extra field fails closed. `POST /v1/tools/run_evals` returns the not-built envelope with `next_action`.

**Unblocks:** HTTP and MCP share one map. New slices fill handlers. They do not add routes per tool.

---

### Slice 2 — Customer keys (`pkr_`)

**Days:** 1

**BYO keys** means the customer supplies the API key. We do not resell tokens. We do not sit on live traffic.

**Creates**

```
src/keys.ts
src/routes/keys.ts
src/schema.sql            # add keys table
test/keys.test.ts
```

Store hashed metadata plus encrypted secret. Return `pkr_` only. CI later uses the project key. The agent later passes `keys_ref`. Never log the raw key.

**TDD**

- `POST /v1/keys` stores a key and returns `pkr_...`
- fetch by id never returns the secret in JSON
- missing key on a later run path will be `suggested_args.keys_ref`

**BDD:** none as a job. Required before J4 and J7.

**Demo:** create a `pkr_`. Show it on the project. Show the secret is not in the response.

**Unblocks:** `run_evals` and CI recheck.

---

### Slice 3 — `generate_eval_suite` + draft accept (J1)

**Days:** 4

A **job** is what the feature does, plus limits (images, max wait, max spend, allowed models).

Eval sets are **versioned from this slice**. Version 1 is a real version. Do not add a `version` column later.

**Creates**

```
src/tools/generate_eval_suite.ts
src/job-types/json_object.ts
src/job-types/unknown.ts
src/eval-set.ts              # create version 1; membership table
src/routes/accept.ts
src/accept.html
src/schema.sql               # eval_sets, evals, eval_set_members, jobs
test/generate_eval_suite.test.ts
test/accept.test.ts
test/eval-set-version.test.ts
```

Schema that later slices must not rewrite:

- `eval_sets(id, project_id, version, previous_eval_set_id, frozen_at)`
- `evals(id, …)` — example identity
- `eval_set_members(eval_set_id, eval_id)` — which version contains which eval

Copy-on-write later (J5/J6) inserts a new `ste_` and copies membership. It does not edit the old row.

Known type: JSON object out. Reuse that type’s score methods and hard examples. Add sample files from the call.

Unknown type: do not fake a match. Return `JOB_UNCLEAR`. Ask what good means. Write pass/fail checks from that text. Tag them `draft`. Do not invent trusted answers.

Prefer `score_how: "code"`. Split the rest as `"person"`. Computer-made evals stay `draft` until the developer accepts them.

Accept is a screen, not one of the seven agent tools. Accepting a code eval makes it trusted. Rejected drafts are dropped.

If every eval is code, `next_action.tool = run_evals` and `mark_url` is null. If some need a person, `next_action.tool = queue_for_labeling` and `mark_url` may still be null until slice 7 implements the queue. The **field** exists now.

**TDD**

- Zod input/output for `generate_eval_suite`
- idempotency returns the same `ste_` / `cas_` ids
- extra properties rejected

**BDD (J1)**

- **Given** a JSON-object job description. **When** `generate_eval_suite`. **Then** `ste_` exists, at least one eval, each tagged `draft`, counts for code vs person, `next_action` set.
- **Given** a vague description. **When** generate. **Then** `JOB_UNCLEAR`, `ask_human: "what good means"`.
- **Given** `what_good_means` after that. **When** generate again. **Then** draft pass/fail checks, still not trusted.
- **Given** drafts on the accept screen. **When** the developer accepts code evals and rejects others. **Then** kept code evals are trusted. Rejected drafts are gone. No model was run.

**Demo:** “Return JSON with `line_items[]` and `total_cents`.” Open accept. Accept the code evals. Show `ste_` version 1, trusted code evals, `next_action.tool = run_evals`.

**Unblocks:** runner, mark (via `score_how`), J5/J6 versioning.

---

### Slice 4 — `run_evals` + program scoring + cost cap + `get_eval_report` (J2, J8)

**Days:** 5

A **run** stores quality, time, and cost on the same examples.

A **cost cap** is the max dollars this run may spend on model calls.

**Creates**

```
src/tools/run_evals.ts
src/tools/get_eval_report.ts
src/runner/queue.ts
src/runner/worker.ts
src/runner/openrouter.ts
src/runner/spend.ts
src/scoring/json_valid.ts
src/scoring/field_equals.ts
src/scoring/must_not_contain.ts
src/scoring/tool_name.ts
src/scoring/fixture.ts
src/report.html              # read-only report_url; not a dashboard
src/schema.sql               # runs, run_eval_results
test/run_evals.test.ts
test/get_eval_report.test.ts
test/scoring/*.test.ts
test/cost-cap.test.ts
```

`run_evals` is async. Immediate output: `run_id`, `status: "queued"` or `"running"`. Poll `get_eval_report`. Do not block the agent turn.

Use `keys_ref` or the project key. Call OpenRouter only for these eval calls. Never send live user traffic.

Honor `max_eval_spend_usd`. Stop between evals. Store what finished. Return `COST_CAP_EXCEEDED` and the partial `run_id`. Report status `partial`. A partial pass is not a pass.

Default short model list size is 5. If `models` is set, 1–8.

Skip person evals in this slice only if they are not trusted. Score trusted code evals with the program. A code eval never sits in a mark queue (J2).

Too few trusted evals: do not run. Return `need_more_evals`. About 10 is the start bar. If every remaining eval is a code eval, at least 5 may be enough.

`get_eval_report`: paginate rows (default 20, max 50). No traces. No model output blobs. `live_traffic_changed: false`. Include `ci_exit` as a field even before the CI script exists: `0` only on a complete pass.

Accept `intent: "recheck"` and `named_model` on the input now. Recheck behavior that mutates nothing lands fully in slice 10. Do not add a second CI endpoint later.

**TDD**

- immediate `run_id`
- worker writes pass/fail, time, cost per eval per model
- cap mid-run → `partial`, listed scored vs not scored
- pagination cursor
- `PROJECT_NOT_FOUND` / `SUITE_NOT_FOUND`

**BDD (J2)**

- **Given** a trusted code eval (valid JSON, field equals, must-not-contain). **When** it is scored. **Then** a program scores every run. It never sits in a mark queue.

**BDD (J8)**

- **Given** a `run_id`. **When** `get_eval_report`. **Then** short summary: pass/fail counts, time, cost, missing-failure flag, `report_url`. Rows paginated. No traces.
- **Given** status `queued` or `running`. **When** report. **Then** `next_action.tool = get_eval_report` with the same `run_id`.

**Demo:** Accept five JSON code evals. Run two models with a $1 cap. Poll until `succeeded`. Show counts, p50 time, spend. Second run with a $0.01 cap returns `COST_CAP_EXCEEDED` and a readable partial `run_id`.

**Unblocks:** `recommend_models`, MCP happy path, CI polling.

---

### Slice 5 — `recommend_models` + approve (J4)

**Days:** 3

**Creates**

```
src/tools/recommend_models.ts
src/rank.ts
src/routes/approve.ts
src/approve.html
src/schema.sql               # recommendations
test/recommend_models.test.ts
test/rank.test.ts
test/approve.test.ts
```

**Hard limits** drop a model before quality: cannot see images, too slow, too expensive, not allowed.

Then drop models that fail trusted evals. If none remain: `does_not_work`, failing eval ids, `named_model` null.

If some remain: name the cheapest fast one that still passes. Name a slower or costlier model only if quality is clearly better and limits still hold. Return 0–2 backups. Backups must also pass.

Too few trusted evals → `need_more_evals`. Do not fake a name.

Developer approves or rejects on the named-model page. Approve means the **agent** may write the id into the app. This process does not write `.env`. This process does not change live traffic.

CI must not call this tool. The handler can still exist. The CI script in slice 10 must not import it.

**TDD**

- rank: cheapest-fast among passers
- failed eval → never named, never backup
- miss `max_wait_ms` → dropped
- missing `run_id` or run still going → `next_action` is `run_evals` or `get_eval_report`

**BDD (J4)**

- **Given** a trusted eval set and job limits. **When** `run_evals`, poll report, `recommend_models` with `intent: "new_feature"`. **Then** a `rec_` and a model id, or `does_not_work` with failing eval ids. Live traffic unchanged.
- **Given** too few trusted evals. **When** recommend. **Then** `need_more_evals`, no name.
- **Given** approve. **When** the agent writes `MODEL=` into the app `.env`. **Then** EvalRouter did not write that file.

**Demo:** Use the slice 4 run. Call `recommend_models`. Show named model, 0–2 backups, quality, time, cost. Approve. Agent writes `.env`. Confirm EvalRouter did not.

**Unblocks:** MCP end-to-end J1→J4. CI has a `rec_` to freeze.

---

### Slice 6 — MCP (same JSON as HTTP)

**Days:** 3

First-class install path. Not a leftover. Agents do not find this tool on the internet. You put it in MCP config, or you call the API with a key.

**Creates**

```
src/mcp/server.ts
src/mcp/stdio.ts
src/mcp/tools.ts             # generated from src/tools/schema.ts only
examples/mcp.json
test/mcp-dispatch.test.ts
```

MCP wraps `dispatch`. One schema file. HTTP remains the same JSON body. Do not fork handlers.

Register every name in the seven-tool list. Handlers that are not built yet still return the slice 1 envelope. When slice 7–10 fill them, MCP gets them with no MCP diff.

**TDD**

- each MCP tool input schema equals the HTTP Zod schema
- round-trip: MCP call ≡ `POST /v1/tools/{name}` body and output
- auth: same API key via env on the stdio process

**BDD:** J1 and J4 through the agent, not curl. Same Then checks as slices 3–5.

**Demo:** Cursor MCP config points at `node dist/mcp/stdio.js`. Agent describes the JSON job, calls generate / run / report / recommend, gets a named model, writes `.env` after approve.

**Unblocks:** coding-agent install. Mark and failure tools appear on the same server later without a second MCP package.

---

### Slice 7 — Mark screen, two-person agreement, third person (J3)

**Days:** 6

A **marked eval** is one a person scored because a program cannot decide (tone, fuzzy “good reply”). Two people must agree, or a third decides. Only then it is trusted.

This is a product surface. It is not a dashboard. One screen. One eval.

**Creates**

```
src/tools/queue_for_labeling.ts
src/tools/get_label_status.ts
src/mark/app.ts
src/mark/screen.html
src/mark/third.html
src/mark/agreement.ts
src/mark/forms.ts            # fields / pass-fail / rubric / tool / text / file
src/schema.sql               # mark_queue, marks, markers (two named + third)
test/queue_for_labeling.test.ts
test/get_label_status.test.ts
test/mark-agreement.test.ts
test/mark-screen.test.ts
```

`queue_for_labeling` queues only `score_how: "person"`. Never queues code evals. If `n_queued` is 0, `mark_url` is null and `next_action.tool = run_evals`.

Always show: what good means, the input, a draft labeled as a suggestion, the form for this job, submit or cannot-mark, how many are left.

Never show: code evals, the other person’s mark (until third), model names, run scores, a list of all evals.

Marks are independent. No chat. Two named people plus one third. Not a crowd.

Agreement: every required form field matches (trim on text/fields). Optional “why” is not part of agreement. Two accepts of the same draft agree. One accept and one edit disagree. A model draft is never trusted by itself.

States: waiting → one mark → disagree/wait third → trusted → cannot-mark or dropped. Only trusted is used to name a model.

Mark once per eval-set version. Later runs reuse the mark. The runner already scores by stored expected value. Wire person evals into the worker: compare model output to the trusted mark. Do not re-open the screen.

`enough_trusted` is false until the bar in the requirements. Then `next_action.tool = run_evals`. Untrusted evals do not block a name if enough trusted evals already exist.

`get_label_status` does not return `need_more_evals`. That code stays on `run_evals` / `recommend_models`.

**TDD**

- code eval id in `eval_ids` is ignored, not queued
- two matching marks → trusted
- mismatch → `need_third_person`
- third who already marked is rejected
- cannot-mark stores a reason, eval stays untrusted
- MCP schemas for the two new live tools already match (slice 6 registry)

**BDD (J3)**

- **Skip.** **Given** a program check. **When** scored. **Then** no mark screen, never in queue.
- **Mark.** **Given** evals with no program check. **When** people must decide. **Then** mark screen for those only. Two people mark independently. Order does not matter.
- **Given** disagreement. **When** a third person who did not mark this eval decides. **Then** their mark is trusted. The first two do not vote again.
- **Given** unfinished queue and too few trusted evals. **When** the agent asks for a named model. **Then** `need_more_evals` and a mark link. No fake name.
- **Given** cannot mark. **When** they submit a reason. **Then** the eval is not trusted.

**Demo:** Job with a tone check plus JSON checks. Queue skips JSON. Two people mark the tone eval. Trusted count rises. Force a disagreement. Third-person screen shows both marks after the input. Submit. `get_label_status` → `enough_trusted` → `run_evals`.

**Unblocks:** person-path J4. J5 failures that need a person. MCP can now finish the seven-call loop including mark tools.

---

### Slice 8 — `register_failure` + new eval-set version (J5)

**Days:** 4

A **failure** is a bad example. It is a candidate eval until `register_failure` adds it.

**Creates**

```
src/tools/register_failure.ts
src/eval-set-copy.ts         # copy members to a new ste_
test/register_failure.test.ts
test/eval-set-copy.test.ts
```

Copy every old eval into a **new** eval-set version. Add the example. New `ste_` id. New `version` number. Previous `ste_` is unchanged. Do not delete old evals. Do not edit the old `ste_` in place.

If the caller sent a program check, or the job type already has one that fits, the new eval is a trusted code eval. `next_action` is `run_evals` on the **new** `ste_`. No mark queue.

If a program cannot decide, the new eval stays draft. `next_action` is `queue_for_labeling`. CI cannot mark. A model may suggest a check. A program or a person must confirm.

Same `idempotency_key` returns the existing new `ste_` and `cas_`. No duplicate.

Old marks stay on the old version. Copied membership keeps the same `cas_` ids so J6/J7 can say “old evals stayed.” Marks are keyed by `(eval_set_id, eval_id)` only when the form meaning changed. For a pure copy, reuse the trusted mark. Do not ask people to mark the same example again on the new version unless the form fields changed.

**TDD**

- new `ste_`, `previous_eval_set_id` set, old row unchanged
- `old_eval_ids` equals the previous membership
- program_check → `score_how: "code"`, `trusted: true`
- no program check on a tone failure → draft, `mark_url` set
- idempotency

**BDD (J5)**

- **Given** a bad example and an existing eval set. **When** `register_failure`. **Then** a new `ste_` exists, the new eval is on it, every old eval is on it, the previous `ste_` still exists.
- **Given** a program check. **When** register. **Then** next `run_evals` on the new version includes the new eval **and** the old ones. No mark step.
- **Given** a person-needed failure. **When** register. **Then** draft, mark is next, not trusted.

**Demo:** Register “`total_cents` missing” with `field_equals`. Show version 2 = new eval + all of version 1. Show version 1 unchanged. Run version 2. Do not name a model that fails the old evals.

**Unblocks:** J6 (same copy primitive). J7 path `evals_missing_new_failures` → register. MCP tool becomes live.

---

### Slice 9 — `add_feature` keeps old evals (J6)

**Days:** 2

Same copy primitive as J5. New drafts for the new work. Developer still accepts. People still mark only what a program cannot score. They cannot drop old evals to make a new model look good.

**Creates**

```
# extend generate_eval_suite.ts (intent: add_feature)
src/eval-set-retire.ts       # retire = new version without that cas_; history kept
test/add_feature.test.ts
test/retire-eval.test.ts
```

`intent: "add_feature"` requires `eval_set_id`. Writes a new `ste_`. Union = old members + new drafts.

Going backwards on old work is not allowed in v0. Retire is a new version. History is not deleted.

`recommend_models` with `intent: "add_feature"` must not name a model that fails old trusted evals.

**TDD**

- missing `eval_set_id` on `add_feature` → reject
- new version membership ⊇ old trusted evals (unless retired in this version)

**BDD (J6)**

- **Given** an existing named model and new work. **When** `generate_eval_suite` with `intent: "add_feature"` and the existing `eval_set_id`. **Then** new drafts exist, old evals stay, new version exists, old versions stay.
- **Given** a model that fails an old eval. **When** recommend. **Then** that model is not offered for approval.

**Demo:** Add a new field to the JSON job. Show version 3 with old evals plus new drafts. Accept. Run. A model that misses an old `total_cents` check is not named.

**Unblocks:** grow-the-feature loop. CI still points at a frozen `ste_` until someone updates the CI vars.

---

### Slice 10 — CI recheck fails the build, never changes live traffic (J7)

**Days:** 4

A **recheck** runs the saved evals again with the same scoring. Same program checks. Same marked answers. Do not invent new expected answers.

**Creates**

```
src/ci/recheck.ts
src/ci/exit.ts               # map report → process exit
examples/ci-recheck.sh
examples/github-action.yml   # or equivalent; calls the script only
test/recheck.test.ts
test/ci-exit.test.ts
```

CI calls `run_evals` with `intent: "recheck"`, the frozen `ste_`, `named_model` (`rec_id` + `model_id`), and `max_eval_spend_usd` > 0. It polls `get_eval_report`. It must not exit 0 while status is `queued` or `running`.

CI does not call `recommend_models`. CI does not mark. CI does not write config. CI does not change live traffic.

Customer keys on the project. CI does not prompt for keys.

Map the report to a process exit:

| Result | `ci_exit` |
| --- | --- |
| Named model passed all trusted evals on the frozen version, inside time and spend limits, run complete, no new failures missing from the set | `0` |
| Any spec error code | non-zero |
| Still `queued` / `running` when CI’s clock runs out | non-zero |

Exit `0` is the only pass. A skip, a timeout, a partial run, or a draft-only set is not a pass.

If the named model fails: `need_new_model`, fail the build. If backups on the same `rec_` were also scored and also fail: `does_not_work`. If `new_failures` were given and are not in the set: `evals_missing_new_failures`, next tool `register_failure`, fail the build. If the cap stops the run: fail the build. Partial is not a pass. Too few trusted evals or a person-needed failure: `need_more_evals`, non-zero. CI does not mark.

`NAMED_MODEL_MISMATCH` if `rec_id` does not match `model_id`. `COST_CAP_REQUIRED` if the cap is missing or `<= 0`.

The frozen `ste_` is not mutated.

**TDD**

- recheck does not insert evals or versions
- scoring bytes equal the saved program check / mark
- `ci_exit` mapping table
- script exits non-zero on `partial`
- script never writes app `.env`

**BDD (J7)**

- **Given** a saved eval-set version and a named model. **When** CI calls `run_evals` with `intent: "recheck"` and polls the report. **Then** same evals, same scoring, pass/fail + time + cost for the named model. No new named model. Live traffic unchanged.
- **Given** the named model now fails. **When** recheck finishes. **Then** `need_new_model` (or `does_not_work` if backups on that `rec_` also failed), build unsuccessful, `.env` untouched.
- **Given** new bad examples not in the set. **When** recheck. **Then** `evals_missing_new_failures`, not a pass.
- **Given** cost cap mid-run. **When** stop. **Then** partial stored, build unsuccessful, live traffic unchanged.

**Demo:** Point the script at a frozen `ste_` and a named model that still passes. Exit 0. Break one fixture. Exit non-zero. Confirm app `.env` was not rewritten. Confirm `live_traffic_changed` is false.

**Unblocks:** v0 “first version is done when” in the requirements. Merge can fail closed without this tool sitting on live traffic.

---

## 3. Slice list (ordered)

| Slice | Days | Ships | Jobs |
| --- | ---: | --- | --- |
| 0 | 2 | Health, auth, `prj_` | — |
| 1 | 2 | Dispatch, seven-tool schemas, error envelope, `next_action` | shared |
| 2 | 1 | Customer keys `pkr_` | shared (J4, J7) |
| 3 | 4 | `generate_eval_suite`, versioned `ste_`, accept screen | J1 |
| 4 | 5 | `run_evals`, program scoring, cost cap, `get_eval_report` | J2, J8 |
| 5 | 3 | `recommend_models`, approve screen, agent writes `.env` | J4 |
| 6 | 3 | **MCP** — same JSON as HTTP | J1–J4 over the agent |
| 7 | 6 | **Mark screen**, `queue_for_labeling`, `get_label_status`, two-person + third | J3 |
| 8 | 4 | **`register_failure`**, copy-on-write eval-set versions, old evals stay | J5 |
| 9 | 2 | `intent: "add_feature"`, retire = new version | J6 |
| 10 | 4 | **CI recheck**, `ci_exit`, fail the build, never change live traffic | J7 |

**About 36 engineer-days.** One person: ~8 weeks. Two people: ~5 weeks if they use the parallelism below.

Week 1 can ship slices 0–3 (HTTP generate + accept) or stretch into slice 4. That is a demo. The product is slices 0–10.

---

## 4. Parallelism

Two people. Call them A (API / runner) and B (agent install / people screens).

| When | A | B | Must wait |
| --- | --- | --- | --- |
| Start | Slice 0 together, or A owns 0 | — | Store and ids first |
| After 0 | Slice 1 (dispatch + Zod) | Can draft `accept.html` markup against fake JSON | B must not invent a second schema |
| After 1 | Slice 2 keys, then slice 3 generate + eval-set schema | Slice 6 **MCP stub** against dispatch (not-built envelopes). Example `mcp.json`. | MCP stdio needs the registry. It does not need generate to work. |
| After 3 | Slice 4 runner + report + cost cap | Finish accept screen wiring. Job-type library extras. | Runner needs trusted evals and `pkr_` |
| After 4 | Slice 5 recommend + rank | MCP: turn on generate / run / report against live handlers | Recommend needs a succeeded run |
| After 5 | Rank edge cases, approve POST | Slice 6 complete: agent J1→J4 demo | — |
| After 6 | Slice 8 copy-on-write primitive (can start from slice 3 schema) | Slice 7 mark screen + agreement | Mark needs `score_how` and queue tools on dispatch. Copy needs membership tables from slice 3. |
| After 7+8 | Slice 9 `add_feature` + recommend `add_feature` / `after_failure` | Wire mark tools on MCP (no new MCP server) | J6 uses J5’s copy helper |
| After 9 | Slice 10 CI script + `ci_exit` | Fixture jobs and example workflows | Recheck needs frozen `ste_`, `rec_`, keys, report polling |

**Do not parallel:** two people inventing tool JSON. Slice 1 is a gate.

**Do not parallel:** a second store or a second dispatch for MCP.

**Safe parallel after slice 3:** B on mark HTML (slice 7) with fixture `ste_` rows, while A builds the runner (slice 4). Queue tools stay behind a flag until `score_how: "person"` exists in generate. Generate already splits code vs person in slice 3, so this is real parallel work.

**Unsafe parallel:** B building a React SPA while A builds HTML routes. Spec is one mark screen. One process. Server-rendered HTML.

---

## 5. How not to paint into a corner

1. **One dispatch.** HTTP and MCP call `dispatch(name, body)`. If MCP is a handwritten second list of tools, you will duplicate every field. Register all seven names in slice 1. Fill handlers later. MCP in slice 6 is a thin adapter. Slices 7–10 do not add a second MCP package.

2. **Eval-set membership from slice 3.** Do not store `evals.eval_set_id` as the only link. J5 copies membership to a new `ste_`. If you parent every eval to one set, `register_failure` rewrites slice 3. Use `eval_sets` + `eval_set_members`.

3. **Marks keyed per version.** People mark once per eval-set version. `(eval_set_id, eval_id, person_id)`. Frozen marks are what recheck uses. Do not store “the” mark on the eval row alone, or J6 form changes cannot keep old-version history.

4. **`intent` on `run_evals` and `recommend_models` from the first handler.** Include `recheck`, `add_feature`, `after_failure` in the enum in slice 4–5 even if CI does not exist yet. Do not add `/v1/ci/recheck`. CI is the same JSON. Slice 10 is a process exit around that JSON.

5. **Error codes are a closed enum.** Agents switch on `code`, not `message`. Add the full table in slice 1. Returning a new string from CI later will break the agent.

6. **`next_action` is never optional.** Screens are not tools. Accept and approve are HTML. They are not in the seven-call budget. Do not add `accept_drafts` as an eighth agent tool.

7. **Keys before the runner.** `pkr_` is an object with a prefix. Do not read `OPENROUTER_API_KEY` from the server env as the customer key. That turns you into a reseller and puts you next to live traffic.

8. **Cost cap in the worker, not in recommend.** Stop between evals. Persist partial rows. Recommend and CI both read `status: "partial"` + `COST_CAP_EXCEEDED`. Do not invent a second “budget” field for CI.

9. **Code vs person is data, not a later UI guess.** `score_how` is set in generate (slice 3). The mark queue (slice 7) filters on it. The runner (slice 4) already skips untrusted person evals. If generate marks everything `code`, the mark slice cannot save you.

10. **`report_url` is a read-only page.** Paginated rows. No dataset explorer. If slice 4 grows a table of experiments, you have built the out-of-scope dashboard. Keep `report.html` dumb.

11. **CI must not grow recommend.** Slice 10 maps codes to `ci_exit`. A later agent may call `recommend_models` with `after_failure`. The GitHub Action must not. If the script imports `rank.ts`, you will auto-swap in spirit even if you do not write `.env`.

12. **Do not freeze a week-1 schema that omits version.** BUILD.md’s first demo skips MCP, mark, failure versioning, and CI. That is a demo cut. The tables in slice 3 must already be the J5 tables. Otherwise slice 8 is a rewrite.

13. **Idempotency on every mutate.** Generate, register, queue, run. Same key, same ids. CI and agents retry.

14. **No live path.** No proxy in front of OpenRouter. No write to the customer’s production model slot. Approve + agent `.env` write is the only apply step. Put `live_traffic_changed: false` on the report in slice 4 so slice 10 cannot “forget” the field.

---

## 6. What v0 still does not build

These stay out. Do not sneak them into a slice.

- A proxy in front of OpenRouter, Ramp, or the model company
- Auto-swap of the live model
- Prompt rewrite
- A dashboard, experiment table, or dataset explorer
- Crowd marking
- Extra tools (`compare_models`, trace ingest, drift detect, `compile_label_schema`)
- CI calling `recommend_models` or writing the named model into the app
- Editing or deleting a frozen eval-set version in place
- Postgres, Redis, Kubernetes, or a second language
- A second model as judge to create the first trusted answers

---

## 7. Done when (product, not week 1)

Slices 0–10 are done when the requirements §14 list holds. Short form:

- Agent finishes J1 → J2/J3 → J4 in seven tool calls or fewer on the happy path (accept is a screen, not a call)
- Code evals never require a person and never sit in a mark queue
- People mark once per eval-set version; two agree or a third decides
- J4 names a model or returns `does_not_work`; never a fake name
- Too few trusted evals → `need_more_evals`
- J5 and J6 keep old evals on a new `ste_`; history is not deleted
- J7 rechecks a frozen `ste_`, fails the build if the named model now fails, does not change live traffic
- Cost cap stores partial results; partial is not a pass
- J8 is short: counts, time, cost, missing-failure flag, report URL, no traces
- MCP and HTTP send the same JSON
- The agent writes the named model into the app after approval; this tool does not
