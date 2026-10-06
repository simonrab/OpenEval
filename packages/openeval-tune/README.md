# openeval-tune

openeval-tune improves an AI feature. It changes one thing in each round:
the system prompt, the tool descriptions, the harness code, the model settings, or the model.

OpenEval is the referee. openeval-tune is the player.

- OpenEval scores each candidate. It gives the verdict on a hidden holdout split.
- openeval-tune sees training failures only. It uses an optimizer key. That key cannot see holdout evals.
- A change stays only when OpenEval gives the verdict `keep`.

The method follows the hillclimb loop of Claude Code `/claude-api hillclimb`:
one change per round, a train and holdout split, revert on overfit, a noise floor, stop on plateau, and real cost.
openeval-tune works with all model vendors. The referee is independent of the player.

The package has two parts:

1. **An agent skill** (`skills/openeval-tune/SKILL.md`). It tells a coding agent how to run the loop.
2. **A CLI** (`openeval-tune`). It does the OpenEval calls, runs the harness, and keeps the session state.

## Requirements

- Node.js 22 or later.
- An OpenEval server with a project and an eval set. The eval set needs 10 or more trusted evals for a holdout split.
- An optimizer key (`oeo_...`) for the project.
- A `keys_ref` for model calls (direct mode) or judge calls (harness mode with person evals).

A person with a full OpenEval key mints the optimizer key:

```sh
curl -s -X POST "$OPENEVAL_URL/v1/keys" \
  -H "Authorization: Bearer $FULL_KEY" -H "content-type: application/json" \
  -d '{"project_id":"prj_...","scope":"optimizer"}'
```

## Install

### The CLI

From the OpenEval repository:

```sh
npm install
npx openeval-tune help
```

The `bin` file loads TypeScript through `tsx`. It needs no build step.

### The skill as a Claude Code plugin

Use one of these methods:

- Add the package directory as a plugin marketplace, then install the plugin:

  ```text
  /plugin marketplace add ./packages/openeval-tune
  /plugin install openeval-tune@openeval-tune
  ```

- Load the plugin for one session:

  ```sh
  claude --plugin-dir packages/openeval-tune
  ```

- Copy only the skill into a project or into your user skills:

  ```sh
  mkdir -p .claude/skills && cp -R packages/openeval-tune/skills/openeval-tune .claude/skills/
  ```

Other coding agents can read `skills/openeval-tune/SKILL.md` as plain instructions.

## Configuration

| Variable | Flag | Use |
|----------|------|-----|
| `OPENEVAL_URL` | `--url` | The OpenEval server URL. |
| `OPENEVAL_KEY` | (none) | The optimizer key (`oeo_...`). The loop uses only this key. |
| `OPENEVAL_ADMIN_KEY` | (none) | A full key. Only `promote` uses it. |
| `OPENEVAL_PROJECT_ID` | `--project` | The project id (`prj_...`). |
| `OPENEVAL_EVAL_SET_ID` | `--eval-set` | The eval set id (`ste_...`). |
| `OPENEVAL_KEYS_REF` | `--keys-ref` | The stored vendor key reference. |
| `OPENEVAL_TUNE_DIR` | `--state-dir` | The state directory. The default is `.openeval-tune`. |
| `OPENEVAL_TUNE_POLL_MS` | `--poll-ms` | The poll interval for run reports. The default is 2000. |

The CLI never prints a key. It refuses a full key in `OPENEVAL_KEY`.
It refuses an optimizer key in `OPENEVAL_ADMIN_KEY`.

The state file is `.openeval-tune/state.json`. It holds the session id, the mode, the reps,
the baseline ids, the first baseline ids, all runs, all rounds, the spend, the budget, and the promotion stage.
Do not commit this directory. The OpenEval repository ignores it.

## Commands

Each command prints one JSON object on stdout. Notes and progress go to stderr.

| Command | Flags | What it does |
|---------|-------|--------------|
| `baseline` | `--mode harness --cmd "<cmd>" [--label base]` or `--mode direct --candidate <json\|file>`; session flags `--reps 3 --budget 10 --max-rounds 20 --objective quality\|cost --min-effect 0.05 --new-session` | Scores the baseline. Starts the session or updates it. |
| `run-harness` | `--cmd "<cmd>" --label <label> [--reps N] [--concurrency 4] [--timeout-ms 60000] [--commit <sha>] [--description <text>] [--max-spend 2]` | Reads all eval inputs page by page. Runs the harness for each input and rep. Submits the outputs. |
| `run-direct` | `--candidate <json\|file> [--label <label>] [--reps N] [--max-spend 2]` | Calls `run_evals` with one candidate. Polls the report until the run is done. |
| `failures` | `[--run <id> --candidate <id>] [--limit 20]` | Shows training failures. The default is the current baseline. |
| `verdict` | `[--run <id> --candidate <id>] [--baseline-run <id> --baseline-candidate <id>] [--objective cost] [--min-effect 0.05]` | Gets the verdict in the session. Updates the state. The default candidate is the last run. |
| `status` | (none) | Shows the session, the baseline, the rounds, the flat rounds, and the spend against the budget. |
| `report` | (none) | Compares the final baseline with the first baseline. It records no round. |
| `promote` | `--run <id> --candidate <id> [--reuse-run] [--setup <json\|file>] [--max-spend 2] [--intent new_feature\|add_feature]` or `--continue [--full\|--rollback]` | Takes a direct setup to the OpenEval Live human gates. |

A direct candidate is JSON:

```json
{"model":"openai/gpt-4.1-mini","label":"r3","settings":{"temperature":0.2},"system_prompt_file":"prompts/system.txt"}
```

`system_prompt_file` is relative to the JSON file. You can use `system_prompt` with the text in place of it.
The candidate id is `model#label`.

A harness candidate id is `harness#<label>`.

### Exit codes

| Code | Meaning | Agent action |
|------|---------|--------------|
| 0 | Success, or the verdict `keep` | Keep the commit. |
| 1 | Error | Read stderr. |
| 2 | `revert_overfit` or `revert_regressed` | Revert the commit. |
| 3 | `within_noise` | Revert the commit. |
| 4 | `not_comparable` | Fix coverage or errors. Score again. |
| 5 | Plateau | Revert the commit. Stop. Put the failures into groups. |
| 6 | The budget is spent, or the round limit is done | Read `verdict` in the JSON. Keep or revert. Stop. |
| 7 | `promote` waits for a person | Give the approval URL to the user. |

## The harness protocol

In harness mode, the CLI runs your command once for each input and rep.
The command runs in a shell, in the current directory.

**stdin**: one JSON object.

```json
{"eval_id":"ev_01","input":"Return JSON with line_items and total_cents.","system_prompt":null,"rep":0}
```

`system_prompt` is the job system prompt in OpenEval, or `null`.

**stdout**: the model output. The CLI removes one final newline.
The limit is 200000 characters. A longer output becomes an error entry.

**Exit code**: 0 is success. A non-zero exit code becomes an error entry with the last stderr line.
A timeout (`--timeout-ms`) stops the process group and becomes an error entry.

**Usage (optional)**: write one stderr line that starts with `OPENEVAL_USAGE `, then JSON:

```text
OPENEVAL_USAGE {"cost_usd":0.0012,"prompt_tokens":350,"completion_tokens":80,"served_model":"openai/gpt-4.1-mini","time_ms":900}
```

All fields are optional. The last valid line is used. Without `time_ms`, the CLI measures the wall time.
The cost goes into the run spend and into the session budget.

**Environment**: the CLI removes `OPENEVAL_KEY` and `OPENEVAL_ADMIN_KEY`.
It sets `OPENEVAL_EVAL_ID` and `OPENEVAL_REP`.

A small harness in Node.js:

```js
// scripts/eval-harness.mjs
import { answer } from "../src/feature.js";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const { input } = JSON.parse(raw);
const res = await answer(input);
process.stderr.write(`OPENEVAL_USAGE ${JSON.stringify({ cost_usd: res.costUsd })}\n`);
process.stdout.write(res.text);
```

## The loop

1. Make the branch `openeval-tune/<session>`. Do not work on `main`.
2. Run `baseline`.
3. Run `failures`. Read the training failures only.
4. Write one hypothesis. Make one change. Commit it with the hypothesis in the message.
5. Run `run-harness` or `run-direct` with the same mode and reps as the baseline.
6. Run `verdict`. Keep or revert the commit from the exit code.
7. Go to step 3. Stop on plateau (exit 5), budget or round limit (exit 6).
8. Run `report`. Ask a person to review and merge the branch.

The skill file has the full procedure and the JSON of each OpenEval call.

## Promotion

`promote` is optional. It takes a direct setup (model, settings, and system prompt) to OpenEval Live.
It uses the full key in `OPENEVAL_ADMIN_KEY`. It never approves a gate. A person opens each approval URL.

1. `promote --run <id> --candidate <id>` makes a confirm run with the full key (`--reuse-run` skips it).
   Then it calls `recommend_models`. **Gate 1**: a person approves the named setup.
2. `promote --continue` calls `compile_policy`. **Gate 2**: a person approves the policy.
   The first policy of a project becomes the last full policy at this gate. Then the promotion is done.
3. `promote --continue` calls `propose_rollout` with `canary`. **Gate 3**: a person approves the 5% canary.
4. `promote --continue` shows the canary status. A person reads the live report and decides.
5. `promote --continue --full` or `promote --continue --rollback`. **Gate 4**: a person approves it.
6. `promote --continue` confirms that the change is live.

OpenEval names a setup only when it passes every trusted eval. If the setup fails one, `promote` stops.

If the setup has a system prompt, the OpenEval SDK sends it only with `applyPolicySystemPrompt: true`.
The proxy sends it only with the header `x-openeval-apply-system-prompt: true`.
When it is sent, it replaces the app system prompt.

A harness candidate is app code. To ship it, merge the branch. `promote` refuses a harness candidate.

## Limits

- One run holds 2000 outputs or fewer (inputs times reps). Use fewer reps for a large eval set.
- One `submit_outputs` body is 16 MB or less.
- The harness timeout uses process groups. On Windows, the CLI stops only the shell process.
- The session budget counts the run spend that OpenEval reports and the harness cost.
  A direct run can go above the budget by the cost of one run. The cap of each run is the remaining budget.

## Development

```sh
npm test --workspace openeval-tune       # unit tests of the package and an end-to-end run against OpenEval
npm run typecheck --workspace openeval-tune
```
