# Agent guidelines

## Spec

`EVALROUTER_REQUIREMENTS.md` is v0 product truth. Do not edit it unless the user explicitly asks to change the spec. Do not edit files under `spec/` unless the user explicitly asks.

`EVALROUTER_RUNTIME_REQUIREMENTS.md` is Live product truth (the live hop). Do not edit it unless the user explicitly asks. If a Live note and that file disagree, that file wins.

`BUILD.md` is the v0 build order. `RUNTIME_BUILD.md` is the Live build order. Do not put build order inside a spec. If a build file and its requirements disagree, the requirements win.

Do not invent new product goals. Do not implement work a spec lists as out of scope.

v0 slices are done. Do not auto-start Live slices. Wait for the user before `RUNTIME_BUILD.md` slice L0.

## Product

EvalRouter is an **agent tool** (a JSON function the model invokes) and an **HTTP API** (`POST /v1/tools/{name}`). Same JSON body either way.

It is not in front of OpenRouter or Ramp. Live users still go: app → OpenRouter or Ramp → model. This tool never sits on that path.

Agents do not discover it on the internet. You install it: MCP config, or an API URL with a key. **MCP** is a config file that lists tools the model may call.

The agent calls this tool, gets a **named model** (the model id to put in the app), and writes that name into the app. This tool never switches live traffic by itself.

**EvalRouter Live** is a second product. Spec: `EVALROUTER_RUNTIME_REQUIREMENTS.md`. An in-process SDK serves the approved named model, falls back on vendor error, and sends redacted misses back into v0. It is not a hosted proxy. It does not name a model.

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

Live jobs (R1–R6) live in `EVALROUTER_RUNTIME_REQUIREMENTS.md`. Do not invent new Live jobs. Do not implement Live unless the user asks to start `RUNTIME_BUILD.md`.

- R1: compile a policy (`compile_policy`)
- R2: serve live from cached policy (SDK hop)
- R3: sample live misses off the request
- R4: promote a sample into v0 (`promote_live_sample`)
- R5: canary 5% with a human gate
- R6: rollback or 100%, with a human gate

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

## Do not build (Live v1)

See `EVALROUTER_RUNTIME_REQUIREMENTS.md` section 15. In short: hosted proxy, learned per-request pick, evals on the request, dashboard, auto-swap, extra languages/sidecar, canary fractions other than 5% then 100%.

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

Write spec text, product copy, APIs, user-facing strings, handoffs, and agent docs in **ASD-STE100 Simplified Technical English**.

Rules:

- One idea in each sentence. One meaning for each word. One word for each meaning.
- Procedure sentences: 20 words or fewer. Description sentences: 25 words or fewer.
- Active voice. Simple present, simple past, imperative, or `must` / `will` / `can`. Do not use `should`, `could`, or `might`.
- Do not use an `-ing` word as a verb. You can use an `-ing` word as a technical noun if section 1 of the spec defines it.
- Do not use `without`, `during`, `and/or`, contractions, `e.g.`, `i.e.`, or `etc.`
- Define a technical noun the first time you use it. Keep that term. Do not switch to a synonym.
- Do not call evals "tests." Do not call Live a router.

Code, tests, and JSON field names are not STE. Comments and error `message` strings that a person reads are STE.
