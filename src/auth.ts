import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import { unauthorizedBody } from "./errors.js";

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

export function createAuthHook(db: Database.Database) {
  return async function authHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const token = parseBearer(request.headers.authorization);
    if (!token || !isValidApiKey(db, token)) {
      return reply.code(401).send(unauthorizedBody);
    }
  };
}
