# EvalRouter — how to build

Product truth lives in [EVALROUTER_REQUIREMENTS.md](EVALROUTER_REQUIREMENTS.md). This file is the build order only. If this file and the requirements disagree, the requirements win.

Detail lives in the three reviews. Do not treat those files as a second spec.

- Architecture and language: [build/architecture-review.md](build/architecture-review.md)
- Slice files, TDD, parallelism: [build/engineering-sequence.md](build/engineering-sequence.md)
- Demo calendar and milestones: [build/pm-roadmap.md](build/pm-roadmap.md)

An **eval** is a product check on one example. Input goes in. A score says whether the model did the job. Evals are not unit tests. Unit and integration tests cover the API, the runner, and the MCP adapter.

A **code eval** is scored by a program.

A **draft eval** is a suggested check. It is not trusted yet.

A **trusted eval** is one we will use to name a model.

An **eval set** is a versioned list of evals. New work makes a new version. Old versions stay.

A **named model** is the model id the agent should put in the app. We recommend it. We do not apply it to live traffic.

**Live traffic** is real user requests in the app. This tool never sends them and never switches the model that serves them.

**MCP** is a config file that lists tools the model may call. Same JSON body as `POST /v1/tools/{name}`.

v0 is slices 0–10. That is J1–J8. Week 1 can still be an HTTP demo. That demo is not a license to skip MCP, the mark screen, `register_failure` versions, or CI.

**Auto-jump.** When the reviewer passes a slice, the orchestrator writes `build/handoffs/slice-N.md` and starts slice N+1 at once. Do not wait for the user. Template: [build/handoffs/README.md](build/handoffs/README.md). Stop after `slice-10.md`, or if review fails, or if the next slice needs an OpenRouter key you do not have.

---

## 1. Language

**Lock: TypeScript on Node 22.** No second application language in v0.

The product that must feel fast is the agent loop: typed JSON in, `next_action` out, a `run_id` at once, a short report that fits in context, a named model the agent can write. The expensive work is OpenRouter tokens and wait, not our CPU.

Brilliance here is agent UX and parallel model I/O. It is not a live proxy. The spec forbids a proxy in front of OpenRouter, Ramp, or the model company. Do not pick a language because it would be brilliant at that forbidden path.

TypeScript wins because the official MCP SDK is TypeScript, Zod maps 1:1 to tool JSON (`additionalProperties: false`, enums the agent branches on), and Node’s event loop is the right scheduler for 1–8 in-flight model calls. Native `fetch` on Node 22 is enough. `Promise.all` plus a spend gate is the whole parallelism story. One process can serve HTTP, the runner loop, and the small HTML screens. Time-to-ship for auth through CI is shortest here. That matters because marking, versions, and CI are in the v0 done-when.

Python loses. EvalRouter is an agent JSON contract plus a runner, not an eval-research notebook. Python’s gravity well pulls toward dashboards and calling evals “tests.” Both are out. A Python sidecar would fork the tool body.

Go loses. Goroutines would matter if we sat in front of OpenRouter. We do not. MCP and the mark screen are first-class. Go’s MCP SDK and HTML cost extra ship time for no product gain. Revisit Go only if a worker fleet is forced by concurrent runs SQLite cannot take. Do not start there.

Rust loses. It would save milliseconds we do not have. We spend dollars and seconds on model calls.

HTML is markup, not a second app language. `examples/ci-recheck.sh` is a client. Customer fixture programs are theirs and may be any language. We exec them. We do not rewrite the product in that language.

---

## 2. Architecture

Two long-lived processes. Same TypeScript codebase. One tool layer.

**`evalrouter serve`.** Fastify. `GET /health` with no key. `POST /v1/projects` and `POST /v1/tools/{name}` with Bearer auth. Serves `accept.html`, `mark/screen.html`, `mark/third.html`, the named-model page, and a read-only `report_url`. Runs the in-process worker loop. Holds the SQLite file (`better-sqlite3`, WAL).

**`evalrouter mcp`.** Stdio MCP server that Cursor (or another agent host) spawns. It is a client of the same `dispatch`. Default: translate MCP tool calls to `POST /v1/tools/{name}` with the same JSON and the same API key. HTTP remains the source of the body. Do not let the MCP child open SQLite while `serve` is also running.

CI is not a third process of ours. It POSTs `run_evals` with `intent: "recheck"`, polls `get_eval_report`, and exits with `ci_exit`.

```
Agent --stdio--> MCP adapter --HTTP Bearer--> serve --> dispatch --> tools
Agent/CI/curl -------------------HTTP Bearer--> serve --> dispatch --> tools
Person  --browser, signed mark token---------> serve --> mark handlers
Developer --browser, signed accept/approve---> serve --> accept / named-model
serve worker loop --> OpenRouter (customer key only, eval calls only)
```

Live app traffic never enters this diagram.

All seven tools go through `dispatch(name, body, ctx)`. Zod schema per tool. `additionalProperties: false`. Mutating tools take `idempotency_key`. Every success and error includes `next_action`. Truncate `input` / `output` / `trace`. No full traces. Opaque ids: `prj_`, `job_`, `ste_`, `cas_`, `run_`, `rec_`, `pkr_`.

Screens that mutate product state (accept drafts, submit a mark, approve a name) are HTML handlers. They are not extra agent tools. They share the same store and the same trust rules.

Auth: one hashed Bearer key on every `/v1` call. `/health` is open. `mark_url` is a signed token. The second person does not hold the agent key.

Store: SQLite, one file, one writer process. Do not add Postgres or Redis in v0. Eval sets are copy-forward versions. Rows are never updated in place. `eval_sets` + `eval_set_members`. Marks keyed by `(ste_id, cas_id, person_id)`.

Runner: `run_evals` inserts a `runs` row and returns `{ run_id, status }` at once. Work over two seconds is always async. Fan out one async call per model (1–8). Evals sequential inside a model so we can stop between evals. Spend gate: the last in-flight call may finish; eight must not overshoot eight times. Customer keys only (`pkr_`). Eval calls only. Never live traffic.

No React SPA. Server-rendered HTML plus a little script.

---

## 3. Full order

Eleven slices. About **36 engineer-days**. One person: ~8 weeks. Two people: ~5–6 weeks.

PM weeks **M0–M7** are demo dates on that spine. They are not a second sequence.

| Slice | Days | Ships | Jobs | PM |
| --- | ---: | --- | --- | --- |
| 0 | 2 | Health, auth, `prj_`, SQLite | — | **M0** week 1 |
| 1 | 2 | Dispatch, seven-tool schemas, error envelope, `next_action` | shared | week 1 |
| 2 | 1 | Customer keys `pkr_` | shared (J4, J7) | week 1 |
| 3 | 4 | `generate_eval_suite`, versioned `ste_`, accept screen | **J1** | **M1** week 1 |
| 4 | 5 | `run_evals`, program scoring, cost cap, `get_eval_report` | **J2, J8** | **M2** week 1 |
| 5 | 3 | `recommend_models`, approve screen, agent writes `.env` | **J4** | **M2** week 1 HTTP demo |
| 6 | 3 | **MCP** — same JSON as HTTP | J1–J4 over the agent | **M3** week 2 |
| 7 | 6 | **Mark screen**, `queue_for_labeling`, `get_label_status`, two-person + third | **J3** | **M4** week 3 |
| 8 | 4 | **`register_failure`**, copy-on-write eval-set versions | **J5** | **M5** week 4 |
| 9 | 2 | `intent: "add_feature"`, retire = new version | **J6** | **M5** week 4 |
| 10 | 4 | **CI recheck**, `ci_exit`, fail the build, never change live traffic | **J7** | **M6** week 5 |
| — | — | Close remaining spec gaps (unknown job, image limits, error codes, mixed-job loop) | J1–J8 | **M7** week 6 |

**Required, not later:** slice 6 (MCP), slice 7 (mark screen), slices 8–9 (`register_failure` versions and add-feature copy-forward), slice 10 (CI). Do not slip them to after v0. Do not skip MCP to start mark. Do not skip mark to start CI. CI cannot mark.

Week 1 can ship slices 0–5 over HTTP (JSON job, code evals, named model in `.env`). If week 1 is short, ship 0–3 and stretch 4–5. That is a demo. The product is slices 0–10 plus M7.

Shared rules from slice 0 onward:

- `additionalProperties: false` on every tool input
- `next_action` on every success and every error
- mutating calls take `idempotency_key`
- truncate `input` / `output`; no full traces
- `live_traffic_changed` is always `false` when the field exists

TDD applies to C0–C10 code: auth, dispatch, copy-forward, spend gate, agreement, `ci_exit`. Write a failing unit or integration test, then the code. J7 failing the customer’s build when the named model misses evals is a product job. Those evals are not unit tests.

Register all **seven** tool names in slice 1: `generate_eval_suite`, `queue_for_labeling`, `get_label_status`, `run_evals`, `recommend_models`, `register_failure`, `get_eval_report`. Unbuilt tools return a single error envelope with `next_action`. Do not invent a second tool list for MCP later.

---

## 4. Slices

### Slice 0 — Foundation (M0)

**Days:** 2. **Jobs:** none.

Health, hashed Bearer auth, `POST /v1/projects`, SQLite file.

**Done when**

- `GET /health` returns 200 with no key.
- `POST /v1/projects` with a Bearer key returns `{ "project_id": "prj_..." }`.
- A bad or missing key returns 401.
- `npm start` creates SQLite on disk.

**Demo.** curl health and create a `prj_`.

**Unblocks.** Every later slice. Auth and ids never change.

---

### Slice 1 — Tool registry, error envelope, `next_action`

**Days:** 2. **Jobs:** shared contract.

Wire every spec code as a typed enum even if no handler returns it yet: `need_more_evals`, `does_not_work`, `need_new_model`, `evals_missing_new_failures`, `COST_CAP_EXCEEDED`, `JOB_UNCLEAR`, `PROJECT_NOT_FOUND`, `SUITE_NOT_FOUND`, `NAMED_MODEL_MISMATCH`, `COST_CAP_REQUIRED`.

**Done when**

- `POST /v1/tools/{name}` exists. Unknown name → 404 with `next_action`.
- Extra input field → reject (`additionalProperties: false`).
- Unbuilt registered tool → stable `code`, not a crash.
- Mutating call without `idempotency_key` → reject when the spec requires it.

**Demo.** `POST /v1/tools/generate_eval_suite` with an extra field fails closed. `POST /v1/tools/run_evals` returns the not-built envelope with `next_action`.

**Unblocks.** HTTP and MCP share one map. New slices fill handlers. They do not add routes per tool.

---

### Slice 2 — Customer keys (`pkr_`)

**Days:** 1. **Jobs:** shared (needed for J4 and J7).

**BYO keys** means the customer supplies the API key. We do not resell tokens. We do not sit on live traffic.

**Done when**

- `POST /v1/keys` stores a key and returns `pkr_...`.
- Fetch by id never returns the secret in JSON.
- Missing key on a later run path will be `suggested_args.keys_ref`.

**Demo.** Create a `pkr_`. Show it on the project. Show the secret is not in the response.

**Unblocks.** `run_evals` and CI recheck.

---

### Slice 3 — `generate_eval_suite` + draft accept (M1, J1)

**Days:** 4. **Jobs:** J1.

A **job** is what the feature does, plus limits (images, max wait, max spend, allowed models).

Eval sets are **versioned from this slice**. Version 1 is a real version. Use `eval_sets` + `evals` + `eval_set_members`. Do not store `evals.eval_set_id` as the only link. Copy-on-write later (J5/J6) inserts a new `ste_` and copies membership. It does not edit the old row.

Known type: JSON object out. Unknown type: do not fake a match. Return `JOB_UNCLEAR`. Ask what good means. Write pass/fail checks from that text. Tag them `draft`. Prefer `score_how: "code"`. Split the rest as `"person"`. Computer-made evals stay `draft` until the developer accepts them.

Accept is a screen, not one of the seven agent tools. Accepting a code eval makes it trusted. Rejected drafts are dropped.

If every eval is a code eval, `next_action.tool = run_evals` and `mark_url` is null. If some need a person, `next_action.tool = queue_for_labeling`. The **field** exists now even if slice 7 has not landed.

**Done when (J1)**

- Given a JSON-object job description. When `generate_eval_suite`. Then `ste_` exists, at least one eval, each tagged `draft`, counts for code vs person, `next_action` set.
- Given a vague description. When generate. Then `JOB_UNCLEAR`, `ask_human: "what good means"`.
- Given `what_good_means` after that. When generate again. Then draft pass/fail checks, still not trusted.
- Given drafts on the accept screen. When the developer accepts code evals and rejects others. Then kept code evals are trusted. Rejected drafts are gone. No model was run.

**Demo.** “Return JSON with `line_items[]` and `total_cents`.” Open accept. Accept the code evals. Show `ste_` version 1, trusted code evals, `next_action.tool = run_evals`.

**Unblocks.** Runner, mark (via `score_how`), J5/J6 versioning.

---

### Slice 4 — `run_evals` + program scoring + cost cap + `get_eval_report` (M2, J2, J8)

**Days:** 5. **Jobs:** J2, J8.

A **run** stores quality, time, and cost on the same examples. A **cost cap** is the max dollars this run may spend on model calls.

`run_evals` is async. Immediate output: `run_id`, `status: "queued"` or `"running"`. Poll `get_eval_report`. Do not block the agent turn.

Use `keys_ref` or the project key. Call OpenRouter only for these eval calls. Never send live user traffic.

Honor `max_eval_spend_usd`. Stop between evals. Store what finished. Return `COST_CAP_EXCEEDED` and the partial `run_id`. Report status `partial`. A partial pass is not a pass.

Default short model list size is 5. If `models` is set, 1–8.

Skip person evals in this slice if they are not trusted. Score trusted code evals with the program (`json_valid`, `field_equals`, `must_not_contain`, `tool_name`, fixture exec). A code eval never sits in a mark queue.

Too few trusted evals: do not run. Return `need_more_evals`. About 10 is the start bar. If every remaining eval is a code eval, at least 5 may be enough.

`get_eval_report`: paginate rows (default 20, max 50). No traces. No model output blobs. `live_traffic_changed: false`. Include `ci_exit` as a field even before the CI script exists: `0` only on a complete pass.

Accept `intent: "recheck"` and `named_model` on the input now. Recheck that mutates nothing lands fully in slice 10. Do not add a second CI endpoint later.

**Done when (J2)**

- Given a trusted code eval (valid JSON, field equals, must-not-contain). When it is scored. Then a program scores every run. It never sits in a mark queue.

**Done when (J8)**

- Given a `run_id`. When `get_eval_report`. Then short summary: pass/fail counts, time, cost, missing-failure flag, `report_url`. Rows paginated. No traces.
- Given status `queued` or `running`. When report. Then `next_action.tool = get_eval_report` with the same `run_id`.

Also: immediate `run_id`; cap mid-run → `partial` with scored vs not scored listed.

**Demo.** Accept five JSON code evals. Run two models with a $1 cap. Poll until `succeeded`. Show counts, p50 time, spend. Second run with a $0.01 cap returns `COST_CAP_EXCEEDED` and a readable partial `run_id`.

**Unblocks.** `recommend_models`, MCP happy path, CI polling.

---

### Slice 5 — `recommend_models` + approve (M2, J4)

**Days:** 3. **Jobs:** J4.

**Hard limits** drop a model before quality: cannot see images, too slow, too expensive, not allowed.

Then drop models that fail trusted evals. If none remain: `does_not_work`, failing eval ids, `named_model` null.

If some remain: name the cheapest fast one that still passes. Name a slower or costlier model only if quality is clearly better and limits still hold. Return 0–2 backups. Backups must also pass.

Too few trusted evals → `need_more_evals`. Do not fake a name.

Developer approves or rejects on the named-model page. Approve means the **agent** may write the id into the app. This process does not write `.env`. This process does not change live traffic.

CI must not call this tool. The CI script in slice 10 must not import rank.

**Done when (J4)**

- Given a trusted eval set and job limits. When `run_evals`, poll report, `recommend_models` with `intent: "new_feature"`. Then a `rec_` and a model id, or `does_not_work` with failing eval ids. Live traffic unchanged.
- Given too few trusted evals. When recommend. Then `need_more_evals`, no name.
- Given approve. When the agent writes `MODEL=` into the app `.env`. Then EvalRouter did not write that file.

Also: a model that misses `max_wait_ms` is dropped even if it passed evals. A model that failed evals is never named and never a backup.

**Demo.** Use the slice 4 run. Call `recommend_models`. Show named model, 0–2 backups, quality, time, cost. Approve. Agent writes `.env`. Confirm EvalRouter did not.

This is the **week-1 HTTP demo**. MCP, mark, failure versioning, and CI are still required. They are not optional follow-ons.

**Unblocks.** MCP end-to-end J1→J4. CI has a `rec_` to freeze.

---

### Slice 6 — MCP (M3) — required

**Days:** 3. **Jobs:** J1–J4 through the agent, not curl.

First-class install path. Agents do not find this tool on the internet. You put it in MCP config, or you call the API with a key.

MCP wraps `dispatch`. One schema file. HTTP remains the same JSON body. Do not fork handlers. Default transport: stdio client of `serve`, not a second SQLite writer.

Register every name in the seven-tool list. Handlers that are not built yet still return the slice 1 envelope. When slices 7–10 fill them, MCP gets them with no second MCP package.

After slice 1, a stub MCP against not-built envelopes is allowed parallel work. Slice 6 is done when the agent can finish the HTTP loop without curl.

**Done when**

- Each MCP tool input schema equals the HTTP Zod schema.
- Round-trip: MCP call ≡ `POST /v1/tools/{name}` body and output.
- Auth: same API key via env on the stdio process.
- Cursor MCP config points at `evalrouter mcp`. Empty list is not done.

**BDD.** J1 and J4 through the agent. Same Then checks as slices 3–5. Happy path still ≤7 tool calls plus the accept screen.

**Demo.** Cursor MCP config points at the stdio server. Agent describes the JSON job, calls generate / run / report / recommend, gets a named model, writes `.env` after approve.

**Unblocks.** Coding-agent install. Mark and failure tools appear on the same server later.

---

### Slice 7 — Mark screen, two-person agreement, third person (M4, J3) — required

**Days:** 6. **Jobs:** J3.

A **marked eval** is one a person scored because a program cannot decide (tone, fuzzy “good reply”). Two people must agree, or a third decides. Only then it is trusted.

This is a product surface. It is not a dashboard. One screen. One eval.

`queue_for_labeling` queues only `score_how: "person"`. Never queues code evals. If `n_queued` is 0, `mark_url` is null and `next_action.tool = run_evals`.

Always show: what good means, the input, a draft labeled as a suggestion, the form for this job, submit or cannot-mark, how many are left.

Never show: code evals, the other person’s mark (until third), model names, run scores, a list of all evals.

Marks are independent. No chat. Two named people plus one third. Not a crowd.

Agreement: every required form field matches (trim on text/fields). Optional “why” is not part of agreement. Two accepts of the same draft agree. One accept and one edit disagree. A model draft is never trusted by itself.

States: waiting → one mark → disagree/wait third → trusted → cannot-mark or dropped. Only trusted is used to name a model.

Mark once per eval-set version. Later runs reuse the mark. Wire person evals into the worker: compare model output to the trusted mark. Do not re-open the screen.

`enough_trusted` is false until the bar in the requirements. Then `next_action.tool = run_evals`. Untrusted leftover evals do not block a name if enough trusted evals already exist.

`get_label_status` does not return `need_more_evals`. That code stays on `run_evals` / `recommend_models`.

**Done when (J3)**

- Skip. Given a program check. When scored. Then no mark screen, never in queue.
- Mark. Given evals with no program check. When people must decide. Then mark screen for those only. Two people mark independently. Order does not matter.
- Given disagreement. When a third person who did not mark this eval decides. Then their mark is trusted. The first two do not vote again.
- Given unfinished queue and too few trusted evals. When the agent asks for a named model. Then `need_more_evals` and a mark link. No fake name.
- Given cannot mark. When they submit a reason. Then the eval is not trusted.

**Demo.** Job with a tone check plus JSON checks. Queue skips JSON. Two people mark the tone eval. Trusted count rises. Force a disagreement. Third-person screen shows both marks after the input. Submit. `get_label_status` → `enough_trusted` → `run_evals`.

**Unblocks.** Person-path J4. J5 failures that need a person. MCP can now finish the seven-call loop including mark tools.

---

### Slice 8 — `register_failure` + new eval-set version (M5, J5) — required

**Days:** 4. **Jobs:** J5.

A **failure** is a bad example. It is a candidate eval until `register_failure` adds it.

Copy every old eval into a **new** eval-set version. Add the example. New `ste_` id. New `version` number. Previous `ste_` is unchanged. Do not delete old evals. Do not edit the old `ste_` in place.

If the caller sent a program check, or the job type already has one that fits, the new eval is a trusted code eval. `next_action` is `run_evals` on the **new** `ste_`. No mark queue.

If a program cannot decide, the new eval stays draft. `next_action` is `queue_for_labeling`. CI cannot mark. A model may suggest a check. A program or a person must confirm.

Same `idempotency_key` returns the existing new `ste_` and `cas_`. No duplicate.

Old marks stay on the old version. Copied membership keeps the same `cas_` ids. For a pure copy, reuse the trusted mark. Do not ask people to mark the same example again unless the form fields changed.

C10 is not done until both the code path and the person path work.

**Done when (J5)**

- Given a bad example and an existing eval set. When `register_failure`. Then a new `ste_` exists, the new eval is on it, every old eval is on it, the previous `ste_` still exists.
- Given a program check. When register. Then next `run_evals` on the new version includes the new eval **and** the old ones. No mark step.
- Given a person-needed failure. When register. Then draft, mark is next, not trusted.

**Demo.** Register “`total_cents` missing” with `field_equals`. Show version 2 = new eval + all of version 1. Show version 1 unchanged. Run version 2. Do not name a model that fails the old evals.

**Unblocks.** J6 (same copy primitive). J7 path `evals_missing_new_failures` → register. MCP tool becomes live.

---

### Slice 9 — `add_feature` keeps old evals (M5, J6) — required

**Days:** 2. **Jobs:** J6.

Same copy primitive as J5. New drafts for the new work. Developer still accepts. People still mark only what a program cannot score. They cannot drop old evals to make a new model look good.

`intent: "add_feature"` requires `eval_set_id`. Writes a new `ste_`. Union = old members + new drafts.

Going backwards on old work is not allowed in v0. Retire is a new version. History is not deleted.

`recommend_models` with `intent: "add_feature"` must not name a model that fails old trusted evals.

**Done when (J6)**

- Given an existing named model and new work. When `generate_eval_suite` with `intent: "add_feature"` and the existing `eval_set_id`. Then new drafts exist, old evals stay, new version exists, old versions stay.
- Given a model that fails an old eval. When recommend. Then that model is not offered for approval.

**Demo.** Add a new field to the JSON job. Show version 3 with old evals plus new drafts. Accept. Run. A model that misses an old `total_cents` check is not named.

**Unblocks.** Grow-the-feature loop. CI still points at a frozen `ste_` until someone updates the CI vars.

---

### Slice 10 — CI recheck fails the build (M6, J7) — required

**Days:** 4. **Jobs:** J7.

A **recheck** runs the saved evals again with the same scoring. Same program checks. Same marked answers. Do not invent new expected answers.

CI calls `run_evals` with `intent: "recheck"`, the frozen `ste_`, `named_model` (`rec_id` + `model_id`), and `max_eval_spend_usd` > 0. It polls `get_eval_report`. It must not exit 0 while status is `queued` or `running`.

CI does not call `recommend_models`. CI does not mark. CI does not write config. CI does not change live traffic.

Customer keys on the project. CI does not prompt for keys.

Exit 0 only if: named model passed all trusted evals on that version, inside time and spend limits, run complete, no new failures sitting outside the set. Any job error code, a partial run, a timeout, a draft-only set, or still `queued`/`running` is non-zero.

If the named model fails: `need_new_model` (or `does_not_work` only if this run also scored the backups on that `rec_` and they fail too). If `new_failures` were given and are not in the set: `evals_missing_new_failures`, then `register_failure`, then still fail the build. If the cap stops the run: fail the build. Partial is not a pass. Too few trusted evals or a person-needed failure: `need_more_evals`, non-zero. CI does not mark.

`NAMED_MODEL_MISMATCH` if `rec_id` does not match `model_id`. `COST_CAP_REQUIRED` if the cap is missing or `<= 0`.

The frozen `ste_` is not mutated.

**Done when (J7)**

- Given a saved eval-set version and a named model. When CI calls `run_evals` with `intent: "recheck"` and polls the report. Then same evals, same scoring, pass/fail + time + cost for the named model. No new named model. Live traffic unchanged.
- Given the named model now fails. When recheck finishes. Then `need_new_model` (or `does_not_work` if backups on that `rec_` also failed), build unsuccessful, `.env` untouched.
- Given new bad examples not in the set. When recheck. Then `evals_missing_new_failures`, not a pass.
- Given cost cap mid-run. When stop. Then partial stored, build unsuccessful, live traffic unchanged.

**Demo.** Point `examples/ci-recheck.sh` at a frozen `ste_` and a named model that still passes. Exit 0 in minutes. Break one fixture. Exit non-zero. Confirm app `.env` was not rewritten. Confirm `live_traffic_changed` is false. Show a person-needed failure failing the build with `need_more_evals`.

This is the north-star demo: does it work, which cheapest fast model made it work, recheck when it changes.

---

### M7 — Spec complete (week 6)

Not a twelfth product. Slices 0–10 already cover J1–J8. This week closes remaining gaps so v0 matches requirements section 14. Do not invent a new job-type library, extra tools, a dashboard, or a React app.

**Done-when**

- [x] JSON-object detection uses structural JSON signals only. Bare `"invoice"` is not a known type. Vague or unstructured extract jobs return `JOB_UNCLEAR`, not a fake JSON suite.
- [x] A mixed job (JSON + tone) yields `n_code > 0` and `n_person > 0`. After accept, `after_accept_tool` is `queue_for_labeling`.
- [x] Image/PDF attachments are stored on the eval. The mark screen and third-person screen show the file. Existing pass/fail / fields / rubric widgets stay. No `form_type: "file"`. No region mark.
- [x] Named-model page shows name, 0–2 backups, quality, time, cost, and failing evals (including `does_not_work`). Approve does not change live traffic.
- [x] `recommend_models` returns a signed `approve_url`. When a name exists, `next_action.ask_human` is `open approve_url`.
- [x] All ten agent error codes return a usable `next_action`. `need_new_model` → `recommend_models` with `intent: "after_failure"` and `current_named_model`. CI never calls `recommend_models` and never writes `.env`.
- [x] Recheck after J5: old `ste_` unchanged (new eval absent). New `ste_` includes old evals and the new eval.
- [x] One HTTP mixed-job loop: generate → accept code → mark tone → run → recommend → approve → `register_failure` → recheck old / recheck new → `ci_exit` 0 then non-zero.

**Already shipped (do not rebuild).** `needs_images` drops non-vision models before quality. Signed read-only `report_url` (no dashboard). Vague description → `JOB_UNCLEAR` → `what_good_means`. J5 copy-forward. CI script hygiene.

**Demo.** Tests are the done-when. A live Cursor session for the mixed job is optional if `OPENROUTER_API_KEY` is present. Do not block M7 on a manual session.

v0 is done when requirements section 14 holds.

---

## After M7

Shipped after the v0 slices. These are not a rewrite of M7.

- Retire an old eval: `generate_eval_suite` with `retire_eval_ids` copy-forwards to a new `ste_` and omits those `cas_` ids. History is not deleted.
- Known job types: extract, tone, and image/PDF. Detection uses structural signals. Bare `"invoice"` is still not a known type.
- Region mark on image/PDF when the job needs a location. Region is extra payload on the mark, not `form_type: "file"`.

---

## 5. How not to paint into a corner

1. **One dispatch.** HTTP and MCP call `dispatch(name, body)`. Register all seven names in slice 1. Fill handlers later. Slices 7–10 do not add a second MCP package.
2. **Eval-set membership from slice 3.** J5 copies membership to a new `ste_`. If you parent every eval to one set, `register_failure` rewrites slice 3.
3. **Marks keyed per version.** `(ste_id, cas_id, person_id)`. Frozen marks are what recheck uses.
4. **`intent` on `run_evals` and `recommend_models` from the first handler.** Include `recheck`, `add_feature`, `after_failure` in the enum in slices 4–5. Do not add `/v1/ci/recheck`.
5. **Error codes are a closed enum.** Agents switch on `code`, not `message`. Add the full table in slice 1.
6. **`next_action` is never optional.** Accept and approve are HTML. They are not in the seven-call budget.
7. **Keys before the runner.** Do not read `OPENROUTER_API_KEY` from the server env as the customer key.
8. **Cost cap in the worker, not in recommend.** Persist partial rows. Never treat `partial` as a pass.
9. **Code vs person is data.** `score_how` is set in generate (slice 3). The mark queue filters on it. The runner skips untrusted person evals.
10. **`report_url` is a read-only page.** If slice 4 grows a table of experiments, you have built the out-of-scope dashboard.
11. **CI must not grow recommend.** Slice 10 maps codes to `ci_exit`. If the script imports `rank.ts`, you will auto-swap in spirit.
12. **Do not freeze a week-1 schema that omits version.** The tables in slice 3 must already be the J5 tables.
13. **Idempotency on every mutate.** Generate, register, queue, run. Same key, same ids.
14. **No live path.** Approve + agent `.env` write is the only apply step. Put `live_traffic_changed: false` on the report in slice 4.
15. **MCP is an HTTP client of `serve`.** If MCP called a local SQLite and HTTP another, the agent would poll a run that does not exist.

Two people: A owns API / runner; B owns MCP / HTML screens. Do not parallel two people inventing tool JSON. Slice 1 is a gate. Do not parallel a second store or a second dispatch for MCP. Safe after slice 3: B on mark HTML with fixture `ste_` rows while A builds the runner. Unsafe: a React SPA.

---

## 6. Still out of v0

Do not sneak these into a slice.

- A live proxy in front of OpenRouter, Ramp, or the model company
- Auto-swap of the live model
- Prompt rewrite
- Pick a model per live request
- An eval dashboard (tables, experiments, datasets)
- Crowd marking
- Extra tools (`compare_models`, trace ingest, drift detect, `compile_label_schema`)
- CI calling `recommend_models` or writing the named model into the app
- CI marking examples
- Editing or deleting a frozen eval-set version in place
- A second model as judge to create the first trusted answers
- Postgres, Redis, Kubernetes, or a second application language
- A React SPA

Tiny screens the spec already allows are not a dashboard: draft accept, mark (one eval), named-model approve/reject, read-only report URL.

---

## 7. Done when (whole product, not week 1)

- Agent finishes J1 → J2/J3 → J4 in seven tool calls or fewer on the happy path, from Cursor via MCP. Accept is a screen, not a call.
- Code evals never require a person and never sit in a mark queue.
- People mark only when a program cannot. They mark once per eval-set version. Two agree or a third decides.
- J4 names a model or returns `does_not_work`. Never a fake name. Too few trusted evals → `need_more_evals`.
- J5 and J6 keep old evals on a new `ste_`. History is not deleted.
- J7 rechecks a frozen `ste_`, fails the build if the named model now fails, does not change live traffic. Minutes, not hours.
- Cost cap stores partial results. Partial is not a pass.
- J8 is short: counts, time, cost, missing-failure flag, report URL, no traces.
- MCP and HTTP send the same JSON.
- The agent writes the named model into the app after approval. This tool does not.
- Live user requests never went through this tool.
