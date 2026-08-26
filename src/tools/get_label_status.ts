import type Database from "better-sqlite3";
import { projectNotFoundError, suiteNotFoundError } from "../errors.js";
import { getEvalSet, listMembers } from "../eval-set.js";
import { projectExists } from "../keys.js";
import {
  computeLabelCounts,
  hasActiveMarkQueue,
} from "../mark/store.js";
import { buildMarkUrl, signMarkToken } from "../mark/tokens.js";
import { hasEnoughTrustedEvals } from "../runner/worker.js";
import type { ToolHandler } from "../dispatch.js";
import {
  getLabelStatusOutputSchema,
  type getLabelStatusInputSchema,
} from "./schema.js";
import type { z } from "zod";

type LabelStatusInput = z.infer<typeof getLabelStatusInputSchema>;

export const handleGetLabelStatus: ToolHandler = (body, ctx) => {
  const db = ctx.db;
  const baseUrl = ctx.baseUrl ?? "http://127.0.0.1:3000";
  if (!db) {
    throw new Error("get_label_status requires db on ToolContext");
  }

  const input = body as LabelStatusInput;

  if (!projectExists(db, input.project_id)) {
    return { status: 404, body: projectNotFoundError(input.project_id) };
  }

  const evalSet = getEvalSet(db, input.eval_set_id);
  if (!evalSet || evalSet.project_id !== input.project_id) {
    return { status: 404, body: suiteNotFoundError(input.eval_set_id) };
  }

  const members = listMembers(db, input.eval_set_id);
  const counts = computeLabelCounts(db, input.eval_set_id);
  const enoughTrusted = hasEnoughTrustedEvals(members);
  const activeQueue = hasActiveMarkQueue(db, input.eval_set_id);
  const token = signMarkToken(ctx.apiKey ?? "", input.eval_set_id);
  const markUrl = activeQueue
    ? buildMarkUrl(baseUrl, input.eval_set_id, token)
    : null;

  let nextTool: "run_evals" | "get_label_status" | "queue_for_labeling";
  let askHuman: "open mark_url" | null;

  if (enoughTrusted) {
    nextTool = "run_evals";
    askHuman = null;
  } else if (activeQueue) {
    nextTool = "get_label_status";
    askHuman = "open mark_url";
  } else {
    const nPerson = members.filter((m) => m.score_how === "person").length;
    nextTool = nPerson > 0 ? "queue_for_labeling" : "get_label_status";
    askHuman = null;
  }

  const output = getLabelStatusOutputSchema.parse({
    counts,
    enough_trusted: enoughTrusted,
    mark_url: markUrl,
    next_action: {
      tool: nextTool,
      args: {
        project_id: input.project_id,
        eval_set_id: input.eval_set_id,
      },
      ask_human: askHuman,
    },
  });

  return { status: 200, body: output };
};

export function resolveMarkUrlForSet(
  db: Database.Database,
  baseUrl: string,
  apiKey: string,
  evalSetId: string,
): string | null {
  if (!hasActiveMarkQueue(db, evalSetId)) {
    return null;
  }
  const token = signMarkToken(apiKey, evalSetId);
  return buildMarkUrl(baseUrl, evalSetId, token);
}
