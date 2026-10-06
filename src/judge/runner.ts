import type Database from "better-sqlite3";
import type { OpenRouterClient } from "../runner/openrouter.js";
import type { RetryOptions } from "../runner/retry.js";
import type { JudgeFn } from "../runner/score.js";
import { acquireEvalStart, finishEvalSpend, type SpendGate } from "../runner/spend.js";
import { callJudge, type JudgeConfig } from "./judge.js";
import { judgeStatus } from "./store.js";

export type JudgeDeps = {
  client: OpenRouterClient;
  apiKey: string;
  gate: SpendGate;
  retry?: RetryOptions;
};

/** Judge calls go through the spend gate. Real cost is added to the gate. */
export function makeJudgeFn(config: JudgeConfig, deps: JudgeDeps): JudgeFn {
  return async (input, output) => {
    if (!(await acquireEvalStart(deps.gate))) {
      return "cap";
    }
    const result = await callJudge({
      client: deps.client,
      apiKey: deps.apiKey,
      config,
      input,
      output,
      retry: deps.retry,
    });
    await finishEvalSpend(deps.gate, result.cost_usd);
    return result;
  };
}

/** A judge function only when the eval set has a trusted, current calibration. */
export function trustedJudgeFn(
  db: Database.Database,
  evalSetId: string,
  deps: JudgeDeps,
): JudgeFn | null {
  const status = judgeStatus(db, evalSetId);
  return status.status === "trusted" ? makeJudgeFn(status.judge, deps) : null;
}
