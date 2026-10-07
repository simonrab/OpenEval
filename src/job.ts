import type Database from "better-sqlite3";
import type { JobLimits } from "./rank.js";
import type { ToolChoice, ToolDefinition } from "./runner/openrouter.js";

/** The tools that a run sends to the model for this job. Null when the job has no tools. */
export function getJobTools(
  db: Database.Database,
  evalSetId: string,
): { tools: ToolDefinition[]; tool_choice?: ToolChoice } | null {
  const limits = getJobLimits(db, evalSetId);
  if (!limits?.tools || limits.tools.length === 0) {
    return null;
  }
  return {
    tools: limits.tools,
    ...(limits.tool_choice ? { tool_choice: limits.tool_choice } : {}),
  };
}

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Job tools from the explicit tools input, else from evidence.tool_schemas with a valid name. */
export function jobToolsFromInput(input: {
  tools?: ToolDefinition[];
  evidence?: { tool_schemas?: Array<{ name: string; description?: string; schema?: Record<string, unknown> }> };
}): ToolDefinition[] {
  if (input.tools && input.tools.length > 0) {
    return input.tools;
  }
  return (input.evidence?.tool_schemas ?? [])
    .filter((t) => TOOL_NAME.test(t.name))
    .map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      ...(t.schema ? { parameters: t.schema } : {}),
    }));
}

export function getJobLimits(
  db: Database.Database,
  evalSetId: string,
): JobLimits | null {
  const row = db
    .prepare(
      `SELECT j.limits FROM eval_sets es
       JOIN jobs j ON j.id = es.job_id
       WHERE es.id = ?`,
    )
    .get(evalSetId) as { limits: string | null } | undefined;
  if (!row?.limits) {
    return null;
  }
  return JSON.parse(row.limits) as JobLimits;
}

export function getJobSystemPrompt(
  db: Database.Database,
  evalSetId: string,
): string | null {
  const limits = getJobLimits(db, evalSetId);
  const prompt = limits?.system_prompt;
  if (typeof prompt !== "string") {
    return null;
  }
  const text = prompt.trim();
  return text.length > 0 ? text : null;
}
