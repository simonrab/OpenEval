/**
 * Map a finished get_eval_report body to a CI process exit (§13).
 * Exit 0 only on a complete pass. Anything else is non-zero.
 */
export type CiReport = {
  status: "queued" | "running" | "succeeded" | "partial" | "failed";
  code: string | null;
  summary?: {
    n_fail?: number;
    new_failures_missing_from_evals?: boolean;
  };
  eval_ids_not_scored?: string[];
};

export function mapCiExit(report: CiReport): number {
  if (report.status === "queued" || report.status === "running") {
    return 1;
  }
  if (report.code != null) {
    return 1;
  }
  if (report.status === "partial" || report.status === "failed") {
    return 1;
  }
  const nFail = report.summary?.n_fail ?? 0;
  const notScored = report.eval_ids_not_scored?.length ?? 0;
  const missingFailures =
    report.summary?.new_failures_missing_from_evals ?? false;
  if (nFail > 0 || notScored > 0 || missingFailures) {
    return 1;
  }
  if (report.status === "succeeded") {
    return 0;
  }
  return 1;
}
