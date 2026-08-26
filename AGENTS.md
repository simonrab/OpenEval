# Agent guidelines

## Spec

`EVALROUTER_REQUIREMENTS.md` is product truth. Do not edit it unless the user explicitly asks to change the spec. Do not edit files under `spec/` unless the user explicitly asks.

`BUILD.md` is the build order only. Do not put build order inside the spec. If `BUILD.md` and the requirements disagree, the requirements win.

Do not invent new product goals. Do not implement work the spec lists as out of v0.

## Product

EvalRouter is an **agent tool** (a JSON function the model invokes) and an **HTTP API** (`POST /v1/tools/{name}`). Same JSON body either way.

It is not in front of OpenRouter or Ramp. Live users still go: app → OpenRouter or Ramp → model. This tool never sits on that path.

Agents do not discover it on the internet. You install it: MCP config, or an API URL with a key. **MCP** is a config file that lists tools the model may call.

The agent calls this tool, gets a **named model** (the model id to put in the app), and writes that name into the app. This tool never switches live traffic by itself.

## Evals vs tests

An **eval** is a product check on one example. Input in. A score says whether the model did the job.

Evals are not unit tests. Do not call evals "tests" in product copy, APIs, or user-facing strings.

## BDD (product jobs)

**BDD** here means: product jobs use Given / When / Then from the spec (J1–J8). A slice is done when those Then checks hold.

Do not invent new jobs. Read J1–J8 in the requirements before coding a slice.

- J1: start a new AI feature (`generate_eval_suite`)
- J2: score with a program where possible
- J3: people mark only when a program cannot
- J4: run models and name the cheapest fast model that still passes
- J5: a failure becomes an eval (`register_failure`)
- J6: new work does not drop old evals
- J7: recheck a saved eval-set version (CI can fail the build)
- J8: short report that fits in context (`get_eval_report`)

## TDD (implementation)

**TDD** here means: the API, runner, and MCP adapter use unit and integration tests. Write a failing test, then write the code that makes it pass.

CI can fail the build when the named model fails evals. That is J7 (recheck), not TDD.

## Scoring

Prefer **code evals** (a program scores the example). People mark only when a program cannot. Mark once per eval-set version. Later runs reuse the mark.

A model may suggest a check. A program or a person must confirm. A model does not create a trusted eval by itself.

## Do not build (v0)

- A live proxy in front of OpenRouter, Ramp, or the model company
- Auto-swap of the live model
- Prompt rewrite
- An eval dashboard (tables, experiments, datasets)
- Crowd marking

## Slice loop (orchestrator)

Roles: one orchestrator, one implementer, one reviewer. The orchestrator does not write product code.

1. Implementer does the current slice (TDD).
2. Reviewer checks `BUILD.md` done-when, spec freeze, tests.
3. If review fails: implementer fixes. Repeat 1–2. Do not start the next slice.
4. If review passes: orchestrator writes the handoff, then **starts the next slice at once**. Do not wait for the user.

Handoff path: `build/handoffs/slice-N.md` (N is the slice that just passed). Write it only after review passes. Follow the template in `build/handoffs/README.md`.

Then start slice N+1 with a new implementer, then a new reviewer. Same rules.

Stop the chain (do not auto-jump) when:

- Review still fails
- Slice 10 has a passing handoff (`build/handoffs/slice-10.md`) — v0 slices are done; wait for the user before M7 extras
- The user says stop
- The next slice needs a secret you do not have (OpenRouter key for slice 4+). Write that in the handoff and wait.

Do not skip a slice. Do not write a handoff for a slice that is not done.

## Language

Short sentences. One idea per sentence. Define a term the first time you use it.
