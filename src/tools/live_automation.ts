import type Database from "better-sqlite3";
import { agentError, projectNotFoundError } from "../errors.js";
import {
  newAuditEventId,
  newAutomationId,
  newDecisionCycleId,
} from "../ids.js";
import { projectExists } from "../keys.js";
import { CANARY_PERCENT } from "../live/sticky.js";
import {
  activateCanary,
  getApprovedDraftPolicyId,
  getPolicyRow,
  getProjectLiveState,
  promotePolicyCanaryToLastFull,
  rollbackToPolicy,
  type PolicyRow,
  type SignedPolicy,
} from "../policy.js";
import {
  listSampleGroups,
  markSampleGroupState,
  quarantineFloodedSampleGroups,
} from "../samples.js";
import { promoteLiveSample } from "./promote_live_sample.js";
import type { ToolHandler } from "../dispatch.js";
import {
  configureLiveAutomationOutputSchema,
  decisionCycleOutputSchema,
  type configureLiveAutomationInputSchema,
  type getDecisionCycleStatusInputSchema,
  type runLiveDecisionCycleInputSchema,
} from "./schema.js";
import { ErrorCode, type NextAction } from "./types.js";
import {
  getIdempotentResponse,
  storeIdempotentResponse,
} from "../eval-set.js";
import type { z } from "zod";

type ConfigureInput = z.infer<typeof configureLiveAutomationInputSchema>;
type RunInput = z.infer<typeof runLiveDecisionCycleInputSchema>;
type StatusInput = z.infer<typeof getDecisionCycleStatusInputSchema>;

export type AutomationMode = "manual" | "guarded";

export type AutomationConfig = {
  project_id: string;
  automation_id: string | null;
  mode: AutomationMode;
  auto_canary: boolean;
  auto_full: boolean;
  auto_rollback: boolean;
  allowed_models: string[];
  max_eval_spend_usd: number;
  min_eval_pass_rate: number;
  max_fallback_rate: number;
  max_miss_rate: number;
  min_canary_age_s: number;
  min_canary_requests: number;
  sample_flood_limit: number;
  expires_at: string | null;
  kill_switch: boolean;
  frozen: boolean;
};

export type DecisionCycleRow = {
  id: string;
  project_id: string;
  automation_mode: AutomationMode;
  status: "succeeded" | "blocked";
  pending_action: string | null;
  blocked_reason: string | null;
  decision_ids_json: string;
  audit_ids_json: string;
  live_traffic_changed: number;
  started_at: string;
  finished_at: string;
};

const DEFAULT_CONFIG: Omit<AutomationConfig, "project_id" | "automation_id"> = {
  mode: "manual",
  auto_canary: false,
  auto_full: false,
  auto_rollback: true,
  allowed_models: [],
  max_eval_spend_usd: 5,
  min_eval_pass_rate: 1,
  max_fallback_rate: 0.05,
  max_miss_rate: 0.01,
  min_canary_age_s: 0,
  min_canary_requests: 1,
  sample_flood_limit: 100,
  expires_at: null,
  kill_switch: false,
  frozen: false,
};

function parseJsonArray(text: string | null | undefined): string[] {
  if (!text) {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function toBool(value: unknown): boolean {
  return value === 1 || value === true;
}

export function getAutomationConfig(
  db: Database.Database,
  projectId: string,
): AutomationConfig {
  const row = db
    .prepare(
      `SELECT project_id, automation_id, mode, auto_canary, auto_full,
              auto_rollback, allowed_models_json, max_eval_spend_usd,
              min_eval_pass_rate, max_fallback_rate, max_miss_rate,
              min_canary_age_s, min_canary_requests, sample_flood_limit,
              expires_at, kill_switch, frozen
       FROM live_automation
       WHERE project_id = ?`,
    )
    .get(projectId) as
    | {
        project_id: string;
        automation_id: string;
        mode: AutomationMode;
        auto_canary: number;
        auto_full: number;
        auto_rollback: number;
        allowed_models_json: string;
        max_eval_spend_usd: number;
        min_eval_pass_rate: number;
        max_fallback_rate: number;
        max_miss_rate: number;
        min_canary_age_s: number;
        min_canary_requests: number;
        sample_flood_limit: number;
        expires_at: string | null;
        kill_switch: number;
        frozen: number;
      }
    | undefined;
  if (!row) {
    return { project_id: projectId, automation_id: null, ...DEFAULT_CONFIG };
  }
  return {
    project_id: row.project_id,
    automation_id: row.automation_id,
    mode: row.mode,
    auto_canary: toBool(row.auto_canary),
    auto_full: toBool(row.auto_full),
    auto_rollback: toBool(row.auto_rollback),
    allowed_models: parseJsonArray(row.allowed_models_json),
    max_eval_spend_usd: row.max_eval_spend_usd,
    min_eval_pass_rate: row.min_eval_pass_rate,
    max_fallback_rate: row.max_fallback_rate,
    max_miss_rate: row.max_miss_rate,
    min_canary_age_s: row.min_canary_age_s,
    min_canary_requests: row.min_canary_requests,
    sample_flood_limit: row.sample_flood_limit,
    expires_at: row.expires_at,
    kill_switch: toBool(row.kill_switch),
    frozen: toBool(row.frozen),
  };
}

function guardRules(config: AutomationConfig): Record<string, unknown> {
  return {
    auto_canary: config.auto_canary,
    auto_full: config.auto_full,
    auto_rollback: config.auto_rollback,
    allowed_models: config.allowed_models,
    max_eval_spend_usd: config.max_eval_spend_usd,
    min_eval_pass_rate: config.min_eval_pass_rate,
    max_fallback_rate: config.max_fallback_rate,
    max_miss_rate: config.max_miss_rate,
    min_canary_age_s: config.min_canary_age_s,
    min_canary_requests: config.min_canary_requests,
    sample_flood_limit: config.sample_flood_limit,
    expires_at: config.expires_at,
    kill_switch: config.kill_switch,
    frozen: config.frozen,
  };
}

function recordAuditEvent(
  db: Database.Database,
  args: {
    project_id: string;
    cycle_id: string | null;
    event_type: string;
    body: Record<string, unknown>;
  },
): string {
  const id = newAuditEventId();
  db.prepare(
    `INSERT INTO decision_audit_events
       (id, project_id, cycle_id, event_type, body_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    args.project_id,
    args.cycle_id,
    args.event_type,
    JSON.stringify(args.body),
    new Date().toISOString(),
  );
  return id;
}

function latestCycle(
  db: Database.Database,
  projectId: string,
): DecisionCycleRow | null {
  const row = db
    .prepare(
      `SELECT id, project_id, automation_mode, status, pending_action,
              blocked_reason, decision_ids_json, audit_ids_json,
              live_traffic_changed, started_at, finished_at
       FROM decision_cycles
       WHERE project_id = ?
       ORDER BY finished_at DESC, id DESC
       LIMIT 1`,
    )
    .get(projectId) as DecisionCycleRow | undefined;
  return row ?? null;
}

function insertCycle(
  db: Database.Database,
  args: {
    id: string;
    project_id: string;
    automation_mode: AutomationMode;
    status: "succeeded" | "blocked";
    pending_action: string | null;
    blocked_reason: string | null;
    decision_ids: string[];
    audit_ids: string[];
    live_traffic_changed: boolean;
    started_at: string;
  },
): DecisionCycleRow {
  const finishedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO decision_cycles (
       id, project_id, automation_mode, status, pending_action,
       blocked_reason, decision_ids_json, audit_ids_json,
       live_traffic_changed, started_at, finished_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.id,
    args.project_id,
    args.automation_mode,
    args.status,
    args.pending_action,
    args.blocked_reason,
    JSON.stringify(args.decision_ids),
    JSON.stringify(args.audit_ids),
    args.live_traffic_changed ? 1 : 0,
    args.started_at,
    finishedAt,
  );
  return {
    id: args.id,
    project_id: args.project_id,
    automation_mode: args.automation_mode,
    status: args.status,
    pending_action: args.pending_action,
    blocked_reason: args.blocked_reason,
    decision_ids_json: JSON.stringify(args.decision_ids),
    audit_ids_json: JSON.stringify(args.audit_ids),
    live_traffic_changed: args.live_traffic_changed ? 1 : 0,
    started_at: args.started_at,
    finished_at: finishedAt,
  };
}

function cycleOutput(row: DecisionCycleRow | null, config: AutomationConfig) {
  const decisionIds = row ? parseJsonArray(row.decision_ids_json) : [];
  const auditIds = row ? parseJsonArray(row.audit_ids_json) : [];
  return decisionCycleOutputSchema.parse({
    cycle_id: row?.id ?? null,
    status: row?.status ?? "blocked",
    automation_mode: config.mode,
    pending_action: row?.pending_action ?? null,
    blocked_reason: row?.blocked_reason ?? "no_cycle",
    decision_ids: decisionIds,
    audit_ids: auditIds,
    live_traffic_changed: row ? row.live_traffic_changed === 1 : false,
    next_action: nextActionFor(row?.pending_action ?? null, row?.blocked_reason ?? null),
  });
}

function nextActionFor(
  pendingAction: string | null,
  blockedReason: string | null,
): NextAction {
  if (pendingAction === "promote_sample") {
    return { tool: "promote_live_sample", args: {}, ask_human: null };
  }
  if (blockedReason === "manual_mode") {
    return { tool: "configure_live_automation", args: {}, ask_human: null };
  }
  if (blockedReason === "person_mark_required") {
    return { tool: "queue_for_labeling", args: {}, ask_human: "open mark_url" };
  }
  return { tool: null, args: {}, ask_human: null };
}

function invalidAutomationInput(message: string) {
  return agentError({
    code: ErrorCode.INVALID_INPUT,
    message,
    retryable: true,
    suggested_tool: "configure_live_automation",
    suggested_args: {},
    next_action: {
      tool: "configure_live_automation",
      args: {},
      ask_human: null,
    },
  });
}

function modelAllowed(modelId: string, allowedModels: string[]): boolean {
  if (allowedModels.length === 0) {
    return true;
  }
  return allowedModels.some((pattern) => {
    if (pattern.endsWith("*")) {
      return modelId.startsWith(pattern.slice(0, -1));
    }
    return modelId === pattern;
  });
}

function parsePolicy(row: PolicyRow | null): SignedPolicy | null {
  if (!row) {
    return null;
  }
  try {
    return JSON.parse(row.body_json) as SignedPolicy;
  } catch {
    return null;
  }
}

function recommendationEvidence(
  db: Database.Database,
  recId: string,
): {
  passRate: number;
  failingEvalIds: string[];
} {
  const row = db
    .prepare(
      `SELECT quality_json, failing_eval_ids
       FROM recommendations
       WHERE id = ?`,
    )
    .get(recId) as
    | { quality_json: string; failing_eval_ids: string }
    | undefined;
  if (!row) {
    return { passRate: 0, failingEvalIds: [] };
  }
  let pass = 0;
  let fail = 0;
  try {
    const quality = JSON.parse(row.quality_json) as {
      n_pass?: unknown;
      n_fail?: unknown;
    };
    pass = typeof quality.n_pass === "number" ? quality.n_pass : 0;
    fail = typeof quality.n_fail === "number" ? quality.n_fail : 0;
  } catch {
    pass = 0;
    fail = 0;
  }
  const total = pass + fail;
  return {
    passRate: total === 0 ? 0 : pass / total,
    failingEvalIds: parseJsonArray(row.failing_eval_ids),
  };
}

function blockedCycle(
  db: Database.Database,
  config: AutomationConfig,
  args: {
    cycle_id: string;
    reason: string;
    pending_action?: string | null;
    audit_ids: string[];
    started_at: string;
  },
) {
  const row = insertCycle(db, {
    id: args.cycle_id,
    project_id: config.project_id,
    automation_mode: config.mode,
    status: "blocked",
    pending_action: args.pending_action ?? null,
    blocked_reason: args.reason,
    decision_ids: [],
    audit_ids: args.audit_ids,
    live_traffic_changed: false,
    started_at: args.started_at,
  });
  return cycleOutput(row, config);
}

function safetyStats(config: AutomationConfig, fallbackRate: number) {
  if (fallbackRate > config.max_fallback_rate) {
    return "fallback_rate_high";
  }
  return null;
}

export function buildLiveAutomationReport(
  db: Database.Database,
  projectId: string,
) {
  const config = getAutomationConfig(db, projectId);
  const row = latestCycle(db, projectId);
  const decisionIds = row ? parseJsonArray(row.decision_ids_json) : [];
  const auditIds = row ? parseJsonArray(row.audit_ids_json) : [];
  return {
    automation_mode: config.mode,
    last_cycle: row
      ? {
          cycle_id: row.id,
          status: row.status,
          finished_at: row.finished_at,
        }
      : null,
    pending_action: row?.pending_action ?? null,
    blocked_reason: row?.blocked_reason ?? null,
    decision_ids: decisionIds,
    audit_ids: auditIds,
  };
}

export const handleConfigureLiveAutomation: ToolHandler = (body, ctx) => {
  const db = ctx.db;
  if (!db) {
    throw new Error("configure_live_automation requires db on ToolContext");
  }
  const input = body as ConfigureInput;
  const existing = getIdempotentResponse(
    db,
    "configure_live_automation",
    input.idempotency_key,
  );
  if (existing) {
    return existing;
  }
  if (!projectExists(db, input.project_id)) {
    return { status: 404, body: projectNotFoundError(input.project_id) };
  }

  const rules = input.guard_rules ?? {};
  if (input.mode === "guarded" && input.approved_by == null) {
    return {
      status: 400,
      body: invalidAutomationInput("approved_by is required for guarded mode."),
    };
  }

  const automationId = newAutomationId();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO live_automation (
       project_id, automation_id, mode, auto_canary, auto_full,
       auto_rollback, allowed_models_json, max_eval_spend_usd,
       min_eval_pass_rate, max_fallback_rate, max_miss_rate,
       min_canary_age_s, min_canary_requests, sample_flood_limit,
       expires_at, kill_switch, frozen, approved_by, configured_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       automation_id = excluded.automation_id,
       mode = excluded.mode,
       auto_canary = excluded.auto_canary,
       auto_full = excluded.auto_full,
       auto_rollback = excluded.auto_rollback,
       allowed_models_json = excluded.allowed_models_json,
       max_eval_spend_usd = excluded.max_eval_spend_usd,
       min_eval_pass_rate = excluded.min_eval_pass_rate,
       max_fallback_rate = excluded.max_fallback_rate,
       max_miss_rate = excluded.max_miss_rate,
       min_canary_age_s = excluded.min_canary_age_s,
       min_canary_requests = excluded.min_canary_requests,
       sample_flood_limit = excluded.sample_flood_limit,
       expires_at = excluded.expires_at,
       kill_switch = excluded.kill_switch,
       frozen = excluded.frozen,
       approved_by = excluded.approved_by,
       configured_at = excluded.configured_at`,
  ).run(
    input.project_id,
    automationId,
    input.mode,
    rules.auto_canary === true ? 1 : 0,
    rules.auto_full === true ? 1 : 0,
    rules.auto_rollback === false ? 0 : 1,
    JSON.stringify(rules.allowed_models ?? []),
    rules.max_eval_spend_usd ?? DEFAULT_CONFIG.max_eval_spend_usd,
    rules.min_eval_pass_rate ?? DEFAULT_CONFIG.min_eval_pass_rate,
    rules.max_fallback_rate ?? DEFAULT_CONFIG.max_fallback_rate,
    rules.max_miss_rate ?? DEFAULT_CONFIG.max_miss_rate,
    rules.min_canary_age_s ?? DEFAULT_CONFIG.min_canary_age_s,
    rules.min_canary_requests ?? DEFAULT_CONFIG.min_canary_requests,
    rules.sample_flood_limit ?? DEFAULT_CONFIG.sample_flood_limit,
    rules.expires_at ?? null,
    rules.kill_switch === true ? 1 : 0,
    rules.frozen === true ? 1 : 0,
    input.approved_by ?? null,
    now,
  );
  const config = getAutomationConfig(db, input.project_id);
  const auditId = recordAuditEvent(db, {
    project_id: input.project_id,
    cycle_id: null,
    event_type: "automation_configured",
    body: {
      automation_id: automationId,
      mode: input.mode,
      guard_rules: guardRules(config),
    },
  });
  const output = configureLiveAutomationOutputSchema.parse({
    automation_id: automationId,
    automation_mode: config.mode,
    guard_rules: guardRules(config),
    audit_ids: [auditId],
    live_traffic_changed: false,
    next_action: {
      tool: config.mode === "guarded" ? "run_live_decision_cycle" : null,
      args: config.mode === "guarded" ? { project_id: input.project_id } : {},
      ask_human: null,
    },
  });
  storeIdempotentResponse(
    db,
    "configure_live_automation",
    input.idempotency_key,
    200,
    output,
    input.project_id,
  );
  return { status: 200, body: output };
};

export const handleRunLiveDecisionCycle: ToolHandler = (body, ctx) => {
  const db = ctx.db;
  if (!db) {
    throw new Error("run_live_decision_cycle requires db on ToolContext");
  }
  const input = body as RunInput;
  const existing = getIdempotentResponse(
    db,
    "run_live_decision_cycle",
    input.idempotency_key,
  );
  if (existing) {
    return existing;
  }
  if (!projectExists(db, input.project_id)) {
    return { status: 404, body: projectNotFoundError(input.project_id) };
  }

  const config = getAutomationConfig(db, input.project_id);
  const cycleId = newDecisionCycleId();
  const startedAt = new Date().toISOString();
  const auditIds: string[] = [];

  auditIds.push(
    recordAuditEvent(db, {
      project_id: input.project_id,
      cycle_id: cycleId,
      event_type: "cycle_started",
      body: { mode: config.mode },
    }),
  );

  if (config.mode === "manual") {
    const output = blockedCycle(db, config, {
      cycle_id: cycleId,
      reason: "manual_mode",
      audit_ids: auditIds,
      started_at: startedAt,
    });
    storeIdempotentResponse(
      db,
      "run_live_decision_cycle",
      input.idempotency_key,
      200,
      output,
      input.project_id,
    );
    return { status: 200, body: output };
  }

  if (config.expires_at && Date.parse(config.expires_at) <= Date.now()) {
    const output = blockedCycle(db, config, {
      cycle_id: cycleId,
      reason: "rules_expired",
      audit_ids: auditIds,
      started_at: startedAt,
    });
    storeIdempotentResponse(
      db,
      "run_live_decision_cycle",
      input.idempotency_key,
      200,
      output,
      input.project_id,
    );
    return { status: 200, body: output };
  }

  if (config.kill_switch) {
    const output = blockedCycle(db, config, {
      cycle_id: cycleId,
      reason: "kill_switch",
      audit_ids: auditIds,
      started_at: startedAt,
    });
    storeIdempotentResponse(
      db,
      "run_live_decision_cycle",
      input.idempotency_key,
      200,
      output,
      input.project_id,
    );
    return { status: 200, body: output };
  }

  const quarantined = quarantineFloodedSampleGroups(
    db,
    input.project_id,
    config.sample_flood_limit,
  );
  if (quarantined.length > 0) {
    auditIds.push(
      recordAuditEvent(db, {
        project_id: input.project_id,
        cycle_id: cycleId,
        event_type: "sample_flood_quarantined",
        body: { sample_group_ids: quarantined },
      }),
    );
    const output = blockedCycle(db, config, {
      cycle_id: cycleId,
      reason: "sample_flood",
      audit_ids: auditIds,
      started_at: startedAt,
    });
    storeIdempotentResponse(
      db,
      "run_live_decision_cycle",
      input.idempotency_key,
      200,
      output,
      input.project_id,
    );
    return { status: 200, body: output };
  }

  const live = getProjectLiveState(db, input.project_id);
  const requestCount = live?.request_count ?? 0;
  const fallbackRate =
    requestCount === 0 ? 0 : (live?.fallback_count ?? 0) / requestCount;
  const safetyReason = safetyStats(config, fallbackRate);
  if (
    live?.canary_policy_id &&
    config.auto_rollback &&
    safetyReason !== null
  ) {
    const target = live.rollback_target_policy_id ?? live.last_full_policy_id;
    if (target && rollbackToPolicy(db, input.project_id, target)) {
      const auditId = recordAuditEvent(db, {
        project_id: input.project_id,
        cycle_id: cycleId,
        event_type: "auto_rollback",
        body: { policy_id: target, reason: safetyReason },
      });
      const row = insertCycle(db, {
        id: cycleId,
        project_id: input.project_id,
        automation_mode: config.mode,
        status: "succeeded",
        pending_action: "auto_rollback",
        blocked_reason: null,
        decision_ids: [target],
        audit_ids: [...auditIds, auditId],
        live_traffic_changed: true,
        started_at: startedAt,
      });
      const output = cycleOutput(row, config);
      storeIdempotentResponse(
        db,
        "run_live_decision_cycle",
        input.idempotency_key,
        200,
        output,
        input.project_id,
      );
      return { status: 200, body: output };
    }
  }

  if (live?.canary_policy_id && config.auto_full) {
    if (config.frozen) {
      const output = blockedCycle(db, config, {
        cycle_id: cycleId,
        reason: "frozen",
        audit_ids: auditIds,
        started_at: startedAt,
      });
      storeIdempotentResponse(
        db,
        "run_live_decision_cycle",
        input.idempotency_key,
        200,
        output,
        input.project_id,
      );
      return { status: 200, body: output };
    }
    const groups = listSampleGroups(db, input.project_id);
    const p0Miss = groups.some(
      (group) =>
        group.state !== "quarantined" &&
        group.why === "app_reported" &&
        group.policy_id === live.canary_policy_id,
    );
    if (p0Miss) {
      const output = blockedCycle(db, config, {
        cycle_id: cycleId,
        reason: "p0_live_miss",
        audit_ids: auditIds,
        started_at: startedAt,
      });
      storeIdempotentResponse(
        db,
        "run_live_decision_cycle",
        input.idempotency_key,
        200,
        output,
        input.project_id,
      );
      return { status: 200, body: output };
    }
    if (requestCount < config.min_canary_requests) {
      const output = blockedCycle(db, config, {
        cycle_id: cycleId,
        reason: "canary_traffic_low",
        audit_ids: auditIds,
        started_at: startedAt,
      });
      storeIdempotentResponse(
        db,
        "run_live_decision_cycle",
        input.idempotency_key,
        200,
        output,
        input.project_id,
      );
      return { status: 200, body: output };
    }
    if (
      promotePolicyCanaryToLastFull(
        db,
        input.project_id,
        live.canary_policy_id,
      )
    ) {
      const auditId = recordAuditEvent(db, {
        project_id: input.project_id,
        cycle_id: cycleId,
        event_type: "auto_full",
        body: { policy_id: live.canary_policy_id },
      });
      const row = insertCycle(db, {
        id: cycleId,
        project_id: input.project_id,
        automation_mode: config.mode,
        status: "succeeded",
        pending_action: "auto_full",
        blocked_reason: null,
        decision_ids: [live.canary_policy_id],
        audit_ids: [...auditIds, auditId],
        live_traffic_changed: true,
        started_at: startedAt,
      });
      const output = cycleOutput(row, config);
      storeIdempotentResponse(
        db,
        "run_live_decision_cycle",
        input.idempotency_key,
        200,
        output,
        input.project_id,
      );
      return { status: 200, body: output };
    }
  }

  const candidateGroup = listSampleGroups(db, input.project_id).find(
    (group) => group.state === "new",
  );
  if (candidateGroup) {
    const promoted = promoteLiveSample(
      {
        project_id: input.project_id,
        sample_id: candidateGroup.exemplar_sample_id,
        idempotency_key: `cycle:${cycleId}:${candidateGroup.id}`,
      },
      ctx,
    );
    if ("then" in promoted) {
      throw new Error("promote_live_sample must be synchronous in decision cycle");
    }
    if (promoted.status === 200) {
      markSampleGroupState(db, candidateGroup.id, "candidate");
      const body = promoted.body as {
        eval_set_id?: unknown;
        eval_id?: unknown;
        next_action?: { tool?: unknown };
      };
      const auditId = recordAuditEvent(db, {
        project_id: input.project_id,
        cycle_id: cycleId,
        event_type: "sample_group_promoted",
        body: {
          sample_group_id: candidateGroup.id,
          sample_id: candidateGroup.exemplar_sample_id,
          eval_id: body.eval_id,
          eval_set_id: body.eval_set_id,
        },
      });
      const row = insertCycle(db, {
        id: cycleId,
        project_id: input.project_id,
        automation_mode: config.mode,
        status: "blocked",
        pending_action: "promote_sample",
        blocked_reason:
          body.next_action?.tool === "queue_for_labeling"
            ? "person_mark_required"
            : "eval_candidate_ready",
        decision_ids:
          typeof body.eval_set_id === "string" ? [body.eval_set_id] : [],
        audit_ids: [...auditIds, auditId],
        live_traffic_changed: false,
        started_at: startedAt,
      });
      const output = cycleOutput(row, config);
      storeIdempotentResponse(
        db,
        "run_live_decision_cycle",
        input.idempotency_key,
        200,
        output,
        input.project_id,
      );
      return { status: 200, body: output };
    }
    markSampleGroupState(db, candidateGroup.id, "blocked");
  }

  if (!live?.canary_policy_id && config.auto_canary) {
    if (config.frozen) {
      const output = blockedCycle(db, config, {
        cycle_id: cycleId,
        reason: "frozen",
        audit_ids: auditIds,
        started_at: startedAt,
      });
      storeIdempotentResponse(
        db,
        "run_live_decision_cycle",
        input.idempotency_key,
        200,
        output,
        input.project_id,
      );
      return { status: 200, body: output };
    }
    const draftId = getApprovedDraftPolicyId(db, input.project_id);
    if (!draftId) {
      const output = blockedCycle(db, config, {
        cycle_id: cycleId,
        reason: "no_approved_draft",
        audit_ids: auditIds,
        started_at: startedAt,
      });
      storeIdempotentResponse(
        db,
        "run_live_decision_cycle",
        input.idempotency_key,
        200,
        output,
        input.project_id,
      );
      return { status: 200, body: output };
    }
    const policy = parsePolicy(getPolicyRow(db, draftId));
    if (!policy || !modelAllowed(policy.primary.model_id, config.allowed_models)) {
      const output = blockedCycle(db, config, {
        cycle_id: cycleId,
        reason: "model_not_allowed",
        audit_ids: auditIds,
        started_at: startedAt,
      });
      storeIdempotentResponse(
        db,
        "run_live_decision_cycle",
        input.idempotency_key,
        200,
        output,
        input.project_id,
      );
      return { status: 200, body: output };
    }
    const evidence = recommendationEvidence(db, policy.rec_id);
    if (evidence.failingEvalIds.length > 0) {
      const output = blockedCycle(db, config, {
        cycle_id: cycleId,
        reason: "failed_trusted_eval",
        audit_ids: auditIds,
        started_at: startedAt,
      });
      storeIdempotentResponse(
        db,
        "run_live_decision_cycle",
        input.idempotency_key,
        200,
        output,
        input.project_id,
      );
      return { status: 200, body: output };
    }
    if (evidence.passRate < config.min_eval_pass_rate) {
      const output = blockedCycle(db, config, {
        cycle_id: cycleId,
        reason: "eval_pass_rate_low",
        audit_ids: auditIds,
        started_at: startedAt,
      });
      storeIdempotentResponse(
        db,
        "run_live_decision_cycle",
        input.idempotency_key,
        200,
        output,
        input.project_id,
      );
      return { status: 200, body: output };
    }
    if (activateCanary(db, ctx.apiKey ?? "", input.project_id, draftId)) {
      const auditId = recordAuditEvent(db, {
        project_id: input.project_id,
        cycle_id: cycleId,
        event_type: "auto_canary",
        body: { policy_id: draftId, percent: CANARY_PERCENT },
      });
      const row = insertCycle(db, {
        id: cycleId,
        project_id: input.project_id,
        automation_mode: config.mode,
        status: "succeeded",
        pending_action: "auto_canary",
        blocked_reason: null,
        decision_ids: [draftId],
        audit_ids: [...auditIds, auditId],
        live_traffic_changed: true,
        started_at: startedAt,
      });
      const output = cycleOutput(row, config);
      storeIdempotentResponse(
        db,
        "run_live_decision_cycle",
        input.idempotency_key,
        200,
        output,
        input.project_id,
      );
      return { status: 200, body: output };
    }
  }

  const output = blockedCycle(db, config, {
    cycle_id: cycleId,
    reason: "no_action",
    audit_ids: auditIds,
    started_at: startedAt,
  });
  storeIdempotentResponse(
    db,
    "run_live_decision_cycle",
    input.idempotency_key,
    200,
    output,
    input.project_id,
  );
  return { status: 200, body: output };
};

export const handleGetDecisionCycleStatus: ToolHandler = (body, ctx) => {
  const db = ctx.db;
  if (!db) {
    throw new Error("get_decision_cycle_status requires db on ToolContext");
  }
  const input = body as StatusInput;
  if (!projectExists(db, input.project_id)) {
    return { status: 404, body: projectNotFoundError(input.project_id) };
  }
  const config = getAutomationConfig(db, input.project_id);
  const row =
    input.cycle_id != null
      ? (db
          .prepare(
            `SELECT id, project_id, automation_mode, status, pending_action,
                    blocked_reason, decision_ids_json, audit_ids_json,
                    live_traffic_changed, started_at, finished_at
             FROM decision_cycles
             WHERE project_id = ? AND id = ?`,
          )
          .get(input.project_id, input.cycle_id) as DecisionCycleRow | undefined) ??
        null
      : latestCycle(db, input.project_id);
  return { status: 200, body: cycleOutput(row, config) };
};
