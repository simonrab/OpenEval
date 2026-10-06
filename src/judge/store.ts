import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { listMembers } from "../eval-set.js";
import { newId } from "../ids.js";
import type { MarkPayload } from "../mark/forms.js";
import type { ModelSettings } from "../runner/openrouter.js";
import { lineageRootId, splitSalt } from "../splits.js";
import {
  CALIBRATION_TEST_FRACTION,
  judgeConfigHash,
  type JudgeConfig,
  type Verdict,
} from "./judge.js";

export type JudgeRow = JudgeConfig & {
  id: string;
  project_id: string;
  lineage_id: string;
  config_hash: string;
};

export type CalibrationItem = {
  eval_id: string;
  input: string;
  output: string;
  human: Verdict;
};

export type CalibrationRow = {
  id: string;
  judge_id: string;
  eval_set_id: string;
  config_hash: string;
  items_fingerprint: string;
  status: "trusted" | "uncalibrated";
  reason: string;
  n_items: number;
  n_train: number;
  n_test: number;
  n_agree: number;
  n_judge_errors: number;
  accuracy: number | null;
  kappa: number | null;
  cost_usd: number;
  created_at: string;
};

export type JudgeStatus =
  | { status: "none"; reason: string }
  | {
      status: "uncalibrated" | "stale" | "trusted";
      reason: string;
      judge: JudgeRow;
      calibration: CalibrationRow | null;
    };

/** pass_fail and rubric marks are verdicts. Other forms compare fields or text. */
export function isVerdictMark(mark: MarkPayload): boolean {
  return mark.form_type === "pass_fail" || mark.form_type === "rubric";
}

/** The human verdict of a mark, or null when it has none (na, or not a verdict form). */
export function humanVerdict(mark: MarkPayload): Verdict | null {
  if (mark.form_type === "pass_fail") {
    return mark.pass_fail === "pass" || mark.pass_fail === "fail" ? mark.pass_fail : null;
  }
  if (mark.form_type === "rubric") {
    const choices = Object.values(mark.rubric ?? {});
    if (choices.includes("fail")) {
      return "fail";
    }
    return choices.includes("pass") ? "pass" : null;
  }
  return null;
}

function parseMark(raw: string | null): MarkPayload | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as MarkPayload;
  } catch {
    return null;
  }
}

/** Trusted person evals where people marked a concrete output pass or fail. */
export function listCalibrationItems(
  db: Database.Database,
  evalSetId: string,
): CalibrationItem[] {
  const row = db.prepare(`SELECT trusted_mark, trusted_output FROM evals WHERE id = ?`);
  const items: CalibrationItem[] = [];
  for (const m of listMembers(db, evalSetId)) {
    if (m.score_how !== "person" || m.status !== "trusted") {
      continue;
    }
    const r = row.get(m.eval_id) as
      | { trusted_mark: string | null; trusted_output: string | null }
      | undefined;
    const mark = parseMark(r?.trusted_mark ?? null);
    if (!mark || r?.trusted_output == null) {
      continue;
    }
    const human = humanVerdict(mark);
    if (human) {
      items.push({ eval_id: m.eval_id, input: m.input_truncated, output: r.trusted_output, human });
    }
  }
  return items;
}

/** Changes when a human-marked output is added, removed, or changed. */
export function itemsFingerprint(items: CalibrationItem[]): string {
  const lines = items
    .map((i) => `${i.eval_id}:${i.human}:${createHash("sha256").update(i.output).digest("hex")}`)
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** Stable train/test assignment per item, from the secret lineage salt. */
export function calibrationSplit(
  db: Database.Database,
  evalSetId: string,
  items: CalibrationItem[],
): { train: CalibrationItem[]; test: CalibrationItem[] } {
  const salt = splitSalt(db, lineageRootId(db, evalSetId));
  const train: CalibrationItem[] = [];
  const test: CalibrationItem[] = [];
  for (const item of items) {
    const h = createHash("sha256").update(`calibration:${salt}${item.eval_id}`).digest("hex");
    const u = Number.parseInt(h.slice(0, 8), 16) / 0x1_0000_0000;
    (u < CALIBRATION_TEST_FRACTION ? test : train).push(item);
  }
  return { train, test };
}

function toJudgeRow(r: {
  id: string;
  project_id: string;
  lineage_id: string;
  judge_model: string;
  rubric: string;
  settings_json: string;
  config_hash: string;
}): JudgeRow {
  return {
    id: r.id,
    project_id: r.project_id,
    lineage_id: r.lineage_id,
    judge_model: r.judge_model,
    rubric: r.rubric,
    settings: JSON.parse(r.settings_json) as ModelSettings,
    config_hash: r.config_hash,
  };
}

export function getJudge(db: Database.Database, evalSetId: string): JudgeRow | null {
  const row = db
    .prepare(
      `SELECT id, project_id, lineage_id, judge_model, rubric, settings_json, config_hash
       FROM judges WHERE lineage_id = ?`,
    )
    .get(lineageRootId(db, evalSetId)) as Parameters<typeof toJudgeRow>[0] | undefined;
  return row ? toJudgeRow(row) : null;
}

/** One judge per lineage. A new config replaces the old one and needs a new calibration. */
export function saveJudge(
  db: Database.Database,
  projectId: string,
  evalSetId: string,
  config: JudgeConfig,
): JudgeRow {
  const lineage = lineageRootId(db, evalSetId);
  const hash = judgeConfigHash(config);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO judges
       (id, project_id, lineage_id, judge_model, rubric, settings_json, config_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(lineage_id) DO UPDATE SET
       judge_model = excluded.judge_model,
       rubric = excluded.rubric,
       settings_json = excluded.settings_json,
       config_hash = excluded.config_hash,
       updated_at = excluded.updated_at`,
  ).run(
    newId("jdg_"),
    projectId,
    lineage,
    config.judge_model,
    config.rubric,
    JSON.stringify(config.settings),
    hash,
    now,
    now,
  );
  return getJudge(db, evalSetId)!;
}

export function saveCalibration(
  db: Database.Database,
  judge: JudgeRow,
  evalSetId: string,
  row: Omit<CalibrationRow, "id" | "judge_id" | "eval_set_id" | "config_hash" | "created_at">,
): CalibrationRow {
  const id = newId("jcal_");
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO judge_calibrations
       (id, judge_id, project_id, lineage_id, eval_set_id, config_hash, items_fingerprint,
        status, reason, n_items, n_train, n_test, n_agree, n_judge_errors, accuracy, kappa,
        cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    judge.id,
    judge.project_id,
    judge.lineage_id,
    evalSetId,
    judge.config_hash,
    row.items_fingerprint,
    row.status,
    row.reason,
    row.n_items,
    row.n_train,
    row.n_test,
    row.n_agree,
    row.n_judge_errors,
    row.accuracy,
    row.kappa,
    row.cost_usd,
    createdAt,
  );
  return {
    ...row,
    id,
    judge_id: judge.id,
    eval_set_id: evalSetId,
    config_hash: judge.config_hash,
    created_at: createdAt,
  };
}

function latestCalibration(db: Database.Database, judge: JudgeRow): CalibrationRow | null {
  const row = db
    .prepare(
      `SELECT id, judge_id, eval_set_id, config_hash, items_fingerprint, status, reason,
              n_items, n_train, n_test, n_agree, n_judge_errors, accuracy, kappa, cost_usd,
              created_at
       FROM judge_calibrations WHERE lineage_id = ?
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get(judge.lineage_id) as CalibrationRow | undefined;
  return row ?? null;
}

/**
 * The judge can grade only when status is trusted: the last calibration used
 * this exact config, passed the thresholds, and no human marks changed since.
 */
export function judgeStatus(db: Database.Database, evalSetId: string): JudgeStatus {
  const judge = getJudge(db, evalSetId);
  if (!judge) {
    return { status: "none", reason: "No judge is set for this eval set." };
  }
  const calibration = latestCalibration(db, judge);
  if (!calibration) {
    return { status: "uncalibrated", reason: "The judge has no calibration.", judge, calibration };
  }
  if (calibration.config_hash !== judge.config_hash) {
    return {
      status: "uncalibrated",
      reason: "The judge changed after its last calibration.",
      judge,
      calibration,
    };
  }
  const fingerprint = itemsFingerprint(listCalibrationItems(db, evalSetId));
  if (calibration.items_fingerprint !== fingerprint) {
    return {
      status: calibration.status === "trusted" ? "stale" : "uncalibrated",
      reason: "Human marks changed after the last calibration. Calibrate again.",
      judge,
      calibration,
    };
  }
  if (calibration.status !== "trusted") {
    return { status: "uncalibrated", reason: calibration.reason, judge, calibration };
  }
  return { status: "trusted", reason: calibration.reason, judge, calibration };
}
