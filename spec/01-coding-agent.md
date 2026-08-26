# 01. Coding agent

Slice for the coding agent only. Other slices own marking, scoring rules, failure intake, and recheck-on-change. This slice says who this user is, which jobs it finishes, and the seven tools it calls.

EvalRouter checks that an AI feature works with evals, names the cheapest fast model that still passes, and runs that check again when the product changes. The app still sends live user requests to OpenRouter or the model company. This tool does not sit on that path. First version does not rewrite prompts. It does not change the live model by itself.

## User

**Who:** A coding agent (Cursor, Claude Code, Codex, or a custom agent).

**How it works:** It calls **agent tools**. An agent tool is a JSON function the model invokes. The same JSON body is accepted at `POST /v1/tools/{name}`. The agent does not fill a dashboard.

**What it has at the start:** A job description. Optional sample files from the repo. Optional limits: images needed, max wait, max spend, allowed models.

**What it keeps across calls:** Opaque ids (`prj_`, `job_`, `ste_`, `cas_`, `run_`, `rec_`).

**What it does with a named model:** Writes the model id into app config. Live traffic still goes to OpenRouter or the vendor.

**What it will not do:** Open a mark screen. Invent trusted answers. Rewrite the prompt. Swap the live model. Send live user requests through this tool.

## Words

An **eval** is a check on one example. Input goes in. A score says whether the model did the job.

A **code eval** is scored by a program. Examples: valid JSON, correct tool name, a field equals a known value, a must-not-contain check. No person is needed on each run.

A **draft eval** is a suggested check. It is not trusted yet.

A **marked eval** is one a person scored because a program cannot decide (tone, fuzzy "good reply"). Two people must agree, or a third decides. Only then it is trusted for a model choice.

A **trusted eval** is one we will use to name a model. Code evals become trusted once accepted. Marked evals become trusted only after the two-person (or third-person) step.

An **eval set** is a versioned list of evals. New work makes a new version. Old versions stay.

A **run** is models scored on one eval-set version. It stores quality, time, and cost on the same examples.

A **named model** is the model the agent should put in the app. We recommend it. We do not apply it to live traffic.

A **job** is what the feature does, plus limits (images, max wait, max spend, allowed models).

A **project** is one AI feature.

**`next_action`** is always present on success and on error. It is the next tool to call, or a request to ask the human, then which tool to call after that.

## Jobs this user completes

This user finishes J1, J4, and J8. To get from J1 to J4 it also calls the mark and status tools (J2/J3 live in another slice). It may call failure and grow-the-set tools (J5/J6/J7 live in other slices). Those calls still follow the contracts below.

### J1. Start a new AI feature

**Goal:** Describe the job. Get draft evals.

**Given** a job description and optional sample files (and optional limits).

**When** the agent calls `generate_eval_suite`.

**Then** it gets:

- an eval set id
- at least one eval, each tagged `draft`
- which evals a program can score (`code`) vs which need a person (`person`)
- a mark URL only if some evals need a person
- `next_action`

If the job type is known, reuse that type’s score methods and hard examples, and add the sample files.

If the job type is unknown, do not fake a match. Ask what good means (how it should behave, what success is, what must never happen). Write pass/fail checks from that. Do not invent trusted answers.

Prefer code evals. People mark only the rest.

**Done:** `ste_` exists. At least one eval. Drafts are tagged `draft`.

**Branches:**

- All code evals → `next_action.tool = run_evals` (skip mark tools).
- Some person evals → `next_action.tool = queue_for_labeling`, `mark_url` set.
- Cannot write evals yet → error `JOB_UNCLEAR`. Agent asks the human what good means, then calls `generate_eval_suite` again with that text.

### J4. Run models and name the cheapest fast model that still passes

**Goal:** Run a short list of models on the same trusted evals. Name the cheapest fast model that still passes, or say none work.

**Given** a trusted eval set and the job’s limits.

**When** the agent calls `run_evals`, polls with `get_eval_report` until the run finishes, then calls `recommend_models` with `intent: "new_feature"` (or `add_feature` / `after_failure` / `recheck` when those paths apply).

**Then** the run records quality, time, and cost for each model on the same evals. `recommend_models` then:

1. Drops models that miss hard limits (cannot see images, too slow, too expensive, not allowed).
2. Drops models that fail the trusted evals.
3. If none remain: `does_not_work` plus failing eval ids. `named_model` is null. Do not name a model that fails.
4. If some remain: name the cheapest fast one that still passes.
5. Name a slower or costlier model only if quality is clearly better and limits still hold.
6. Return 0–2 backup models. Backups must also pass.

If there are too few trusted evals, return `need_more_evals` and the mark URL. Do not fake a named model.

**Done:** The agent has a model id to write into the app, or a clear no with failing eval ids. Live traffic was not changed.

**Branches:**

- Named model returned → agent writes the id into config. Stops.
- `does_not_work` → show failing eval ids to the human. Do not write a model id.
- `need_more_evals` → `queue_for_labeling` or add examples. Do not name a model.
- `COST_CAP_EXCEEDED` → read the partial `run_id`, raise the cap, or run a smaller model list.

### J8. Short report that fits in context

**Goal:** A short summary the agent can keep in one turn.

**Given** a `run_id` (or a `rec_` named-model id).

**When** the agent calls `get_eval_report`.

**Then** it gets a short summary: what passed, what failed, time, cost, whether new bad examples are missing from the eval set, and a report URL. Eval rows are paginated. No full traces. No model output blobs.

**Done:** The payload fits in the agent context. A human can open `report_url` for detail.

**Branches:**

- `status` is `queued` or `running` → poll `get_eval_report` again with the same `run_id`.
- `status` is `succeeded` or `partial` → `next_action` is usually `recommend_models`.
- New bad examples are not in the eval set → error `evals_missing_new_failures`. Next tool is `register_failure`. That is not a pass.

## Call order (J1 → J4)

Target: finish J1 through J4 in at most seven tool calls.

1. `generate_eval_suite`
2. `queue_for_labeling` only if some evals need a person
3. `get_label_status` until enough trusted evals (or skip if all were code evals)
4. `run_evals` (returns immediately)
5. `get_eval_report` until the run is done (counts as tool calls)
6. `recommend_models`

If `generate_eval_suite` returns `JOB_UNCLEAR`, the extra generate call after the human answers still counts toward the seven.

## Tool contracts

Same JSON on the agent tool and on `POST /v1/tools/{name}`. Small output. `additionalProperties` false on inputs. Enums for anything the agent branches on. Always `next_action`.

`next_action` shape:

```jsonc
{
  "tool": "generate_eval_suite" | "queue_for_labeling" | "get_label_status" | "run_evals" | "recommend_models" | "register_failure" | "get_eval_report" | null,
  "args": {},
  "ask_human": null | "what good means" | "open mark_url" | "none of the models passed; see failing_eval_ids"
}
```

If `tool` is null, the agent must do `ask_human`, then call the tool named in a follow-up `next_action` or retry the same tool with the new text.

### Shared ids

| Prefix | Object |
| --- | --- |
| `prj_` | Project (one AI feature) |
| `job_` | Job (description + limits) |
| `ste_` | Eval set |
| `cas_` | Eval |
| `run_` | Run |
| `rec_` | Named-model recommendation |

### 1. `generate_eval_suite`

**Jobs:** J1. Also called when the feature grew (J6 in another slice).

**When to call:** First call for a new feature. Call again after `JOB_UNCLEAR` with what good means. Call again when adding work to an existing eval set.

**Do:** Write draft evals. Known job type: use the library, plus sample files. Unknown job type: write pass/fail checks from what good means. Split code vs person. Tag computer-made examples `draft`. Do not invent trusted answers. Do not run models.

**Input:**

```jsonc
{
  "project_id": "prj_..." | null,          // created if omitted
  "eval_set_id": "ste_..." | null,         // set when adding to an existing set
  "description": "Invoice image → JSON line items",
  "sample_files": [{ "path": "fixtures/inv-001.json", "content": "..." }],
  "limits": {
    "needs_images": true,
    "max_wait_ms": 3000,
    "max_spend_usd_per_1k": 12.0,
    "allowed_models": ["anthropic/*", "openai/*"]
  },
  "what_good_means": null | {
    "how_it_should_behave": "...",
    "success": "...",
    "must_never": "..."
  }
}
```

Required: `description`, or `what_good_means` after `JOB_UNCLEAR`. `sample_files` optional. `limits` optional.

**Output:**

```jsonc
{
  "project_id": "prj_...",
  "job_id": "job_...",
  "eval_set_id": "ste_...",
  "version": 1,
  "evals": [
    { "eval_id": "cas_...", "title": "JSON has line_items[]", "score_how": "code", "status": "draft" }
  ],
  "n_code": 8,
  "n_person": 2,
  "n_draft": 10,
  "mark_url": "https://..." | null,
  "next_action": { "tool": "run_evals" | "queue_for_labeling", "args": {}, "ask_human": null }
}
```

Return at most a short preview of evals in `evals` (first 5). Full list is paginated via `get_eval_report`.

**Errors to branch on:**

| code | when | next_action |
| --- | --- | --- |
| `JOB_UNCLEAR` | Cannot write evals from the description | `tool: null`, `ask_human: "what good means"`. Then call this tool again with `what_good_means`. |

### 2. `queue_for_labeling`

**Jobs:** J3 (other slice). This user calls it so a person can mark.

**When to call:** After J1, only for evals a program cannot score. Skip if `n_person = 0`.

**Do:** Put those evals in the mark queue. Return a mark URL. Do not queue code evals.

**Input:**

```jsonc
{
  "project_id": "prj_...",
  "eval_set_id": "ste_...",
  "eval_ids": ["cas_..."] | null   // default: all person evals in the set
}
```

Required: `project_id`, `eval_set_id`.

**Output:**

```jsonc
{
  "n_queued": 2,
  "mark_url": "https://...",
  "next_action": { "tool": "get_label_status", "args": { "eval_set_id": "ste_..." }, "ask_human": "open mark_url" }
}
```

If `n_queued` is 0, `mark_url` is null and `next_action.tool` is `run_evals`.

**Errors to branch on:** none of the six job codes. A zero queue is success, not an error.

### 3. `get_label_status`

**Jobs:** J3 (other slice). This user polls it.

**When to call:** After `queue_for_labeling`, until enough trusted evals exist.

**Do:** Return counts. Do not mark anything.

**Input:**

```jsonc
{
  "project_id": "prj_...",
  "eval_set_id": "ste_..."
}
```

Required: both.

**Output:**

```jsonc
{
  "counts": {
    "draft": 3,
    "code": 8,
    "waiting_for_person": 2,
    "trusted": 8
  },
  "enough_trusted": true,
  "mark_url": "https://..." | null,
  "next_action": { "tool": "run_evals" | "get_label_status" | "queue_for_labeling", "args": {}, "ask_human": null | "open mark_url" }
}
```

`enough_trusted` is false until there are enough trusted evals to name a model (about 10 is the start bar; the mark slice owns the exact gate).

If `enough_trusted` is false, `next_action.tool` is `get_label_status` (poll) and `ask_human` is `open mark_url`.

**Errors to branch on:** this tool does not return `need_more_evals`. That code is returned by `recommend_models` if the agent asks for a name too soon.

### 4. `run_evals`

**Jobs:** J4. Also recheck (J7 in another slice).

**When to call:** After there is an eval set. For J4, after enough trusted evals.

**Do:** Run a short list of models on one eval-set version. Async. Honor a cost cap. Use the customer’s keys for model calls. Record quality, time, and cost on the same evals. Do not block the agent turn. Do not send live user traffic.

**Input:**

```jsonc
{
  "project_id": "prj_...",
  "eval_set_id": "ste_...",
  "eval_set_version": 1 | null,          // default: latest
  "models": ["anthropic/claude-sonnet-4.6"] | null,  // default: a short list that fits limits
  "max_eval_spend_usd": 2.0,
  "keys_ref": "pkr_..."
}
```

Required: `project_id`, `eval_set_id`, `max_eval_spend_usd`, `keys_ref`. `models` 1–8 if set.

**Output (immediate):**

```jsonc
{
  "run_id": "run_...",
  "status": "queued" | "running",
  "eta_s": 90,
  "est_cost_usd": 0.80,
  "next_action": { "tool": "get_eval_report", "args": { "run_id": "run_..." }, "ask_human": null }
}
```

**Errors to branch on:**

| code | when | next_action |
| --- | --- | --- |
| `COST_CAP_EXCEEDED` | Spend hit the cap before start, or mid-run | Partial `run_id` in the error body when a partial run exists. Agent reads it with `get_eval_report`, or raises `max_eval_spend_usd` and calls `run_evals` again. |
| `need_more_evals` | Eval set has too few trusted evals | `queue_for_labeling` or add examples. Do not run. |

### 5. `recommend_models`

**Jobs:** J4.

**When to call:** After a run has finished (or `partial` with usable results). Also after failure or recheck, with the matching `intent`.

**Do:** Name the cheapest fast model that passed the trusted evals inside limits, or say none work. Recommend only. Do not change live traffic. Do not rewrite the prompt.

**Input:**

```jsonc
{
  "project_id": "prj_...",
  "eval_set_id": "ste_...",
  "run_id": "run_...",
  "intent": "new_feature" | "add_feature" | "after_failure" | "recheck",
  "current_named_model": "anthropic/claude-sonnet-4.6" | null
}
```

Required: `project_id`, `eval_set_id`, `intent`. `run_id` required unless `next_action` already told the agent to run first. `current_named_model` required when `intent` is `after_failure` or `recheck`.

`intent` meaning:

| value | when |
| --- | --- |
| `new_feature` | J1 then J4 |
| `add_feature` | Feature grew; old evals still in the set |
| `after_failure` | A bad example was registered, or the named model now fails |
| `recheck` | Same evals, same scoring, later |

If `run_id` is missing or the run is still going, do not name a model. Return `next_action.tool = run_evals` or `get_eval_report`.

**Output:**

```jsonc
{
  "recommendation_id": "rec_...",
  "named_model": { "id": "anthropic/claude-sonnet-4.6", "backups": ["openai/gpt-4.1-mini"] } | null,
  "failing_eval_ids": ["cas_..."],
  "quality": { "n_pass": 27, "n_fail": 3 },
  "time_ms": { "p50": 820, "p95": 2100 },
  "cost_usd": 0.42,
  "report_url": "https://...",
  "next_action": { "tool": null | "get_eval_report" | "queue_for_labeling" | "register_failure" | "run_evals", "args": {}, "ask_human": null | "none of the models passed; see failing_eval_ids" | "open mark_url" }
}
```

`named_model` is null when the decision is not a name. `backups` has 0–2 models. Each backup must pass.

**Errors to branch on:**

| code | when | next_action |
| --- | --- | --- |
| `need_more_evals` | Too few trusted evals | Mark or add examples. Do not name a model. |
| `does_not_work` | No model passed | `ask_human` with failing eval ids. `named_model` null. |
| `need_new_model` | The current named model now fails | Call this tool again with `intent: "after_failure"`. Do not change live traffic. |
| `evals_missing_new_failures` | New bad examples are not in the eval set | `register_failure`. This is not a pass. |
| `COST_CAP_EXCEEDED` | The underlying run hit the cap and results are not enough to name | Use the partial `run_id`, or rerun with a higher cap. |

### 6. `register_failure`

**Jobs:** J5 (other slice). This user calls it when a bad example shows up.

**When to call:** A bad example showed up in the app, from a person, or on recheck. Also when `evals_missing_new_failures` is returned.

**Do:** Turn the failure into a candidate eval on a new eval-set version. Keep old evals. If a program can score it, skip mark. If a person must score it, `next_action` is mark.

**Input:**

```jsonc
{
  "project_id": "prj_...",
  "eval_set_id": "ste_...",
  "input": {},
  "output": {},
  "why_bad": "total_cents missing from JSON",
  "current_named_model": "anthropic/claude-sonnet-4.6" | null
}
```

Required: `project_id`, `why_bad`, and `input`. `eval_set_id` optional (project default). Truncate `input` / `output`; no full traces.

**Output:**

```jsonc
{
  "eval_id": "cas_...",
  "eval_set_id": "ste_...",
  "version": 4,
  "score_how": "code" | "person",
  "status": "draft",
  "mark_url": "https://..." | null,
  "next_action": { "tool": "run_evals" | "queue_for_labeling", "args": {}, "ask_human": null | "open mark_url" }
}
```

**Errors to branch on:** none of the six job codes on a successful register. After register, the next J4 run must include this eval and the old ones (J5/J6 rules).

### 7. `get_eval_report`

**Jobs:** J8. Also used to poll `run_evals`.

**When to call:** After `run_evals`. When the agent needs a short summary. To page through failing evals.

**Do:** Return a compact report. Paginate eval rows. Never dump traces.

**Input:**

```jsonc
{
  "project_id": "prj_...",
  "run_id": "run_..." | null,
  "recommendation_id": "rec_..." | null,
  "eval_set_id": "ste_..." | null,
  "cursor": null,
  "limit": 20
}
```

Required: `project_id` and exactly one of `run_id`, `recommendation_id`, `eval_set_id`. `limit` default 20, max 50.

**Output:**

```jsonc
{
  "status": "queued" | "running" | "succeeded" | "partial" | "failed",
  "summary": {
    "run_id": "run_...",
    "eval_set_id": "ste_...",
    "eval_set_version": 3,
    "n_pass": 27,
    "n_fail": 6,
    "time_ms": { "p50": 820, "p95": 2100 },
    "cost_usd": 0.91,
    "named_model_still_passes": true | false | null,
    "new_failures_missing_from_evals": false
  },
  "failing_eval_ids": ["cas_..."],
  "items": [
    { "eval_id": "cas_...", "title": "JSON has total_cents", "passed": false, "reason_short": "field missing" }
  ],
  "next_cursor": "q2..." | null,
  "truncated": false,
  "report_url": "https://...",
  "next_action": { "tool": "get_eval_report" | "recommend_models" | "register_failure" | null, "args": {}, "ask_human": null }
}
```

No `output` or trace fields. `reason_short` is one line. `items` is the current page only.

If `status` is `queued` or `running`, `next_action.tool` is `get_eval_report` with the same `run_id`.

If `new_failures_missing_from_evals` is true, that is `evals_missing_new_failures`: not a pass. `next_action.tool` is `register_failure`.

**Errors to branch on:**

| code | when | next_action |
| --- | --- | --- |
| `evals_missing_new_failures` | New bad examples are not in the eval set | `register_failure` |
| `need_new_model` | Named model now fails this run | `recommend_models` with `intent: "after_failure"` |
| `does_not_work` | No model on this run passed | Show `failing_eval_ids` |
| `COST_CAP_EXCEEDED` | Run stopped at the cap (`status: partial`) | Read what exists, or rerun with a higher cap |

## Errors this user must branch on

Every error has `code`, a short `message`, and `next_action`. The agent switches on `code`. It does not parse `message` to decide.

```jsonc
{
  "code": "need_more_evals",
  "message": "8 trusted evals; need more before naming a model",
  "run_id": "run_..." | null,
  "failing_eval_ids": [],
  "mark_url": "https://..." | null,
  "next_action": { "tool": "queue_for_labeling", "args": {}, "ask_human": "open mark_url" }
}
```

| code | meaning | agent must |
| --- | --- | --- |
| `need_more_evals` | Not enough trusted evals to name a model | Mark or add examples. Do not name a model. |
| `does_not_work` | No model passed | Show failing eval ids. Do not name a model. |
| `need_new_model` | The named model now fails | Call `recommend_models` with `intent: "after_failure"`. Do not change live traffic. |
| `evals_missing_new_failures` | New bad examples are not in the eval set | Call `register_failure`. Do not treat the run as a pass. |
| `COST_CAP_EXCEEDED` | Eval spend hit the cap | Use the partial `run_id` if present, or raise the cap and rerun. |
| `JOB_UNCLEAR` | Cannot write evals yet | Ask what good means. Call `generate_eval_suite` again. |

Do not invent a named model when any of these fire.

## Done-when for this user

This user is done when:

- J1 returned an eval set id, at least one eval, drafts tagged `draft`, and a `next_action`.
- Code evals never required a person.
- If some evals needed a person, the agent passed `mark_url` on and waited on `get_label_status` instead of marking.
- J4 returned a named model to write into config, or `does_not_work` with failing eval ids. Never a fake name.
- J1 through J4 took at most seven tool calls on the happy path.
- J8 fit in context: pass/fail counts, time, cost, missing-failure flag, report URL, no traces.
- The agent wrote the named model into the app itself. This tool did not.
- Live user requests never went through this tool.
- The prompt was not rewritten. The live model was not auto-swapped.

## Out of scope for this user

- Filling a dashboard, experiment table, or dataset UI
- Marking examples (developer and second person; other slice)
- Scoring-program internals (other slice)
- Keep-old-evals rules beyond: this user must send the existing `eval_set_id` and must not drop ids it already holds
- Recheck schedule / CI wiring (other slice), except it must honor `intent: "recheck"` and must not change live traffic
- Sending live user requests through this tool
- Rewriting prompts
- Changing the live model without the agent writing config
- Picking a model per live request
- Crowd marking
- A full eval website
- Extra tools beyond the seven above (`compare_models`, trace ingest, drift detect)
