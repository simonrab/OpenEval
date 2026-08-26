# EvalRouter — PM roadmap (full v0)

**Date:** 25 August 2026  
**Status:** committed plan for the whole loop  
**Product truth:** [EVALROUTER_REQUIREMENTS.md](../EVALROUTER_REQUIREMENTS.md)  
**Build order:** [BUILD.md](../BUILD.md)

This file is the product plan. It does not change the spec. It does not change BUILD.md. If this file and the requirements disagree, the requirements win.

An **eval** is a check on one example. Input goes in. A score says whether the model did the job. Evals are not unit tests.

A **named model** is the model id the agent should put in the app. We recommend it. We do not apply it to live traffic.

**Live traffic** is real user requests in the app. This tool never sends them and never switches the model that serves them.

**MCP** is a config file that lists tools the model may call.

---

## North star

The product must work fast and be brilliant at three questions:

1. Does this AI feature work on evals for this job?
2. Which cheapest fast model still makes it work, under time and money limits?
3. Recheck when the feature changes, a failure appears, or real use changes.

Fast means the agent finishes the loop in a few tool calls, the runner scores models in parallel, people mark only fuzzy evals on one quick screen, and CI recheck is minutes.

Brilliant means we never fake a named model, never drop old evals, never mark a code eval, and never change live traffic.

We ship demos at each milestone. We do not stop at the HTTP `.env` demo. MCP, the mark screen, failure → new eval-set version, and CI recheck are in v0. They are not optional.

BUILD.md sequences slices so week 1 can demo over HTTP. That is a demo date, not a product cut. This roadmap commits slices 0–7 plus the remaining spec jobs (J1–J8) as the v0 loop.

---

## Language choice (product call)

**Recommend TypeScript on Node 22.** One language for the HTTP API, the runner, and MCP.

What we optimize: **agent UX**. The product is a JSON function the model invokes, plus `POST /v1/tools/{name}` with the same body. The official MCP SDK is TypeScript. Request and response shapes map to Zod. The agent branches on enums and `next_action`. That surface is the product.

Tradeoff vs **eval throughput:** Python would make it easier to hire eval-research people and to pull scoring libraries. Parallel scoring of 5–8 models on tens of evals is not a language problem at v0. Node async plus a `runs` table is enough. We are not copying DeepEval’s metric list. Throughput in v0 is “minutes in CI,” not a farm.

Tradeoff vs **hiring:** Python has a larger eval-infra pool. TypeScript has the agent, MCP, and HTTP pool. We hire for the agent loop. Scoring programs in v0 are small (`json_valid`, `field_equals`, `must_not_contain`, `tool_name`, fixture). Do not add a second language in v0. A Python sidecar would fork the JSON body and break “same body either way.”

If eval volume later needs a worker fleet, keep TypeScript and add processes. Do not rewrite the agent surface.

---

## What “brilliant and fast” means (acceptance)

These bars are product acceptance, not unit tests.

### Agent finishes J1 → J4 in few tool calls

J1 is start a new AI feature (`generate_eval_suite`). J4 is run models and name the cheapest fast model that still passes.

Happy path: at most seven tool calls.

1. `generate_eval_suite`
2. `queue_for_labeling` only if some evals need a person
3. `get_label_status` until enough trusted evals (skip if all were code evals)
4. `run_evals` (returns at once)
5. `get_eval_report` until the run is done (counts as tool calls)
6. `recommend_models`

`next_action` is always present on success and on error. The agent switches on `code`. It does not parse `message`. Developer accept of drafts is a screen. It is not one of the seven.

If `JOB_UNCLEAR`, the extra generate call after the human answers still counts toward the seven.

J8 (`get_eval_report`) is short. Pass/fail counts, time, cost, missing-failure flag, report URL. Paginate eval rows. No traces. No model output blobs. The payload fits in the agent context.

### Runner is parallel

`run_evals` is async. Immediate output is `run_id` and `status: "queued"` or `"running"`. It does not block the agent turn.

Default short model list size is 5. If `models` is set, 1–8. Score those models on the same trusted evals in parallel, not one model after another when the vendor allows it.

Every run stores quality, time, and cost on the same examples.

Honor `max_eval_spend_usd`. Stop between evals when the cap is hit. Store partial results. A partial pass is not a pass.

Customer keys only. Never send live user traffic.

### Mark screen is the only UI and is quick

The mark screen is for evals a program cannot score (tone, fuzzy “good reply”). It is the only real UI in v0.

Also allowed, and tiny: draft accept, named-model approve/reject, and a read-only report URL. No dataset explorer. No experiment studio. No eval dashboard.

One screen. One eval. Always show: what good means, the input, a draft labeled as a suggestion, the form, submit or cannot-mark, how many are left.

Never show: code evals, other people’s marks until the third person, model names, run scores, a list of all evals.

Two named people mark independently. A third decides if they disagree. Mark once per eval-set version. Later runs reuse the mark.

A second marker finishes from the mark link alone. Target: seconds per eval, not a session in a dashboard.

### CI is minutes, not hours

CI calls `run_evals` with `intent: "recheck"` on a frozen eval-set version. It polls `get_eval_report`. It must not exit 0 while status is `queued` or `running`.

Exit 0 only if the named model passed all trusted evals on the frozen version, inside time and spend limits, run complete, no new failures missing from the set. A skip, a timeout, a partial run, or a draft-only set is not a pass.

Target: a standard recheck (named model, frozen `ste_`, tens of trusted evals) finishes in minutes. Not hours. Not overnight.

CI does not call `recommend_models`. CI does not mark. CI does not write config. CI does not change live traffic. Failing the build is not a model change.

---

## Milestones

Each milestone is what a user can do. Engineering tasks live in BUILD.md slices. Do not start the next milestone’s demo until this one can be shown.

A **code eval** is scored by a program. A **draft eval** is a suggested check. It is not trusted yet. A **trusted eval** is one we will use to name a model. An **eval set** is a versioned list of evals. New work makes a new version. Old versions stay.

### M0 — Project exists (BUILD slice 0)

**Week 1, days 1–2.**

**Outcome.** A developer can stand up EvalRouter, prove it is alive, and get a project id.

- `GET /health` returns 200 with no key.
- `POST /v1/projects` with a Bearer key returns `prj_`.
- A bad or missing key returns 401.

**Demo.** `curl` health and create a project. You get a `prj_` id.

**Not done.** No evals. No models. No agent.

---

### M1 — Start a feature over HTTP (BUILD slice 1, J1)

**Week 1, days 3–4.**

**Outcome.** A developer (via curl or the agent later) describes a job and gets draft evals. They accept, edit, or reject drafts on a small screen.

- JSON-object job returns a `ste_` id, at least one eval, each tagged `draft`, and counts for code vs person.
- Vague description returns `JOB_UNCLEAR` and asks what good means.
- A second call with `what_good_means` writes draft pass/fail checks. They are not trusted.
- Accept turns kept code evals into trusted. Rejected drafts are dropped.
- If every eval is a code eval, `next_action.tool` is `run_evals` and `mark_url` is null.
- The tool does not run models.

**Demo.** Call `generate_eval_suite` with “return JSON with `line_items[]` and `total_cents`.” Open the accept page. Accept the code evals. Show trusted code evals.

**Not done.** No run. No named model. Mark tools may be named in `next_action` but the mark screen is M4.

---

### M2 — HTTP loop: run, report, name, write `.env` (BUILD slices 2–3, J2, J4, J8)

**Week 1, days 5–7. First demo.**

**Outcome.** On a JSON job with trusted code evals only, the agent (still via HTTP) runs a short model list, reads a short report, gets a named model or a clear no, and after developer approval writes that id into the app `.env`. EvalRouter does not write that file. Live traffic still goes to OpenRouter or the vendor.

J2 holds: a program scores those evals. No mark screen. They never sit in a mark queue.

J4 holds: drop models that miss hard limits. Drop models that fail trusted evals. If none remain: `does_not_work` plus failing eval ids. If some remain: name the cheapest fast one that still passes. 0–2 backups, all must pass. Too few trusted evals → `need_more_evals`. Never a fake name.

J8 holds: short report. Poll until `succeeded` or `partial`. `live_traffic_changed` is always `false`.

Cost cap: a tiny cap stores partial results and returns `COST_CAP_EXCEEDED`. A partial pass is not a pass.

**Demo.** Accept five JSON code evals (code-eval bar is at least 5). Run two models with a $1 cap. Poll until `succeeded`. Call `recommend_models`. Show name, backups, quality, time, cost. Approve. Agent writes `MODEL=provider/model` into `.env`. Confirm EvalRouter did not write that file. Show a second run at $0.01 that returns a readable partial `run_id`.

**This is a demo, not v0 done.** MCP is missing. Fuzzy jobs cannot be marked. Failures do not version the eval set. CI cannot fail the build.

---

### M3 — MCP for Cursor (BUILD slice 4)

**Week 2.**

**Outcome.** A Cursor agent calls the same seven tools (the ones that exist) from MCP config. No curl. Same JSON body as HTTP. The agent describes a JSON job, finishes J1 → J4, and writes the named model into `.env` after approval.

MCP wraps dispatch. Do not fork business logic. HTTP remains the source of the JSON body.

**Demo.** In Cursor, describe the JSON job. The agent calls `generate_eval_suite`, `run_evals`, `get_eval_report`, and `recommend_models`. You approve. The agent writes `.env`.

**Acceptance for “few tool calls” now applies in the real agent, not only in curl.** Happy path still ≤7 tool calls plus the accept screen.

When mark and failure tools land, they appear on the same MCP server. Do not ship a second MCP surface.

**Not done.** Tone jobs still have no mark screen. CI still does not exist.

---

### M4 — Mark screen for fuzzy evals (BUILD slice 5, J3)

**Week 3.**

**Outcome.** People mark only when a program cannot score. The coding agent never marks. The second person finishes from the mark link alone.

- Agent calls `queue_for_labeling` only for person evals. Code evals never queue.
- If `n_queued` is 0, `mark_url` is null and `next_action` is `run_evals`.
- `get_label_status` returns draft / code / waiting / trusted / need_third counts.
- Two agreeing marks, or a third decision, make the eval trusted.
- `enough_trusted` is false until the bar (about 10; if every remaining eval is a code eval, at least 5 may be enough). Then `next_action` is `run_evals`.
- Asking for a name too soon returns `need_more_evals` and the mark link. No fake name.
- Cannot-mark leaves a reason. That eval is not trusted.
- Form matches the job: fields, pass/fail, rubric, tool calls, image/PDF when the job has files. Unused widgets stay hidden.
- Marks are independent. No chat in the product.

Developer still accepts drafts first. If they can turn a fuzzy draft into a code eval, they do that. Then it never goes to mark.

**Demo.** Generate a job that needs a tone check plus JSON checks. Show JSON evals skipped by the queue. Mark the tone eval as two people. Show trusted count rise. Show a disagreement that opens the third-person screen. Agent waits on `get_label_status`, then runs and names.

**Not done.** A bad example still does not create a new eval-set version. CI still does not recheck.

---

### M5 — Failure → new eval-set version; new work keeps old evals (BUILD slice 6, J5, J6)

**Week 4.**

**Outcome.** A bad example becomes an eval on a **new** eval-set version. Old evals stay. The previous `ste_` is unchanged. History is not deleted.

J5: `register_failure` copies every old eval into a new `ste_` and adds the example. New version number.

- Program check supplied, or job type already has one that fits → trusted code eval. `next_action` is `run_evals` on the new `ste_`. No mark queue.
- Program cannot decide → draft. `next_action` is mark. CI cannot mark. CI would fail with `need_more_evals`.
- A model may suggest a check. A program or a person must confirm. A model does not create a trusted eval by itself.
- Same `idempotency_key` returns the existing new `ste_` and `cas_`. No duplicate.

J6: `generate_eval_suite` with `intent: "add_feature"` writes new draft evals for new work. Old evals stay. The next run uses the union. Developer still accepts new drafts and marks only the rest. They cannot drop old evals to make a new model look good. Do not name a model that fails old evals. Retire is a new version. Going backwards on old work is not allowed in v0.

**Demo.** Register “`total_cents` missing” with a `field_equals` check. Show version 2 with the new eval plus all of version 1. Show version 1 unchanged. Run on version 2. Do not name a model that fails the old evals. Then add a feature (`add_feature`). Show the union. Show a person-scored failure that stays draft and points at the mark URL.

**Not done.** CI does not yet fail the build on a frozen `ste_`.

---

### M6 — CI recheck (BUILD slice 7, J7)

**Week 5. Full loop demo.**

**Outcome.** After a code change, a prompt change, a vendor model change, or on a timer, CI re-runs the **same** evals with the **same** scoring. Same program checks. Same marked answers. It does not invent new expected answers. It does not add or drop evals. It does not write a new named model. It does not change live traffic.

- Green named model → `ci_exit: 0`.
- Named model now fails → non-zero, `need_new_model`. A later agent may call `recommend_models` with `after_failure`. CI does not.
- Backups on the same `rec_` also scored and also fail → `does_not_work`. CI still does not name a model.
- New bad examples not in the set → `evals_missing_new_failures`. Next is `register_failure`. Not a pass.
- Cost cap mid-run → partial stored, non-zero. Partial is not a pass.
- Too few trusted evals, or a person-needed failure → `need_more_evals`, non-zero. CI does not mark.
- Timeout while `queued` or `running` → non-zero.
- `live_traffic_changed` is always `false`. `.env` is not rewritten.

**Demo.** Point `examples/ci-recheck.sh` at a frozen `ste_` and a named model that still passes. Exit 0 in minutes. Break one fixture so the named model fails. Exit non-zero. Confirm the app `.env` was not rewritten. Show a person-needed failure failing the build with `need_more_evals`.

**This is the north-star demo:** does it work, which cheapest fast model made it work, recheck when it changes.

---

### M7 — Spec complete (remaining v0 jobs)

**Week 6.**

M0–M6 ship the loop. This week closes gaps the spec still requires so v0 is actually done.

**Outcomes a user can do:**

- Unknown job type: no fake match. Ask what good means. Write pass/fail checks from that. Prefer code evals. People mark only the rest.
- Known job types beyond JSON object if the library has them by then. If unsure, stay on the unknown path. Do not invent types.
- Image or PDF jobs: file on the mark screen. Limits include `needs_images` / modalities. Models that cannot see images are dropped before quality.
- Named-model page: developer sees name, 0–2 backups, quality, time, cost, failing evals. Approve or reject. Approve does not switch live traffic.
- Read-only `report_url` for a human. Still no dashboard.
- All agent error codes branch: `need_more_evals`, `does_not_work`, `need_new_model`, `evals_missing_new_failures`, `COST_CAP_EXCEEDED`, `JOB_UNCLEAR`, `PROJECT_NOT_FOUND`, `SUITE_NOT_FOUND`, `NAMED_MODEL_MISMATCH`, `COST_CAP_REQUIRED`.
- Recheck after J5 on the **new** version includes the new eval and the old ones.
- After-failure recommend is an agent job, not CI.
- Copy uses the words in requirements section 1.

**Demo.** One Cursor session for a mixed job (JSON + tone). Mark. Name a model. Write `.env`. Register a failure. Recheck old version (unchanged). Recheck new version (includes the failure). CI green then red. Fourteen-day / next-feature bar in the spec is a later success check, not a week-6 gate: the named model still passes current evals including new hard examples, time and cost still ok, new failures are not sitting outside the evals.

**v0 is done** when requirements section 14 holds. That list is the contract. This week is for anything from that list not already proven in M0–M6.

---

## Calendar

Six weeks. Demos every week. Full spec, not a stop at `.env`.

| Week | Milestone | What a user can do | Demo |
| --- | --- | --- | --- |
| 1 | M0–M2 HTTP loop | Create a project. Draft and accept code evals. Run models. Get a named model. Agent writes `.env`. | curl JSON job → named model in `.env` |
| 2 | M3 MCP for Cursor | Same loop from a Cursor agent. No curl. | Cursor agent names a model and writes `.env` |
| 3 | M4 mark screen | Fuzzy evals marked by two people (or a third). Agent waits, then names. | Tone + JSON job. Queue skips JSON. Two marks. Disagreement → third |
| 4 | M5 failure versioning | Failure becomes an eval on a new `ste_`. Old version stays. Add-feature keeps old evals. | Register `total_cents` missing. Version 2 = old + new. Version 1 unchanged |
| 5 | M6 CI recheck | Frozen evals, same scoring, fail the build, live traffic unchanged. Minutes. | Script exit 0, then break fixture, exit non-zero, `.env` untouched |
| 6 | M7 spec complete | Unknown job, error codes, image limits, approve page, report URL, after-failure agent path. | One mixed-job loop through MCP, mark, failure, CI |

Do not slip M3–M6 to “after v0.” They are v0.

If week 1 slips, still ship the HTTP demo, then MCP next. Do not skip MCP to start mark. The agent is the primary user. If week 3 slips, do not skip mark to start CI. CI cannot mark. Fuzzy jobs would then have no path to trusted evals.

Parallelism that is allowed: draft-accept HTML in week 1 can share patterns with mark HTML in week 3. CI script in week 5 uses the same `run_evals` / `get_eval_report` as week 1. Do not parallelize by dropping a milestone.

---

## Risks if we skip MCP, mark, or CI

We will not skip them. This is why.

### Skip MCP

The product is an agent tool. HTTP-only means the coding agent is not the user. People paste curl. That is not the loop. Cursor will not finish J1 → J4 in seven tool calls if the tools are not in MCP config. Agents do not discover this on the internet. You install it. Without MCP, install is a private API plus a human. The north star “agent finishes the loop” fails.

### Skip the mark screen

Many real jobs are not JSON. Tone, “good reply,” messy extract, image judgment. If we only ship code evals, we fake “the feature works” on the easy part and ignore the rest. The spec forbids a model creating trusted answers by itself. Without mark, person evals stay draft forever. `need_more_evals` never clears. We either name a model on too few trusted evals (forbidden) or we only support JSON toys. Two-person agreement is the trust step. A developer-only checkbox is not that step.

### Skip failure → new eval-set version

Without J5/J6, a failure is a chat note. Old evals get edited in place or dropped so a new model looks good. Recheck then lies. The product promise is: new work does not drop old evals. New version. Old `ste_` unchanged. Skip this and J7 rechecks a set that no longer matches reality, or a set that was silently mutated.

### Skip CI recheck

Without J7, the named model is a one-time demo. Feature change, vendor change, or a new bad example does not fail the build. People find out in live traffic. This tool must never sit on live traffic, so CI is the only automatic gate. A skip, a dashboard glance, or “we will re-run later” is not a pass. Exit 0 is the only pass. Minutes, not hours, or people turn the job off.

---

## Cut list (still out of v0)

Boiling the ocean means the **real product loop**, not a bigger product. Do not build these even after M7.

- A live proxy in front of OpenRouter, Ramp, or the model company
- Auto-swap of the live model
- Prompt rewrite
- Pick a model per live request
- A full eval dashboard (tables, experiments, datasets)
- A full eval website
- Crowd marking / a crowd marketplace of paid strangers
- A second OpenRouter
- A second model as judge to create the first trusted answers
- Chat in the mark screen to negotiate agreement
- Extra tools beyond the seven (`compare_models`, trace ingest, drift detect, `compile_label_schema` as a separate tool)
- CI calling `recommend_models` or writing the named model into the app
- CI marking examples
- Editing or deleting a frozen eval-set version in place
- Copy DeepEval’s metric list or dashboard
- Postgres, Redis, Kubernetes, or a second language in v0

Tiny screens that the spec already allows are not a dashboard: draft accept, mark (one eval), named-model approve/reject, read-only report URL.

---

## Users and who does what, by milestone

| User | M2 HTTP | M3 MCP | M4 mark | M5 failure | M6 CI |
| --- | --- | --- | --- | --- | --- |
| Coding agent | curl stand-in | real user | waits on mark, does not mark | `register_failure`, `add_feature` | may re-run; does not swap live |
| Developer | accept drafts, approve name | same | first/second/third mark if needed | accept new drafts; cannot drop old evals | reads fail; agent names later |
| Second person | unused | unused | marks from link | marks person-scored failures | unused (cannot mark in CI) |
| CI or timer | unused | unused | unused | may call `register_failure`; cannot mark | primary user of recheck |

---

## Done when (whole loop)

Requirements section 14 is the checklist. Restated as outcomes:

- Agent finishes J1 → J2/J3 → J4 in 7 tool calls or fewer on the happy path, from Cursor via MCP.
- Code evals never require a person and never sit in a mark queue.
- People only see evals a program cannot score. They mark once per eval-set version.
- An eval is trusted only after accept (code) or two people agree / a third decides (person).
- J4 returns a named model to write into config, or `does_not_work` with failing eval ids. Never a fake name.
- J5 and J6 keep old evals. New work is a new eval-set version.
- J7 rechecks a saved `ste_` with the same scoring. The build fails if the named model now fails. Live traffic unchanged. Minutes, not hours.
- J8 is short and fits in context.
- The agent wrote the named model into the app after developer approval. This tool did not.
- Live user requests never went through this tool. The prompt was not rewritten. The live model was not auto-swapped.

That is v0. Demos along the way prove each piece. The calendar does not stop at week 1.
