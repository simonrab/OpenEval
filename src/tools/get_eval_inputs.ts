import type { z } from "zod";
import type { ToolHandler } from "../dispatch.js";
import { projectNotFoundError, suiteNotFoundError } from "../errors.js";
import { getEvalSet, listMembers } from "../eval-set.js";
import { getJobSystemPrompt } from "../job.js";
import { projectExists } from "../keys.js";
import { scorableEvals } from "../runner/score.js";
import {
  getEvalInputsOutputSchema,
  type getEvalInputsInputSchema,
} from "./schema.js";

type Input = z.infer<typeof getEvalInputsInputSchema>;

const DEFAULT_LIMIT = 50;

function decodeCursor(cursor: string | null | undefined): number {
  const n = cursor ? Number.parseInt(cursor, 10) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Inputs of every scorable trusted eval, for an app harness to run.
 * No checks, marks, splits, or results. Holdout inputs are not marked.
 */
export const handleGetEvalInputs: ToolHandler = (body, ctx) => {
  const db = ctx.db;
  if (!db) {
    throw new Error("get_eval_inputs requires db on ToolContext");
  }
  const input = body as Input;
  if (!projectExists(db, input.project_id)) {
    return { status: 404, body: projectNotFoundError(input.project_id) };
  }
  const evalSet = getEvalSet(db, input.eval_set_id);
  if (!evalSet || evalSet.project_id !== input.project_id) {
    return { status: 404, body: suiteNotFoundError(input.eval_set_id) };
  }

  const evals = scorableEvals(db, listMembers(db, input.eval_set_id)).sort((a, b) =>
    a.eval_id < b.eval_id ? -1 : a.eval_id > b.eval_id ? 1 : 0,
  );
  const limit = input.limit ?? DEFAULT_LIMIT;
  const offset = decodeCursor(input.cursor);
  const page = evals.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < evals.length;

  const output = getEvalInputsOutputSchema.parse({
    eval_set_id: input.eval_set_id,
    eval_set_version: evalSet.version,
    system_prompt: getJobSystemPrompt(db, input.eval_set_id),
    n_evals: evals.length,
    inputs: page.map((ev) => ({ eval_id: ev.eval_id, input: ev.input_truncated })),
    next_cursor: hasMore ? String(nextOffset) : null,
    truncated: hasMore,
    next_action: hasMore
      ? {
          tool: "get_eval_inputs",
          args: {
            project_id: input.project_id,
            eval_set_id: input.eval_set_id,
            cursor: String(nextOffset),
          },
          ask_human: null,
        }
      : {
          tool: "submit_outputs",
          args: { project_id: input.project_id, eval_set_id: input.eval_set_id },
          ask_human: null,
        },
  });
  return { status: 200, body: output };
};
