import type Database from "better-sqlite3";
import { judgeStatus } from "./store.js";

/** Advice when person evals reused a mark. Null when every eval got a real grade. */
export function graderAdvice(
  db: Database.Database,
  evalSetId: string,
  nNotGraded: number,
): string | null {
  if (nNotGraded === 0) {
    return null;
  }
  const head = `${nNotGraded} person ${nNotGraded === 1 ? "eval" : "evals"} reused a person mark and did not grade the output.`;
  const status = judgeStatus(db, evalSetId);
  switch (status.status) {
    case "none":
      return `${head} Call configure_judge and calibrate_judge, or add program checks.`;
    case "stale":
      return `${head} Human marks changed after calibration. Call calibrate_judge again.`;
    case "uncalibrated":
      return `${head} The judge is not trusted: ${status.reason} Get more marks, then call calibrate_judge.`;
    case "trusted":
      return `${head} The judge is trusted now. Score the outputs again so the judge grades them. submit_outputs needs keys_ref and max_eval_spend_usd for this.`;
  }
}
