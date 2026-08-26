# EvalRouter — developer spec

This slice is for the person who owns the AI feature.
The coding agent, the second marker, and CI are other slices.

## User

You own the AI feature.

You accept or edit the evals the agent proposes.

You mark an example only when a program cannot score it.

You approve or reject the named model.

You put the approved name in the app, or you let the agent write it there after you approve.

You may be the first person to mark, or the second person, or the third if the first two disagree.

This tool does not sit in live user traffic.
It is not a second OpenRouter.

## Words

**Eval:** a check on one example. Input in. Score whether the model did the job.

**Code eval:** a program scores it. Examples: valid JSON, correct tool name, field equals a known value, a test in the repo passes, must-not-contain. No person needed on later runs.

**Draft eval:** a suggested check. Not trusted yet.

**Marked eval:** a person set the right answer or pass/fail because a program cannot decide. Two people must agree, or a third decides. Only then we trust it for a model choice.

**Trusted eval:** a code eval, or a marked eval that two people agreed on (or a third decided). Only trusted evals gate a model name.

**Named model:** the model to put in the app. We recommend it. We do not switch live traffic ourselves.

**Eval set:** a versioned list of evals for this feature. New work makes a new version. Old versions stay.

## Job of the product

Check that the feature works, using evals for this job.

Name the cheapest fast model that still passes, under your time and money limits.

Recheck when the product changes.

## What you must approve

1. Draft evals, or your edits of them, before they are trusted or sent to a person to mark.
2. Your mark on any eval a program cannot score. A second person must agree, or a third decides.
3. The named model before it goes in the app.

You do not approve a model that fails trusted evals.

You do not approve a name when there are too few trusted evals.

A model may suggest a draft eval or a draft answer. You confirm, edit, or reject it. A model does not create a trusted answer by itself.

## Jobs

### J3 — Mark only when a program cannot score

#### Skip

Given an eval with a program check (valid JSON, tool name, known field, a test in the repo, must-not-contain).

When the agent scores it.

Then a program scores every run.

You do not see this eval on a mark screen.

It never sits in a mark queue.

#### Mark

Given evals with no program check.

When people must decide (tone, fuzzy “good reply”).

Then you see a mark screen for those evals only.

You write the right answer or pass/fail.

You may confirm or rewrite a draft answer a model suggested.

Mark once. Later runs use that mark. A program re-runs the scoring. You do not mark the same example again each run.

Two people mark the same example. You may be first or second.

If they disagree, a third person decides. You may be that third person if you were not one of the two.

#### Too few trusted evals

Given a mark queue that is unfinished, and not enough trusted evals (about 10 is the start bar).

When the agent asks for a named model.

Then the product returns `need_more_evals` and a mark link.

It does not fake a model name.

Untrusted evals do not block a name if enough trusted evals already exist.

#### Done when

- Code evals never appear on a mark screen.
- Fuzzy evals appear only until they are marked and agreed, or a third person decides.
- You mark once per example, not per run.
- A model name is not returned unless enough trusted evals exist.

### Edit draft evals the agent proposed

Given the agent wrote draft evals for this job.

When you open the drafts.

Then you can accept, edit, or reject each one.

You can change the example, the pass/fail check, or how it is scored.

If you can turn a fuzzy draft into a code eval, do that. Then it never goes to a mark queue.

Computer-made drafts stay tagged draft until you accept them.

A program can confirm that a code eval’s check exists. You still accept that this is the right check for the job.

Rejected drafts are dropped. They are not used to name a model.

#### Done when

- No draft is trusted until you accept it.
- A code eval you keep is scored by a program from then on.
- Edited drafts replace the suggestion. The old suggestion is not trusted.

### J6 — New feature must keep old evals

Given an existing named model and new work.

When the agent says the feature grew.

Then the product writes new draft evals for the new work.

Old evals stay.

The next model run uses the union: old evals plus new ones.

The eval set gets a new version. Old versions stay.

You still accept or edit the new drafts.

You still mark only the ones a program cannot score.

You cannot drop old evals to make a new model look good.

Do not name a model that fails old evals.

You may retire an old example that no longer happens. That is a new eval-set version. History is not deleted.

#### Done when

- The union still contains every old trusted eval, unless you retired it in a new version.
- A named model that fails an old eval is not offered for approval.
- Going backwards on old work is not allowed in v0.

### Approve or reject the named model

Given a run on trusted evals, inside your time and money limits.

When the product names a model, or says none work.

Then you see the name, 0–2 backups, quality, time, and cost.

You also see failing eval ids if none passed.

#### Approve

Given a named model that passed the trusted evals.

When you accept it.

Then the agent puts that name in the app.

This tool does not change live traffic.

#### Reject

Given a named model you do not want.

When you reject it.

Then that name is not written into the app by this tool.

You may add evals, change limits, or ask the agent to run again.

#### None work

Given no model passed.

When you review the result.

Then the product returns `does_not_work` and the failing eval ids.

You do not approve a failing model.

#### Too few trusted evals

Given not enough trusted evals.

When you would otherwise approve a name.

Then the product returns `need_more_evals`.

You mark or add examples. You do not get a fake name.

#### Done when

- An approved name is what the agent should put in the app.
- A rejected name is not written into the app by this tool.
- Live traffic is unchanged by this tool either way.
- v0 does not rewrite the prompt.

## Screens (only if needed)

You do not need a full eval website.

**Drafts.** A list of suggested evals. Each is tagged draft. Each says whether a program can score it. Actions: accept, edit, reject.

**Mark.** Only evals a program cannot score. You set the right answer or pass/fail. You see a draft answer if a model suggested one. Skip this screen when every eval is a code eval. The second marker sees the same kind of form. Form fields are in the marker spec.

**Named model.** The recommended model, 0–2 backups, quality, time, cost, and failing evals if none work. Actions: approve, reject. Approving does not switch live traffic.

## What you never have to do

- Invent evals from nothing. The agent writes drafts.
- Mark a code eval.
- Mark the same example on every later run.
- Send live user requests through this tool.
- Let this tool change the live model by itself.
- Rewrite the prompt in v0.
- Pick a model for each live user request.
- Use a full eval dashboard (tables, experiments, datasets).
- Crowd-mark.
- Sit in the middle of OpenRouter or the model company.

## Out of this slice

The coding agent’s tool calls, the second marker’s form fields, and CI recheck are other specs.
