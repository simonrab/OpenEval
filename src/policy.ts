import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { newPolicyId } from "./ids.js";
import { CANARY_PERCENT, parseCanaryPercent } from "./live/sticky.js";

export const DEFAULT_MAX_WAIT_MS = 30000;

export type PolicyModel = {
  model_id: string;
  timeout_ms: number;
};

export type UnsignedPolicy = {
  policy_id: string;
  version: number;
  previous_policy_id: string | null;
  project_id: string;
  rec_id: string;
  ste_id: string;
  compiled_at: string;
  primary: PolicyModel;
  backups: PolicyModel[];
  canary: unknown;
};

export type SignedPolicy = UnsignedPolicy & { sig: string };

export type PolicyRow = {
  id: string;
  project_id: string;
  body_json: string;
  etag: string;
  created_at: string;
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = canonicalValue(obj[key]);
    }
    return out;
  }
  return value;
}

export function canonicalPolicyBytes(doc: object): Buffer {
  const record = { ...(doc as Record<string, unknown>) };
  delete record.sig;
  return Buffer.from(JSON.stringify(canonicalValue(record)), "utf8");
}

function hmacHex(apiKey: string, bytes: Buffer): string {
  return createHmac("sha256", apiKey).update(bytes).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export function signPolicy(apiKey: string, unsigned: UnsignedPolicy): SignedPolicy {
  const bytes = canonicalPolicyBytes(unsigned);
  const hex = hmacHex(apiKey, bytes);
  return { ...unsigned, sig: `hmac-sha256:${hex}` };
}

export function verifyPolicy(apiKey: string, doc: SignedPolicy): boolean {
  if (typeof doc.sig !== "string" || doc.sig.length === 0) {
    return false;
  }
  const expected = signPolicy(apiKey, doc).sig;
  return safeEqual(expected, doc.sig);
}

export function policyEtag(bodyJson: string): string {
  return createHash("sha256").update(bodyJson, "utf8").digest("hex");
}

export function formatEtag(hex: string): string {
  return `"${hex}"`;
}

export function normalizeEtag(value: string | string[] | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  let trimmed = value.trim();
  if (trimmed.startsWith("W/")) {
    trimmed = trimmed.slice(2).trim();
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function putPolicy(
  db: Database.Database,
  apiKey: string,
  unsigned: UnsignedPolicy,
): SignedPolicy {
  const policyId = unsigned.policy_id || newPolicyId();
  const signed = signPolicy(apiKey, { ...unsigned, policy_id: policyId });
  const bodyJson = JSON.stringify(signed);
  const etag = policyEtag(bodyJson);
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO policies (id, project_id, body_json, etag, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(policyId, unsigned.project_id, bodyJson, etag, createdAt);
  return signed;
}

export const insertPolicyForTest = putPolicy;

export type ProjectLiveState = {
  project_id: string;
  last_full_policy_id: string | null;
  draft_policy_id: string | null;
  canary_policy_id: string | null;
  canary_percent: number | null;
  rollback_target_policy_id: string | null;
  hashed_request_count: number;
  canary_request_count: number;
  fallback_count: number;
  request_count: number;
  pii_blocked_count: number;
  last_known_loaded_at: string | null;
};

export type RuntimePolicyDocument = {
  last_full: SignedPolicy;
  canary: SignedPolicy | null;
  canary_percent: number;
};

function parseAndVerifyRow(
  apiKey: string,
  row: PolicyRow,
): SignedPolicy | null {
  let parsed: SignedPolicy;
  try {
    parsed = JSON.parse(row.body_json) as SignedPolicy;
  } catch {
    return null;
  }
  if (!verifyPolicy(apiKey, parsed)) {
    return null;
  }
  return parsed;
}

export function getProjectLiveState(
  db: Database.Database,
  projectId: string,
): ProjectLiveState | null {
  const row = db
    .prepare(
      `SELECT project_id, last_full_policy_id, draft_policy_id,
              canary_policy_id, canary_percent, rollback_target_policy_id,
              COALESCE(hashed_request_count, 0) AS hashed_request_count,
              COALESCE(canary_request_count, 0) AS canary_request_count,
              COALESCE(fallback_count, 0) AS fallback_count,
              COALESCE(request_count, 0) AS request_count,
              COALESCE(pii_blocked_count, 0) AS pii_blocked_count,
              last_known_loaded_at
       FROM project_live_state
       WHERE project_id = ?`,
    )
    .get(projectId) as ProjectLiveState | undefined;
  return row ?? null;
}

export function upsertDraftPolicy(
  db: Database.Database,
  projectId: string,
  policyId: string,
): void {
  db.prepare(
    `INSERT INTO project_live_state (project_id, last_full_policy_id, draft_policy_id)
     VALUES (?, NULL, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       draft_policy_id = excluded.draft_policy_id`,
  ).run(projectId, policyId);
}

export function getPolicyRow(
  db: Database.Database,
  policyId: string,
): PolicyRow | null {
  const row = db
    .prepare(
      `SELECT id, project_id, body_json, etag, created_at
       FROM policies
       WHERE id = ?`,
    )
    .get(policyId) as PolicyRow | undefined;
  return row ?? null;
}

function policyRowVerifies(
  apiKey: string,
  row: PolicyRow,
): boolean {
  return parseAndVerifyRow(apiKey, row) !== null;
}

export function promoteToLastFullIfNone(
  db: Database.Database,
  apiKey: string,
  projectId: string,
  policyId: string,
): boolean {
  const row = getPolicyRow(db, policyId);
  if (!row || row.project_id !== projectId) {
    return false;
  }
  if (!policyRowVerifies(apiKey, row)) {
    return false;
  }
  const result = db
    .prepare(
      `INSERT INTO project_live_state (project_id, last_full_policy_id, draft_policy_id)
       VALUES (?, ?, NULL)
       ON CONFLICT(project_id) DO UPDATE SET
         last_full_policy_id = excluded.last_full_policy_id,
         draft_policy_id = CASE
           WHEN project_live_state.draft_policy_id = excluded.last_full_policy_id
           THEN NULL
           ELSE project_live_state.draft_policy_id
         END
       WHERE project_live_state.last_full_policy_id IS NULL`,
    )
    .run(projectId, policyId);
  return result.changes > 0;
}

export function getLastFullPolicy(
  db: Database.Database,
  apiKey: string,
  projectId: string,
): PolicyRow | null {
  const state = getProjectLiveState(db, projectId);
  if (!state?.last_full_policy_id) {
    return null;
  }
  const row = getPolicyRow(db, state.last_full_policy_id);
  if (!row) {
    return null;
  }
  if (!policyRowVerifies(apiKey, row)) {
    return null;
  }
  return row;
}

export function recordPolicyDecision(
  db: Database.Database,
  policyId: string,
  decision: "approved" | "rejected",
): void {
  db.prepare(
    `INSERT INTO policy_approvals (policy_id, decision, decided_at)
     VALUES (?, ?, ?)
     ON CONFLICT(policy_id) DO UPDATE SET
       decision = excluded.decision,
       decided_at = excluded.decided_at`,
  ).run(policyId, decision, new Date().toISOString());
}

export function getPolicyDecision(
  db: Database.Database,
  policyId: string,
): "approved" | "rejected" | null {
  const row = db
    .prepare(`SELECT decision FROM policy_approvals WHERE policy_id = ?`)
    .get(policyId) as { decision: string } | undefined;
  if (row?.decision === "approved" || row?.decision === "rejected") {
    return row.decision;
  }
  return null;
}

function verifiedPolicyFromId(
  db: Database.Database,
  apiKey: string,
  policyId: string | null,
): SignedPolicy | null {
  if (!policyId) {
    return null;
  }
  const row = getPolicyRow(db, policyId);
  if (!row) {
    return null;
  }
  return parseAndVerifyRow(apiKey, row);
}

export function getApprovedDraftPolicyId(
  db: Database.Database,
  projectId: string,
): string | null {
  const state = getProjectLiveState(db, projectId);
  if (!state?.draft_policy_id) {
    return null;
  }
  if (state.draft_policy_id === state.last_full_policy_id) {
    return null;
  }
  if (getPolicyDecision(db, state.draft_policy_id) !== "approved") {
    return null;
  }
  return state.draft_policy_id;
}

export function activateCanary(
  db: Database.Database,
  apiKey: string,
  projectId: string,
  policyId: string,
): boolean {
  const row = getPolicyRow(db, policyId);
  if (!row || row.project_id !== projectId) {
    return false;
  }
  if (!policyRowVerifies(apiKey, row)) {
    return false;
  }
  const result = db
    .prepare(
      `UPDATE project_live_state
       SET canary_policy_id = ?,
           canary_percent = ?,
           rollback_target_policy_id = last_full_policy_id
       WHERE project_id = ?
         AND last_full_policy_id IS NOT NULL`,
    )
    .run(policyId, CANARY_PERCENT, projectId);
  return result.changes > 0;
}

export function clearCanary(
  db: Database.Database,
  projectId: string,
): void {
  db.prepare(
    `UPDATE project_live_state
     SET canary_policy_id = NULL,
         canary_percent = 0
     WHERE project_id = ?`,
  ).run(projectId);
}

export function promoteCanaryToLastFull(
  db: Database.Database,
  projectId: string,
): boolean {
  const state = getProjectLiveState(db, projectId);
  if (!state?.canary_policy_id) {
    return false;
  }
  const result = db
    .prepare(
      `UPDATE project_live_state
       SET last_full_policy_id = canary_policy_id,
           canary_policy_id = NULL,
           canary_percent = 0,
           draft_policy_id = CASE
             WHEN draft_policy_id = canary_policy_id THEN NULL
             ELSE draft_policy_id
           END
       WHERE project_id = ?
         AND canary_policy_id IS NOT NULL`,
    )
    .run(projectId);
  return result.changes > 0;
}

export function promotePolicyCanaryToLastFull(
  db: Database.Database,
  projectId: string,
  policyId: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE project_live_state
       SET last_full_policy_id = ?,
           canary_policy_id = NULL,
           canary_percent = 0,
           draft_policy_id = CASE
             WHEN draft_policy_id = ? THEN NULL
             ELSE draft_policy_id
           END
       WHERE project_id = ?
         AND canary_policy_id = ?
         AND canary_percent = ?`,
    )
    .run(policyId, policyId, projectId, policyId, CANARY_PERCENT);
  return result.changes > 0;
}

export function rollbackToLastFull(
  db: Database.Database,
  projectId: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE project_live_state
       SET last_full_policy_id = COALESCE(rollback_target_policy_id, last_full_policy_id),
           canary_policy_id = NULL,
           canary_percent = 0
       WHERE project_id = ?
         AND last_full_policy_id IS NOT NULL`,
    )
    .run(projectId);
  return result.changes > 0;
}

export function rollbackToPolicy(
  db: Database.Database,
  projectId: string,
  policyId: string,
): boolean {
  const row = getPolicyRow(db, policyId);
  if (!row || row.project_id !== projectId) {
    return false;
  }
  const result = db
    .prepare(
      `UPDATE project_live_state
       SET last_full_policy_id = ?,
           canary_policy_id = NULL,
           canary_percent = 0
       WHERE project_id = ?
         AND last_full_policy_id IS NOT NULL`,
    )
    .run(policyId, projectId);
  return result.changes > 0;
}

export function upsertLiveStats(
  db: Database.Database,
  projectId: string,
  stats: {
    hashed_request_count: number;
    canary_request_count: number;
    fallback_count: number;
    request_count: number;
    pii_blocked_count?: number;
    last_known_loaded_at?: string;
  },
): void {
  db.prepare(
    `UPDATE project_live_state
     SET hashed_request_count = ?,
         canary_request_count = ?,
         fallback_count = ?,
         request_count = ?,
         pii_blocked_count = COALESCE(?, pii_blocked_count),
         last_known_loaded_at = COALESCE(?, last_known_loaded_at),
         stats_updated_at = ?
     WHERE project_id = ?`,
  ).run(
    stats.hashed_request_count,
    stats.canary_request_count,
    stats.fallback_count,
    stats.request_count,
    stats.pii_blocked_count ?? null,
    stats.last_known_loaded_at ?? null,
    new Date().toISOString(),
    projectId,
  );
}

export function getRuntimePolicyDocument(
  db: Database.Database,
  apiKey: string,
  projectId: string,
): { bodyJson: string; etag: string } | null {
  const lastFullRow = getLastFullPolicy(db, apiKey, projectId);
  if (!lastFullRow) {
    return null;
  }
  const lastFull = JSON.parse(lastFullRow.body_json) as SignedPolicy;
  const state = getProjectLiveState(db, projectId);
  let canary: SignedPolicy | null = null;
  let canaryPercent = 0;
  if (state?.canary_policy_id && state.canary_percent === CANARY_PERCENT) {
    const canaryDoc = verifiedPolicyFromId(db, apiKey, state.canary_policy_id);
    if (canaryDoc) {
      canary = canaryDoc;
      canaryPercent = CANARY_PERCENT;
    }
  }
  const bodyJson = JSON.stringify({
    last_full: lastFull,
    canary,
    canary_percent: canaryPercent,
  } satisfies RuntimePolicyDocument);
  return { bodyJson, etag: policyEtag(bodyJson) };
}

export function parseRuntimePolicyDocument(
  apiKey: string,
  text: string,
): RuntimePolicyDocument | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const rec = parsed as Record<string, unknown>;
  if (rec.last_full !== undefined) {
    if (rec.last_full === null || typeof rec.last_full !== "object") {
      return null;
    }
    const lastFull = rec.last_full as SignedPolicy;
    if (!verifyPolicy(apiKey, lastFull)) {
      return null;
    }
    let canary: SignedPolicy | null = null;
    if (rec.canary != null) {
      if (typeof rec.canary !== "object") {
        return null;
      }
      const canaryDoc = rec.canary as SignedPolicy;
      if (!verifyPolicy(apiKey, canaryDoc)) {
        return null;
      }
      canary = canaryDoc;
    }
    const percent = parseCanaryPercent(rec.canary_percent);
    return {
      last_full: lastFull,
      canary,
      canary_percent: canary && percent === CANARY_PERCENT ? CANARY_PERCENT : 0,
    };
  }
  if (typeof rec.sig === "string" && rec.primary) {
    const doc = rec as SignedPolicy;
    if (!verifyPolicy(apiKey, doc)) {
      return null;
    }
    return { last_full: doc, canary: null, canary_percent: 0 };
  }
  return null;
}
