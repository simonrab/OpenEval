import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { newPolicyId } from "./ids.js";

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
      `SELECT project_id, last_full_policy_id, draft_policy_id
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
