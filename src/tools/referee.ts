import type Database from "better-sqlite3";
import { agentError } from "../errors.js";
import { runCandidates } from "../runner/candidates.js";
import { getRun, type RunRow } from "../runner/queue.js";
import { ErrorCode, type AgentError } from "./types.js";

export function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export function runNotFoundError(runId: string): AgentError {
  return agentError({
    code: ErrorCode.INVALID_INPUT,
    message: "Run not found",
    retryable: false,
    suggested_tool: null,
    suggested_args: { run_id: runId },
    next_action: { tool: null, args: {}, ask_human: null },
  });
}

export function candidateNotFoundError(runId: string, candidateId: string): AgentError {
  return agentError({
    code: ErrorCode.INVALID_INPUT,
    message: "The run has no candidate with this id",
    retryable: false,
    suggested_tool: "get_eval_report",
    suggested_args: { run_id: runId, candidate_id: candidateId },
    next_action: { tool: "get_eval_report", args: { run_id: runId }, ask_human: null },
  });
}

export function loadProjectRun(
  db: Database.Database,
  projectId: string,
  runId: string,
): RunRow | null {
  const run = getRun(db, runId);
  return run && run.project_id === projectId ? run : null;
}

export function runHasCandidate(
  db: Database.Database,
  run: RunRow,
  candidateId: string,
): boolean {
  if (runCandidates(run.models, run.candidates).some((c) => c.id === candidateId)) {
    return true;
  }
  return (
    db
      .prepare(`SELECT 1 FROM run_results WHERE run_id = ? AND model_id = ? LIMIT 1`)
      .get(run.id, candidateId) !== undefined
  );
}

export function runIsDone(run: RunRow): boolean {
  return run.status !== "queued" && run.status !== "running";
}
