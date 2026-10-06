---
name: openeval-tune
description: Improve or tune an AI feature with OpenEval as the referee. Use when the user asks to improve, tune, optimize, or hillclimb the system prompt, tool descriptions, harness code, model, or model settings of an AI feature against OpenEval evals. Makes one change per round, scores it, keeps it only on an OpenEval "keep" verdict, and stops on plateau, budget, or round limit.
---

# openeval-tune

You are the player. OpenEval is the referee.
You change the AI feature one change at a time.
OpenEval scores each change and gives a verdict on a hidden holdout split.
You see training failures only. You never see holdout evals.

Use the `openeval-tune` CLI for every step.
Each command prints one JSON object on stdout and short notes on stderr.
Run `openeval-tune help` for all flags.

## Rules

1. Make one change per round. One hypothesis, one change, one commit.
2. The effect is the measure. The size of the diff is not the measure.
3. Remove fluff from prompts. Short, clear instructions are better than long lists.
4. Never edit evals, graders, judges, rubrics, or OpenEval config.
5. Never try to find out which evals are in the holdout split.
   Do not compare counts across runs to guess holdout evals.
6. Use only the optimizer key (`oeo_...`) in the loop. Never use a full key in the loop.
7. Never work on `main`. Work on the branch `openeval-tune/<session>`.
8. Never open or approve an approval URL. A person does that.
9. Never call evals "tests" when you talk to the user.

## Setup

1. Confirm the environment. All of these must be set:

   ```sh
   echo "$OPENEVAL_URL" "$OPENEVAL_PROJECT_ID" "$OPENEVAL_EVAL_SET_ID" "$OPENEVAL_KEYS_REF"
   test -n "$OPENEVAL_KEY" && case "$OPENEVAL_KEY" in oeo_*) echo "optimizer key ok";; *) echo "NOT an optimizer key";; esac
   ```

   Do not print the key. If `OPENEVAL_KEY` is missing, ask a person with a full key to mint one:

   ```sh
   curl -s -X POST "$OPENEVAL_URL/v1/keys" \
     -H "Authorization: Bearer $FULL_KEY" -H "content-type: application/json" \
     -d '{"project_id":"prj_...","scope":"optimizer"}'
   # => {"api_key":"oeo_...","scope":"optimizer","project_id":"prj_..."}
   ```

2. Ask the user and write down the answers:
   - Levers that you can change: system prompt, tool descriptions, harness files, model settings, model.
   - Paths that are off limits.
   - Objective: `quality` (default) or `cost`.
   - Budget ceiling in USD.
   - Maximum number of rounds.
   - Reps per input (default 3).
   - Minimum effect that matters (`min_effect`, for example 0.05).

3. Pick the mode. Baseline and every candidate use the same mode, reps, and eval set.
   - **Direct mode**: only the system prompt, model settings, or model change.
     OpenEval calls the model with `run_evals`.
   - **Harness mode**: tool descriptions, harness code, or other app code change.
     The app harness runs on your machine, and the CLI submits its outputs.

4. Make the branch `openeval-tune/<session>`. `<session>` is a short session name, for example the date.
   Never work on `main`.

   ```sh
   git switch -c openeval-tune/$(date +%Y%m%d-%H%M)
   ```

### The harness command (harness mode)

The harness command runs once for each input and rep.

- stdin: one JSON object `{"eval_id":"ev_...","input":"...","system_prompt":"..." or null,"rep":0}`.
- stdout: the model output. The CLI removes one final newline.
- Exit code 0 means success. A non-zero exit code, or a timeout, gives an `error` entry.
- Optional usage: write one stderr line
  `OPENEVAL_USAGE {"cost_usd":0.0012,"prompt_tokens":350,"completion_tokens":80,"served_model":"vendor/model","time_ms":900}`.
  All fields are optional. The last valid line is used.
- The CLI removes `OPENEVAL_KEY` and `OPENEVAL_ADMIN_KEY` from the harness environment.
  It sets `OPENEVAL_EVAL_ID` and `OPENEVAL_REP`.

If the app has no such entry point, write a small script that calls the real app code path.
Commit that script before the baseline. Do not change it during the loop.

## Baseline

Harness mode:

```sh
openeval-tune baseline --mode harness --cmd "node scripts/eval-harness.mjs" --label base \
  --reps 3 --budget 10 --max-rounds 15 --objective quality --min-effect 0.05 \
  --commit "$(git rev-parse --short HEAD)"
```

Direct mode (`candidate.json` can hold `system_prompt_file`, relative to the JSON file):

```sh
cat > candidate.json <<'EOF'
{"model":"openai/gpt-4.1-mini","settings":{"temperature":0.2},"system_prompt_file":"prompts/system.txt"}
EOF
openeval-tune baseline --mode direct --candidate candidate.json --label base \
  --reps 3 --budget 10 --max-rounds 15
```

The output has `run_id`, `candidate_id`, `session_id`, and spend.

## Round

Do these steps in each round.

1. Read the training failures of the current baseline. Do not read anything else about scores.

   ```sh
   openeval-tune failures --limit 20
   ```

2. Find one pattern in the failures. Write one hypothesis.
   Example: "The model wraps JSON in markdown fences. A sentence that forbids fences fixes 4 failures."
3. Make one change for that hypothesis. Commit it with the hypothesis in the message:

   ```sh
   git commit -am "tune r3: forbid markdown fences in JSON output

   Hypothesis: 4 train failures wrap JSON in fences."
   ```

4. Score the candidate with the same mode and reps as the baseline.

   ```sh
   # harness mode
   openeval-tune run-harness --cmd "node scripts/eval-harness.mjs" --label r3 \
     --commit "$(git rev-parse --short HEAD)" --description "forbid markdown fences"
   # direct mode
   openeval-tune run-direct --candidate candidate.json --label r3
   ```

5. Ask for the verdict. The CLI uses the session and the current baseline from the state file.

   ```sh
   openeval-tune verdict; echo "exit=$?"
   ```

6. Act on the exit code:

   | Exit | Verdict | Do this |
   |------|---------|---------|
   | 0 | `keep` | Keep the commit. The candidate is the new baseline. |
   | 2 | `revert_overfit`, `revert_regressed` | `git revert --no-edit HEAD`. |
   | 3 | `within_noise` | `git revert --no-edit HEAD`. The change is not larger than the noise. |
   | 4 | `not_comparable` | Do not judge the change. Fix coverage or harness errors. Score again. |
   | 5 | plateau | Revert this commit. Stop the loop. Go to "Plateau". |
   | 6 | budget spent or round limit done | Read `verdict` in the JSON. Keep or revert this commit. Stop. |
   | 1 | error | Read stderr. Fix the cause. Do not guess a verdict. |

7. If the JSON has `"underpowered": true`, the noise is larger than `min_effect`.
   Make a new baseline with more reps (`baseline --reps 5 ...`), or stop and ask the user.

Then start the next round.

## Plateau

At a plateau, do not make more changes. Put the remaining training failures into groups:

- **Grader disagreement**: the output looks correct, but the grader fails it. Tell the user. Do not edit the grader.
- **Harness error**: the harness crashed or timed out. Fix the harness only if the user agrees.
- **Structural**: the fix needs a lever that is off limits, a new tool, or a different model.
- **Noise**: the eval is flaky across reps.

Give the user the eval ids and one example per group.

## Finish

1. Run the report. It compares the final baseline with the first baseline. It does not record a round.

   ```sh
   openeval-tune report
   openeval-tune status
   ```

2. Tell the user:
   - Each kept change: commit, hypothesis, and the verdict evidence (train and holdout delta).
   - The holdout delta of the final baseline against the first baseline.
   - The cost per call delta and the p50 latency delta.
   - The total spend against the budget.
3. Ask the user to review and merge the branch. Do not merge it yourself.

## Promotion (optional, direct mode only)

Do this only when the user asks for it. A person approves each gate.
`promote` needs a full key in `OPENEVAL_ADMIN_KEY`. The user sets it. Never use it in the loop.
A harness candidate is app code: the user ships it with the branch merge.

```sh
openeval-tune promote --run <run_id> --candidate <candidate_id>   # exit 7 = waits for a person
```

The CLI runs a confirm run with the full key, then calls `recommend_models`.
OpenEval names a setup only when it passes every trusted eval.
After each gate, give the `approve_url` to the user. Wait until the user says that they approved it. Then run:

```sh
openeval-tune promote --continue
```

| Gate | What the person approves | Next stage |
|------|--------------------------|------------|
| 1 | The named setup (`/approve`) | `compile_policy` |
| 2 | The compiled policy (`/compile-approve`) | If this is the first policy of the project, it is live now. Else a canary proposal. |
| 3 | The 5% canary (`/rollout-approve`) | The canary runs on live traffic. |
| 4 | The full rollout or the rollback (`/rollout-approve`) | Done. |

When the stage is `canary_live`, the user reads the live report and decides.
Run `openeval-tune promote --continue --full` or `openeval-tune promote --continue --rollback` only on the user's decision.

If the winning setup has a system prompt, tell the user:
the OpenEval SDK sends the policy system prompt only with `applyPolicySystemPrompt: true`.
The proxy sends it only with the header `x-openeval-apply-system-prompt: true`.
When it is sent, it replaces the app system prompt. The app change must be in place before the canary.

## OpenEval calls that the CLI makes

All calls are `POST {OPENEVAL_URL}/v1/tools/{name}` with `Authorization: Bearer <key>` and a JSON body.
The same tool names work over the OpenEval MCP server. Each idempotency key is a new random UUID.

`get_eval_inputs` (harness mode, page by page):

```json
{"project_id":"prj_1","eval_set_id":"ste_1","limit":200,"cursor":"200"}
```

`submit_outputs` (harness mode; one output for each input and rep):

```json
{"project_id":"prj_1","eval_set_id":"ste_1",
 "candidate":{"id":"harness#r3","label":"r3","description":"forbid markdown fences","commit":"a1b2c3d"},
 "outputs":[{"eval_id":"ev_1","rep":0,"output":"{\"total\":3}","time_ms":812,"cost_usd":0.0011,"prompt_tokens":340,"completion_tokens":20,"served_model":"openai/gpt-4.1-mini"},
            {"eval_id":"ev_2","rep":0,"error":"The harness timed out after 60000 ms.","time_ms":60000}],
 "keys_ref":"key_1","max_eval_spend_usd":2,
 "idempotency_key":"7d2c1c9e-4f0a-4a51-9a53-0f3e1f3c2b10"}
```

`run_evals` (direct mode):

```json
{"project_id":"prj_1","eval_set_id":"ste_1",
 "candidates":[{"id":"openai/gpt-4.1-mini#r3","model":"openai/gpt-4.1-mini","settings":{"temperature":0.2},"system_prompt":"Answer in JSON only."}],
 "reps":3,"max_eval_spend_usd":2,"keys_ref":"key_1",
 "idempotency_key":"3b8e0f5a-0d6e-4f63-8a8c-2b7c4a1d9e21"}
```

`get_eval_report` (poll until `succeeded`, `partial`, or `failed`):

```json
{"project_id":"prj_1","run_id":"run_..."}
```

`get_training_failures`:

```json
{"project_id":"prj_1","run_id":"run_...","candidate_id":"harness#r2","limit":20}
```

`get_verdict` (in the session; `idempotency_key` is necessary with `session_id`):

```json
{"project_id":"prj_1","baseline_run_id":"run_a","baseline_candidate_id":"harness#r2",
 "candidate_run_id":"run_b","candidate_id":"harness#r3","objective":"quality",
 "session_id":"tune-5f0c...","min_effect":0.05,
 "idempotency_key":"c1f4a7d2-8e3b-4b9a-b1c6-5d2e7f9a0b13"}
```

Promotion calls use the full key only:
`run_evals`, `recommend_models {"project_id","eval_set_id","run_id","intent":"new_feature","idempotency_key"}`,
`compile_policy {"project_id","recommendation_id","eval_set_id","idempotency_key"}`,
`get_live_report {"project_id"}`, and `propose_rollout {"project_id","intent":"canary"|"full"|"rollback","idempotency_key"}`.
