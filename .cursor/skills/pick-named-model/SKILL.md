---
name: pick-named-model
description: >-
  Pick a named model for one AI job with EvalRouter. Use when the user
  names a Retinue purpose (trigger, question_detector, and the rest) or
  asks to pick, choose, or name a model for a task.
---

# Pick a named model

The user names one job. That is the whole request. Example: "Pick a named model for Retinue trigger."

1. Use EvalRouter MCP. Start the server if it is down.
2. Call `generate_eval_suite` for that job only.
3. Call only `next_action.tool` after that.
4. When a result starts with `Stop`, show the URL and wait. Do not click it.
5. Do not accept, mark, or approve. Do not write a model id until the user says it is approved.
