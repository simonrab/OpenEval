# 03. Marker (second person)

Slice of the EvalRouter product spec. This file is the contract for the second person who marks examples. It does not specify the agent API, the developer’s accept-evals job, or how a model is named.

## User

You are a domain person or a teammate. You are not the coding agent. You are not the primary developer.

Your job is to say what a good answer looks like when a program cannot score.

You open a mark link. You work on one eval at a time. You do not name a model. You do not run models. You do not keep a dashboard.

Another person marks the same evals. You are the second mark. If the two of you disagree, a third person decides.

Prefer program-scored evals. You only see the rest.

## Words

| Term | Meaning |
| --- | --- |
| Eval | A check on one example. Input in. Score whether the model did the job. |
| Code eval | A program scores it. Examples: valid JSON, correct tool name, a field equals a known value, must-not-contain. No person needed on each run. |
| Draft | A suggested answer or suggested pass/fail. A model may write a draft. A draft is not trusted. |
| Marked example | A person set the right answer or pass/fail because a program cannot decide. |
| Trusted eval | Two people agreed on the mark, or a third person decided. Only then we use it when we name a model. |

## When you are asked vs skipped

You are asked when no program check can score the eval. Typical cases: tone, "was this a good reply," messy extract with no single right JSON, image or PDF judgment with no known expected fields.

You are skipped when a program can score it. Code evals never appear on the mark screen. You never mark valid JSON, a known field value, a known tool name, or a must-not-contain string.

If every eval in the set is a code eval, there is no mark link. The queue is empty.

A failure that a program can score does not come to you. A failure that needs a person does.

## Jobs

### M1. See only evals a program cannot score

Given an eval set that mixes code evals and evals with no program check.

When you open the mark link.

Then you see only evals with no program check. Code evals do not appear. You are not asked to score them.

### M2. Mark the same eval as the other person

Given an eval a program cannot score.

When you open it.

Then you mark that eval. Another person marks it too. You do not see their mark before you submit. Order does not matter.

### M3. Form matches this job

Given the job’s score form (fields, pass/fail, rubric checks, tool calls, image or PDF).

When you open an eval.

Then the screen shows that form and the example input. Unused widgets stay hidden. If the job has an image or PDF, the file is on the same screen.

### M4. Confirm or reject a draft

Given a model suggested a draft answer or draft pass/fail.

When you mark.

Then you accept it, edit it, or reject it and fill the form yourself. Accepting is your mark, not automatic trust. If you reject, the draft is discarded for you. A model does not create a trusted eval by itself.

### M5. Two people agree, or a third decides

Given two independent marks on the same eval.

When they match.

Then the eval becomes trusted. You are not asked again on this eval-set version.

When they do not match.

Then a third person, who did not mark this eval, decides. They see the input, both marks, and any draft. They pick one mark, write a new mark, or drop the eval. Their decision is the trusted mark. The two of you do not vote again.

### M6. Mark once, not every run

Given a trusted eval on an eval-set version.

When models run, recheck, or CI scores the same version.

Then nobody is asked to mark that eval again. The stored mark scores every run.

When the meaning of good changes, or the form fields change, that is a new eval-set version. You may be asked to mark the new version. Old versions keep their marks.

### M7. Cannot mark

Given an example you cannot judge (broken input, missing file, not your domain).

When you choose cannot mark.

Then you leave a short reason. The eval is not trusted. It does not count toward naming a model until someone who can judge it marks it, or it is dropped.

## One mark screen

One screen. One eval. No table of experiments.

Always shown:

1. What good means for this job, and what must never happen.
2. The example input (text, and files if any).
3. A draft, if one exists, labeled as a suggestion. Not labeled as the right answer.
4. The form for this job.
5. Submit. Or cannot mark, with a reason.
6. How many evals are left in this queue.

Never shown:

- Code evals
- Other people’s marks (until you are the third person)
- Model names, run scores, time, or cost
- A list of all evals in the project

### Form fields by job

The form is built from this job. Mix only what the job needs.

| If the job needs | You set |
| --- | --- |
| Structured fields (extract, invoice-like) | Expected value per named field. Empty if the field should be absent. |
| Pass / fail | Pass, fail, or not applicable, against the example. Optional one-line why. |
| Rubric | Pass or fail on each check written from this job (tone, length, cites a required clause). Not a 1-5 score. |
| Tool calls | Expected tool name and argument values when there is a right call. If there is no single right call, use pass/fail or rubric instead. |
| Image or PDF | The file on screen. Then fields, pass/fail, or rubric about what is in it. Region mark only if this job needs a location. |
| A right reply in text | The expected text, or pass/fail on a shown reply. |

Hidden when the job does not need them.

### Third-person screen

Same input and form. Plus the two marks, shown after the input. The third person submits one trusted mark or drops the eval.

This user may later act as third person on a different eval they did not mark. They never decide on an eval they already marked.

## Agreement rules

Marks are independent. You do not chat in the product to reach a match.

First version: two named people plus one third person. Not a crowd.

Two marks agree when they match on every field the form requires:

- Pass/fail: same choice (pass, fail, or not applicable).
- Fields: same value for each named field after trim of leading and trailing whitespace.
- Rubric: same pass or fail on each check.
- Tool calls: same tool name and same argument values.
- Expected text: same text after trim of leading and trailing whitespace.
- Image/PDF regions: same region within the job’s stated tolerance, or same field values if the job uses fields.

If any required part differs, they disagree. Optional "why" text is not part of agreement.

A draft both people accept still needs that match. Two accepts of the same draft count as agreement. One accept and one edit is disagreement. The draft did not become trusted by itself.

After trust, the mark is frozen for that eval-set version. Runs reuse it.

States for one eval:

1. Waiting for a person
2. One person has marked (not trusted)
3. Two marks in, they disagree, waiting for a third
4. Trusted (two agreed, or a third decided)
5. Cannot mark, or dropped (not trusted)

Only state 4 is used when we name a model.

## Done-when

- Code evals never sit in the mark queue and never open on this screen.
- You only see evals a program cannot score.
- An eval is trusted only after two people agree or a third person decides.
- A model draft is never trusted without a person’s accept or edit as their mark, plus agreement as above.
- You mark once per eval-set version. Later runs do not re-open the screen for that eval.
- The form matches the job: fields, pass/fail, rubric checks, tool calls, and image/PDF when the job has files.
- You can finish from the mark link alone.
- Untrusted evals do not block naming a model if enough trusted evals already exist. If too few trusted evals exist, the mark link stays the next action. Do not invent a trusted answer to unblock.

## Out of scope

- A dashboard, experiment table, or dataset explorer
- A crowd marketplace of paid strangers
- Approving the model name (developer)
- Writing or accepting the eval set (developer or agent)
- Scoring code evals
- Changing live traffic
- Rewriting the prompt
- A second model acting as a judge to create the first trusted answers
- Chat in the mark screen to negotiate agreement
