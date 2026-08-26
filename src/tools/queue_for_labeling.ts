import type Database from "better-sqlite3";
import { projectNotFoundError, suiteNotFoundError } from "../errors.js";
import {
  getEvalSet,
  getIdempotentResponse,
  storeIdempotentResponse,
} from "../eval-set.js";
import { projectExists } from "../keys.js";
import { buildMarkUrl, signMarkToken } from "../mark/tokens.js";
import {
  ensureProjectPeople,
  queuePersonEvals,
} from "../mark/store.js";
import type { ToolHandler } from "../dispatch.js";
import {
  queueForLabelingOutputSchema,
  type queueForLabelingInputSchema,
} from "./schema.js";
import type { z } from "zod";

type QueueInput = z.infer<typeof queueForLabelingInputSchema>;

export const handleQueueForLabeling: ToolHandler = (body, ctx) => {
  const db = ctx.db;
  const baseUrl = ctx.baseUrl ?? "http://127.0.0.1:3000";
  if (!db) {
    throw new Error("queue_for_labeling requires db on ToolContext");
  }

  const input = body as QueueInput;
  const existing = getIdempotentResponse(
    db,
    "queue_for_labeling",
    input.idempotency_key,
  );
  if (existing) {
    return existing;
  }

  if (!projectExists(db, input.project_id)) {
    return { status: 404, body: projectNotFoundError(input.project_id) };
  }

  const evalSet = getEvalSet(db, input.eval_set_id);
  if (!evalSet || evalSet.project_id !== input.project_id) {
    return { status: 404, body: suiteNotFoundError(input.eval_set_id) };
  }

  ensureProjectPeople(db, input.project_id);
  queuePersonEvals(db, input.eval_set_id, input.eval_ids ?? null);

  const personQueued = db
    .prepare(
      `SELECT COUNT(*) AS n FROM mark_queue mq
       JOIN evals e ON e.id = mq.eval_id
       WHERE mq.eval_set_id = ?
         AND e.score_how = 'person'
         AND mq.state IN ('waiting', 'one_mark', 'disagree')`,
    )
    .get(input.eval_set_id) as { n: number };

  const nQueued = personQueued.n;
  const token = signMarkToken(ctx.apiKey ?? "", input.eval_set_id);
  const markUrl =
    nQueued > 0
      ? buildMarkUrl(baseUrl, input.eval_set_id, token)
      : null;

  const output = queueForLabelingOutputSchema.parse({
    n_queued: nQueued,
    mark_url: markUrl,
    next_action:
      nQueued > 0
        ? {
            tool: "get_label_status",
            args: {
              project_id: input.project_id,
              eval_set_id: input.eval_set_id,
            },
            ask_human: "open mark_url",
          }
        : {
            tool: "run_evals",
            args: {
              project_id: input.project_id,
              eval_set_id: input.eval_set_id,
            },
            ask_human: null,
          },
  });

  storeIdempotentResponse(
    db,
    "queue_for_labeling",
    input.idempotency_key,
    200,
    output,
    input.project_id,
  );

  return { status: 200, body: output };
};
