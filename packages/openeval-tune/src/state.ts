import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { VerdictName } from "./client.js";

export type Mode = "direct" | "harness";

/** A direct setup, as run_evals takes it. */
export type DirectSetup = {
  id: string;
  model: string;
  settings?: Record<string, unknown>;
  system_prompt?: string;
};

export type RunRef = { run_id: string; candidate_id: string };

export type RunRecord = RunRef & {
  mode: Mode;
  label: string | null;
  reps: number;
  cost_usd: number;
  created_at: string;
  setup?: DirectSetup;
  commit?: string;
};

export type RoundRecord = RunRef & {
  round: number;
  verdict: VerdictName;
  reason: string;
  train_delta: number;
  holdout_delta: number;
  underpowered: boolean;
  plateau: boolean;
  created_at: string;
};

export type PromoteStage =
  | "await_recommendation_approval"
  | "await_policy_approval"
  | "await_canary_approval"
  | "canary_live"
  | "await_full_approval"
  | "await_rollback_approval"
  | "done";

export type PromoteState = {
  stage: PromoteStage;
  run_id: string;
  candidate_id: string;
  confirm_run_id: string | null;
  recommendation_id: string | null;
  policy_id: string | null;
  has_system_prompt: boolean;
  approve_urls: Record<string, string>;
  updated_at: string;
};

export type TuneState = {
  version: 1;
  session_id: string;
  project_id: string;
  eval_set_id: string;
  mode: Mode;
  reps: number;
  objective: "quality" | "cost";
  min_effect: number | null;
  budget_usd: number;
  max_rounds: number;
  spend_usd: number;
  baseline: RunRef | null;
  original_baseline: RunRef | null;
  runs: RunRecord[];
  rounds: RoundRecord[];
  promote: PromoteState | null;
  created_at: string;
  updated_at: string;
};

export const DEFAULT_STATE_DIR = ".openeval-tune";

export function statePath(dir: string): string {
  return join(dir, "state.json");
}

export function newSessionId(): string {
  return `tune-${randomUUID()}`;
}

export function newState(opts: {
  project_id: string;
  eval_set_id: string;
  mode: Mode;
  reps?: number;
  objective?: "quality" | "cost";
  min_effect?: number | null;
  budget_usd?: number;
  max_rounds?: number;
  session_id?: string;
}): TuneState {
  const now = new Date().toISOString();
  return {
    version: 1,
    session_id: opts.session_id ?? newSessionId(),
    project_id: opts.project_id,
    eval_set_id: opts.eval_set_id,
    mode: opts.mode,
    reps: opts.reps ?? 3,
    objective: opts.objective ?? "quality",
    min_effect: opts.min_effect ?? null,
    budget_usd: opts.budget_usd ?? 10,
    max_rounds: opts.max_rounds ?? 20,
    spend_usd: 0,
    baseline: null,
    original_baseline: null,
    runs: [],
    rounds: [],
    promote: null,
    created_at: now,
    updated_at: now,
  };
}

export function loadState(dir: string): TuneState | null {
  let text: string;
  try {
    text = readFileSync(statePath(dir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  const parsed = JSON.parse(text) as TuneState;
  if (parsed.version !== 1) {
    throw new Error(`The state file has version ${String(parsed.version)}. This tool reads version 1.`);
  }
  return parsed;
}

/** Write the state file. The write is atomic: a temp file, then a rename. */
export function saveState(dir: string, state: TuneState): void {
  state.updated_at = new Date().toISOString();
  const path = statePath(dir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

export function findRun(state: TuneState, ref: RunRef): RunRecord | undefined {
  return state.runs.find((r) => r.run_id === ref.run_id && r.candidate_id === ref.candidate_id);
}

export function remainingBudget(state: TuneState): number {
  return Math.max(0, state.budget_usd - state.spend_usd);
}

export function budgetSpent(state: TuneState): boolean {
  return state.spend_usd >= state.budget_usd;
}

export function roundsDone(state: TuneState): boolean {
  return state.rounds.length >= state.max_rounds;
}
