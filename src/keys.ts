import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import type Database from "better-sqlite3";
import { agentError, projectNotFoundError } from "./errors.js";
import { newKeysRefId } from "./ids.js";
import { ErrorCode, type AgentError } from "./tools/types.js";

export { projectNotFoundError };

const HKDF_SALT = "evalrouter-keys-refs-v1";
const HKDF_INFO = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export type KeyMeta = {
  keys_ref: string;
  project_id: string;
  provider: string | null;
  created_at: string;
};

type KeyRow = {
  id: string;
  project_id: string;
  ciphertext: string;
  fingerprint: string;
  provider: string | null;
  created_at: string;
};

/**
 * Derive the AES wrap key from EVALROUTER_KEY (the server Bearer secret).
 * The wrap key is never stored in SQLite.
 */
export function deriveWrapKey(apiKey: string): Buffer {
  return Buffer.from(hkdfSync("sha256", apiKey, HKDF_SALT, HKDF_INFO, 32));
}

function encryptSecret(wrapKey: Buffer, secret: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", wrapKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptSecret(wrapKey: Buffer, packed: string): string {
  const buf = Buffer.from(packed, "base64");
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", wrapKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8",
  );
}

function fingerprintSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function projectExists(
  db: Database.Database,
  projectId: string,
): boolean {
  const row = db
    .prepare("SELECT id FROM projects WHERE id = ?")
    .get(projectId) as { id: string } | undefined;
  return row !== undefined;
}

export function storeKey(
  db: Database.Database,
  wrapKey: Buffer,
  input: { projectId: string; secret: string; provider?: string | null },
): string {
  const id = newKeysRefId();
  const createdAt = new Date().toISOString();
  const ciphertext = encryptSecret(wrapKey, input.secret);
  const fingerprint = fingerprintSecret(input.secret);
  db.prepare(
    `INSERT INTO keys_refs (id, project_id, ciphertext, fingerprint, provider, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId,
    ciphertext,
    fingerprint,
    input.provider ?? null,
    createdAt,
  );
  return id;
}

export function getKeyMeta(
  db: Database.Database,
  keysRef: string,
): KeyMeta | null {
  const row = db
    .prepare(
      "SELECT id, project_id, provider, created_at FROM keys_refs WHERE id = ?",
    )
    .get(keysRef) as Omit<KeyRow, "ciphertext" | "fingerprint"> | undefined;
  if (!row) {
    return null;
  }
  return {
    keys_ref: row.id,
    project_id: row.project_id,
    provider: row.provider,
    created_at: row.created_at,
  };
}

export function listProjectKeysRefs(
  db: Database.Database,
  projectId: string,
): string[] {
  const rows = db
    .prepare(
      "SELECT id FROM keys_refs WHERE project_id = ? ORDER BY created_at ASC, id ASC",
    )
    .all(projectId) as { id: string }[];
  return rows.map((row) => row.id);
}

export function readSecret(
  db: Database.Database,
  wrapKey: Buffer,
  keysRef: string,
): string {
  const row = db
    .prepare("SELECT ciphertext FROM keys_refs WHERE id = ?")
    .get(keysRef) as { ciphertext: string } | undefined;
  if (!row) {
    throw new Error("keys_ref not found");
  }
  return decryptSecret(wrapKey, row.ciphertext);
}

/**
 * Envelope for a later run path that needs a customer key and has none.
 * The agent should pass `keys_ref` (a `pkr_` id from POST /v1/keys).
 */
export function missingKeysRefError(projectId: string): AgentError {
  return agentError({
    code: ErrorCode.INVALID_INPUT,
    message: "A customer key is required. POST /v1/keys and pass keys_ref.",
    retryable: true,
    suggested_tool: "run_evals",
    suggested_args: { keys_ref: "pkr_..." },
    next_action: {
      tool: "run_evals",
      args: { project_id: projectId, keys_ref: "pkr_..." },
      ask_human: null,
    },
  });
}
