import type Database from "better-sqlite3";
import { canaryNotActiveError, policyNotApprovedError, projectNotFoundError } from "../errors.js";
import {
  getIdempotentResponse,
  storeIdempotentResponse,
} from "../eval-set.js";
import { projectExists } from "../keys.js";
import {
  getApprovedDraftPolicyId,
  getProjectLiveState,
} from "../policy.js";
import { insertLiveRollout } from "../rollouts.js";
import {
  buildRolloutApproveUrl,
  signRolloutApproveToken,
} from "../routes/rollout-approve.js";
import type { ToolHandler } from "../dispatch.js";
import {
  proposeRolloutOutputSchema,
  type proposeRolloutInputSchema,
} from "./schema.js";
import type { z } from "zod";

type ProposeInput = z.infer<typeof proposeRolloutInputSchema>;

export const handleProposeRollout: ToolHandler = (body, ctx) => {
  const db = ctx.db;
  const apiKey = ctx.apiKey ?? "";
  const baseUrl = ctx.baseUrl ?? "http://127.0.0.1:3000";
  if (!db) {
    throw new Error("propose_rollout requires db on ToolContext");
  }

  const input = body as ProposeInput;
  const existing = getIdempotentResponse(
    db,
    "propose_rollout",
    input.idempotency_key,
  );
  if (existing) {
    return existing;
  }

  if (!projectExists(db, input.project_id)) {
    return { status: 404, body: projectNotFoundError(input.project_id) };
  }

  const live = getProjectLiveState(db, input.project_id);
  if (!live?.last_full_policy_id) {
    return {
      status: 400,
      body: policyNotApprovedError({
        project_id: input.project_id,
      }),
    };
  }

  if (input.intent === "canary") {
    const draftId = getApprovedDraftPolicyId(db, input.project_id);
    if (!draftId) {
      return {
        status: 400,
        body: policyNotApprovedError({
          project_id: input.project_id,
        }),
      };
    }
    return storePropose(
      db,
      apiKey,
      baseUrl,
      input,
      {
        old_policy_id: live.last_full_policy_id,
        new_policy_id: draftId,
        rollback_target_policy_id:
          live.rollback_target_policy_id ?? live.last_full_policy_id,
      },
    );
  }

  if (input.intent === "full") {
    if (!live.canary_policy_id || live.canary_percent !== 5) {
      return { status: 400, body: canaryNotActiveError(input.project_id) };
    }
    return storePropose(
      db,
      apiKey,
      baseUrl,
      input,
      {
        old_policy_id: live.last_full_policy_id,
        new_policy_id: live.canary_policy_id,
        rollback_target_policy_id:
          live.rollback_target_policy_id ?? live.last_full_policy_id,
      },
    );
  }

  return storePropose(
    db,
    apiKey,
    baseUrl,
    input,
    {
      old_policy_id: live.last_full_policy_id,
      new_policy_id:
        live.rollback_target_policy_id ?? live.last_full_policy_id,
      rollback_target_policy_id:
        live.rollback_target_policy_id ?? live.last_full_policy_id,
    },
  );
};

function storePropose(
  db: Database.Database,
  apiKey: string,
  baseUrl: string,
  input: ProposeInput,
  pointers: {
    old_policy_id: string | null;
    new_policy_id: string | null;
    rollback_target_policy_id: string | null;
  },
): { status: number; body: unknown } {
  const rollout = insertLiveRollout(db, {
    project_id: input.project_id,
    intent: input.intent,
    old_policy_id: pointers.old_policy_id,
    new_policy_id: pointers.new_policy_id,
    rollback_target_policy_id: pointers.rollback_target_policy_id,
  });
  const token = signRolloutApproveToken(apiKey, rollout.id);
  const approveUrl = buildRolloutApproveUrl(baseUrl, rollout.id, token);
  const output = proposeRolloutOutputSchema.parse({
    rollout_id: rollout.id,
    approve_url: approveUrl,
    live_traffic_changed: false,
    next_action: {
      tool: null,
      args: { approve_url: approveUrl },
      ask_human: "open approve_url",
    },
  });
  storeIdempotentResponse(
    db,
    "propose_rollout",
    input.idempotency_key,
    200,
    output,
    input.project_id,
  );
  return { status: 200, body: output };
}
