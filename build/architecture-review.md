# EvalRouter architecture review

This is the full system, not a week-1 demo cut. MCP, the mark screen, eval-set versions, `register_failure`, and CI recheck are required work in the sequence below. They are not optional follow-ons.

Product truth is `EVALROUTER_REQUIREMENTS.md`. This file does not change that spec. `BUILD.md` is a shipping order only. Where `BUILD.md` defers MCP, marking, versioning, or CI, treat that as a demo tactic, not as architecture.

An **eval** is a product check on one example. Input goes in. A score says whether the model did the job. Evals are not unit tests. Unit and integration tests cover the API, runner, and MCP adapter. Those tests live in the repo. Evals live in a versioned eval set.

---

## 1. What the system is

EvalRouter is an **agent tool** and an **HTTP API**. An agent tool is a JSON function the model invokes. The HTTP path is `POST /v1/tools/{name}`. Same JSON body either way.

You install it. MCP config, or an API URL plus a key. **MCP** is a config file that lists tools the model may call. Agents do not discover this product on the internet.

It does not sit in front of OpenRouter, Ramp, or the model company. Live users still go: app → OpenRouter or Ramp → model. This process never sees live user requests. It never swaps the live model. It never rewrites the prompt.

The agent calls a tool, gets a **named model** (the model id to put in the app), and writes that id into app config after a person approves. CI calls the same JSON later to recheck a frozen eval-set version. If the named model now fails, CI fails the build. Live traffic stays on whatever the app already has.

Three ways in. Same steps after that.

1. New feature: describe the job, write evals, score, name a model or say none work.
2. Failure: a bad example becomes an eval on a new eval-set version. Old evals stay. Score and name again.
3. Change or timer: recheck the frozen version with the same scoring. Fail the build if the named model now fails.

Prefer a **code eval** (a program scores the example). People mark only when a program cannot. Mark once per eval-set version. Later runs reuse the mark.

Seven agent tools: `generate_eval_suite`, `queue_for_labeling`, `get_label_status`, `run_evals`, `recommend_models`, `register_failure`, `get_eval_report`. Developer accept of drafts, the mark screen, and named-model approve are screens. They are not agent tools.

Out of v0: a live proxy, auto-swap, prompt rewrite, an eval dashboard, crowd marking, LLM-as-judge to create the first trusted answers.

---

## 2. Language

I pick **TypeScript on Node 22** as the only application language in v0.

The product that must feel fast is the agent loop: typed JSON in, `next_action` out, a `run_id` at once, a short report that fits in context, a named model the agent can write. The expensive work is OpenRouter tokens and wait, not our CPU. Pick the language that is brilliant at JSON contracts, MCP, and I/O fan-out. Do not pick the language that is brilliant at a live proxy we are forbidden to build.

### What the runtime must do well

- Validate tight JSON (`additionalProperties: false`, enums the agent branches on).
- Speak MCP on day one, with the same tool bodies as HTTP.
- Fan out 1–8 model HTTP calls without blocking the agent turn.
- Serve one mark screen (and a small accept page, and a named-model page) from a link.
- Keep control-plane latency in a few milliseconds so the wait the user feels is the model, not us.
- Ship J1–J8, including marking, versions, and CI, without a second stack.

Scoring is `json_valid`, `field_equals`, `must_not_contain`, `tool_name`, plus a frozen person mark. That is not numeric science. Eval spend will dwarf our CPU on every real run.

### TypeScript wins

The official MCP SDK is TypeScript. Cursor, Claude Code, and most MCP servers in this install path already live there. Request and response shapes map cleanly to Zod. The seven tools are one `dispatch(name, body, ctx)` function with a Zod schema per name.

Node’s event loop is the right scheduler for this runner. Five to eight OpenRouter calls in flight is I/O wait. `Promise.all` plus a spend gate is the whole parallelism story. Native `fetch` on Node 22 is enough. No worker fleet.

One process can serve Fastify, the in-process run loop, and the HTML screens. MCP is a second process (Cursor spawns stdio) that calls the same HTTP API. One language, two entrypoints, one tool layer.

Time-to-ship for the full map (auth through CI) is shortest here. That matters because marking, versions, and CI are in the v0 done-when, not a later product.

Control-plane latency is irrelevant next to an 800 ms model call. Node still returns `run_evals` in a few milliseconds with a `run_id`. That is the speed the agent feels.

### Python loses

Python is the default for eval research libraries. EvalRouter is an agent JSON contract plus a runner. The spec forbids a DeepEval-shaped dashboard and forbids calling evals "tests." Python’s gravity well pulls toward both.

An MCP Python SDK exists. The reference SDK, Cursor’s config examples, and JSON-schema-as-code are TypeScript. FastAPI plus MCP becomes two servers or an awkward share of Pydantic models. The agent-facing surface is the whole product. Second-class MCP is a real loss.

The GIL does not decide this. We are I/O bound. Python’s usual "ML scoring" advantage also does not apply. We do not embed, classify, or train. We parse JSON and compare fields.

Startup and typing are worse for a CI helper and for `code` enums the agent must switch on. Pydantic is fine. Zod plus TypeScript is a better fit for `additionalProperties: false` tool bodies.

Do not add Python later for "eval scoring." That split would fork the tool layer. If a customer has a check in their repo, we exec their program. That program can be any language. It is not ours.

### Go loses

Go would be the right call if we sat in front of OpenRouter and had to schedule thousands of live requests. We do not. The spec bans that path.

Goroutines are excellent at HTTP fan-out. We need at most eight model calls and a short eval list (smoke ≤ 15, standard ≤ 60). Node does that without a design meeting. The bottleneck is token latency and the cost cap, not the scheduler.

MCP and the mark screen are first-class in v0. Go’s MCP SDK is behind TypeScript. The mark screen is form-by-job, independent dual mark, and a third-person view. Serving that as HTML from Node is small. Doing it in Go templates, or adding a second language for HTML, is extra cost for no product gain.

JSON tool contracts in Go are more boilerplate. Time-to-ship for J1–J8 grows. A static CI binary is nice. A shell client that POSTs `run_evals` and maps `ci_exit` is what the spec asks for, and TypeScript can also be `npx evalrouter recheck`.

Go becomes interesting only if we outgrow one process and SQLite: many concurrent runs, a worker fleet, a real queue. That is not v0. Do not build the v0 control plane in Go to prepay for that.

### Rust loses

Rust would save milliseconds we do not have. We spend dollars and seconds on model calls. We store no full traces. We do not parse huge blobs. We do not embed a scoring VM.

MCP, Zod-like input contracts, and the mark HTML would all be slower to ship. The agent loop would not feel faster. Rust is the wrong brilliance for this use case.

### Mixes lose in v0

TypeScript API plus Python scorer: the scorer is twenty lines. Two runtimes, two deploys, schema drift.

Go or Rust runner plus TypeScript MCP: the runner *is* `fetch` plus a spend gate. The tool layer must stay one function. A second language splits it.

TypeScript plus a React SPA: the spec allows three small screens (drafts, mark, named model) and a read-only report URL. No dashboard. Server-rendered HTML plus a little script. React is out of v0.

**Second language in v0: none.** HTML is markup. `examples/ci-recheck.sh` is a client. Customer fixture programs are theirs. Revisit Go only if a worker fleet is forced by concurrent runs SQLite cannot take. Do not start there.

---

## 3. Architecture

### Processes

Two long-lived processes, same codebase.

**`evalrouter serve`.** Fastify. `GET /health` with no key. `POST /v1/projects` and `POST /v1/tools/{name}` with Bearer auth. Serves `accept.html`, `mark/screen.html`, `mark/third.html`, the named-model page, and a read-only `report_url`. Runs the in-process worker loop. Holds the SQLite file.

**`evalrouter mcp`.** Stdio MCP server that Cursor (or another agent host) spawns. Default: it translates MCP tool calls to `POST /v1/tools/{name}` with the same JSON and the same API key. HTTP remains the source of the body. `dispatch` stays one function.

Do not let the MCP child open SQLite while `serve` is also running. Two writers on one file will hurt. Full install (mark screen, CI, agent at once) is: start `serve`, point MCP at `EVALROUTER_URL` plus `EVALROUTER_KEY`.

In-process MCP that imports `dispatch` and owns the file is only safe when nothing else writes that file. The mark screen and CI need `serve`. Treat HTTP-client MCP as the v0 default.

CI is not a third process of ours. It is a job in the customer’s pipeline. It POSTs `run_evals` with `intent: "recheck"`, polls `get_eval_report`, and exits with `ci_exit`. A timer can do the same.

Browsers hit the HTML screens. The second person finishes from `mark_url` alone. They do not get the agent API key.

```
Agent --stdio--> MCP adapter --HTTP Bearer--> serve --> dispatch --> tools
Agent/CI/curl -------------------HTTP Bearer--> serve --> dispatch --> tools
Person  --browser, signed mark token---------> serve --> mark handlers
Developer --browser, signed accept/approve---> serve --> accept / named-model
serve worker loop --> OpenRouter (customer key only, eval calls only)
```

Live app traffic never enters this diagram.

### One tool layer

All seven tools go through `dispatch(name, body, ctx)`.

- Zod schema per tool. `additionalProperties: false`.
- Auth and project membership already checked by HTTP (or forwarded by MCP).
- Mutating tools take `idempotency_key`. Same key returns the stored result.
- Every success and error includes `next_action`.
- Truncate `input` / `output` / `trace`. No full traces.
- Opaque ids: `prj_`, `job_`, `ste_`, `cas_`, `run_`, `rec_`, `pkr_`.

HTTP is `POST /v1/tools/{name}` → parse → `dispatch`. MCP is tool name + args → `dispatch` via HTTP. Screens that must mutate product state (accept drafts, submit a mark, approve a name) call internal handlers, not fake extra agent tools. Those handlers share the same store and the same trust rules.

Do not fork tool code for MCP.

### Data store

SQLite, one file, WAL mode, `better-sqlite3`. Enough for v0: few concurrent runs, one writer process.

Do not add Postgres or Redis until `serve` cannot keep up. Design tables so a later worker could claim a `runs` row. Do not build that fleet now.

Main tables:

| Table | Role |
| --- | --- |
| `api_keys` | Hash of the Bearer key. Never store the raw key. |
| `projects` | One AI feature. `prj_`. Optional default cost cap. |
| `jobs` | Description plus limits (images, max wait, max spend, allow/deny lists). `job_`. |
| `eval_sets` | One version. `ste_`, `version`, `previous_ste_id`, `project_id`. Rows are never updated in place. |
| `evals` | One example plus how to score. `cas_`, `score_how` (`code` \| `person`), program check, truncated input. |
| `eval_set_members` | `(ste_id, cas_id)`. A `cas_` can sit on many versions. |
| `people` | Named markers on the project (developer, second, third). Not a crowd. |
| `marks` | `(ste_id, cas_id, person_id, payload, role)`. Independent. |
| `mark_queue` | Person evals only. State for that version. |
| `runs` | `run_`, status, cap, spend so far, intent, `ste_id`, model list, `named_model` for recheck. |
| `run_results` | `(run_id, cas_id, model_id, passed, time_ms, cost_usd, reason_short)`. |
| `recommendations` | `rec_`, named model, 0–2 backups, source `run_id`. |
| `named_model_approvals` | Approve or reject. Approve does not write the app `.env`. |
| `keys_refs` | `pkr_`. Customer OpenRouter (or provider) keys, encrypted at rest. BYO. We do not resell tokens. |
| `idempotency` | Key plus stored JSON response. |

Draft accept is a status change on `(ste_id, cas_id)` for code evals. Rejected drafts are dropped from the set. They are not trusted.

### Eval-set versions

An **eval set** is a versioned list of evals. New work makes a new `ste_` and a new `version` number. The previous `ste_` stays. History is not deleted. v0 does not edit or delete a frozen version in place.

Copy-forward:

1. Insert a new `eval_sets` row. Point `previous_ste_id` at the old `ste_`.
2. Copy every `eval_set_members` row to the new `ste_`.
3. Copy frozen marks for those members onto the new version (same scoring).
4. Add the new eval (`register_failure`) or the new drafts (`intent: "add_feature"`).
5. New person evals start untrusted. New code evals with a program check are trusted after the spec’s accept rule (developer accept on generate; on failure, a supplied program check is enough).

Marks are per `(cas_id, ste_id)`. People mark once per version. Recheck of a frozen `ste_` reuses those marks. If the meaning of good or the form fields change, that is a new version. People may mark the new version. Old versions keep their marks.

`generate_eval_suite` with `intent: "add_feature"` uses this same copy-forward. The next run uses the union. You may retire an example that no longer happens only as a new version. Going backwards on old work is not allowed in v0. Do not name a model that fails old trusted evals.

CI pins a `ste_`. Recheck must not mutate it. `register_failure` always creates a different `ste_`.

### Auth

One hashed Bearer key on every `/v1` call. Missing or bad key → 401.

`/health` is open.

`mark_url` is a signed token (HMAC). It names the eval set, the person slot, and an expiry. The second person does not hold the agent key. The third-person URL is a different token. Tokens cannot see code evals.

Accept and named-model pages use signed developer tokens, or the Bearer key in a browser that already has it. Do not build a full login product in v0.

### Job queue (no Redis)

`run_evals` inserts a `runs` row and returns `{ run_id, status: "queued" | "running" }` at once. Work over two seconds is always async. The agent turn is not blocked. CI must not exit 0 while status is `queued` or `running`.

The worker is a loop in `serve`:

1. Claim the next `queued` row (transaction: set `running`).
2. Load trusted evals for that `ste_` only. Drafts waiting for a person are not scored as pass/fail.
3. Fan out model calls under the spend gate.
4. Write `run_results` as each eval returns. Stop between evals when the cap is hit. Finish the in-flight call. Do not tear down a row that already returned.
5. Set status `succeeded`, `partial` (cap), or `failed`.

On process boot, `running` rows with no worker are claimed again or marked failed and left readable. The `runs` table is the source of truth. Do not keep the only copy of progress in memory.

Too few trusted evals: do not run. Return `need_more_evals`. About 10 is the start bar. If every remaining eval is a code eval, at least 5 may be enough.

### Runner fan-out

Default short list size is 5. If `models` is set, 1–8. Customer keys only (`keys_ref` or project keys). Eval calls only. Never live traffic.

Each result stores quality, time, and cost on the **same** example.

**Spend gate.** Count only this run’s model-call spend. The call’s `max_eval_spend_usd` wins over the project default. CI must pass a cap `> 0` or get `COST_CAP_REQUIRED`.

Parallelism: one async call per model, evals sequential *inside* a model so we can stop between evals. A global gate decides if a new call may start:

- If `spend >= cap`, start nothing. Status `partial`. Code `COST_CAP_EXCEEDED`.
- If in-flight calls plus `spend` could exceed the cap by more than one call, wait until a call finishes.
- Spec allowance: spend may go past the cap by the last in-flight call, not by eight.

Without that gate, eight models near the cap would overshoot eight times. That is a bug.

When the cap hits, store which `cas_` ids ran and which did not. A partial pass is not a pass. CI fails the build. A later run may raise the cap. It must not skip failed evals from the partial set.

Code evals: program scores. Person evals: compare model output to the frozen mark for this `ste_`. Do not open the mark screen from the runner.

### How we name a model

`recommend_models` reads a finished (or usable partial) run. It does not call models. CI does not call this tool.

1. Drop models that miss hard limits (images, `max_wait_ms`, spend per 1k, allow/deny lists).
2. Drop models that fail trusted evals.
3. None remain → `does_not_work`, failing eval ids, `named_model` null.
4. Some remain → cheapest fast one that still passes. A slower or costlier model only if quality is clearly better and limits still hold.
5. 0–2 backups. Each backup must pass.
6. Too few trusted evals → `need_more_evals`. Do not fake a name.

Developer approves on the named-model page. Approve means the agent may write the id into the app. This process does not write `.env`. `live_traffic_changed` is always `false`.

### Mark screen (required, not later)

Only evals a program cannot score. `queue_for_labeling` never queues code evals. If `n_queued` is 0, `mark_url` is null and `next_action` is `run_evals`.

One screen. One eval. Always show: what good means, the input, a draft labeled as a suggestion, the form, submit or cannot-mark, how many are left. Never show: code evals, the other person’s mark (until third), model names, run scores, a list of all evals.

Two named people mark independently. Order does not matter. They do not chat in the product. If every required field matches (trim on text; same pass/fail; same rubric checks; same tool name and args; region within tolerance), the eval is trusted. Optional "why" is not part of agreement. If they disagree, a third person who did not mark this eval sees both marks and decides or drops.

A model draft is never trusted by itself. Two accepts of the same draft count as agreement. One accept and one edit is disagreement.

States for one eval on one version: waiting; one mark (not trusted); two marks disagree, need third; trusted; cannot-mark or dropped. Only trusted evals gate a name.

`get_label_status` returns counts including `need_third_person`. It does not mark.

### CI recheck (required, not later)

Same tools. `intent: "recheck"`. Frozen `ste_`. `named_model` (`rec_id` + `model_id`) required. Cap `> 0`. Poll until terminal. Map the report to a process exit.

Exit 0 only if: named model passed all trusted evals on that version, inside time and spend limits, run complete, no new failures sitting outside the set. Any job error code, a partial run, a timeout, a draft-only set, or still `queued`/`running` is non-zero.

CI does not call `recommend_models`. CI does not mark. CI does not write config. CI does not change live traffic. If the named model fails: `need_new_model` (or `does_not_work` only if this run also scored the backups on that `rec_` and they fail too). If `new_failures` were given and are not in the set: `evals_missing_new_failures`, then `register_failure`, then still fail the build.

---

## 4. Full build map

Each component is real work. Done means the Given / When / Then for the jobs it serves. Ship on HTTP and on MCP the same day a tool exists, because MCP is a transport over `dispatch`, not a later product.

Do not start a component until its dependencies can be demoed.

| ID | Component | Jobs | Depends on | Ships |
| --- | --- | --- | --- | --- |
| C0 | Repo, health, hashed Bearer auth, `POST /v1/projects`, SQLite file | foundation | none | `GET /health`, `prj_` id |
| C1 | `dispatch`, Zod contracts, idempotency, `next_action`, id prefixes | all tools | C0 | HTTP `POST /v1/tools/{name}` returns a structured error for unknown names |
| C2 | MCP stdio adapter as HTTP client of `serve` | install path | C0, C1, running `serve` | Cursor config can list tools. Empty list is not done; wire each tool as it lands |
| C3 | Eval-set store: immutable `ste_`, members, copy-forward helper | J5, J6, J7 | C0 | New version copies old members. Old `ste_` unchanged. No public tool yet |
| C4 | `generate_eval_suite` + known JSON-object library + unknown/`JOB_UNCLEAR` path + accept screen | J1, J6 | C1, C3 | Drafts tagged `draft`. Accept makes kept code evals trusted. `add_feature` copy-forwards |
| C5 | Code scoring: `json_valid`, `field_equals`, `must_not_contain`, `tool_name`, fixture exec | J2 | C4 | Code evals never enter a mark queue |
| C6 | `run_evals` + `runs` table + worker loop + OpenRouter client + spend gate | J4, J7 | C1, C3, C5 (person evals also need C9 marks) | Immediate `run_id`. Cap → `partial`. BYO keys. No live traffic |
| C7 | `get_eval_report` | J8, poll | C6 | Short page (default 20, max 50). No traces. `live_traffic_changed: false` |
| C8 | `recommend_models` + rank + named-model approve page | J4 | C6, C7 | Name or `does_not_work`. Approve does not write `.env` |
| C9 | `queue_for_labeling`, `get_label_status`, mark screen, third-person screen, dual-mark agreement | J3 | C3, C4 | Code evals never shown. Two agree or third decides. Mark once per version |
| C10 | `register_failure` | J5 | C3, C5; person path also C9 | New `ste_`. Program check → trusted code eval, skip mark. Else draft → queue |
| C11 | CI client: `examples/ci-recheck.sh` plus `ci_exit` on the report | J7 | C6, C7, C8’s saved `rec_`, C10 for missing failures | Exit 0 only on a complete pass. Recheck does not mutate `ste_` |

C2 stays open across the rest of the map. When C4 lands, MCP exposes `generate_eval_suite`. When C6–C8 land, MCP exposes run, report, recommend. When C9–C10 land, MCP exposes queue, label status, register. That is how MCP is in the sequence instead of a bolt-on after a HTTP-only demo.

### Dependency notes

- **MCP (C2) depends on dispatch, not on the mark screen.** You can call `generate_eval_suite` from Cursor as soon as C4 exists. You still must finish C9–C11 for v0.
- **Mark (C9) depends on eval sets, not on the runner.** Person jobs cannot be named until C9 is done. Code-only jobs can run after C8. C9 is still required product, because J3 is a v0 job.
- **Version copy-forward (C3) is a store primitive, not a slice you skip until failure intake.** C4 `add_feature`, C10 `register_failure`, and C11 frozen recheck all need it. If C3 is late, J5/J6 become edit-in-place. That is a spec bug.
- **Runner (C6) is shared by J4 and J7.** Do not build a second CI runner. Recheck is `intent: "recheck"` on the same worker.
- **Recommend (C8) depends on a run.** CI must not call it. C11 still depends on a saved `rec_` that C8 produced earlier in the project’s life.
- **`register_failure` (C10) code path depends on C3 and C5.** The person path also depends on C9, because a failure a program cannot score must return `mark_url` and `next_action: queue_for_labeling`. C10 is not done until both paths work. CI then fails a person-needed failure with `need_more_evals`.
- **Accept screen is part of C4**, not an agent tool. Without it, computer-made drafts would be trusted. That is fake gold.

### Suggested demo spine (still the full product)

A JSON-object job can walk C0–C8 with code evals only, including MCP, then C10–C11 with a `field_equals` failure and a CI script. That is a valid spine. It is not a license to skip C9. A second demo job (tone or fuzzy reply) must walk C9: two markers, a disagreement, a third decision, then run and name.

Happy path length: seven tool calls or fewer from J1 to J4, plus the accept screen. `queue_for_labeling` and `get_label_status` count when person evals exist.

### Implementation tests vs evals

TDD applies to C0–C11 code: auth, dispatch, copy-forward, spend gate, agreement, `ci_exit`. Write a failing unit or integration test, then the code.

J7 failing the customer’s build when the named model misses evals is a product job. Do not call those evals tests in copy, APIs, or user-facing strings.

---

## 5. Risks

### Goodhart

**Goodhart:** when a measure becomes a target, people change the work to hit the measure, and the measure stops meaning "the feature works."

Here the target is "named model passes the eval set." A developer can write only easy evals, reject hard drafts, or try to drop old evals so a cheaper model looks good.

Mitigations already in the spec: known types include hard examples; drafts need accept; old evals copy-forward; you cannot edit a frozen `ste_` in place; retire is a new version with history kept; do not name a model that fails old trusted evals; too few trusted evals returns `need_more_evals`, not a name. Keep retire rare and explicit. Do not add a "delete eval" API in v0.

### Fake gold

**Fake gold:** treating a model-written expected answer or pass/fail as truth.

`generate_eval_suite` may use a type library with no model. A model may suggest a draft eval or a draft answer. Computer-made evals stay `draft` until the developer accepts. On the person path, accepting a draft is that person’s mark. Two people must still agree (or a third decides). A model does not create a trusted eval by itself.

v0 does not use a second model as judge to create the first trusted answers. CI does not mark. Recheck does not invent new expected answers.

Do not have `generate_eval_suite` call candidate models to score. That tool writes drafts. It does not run the model list.

### Cost caps

Caps are easy to get wrong in a parallel runner. Eight in-flight calls can blow past the cap eight times. Use the spend gate above. Store partials. Never treat `partial` as a pass. CI fails. The last in-flight call may finish.

`max_eval_spend_usd` is required for CI and must be `> 0`. Default list size 5. Agents will still pass tiny caps. Make `COST_CAP_EXCEEDED` and the partial `run_id` obvious in `next_action`.

BYO keys: the customer pays OpenRouter. We still enforce the cap so a stuck loop does not drain them.

### Async jobs

Agents and CI will poll too fast, exit early, or lose a `run_id`. `run_evals` returns at once. `get_eval_report` is the poll. `next_action` says to poll while `queued` or `running`. CI must not map those statuses to exit 0. Process crash: resume from `runs`.

Idempotency on `register_failure` and other mutators prevents duplicate `ste_` rows when CI retries.

MCP and HTTP must share status. If MCP called a local SQLite and HTTP another, the agent would poll a run that does not exist. That is why MCP is an HTTP client of `serve`.

### Agreement (not IAA)

**IAA** (inter-annotator agreement) is a statistical score of how often two people mark the same way, such as percent agreement or Cohen’s kappa.

This product does not compute IAA. It uses **exact match** on every required field of the form for this job. Optional "why" text is ignored. Two named people, plus a third if they differ. Not a crowd. No chat to negotiate a match.

Risk: exact match is strict. Markers will disagree on whitespace (trim), on equivalent JSON (define equality per field), and on tone. The third person is the escape. "Cannot mark" exists for broken input or wrong domain. Untrusted evals do not block a name if enough trusted evals already exist.

Risk: the same person marks twice. Bind `mark_url` to a named person. The third person must not have marked that eval.

Risk: showing the other mark too soon. Hide it until the third-person screen.

### Other

**`JOB_UNCLEAR`:** do not invent a job type. Ask what good means. Then write pass/fail checks. Still draft.

**Need more evals vs unfinished queue:** untrusted leftover evals must not block if the trusted bar is met. If the bar is not met, `need_more_evals` and the mark link. Do not fake a name.

**Named model mismatch:** CI must pass the saved `rec_id` and `model_id`. Fail closed.

**Report size:** paginate. Truncate. No output blobs. The payload has to fit in the agent context.

**SQLite:** one writer. Fine for v0. WAL. If CI and an agent run at once, they serialize writes and still fan out HTTP. Revisit only under real lock contention.

---

## 6. Decision

Primary language: TypeScript on Node 22. No second application language in v0.

Shape: one `serve` process (HTTP, worker loop, three small HTML screens), SQLite, in-process `runs` queue, MCP as a stdio client of that HTTP API, one `dispatch` for every tool. Runner fans out models behind a spend gate. Eval sets are copy-forward versions. CI is a client that fails the build and never touches live traffic.

v0 is done when C0–C11 exist and J1–J8 hold, including MCP install, dual-mark, failure versioning, and CI recheck. An HTTP-only week-1 loop that skips those is a demo, not the system.
