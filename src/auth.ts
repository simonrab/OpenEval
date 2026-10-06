import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import { scopeForbiddenError, unauthorizedBody } from "./errors.js";

/** full = the server key. optimizer = one project, optimizer tools only. */
export type AuthScope =
  | { scope: "full" }
  | { scope: "optimizer"; projectId: string };

declare module "fastify" {
  interface FastifyRequest {
    authScope?: AuthScope;
  }
}

export const OPTIMIZER_KEY_PREFIX = "oeo_";

export function hashKey(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function parseBearer(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(\S+)$/.exec(header);
  return match?.[1] ?? null;
}

export function storeApiKeyHash(
  db: Database.Database,
  rawKey: string,
): void {
  const keyHash = hashKey(rawKey);
  const createdAt = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM api_keys").run();
    db.prepare(
      "INSERT INTO api_keys (key_hash, created_at) VALUES (?, ?)",
    ).run(keyHash, createdAt);
  });
  tx();
}

export function isValidApiKey(
  db: Database.Database,
  rawKey: string,
): boolean {
  const incoming = Buffer.from(hashKey(rawKey), "utf8");
  const rows = db.prepare("SELECT key_hash FROM api_keys").all() as {
    key_hash: string;
  }[];
  for (const row of rows) {
    const stored = Buffer.from(row.key_hash, "utf8");
    if (
      incoming.length === stored.length &&
      timingSafeEqual(incoming, stored)
    ) {
      return true;
    }
  }
  return false;
}

/** Mint an optimizer key for one project. Only its hash is stored. */
export function mintOptimizerKey(db: Database.Database, projectId: string): string {
  const raw = `${OPTIMIZER_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  db.prepare(
    `INSERT INTO scoped_api_keys (key_hash, project_id, scope, created_at)
     VALUES (?, ?, 'optimizer', ?)`,
  ).run(hashKey(raw), projectId, new Date().toISOString());
  return raw;
}

export function resolveApiKey(db: Database.Database, rawKey: string): AuthScope | null {
  if (isValidApiKey(db, rawKey)) {
    return { scope: "full" };
  }
  const row = db
    .prepare(`SELECT project_id FROM scoped_api_keys WHERE key_hash = ? AND scope = 'optimizer'`)
    .get(hashKey(rawKey)) as { project_id: string } | undefined;
  return row ? { scope: "optimizer", projectId: row.project_id } : null;
}

const OPTIMIZER_ROUTE = "/v1/tools/:name";

export function createAuthHook(db: Database.Database) {
  return async function authHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const token = parseBearer(request.headers.authorization);
    const auth = token ? resolveApiKey(db, token) : null;
    if (!auth) {
      return reply.code(401).send(unauthorizedBody);
    }
    if (
      auth.scope === "optimizer" &&
      !(request.method === "POST" && request.routeOptions.url === OPTIMIZER_ROUTE)
    ) {
      return reply.code(403).send(scopeForbiddenError());
    }
    request.authScope = auth;
  };
}
