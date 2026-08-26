import type Database from "better-sqlite3";
import { notASampleError, suiteNotFoundError } from "../errors.js";
import {
  getIdempotentResponse,
  storeIdempotentResponse,
} from "../eval-set.js";
import { getPolicyRow } from "../policy.js";
import { buildSampleUrl, signSampleToken } from "../sample-token.js";
import { getSample, isPromotableSample } from "../samples.js";
import type { ToolHandler } from "../dispatch.js";
import { executeRegisterFailure } from "./register_failure.js";
import {
  promoteLiveSampleOutputSchema,
  type promoteLiveSampleInputSchema,
  type registerFailureInputSchema,
} from "./schema.js";
import type { z } from "zod";

type PromoteInput = z.infer<typeof promoteLiveSampleInputSchema>;
type RegisterInput = z.infer<typeof registerFailureInputSchema>;

function steIdFromPolicy(
  db: Database.Database,
  policyId: string,
): string | null {
  const row = getPolicyRow(db, policyId);
  if (!row) {
    return null;
  }
  try {
    const doc = JSON.parse(row.body_json) as { ste_id?: unknown };
    if (typeof doc.ste_id === "string" && doc.ste_id.length > 0) {
      return doc.ste_id;
    }
    return null;
  } catch {
    return null;
  }
}

export function promoteLiveSample(
  input: PromoteInput,
  ctx: Parameters<ToolHandler>[1],
): ReturnType<ToolHandler> {
  const db = ctx.db;
  const apiKey = ctx.apiKey ?? "";
  const baseUrl = ctx.baseUrl ?? "http://127.0.0.1:3000";
  if (!db) {
    throw new Error("promote_live_sample requires db on ToolContext");
  }

  const existing = getIdempotentResponse(
    db,
    "promote_live_sample",
    input.idempotency_key,
  );
  if (existing) {
    return existing;
  }

  const sample = getSample(db, input.sample_id);
  if (!isPromotableSample(sample, input.project_id)) {
    return {
      status: 404,
      body: notASampleError({
        project_id: input.project_id,
      }),
    };
  }

  const steId = steIdFromPolicy(db, sample.policy_id);
  if (!steId) {
    return { status: 404, body: suiteNotFoundError("ste_missing") };
  }

  const registerInput: RegisterInput = {
    project_id: input.project_id,
    eval_set_id: steId,
    input: { prompt: sample.input_redacted },
    output: { text: sample.output_redacted },
    why_bad: sample.why,
    program_check: input.program_check,
    idempotency_key: input.idempotency_key,
  };

  const result = executeRegisterFailure(registerInput, ctx);
  if (result.status !== 200) {
    return result;
  }

  const token = signSampleToken(apiKey, sample.id);
  const sampleUrl = buildSampleUrl(baseUrl, sample.id, token);
  const j5 = result.body as Record<string, unknown>;
  const output = promoteLiveSampleOutputSchema.parse({
    ...j5,
    sample_url: sampleUrl,
    live_traffic_changed: false,
  });

  storeIdempotentResponse(
    db,
    "promote_live_sample",
    input.idempotency_key,
    200,
    output,
    input.project_id,
  );

  return { status: 200, body: output };
}

export const handlePromoteLiveSample: ToolHandler = (body, ctx) => {
  return promoteLiveSample(body as PromoteInput, ctx);
};
