import { projectNotFoundError, suiteNotFoundError } from "../errors.js";
import {
  copyEvalSetForward,
  getLatestEvalSetForProject,
} from "../eval-set-copy.js";
import {
  getIdempotentResponse,
  storeIdempotentResponse,
  truncateInput,
} from "../eval-set.js";
import { newEvalId } from "../ids.js";
import { attachImagePdfFiles } from "../eval-files.js";
import { projectExists } from "../keys.js";
import { buildMarkUrl, signMarkToken } from "../mark/tokens.js";
import type { DispatchResult, ToolContext, ToolHandler } from "../dispatch.js";
import {
  registerFailureOutputSchema,
  type registerFailureInputSchema,
} from "./schema.js";
import type { z } from "zod";

type RegisterInput = z.infer<typeof registerFailureInputSchema>;

function failureInputTruncated(
  input: RegisterInput["input"],
  output: RegisterInput["output"],
): string {
  const payload: Record<string, unknown> = { prompt: input.prompt };
  if (input.files && input.files.length > 0) {
    payload.files = input.files;
  }
  if (output && Object.keys(output).length > 0) {
    payload.output = output;
  }
  return truncateInput(JSON.stringify(payload));
}

export function executeRegisterFailure(
  input: RegisterInput,
  ctx: ToolContext,
): DispatchResult {
  const db = ctx.db;
  const baseUrl = ctx.baseUrl ?? "http://127.0.0.1:3000";
  if (!db) {
    throw new Error("register_failure requires db on ToolContext");
  }

  if (!projectExists(db, input.project_id)) {
    return { status: 404, body: projectNotFoundError(input.project_id) };
  }

  let sourceEvalSetId = input.eval_set_id;
  if (!sourceEvalSetId) {
    sourceEvalSetId = getLatestEvalSetForProject(db, input.project_id) ?? undefined;
  }
  if (!sourceEvalSetId) {
    return {
      status: 404,
      body: suiteNotFoundError(input.eval_set_id ?? "ste_missing"),
    };
  }

  let copied;
  try {
    copied = copyEvalSetForward(db, {
      projectId: input.project_id,
      sourceEvalSetId,
    });
  } catch {
    return { status: 404, body: suiteNotFoundError(sourceEvalSetId) };
  }

  const scoreHow = input.program_check ? "code" : "person";
  const trusted = scoreHow === "code";
  const status = trusted ? "trusted" : "draft";
  const evalId = newEvalId();
  const title =
    typeof input.why_bad === "string" && input.why_bad.length > 0
      ? input.why_bad
      : input.input.prompt;
  const createdAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO evals
      (id, title, score_how, status, program_check, input_truncated, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    evalId,
    title,
    scoreHow,
    status,
    input.program_check ? JSON.stringify(input.program_check) : null,
    failureInputTruncated(input.input, input.output),
    createdAt,
  );
  db.prepare(
    `INSERT INTO eval_set_members (eval_set_id, eval_id) VALUES (?, ?)`,
  ).run(copied.newEvalSetId, evalId);
  if (scoreHow === "person" && input.input.files) {
    attachImagePdfFiles(db, [evalId], input.input.files);
  }

  const markUrl =
    scoreHow === "person"
      ? buildMarkUrl(
          baseUrl,
          copied.newEvalSetId,
          signMarkToken(ctx.apiKey ?? "", copied.newEvalSetId),
        )
      : null;

  const output = registerFailureOutputSchema.parse({
    eval_id: evalId,
    eval_set_id: copied.newEvalSetId,
    previous_eval_set_id: copied.previousEvalSetId,
    version: copied.version,
    score_how: scoreHow,
    trusted,
    status,
    old_eval_ids: copied.oldEvalIds,
    mark_url: markUrl,
    next_action:
      scoreHow === "code"
        ? {
            tool: "run_evals",
            args: {
              project_id: input.project_id,
              eval_set_id: copied.newEvalSetId,
            },
            ask_human: null,
          }
        : {
            tool: "queue_for_labeling",
            args: {
              project_id: input.project_id,
              eval_set_id: copied.newEvalSetId,
            },
            ask_human: null,
          },
  });

  return { status: 200, body: output };
}

export const handleRegisterFailure: ToolHandler = (body, ctx) => {
  const db = ctx.db;
  if (!db) {
    throw new Error("register_failure requires db on ToolContext");
  }

  const input = body as RegisterInput;
  const existing = getIdempotentResponse(
    db,
    "register_failure",
    input.idempotency_key,
  );
  if (existing) {
    return existing;
  }

  const result = executeRegisterFailure(input, ctx);
  if (result.status === 200) {
    storeIdempotentResponse(
      db,
      "register_failure",
      input.idempotency_key,
      200,
      result.body,
      input.project_id,
    );
  }

  return result;
};
