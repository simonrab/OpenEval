import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { listMembers } from "./eval-set.js";

export type Split = "train" | "holdout";

export const HOLDOUT_FRACTION = 0.3;
export const MIN_EVALS_TO_SPLIT = 10;

export type EvalSplit = {
  /** Trusted member eval id -> split. */
  splits: Map<string, Split>;
  /** True when the set is too small to split. */
  directional: boolean;
};

type SplitInput = { eval_id: string; archetype_id: string | null };

function hashOf(evalId: string, salt: string): string {
  return createHash("sha256").update(`split:${salt}${evalId}`).digest("hex");
}

function byHash(salt: string): (a: SplitInput, b: SplitInput) => number {
  return (a, b) => {
    const ha = hashOf(a.eval_id, salt);
    const hb = hashOf(b.eval_id, salt);
    if (ha !== hb) {
      return ha < hb ? -1 : 1;
    }
    return a.eval_id < b.eval_id ? -1 : 1;
  };
}

/**
 * Assign new evals to train or holdout. Existing assignments never change.
 * Holdout quotas are per archetype, with largest remainders to hit the total.
 * The salt is secret, so a caller with eval ids cannot compute the holdout.
 */
export function assignSplits(
  evals: SplitInput[],
  existing: Map<string, Split>,
  fraction = HOLDOUT_FRACTION,
  salt = "",
): Map<string, Split> {
  const out = new Map<string, Split>();
  for (const ev of evals) {
    const prior = existing.get(ev.eval_id);
    if (prior) {
      out.set(ev.eval_id, prior);
    }
  }
  const n = evals.length;
  if (n < 2) {
    for (const ev of evals) {
      if (!out.has(ev.eval_id)) out.set(ev.eval_id, "train");
    }
    return out;
  }
  const target = Math.min(n - 1, Math.max(1, Math.round(n * fraction)));

  const strata = new Map<string, SplitInput[]>();
  for (const ev of evals) {
    const key = ev.archetype_id ?? "";
    const list = strata.get(key) ?? [];
    list.push(ev);
    strata.set(key, list);
  }
  const keys = [...strata.keys()].sort();
  const quota = new Map<string, number>();
  const remainders: Array<{ key: string; rem: number }> = [];
  let assigned = 0;
  for (const key of keys) {
    const exact = (strata.get(key)!.length * target) / n;
    const base = Math.floor(exact);
    quota.set(key, base);
    assigned += base;
    remainders.push({ key, rem: exact - base });
  }
  remainders.sort((a, b) => b.rem - a.rem || (a.key < b.key ? -1 : 1));
  for (let i = 0; i < target - assigned; i += 1) {
    const key = remainders[i % remainders.length]!.key;
    quota.set(key, quota.get(key)! + 1);
  }

  const leftovers: SplitInput[] = [];
  for (const key of keys) {
    const members = strata.get(key)!;
    const held = members.filter((ev) => out.get(ev.eval_id) === "holdout").length;
    const fresh = members.filter((ev) => !out.has(ev.eval_id)).sort(byHash(salt));
    const need = Math.max(0, quota.get(key)! - held);
    fresh.forEach((ev, i) => {
      if (i < need) {
        out.set(ev.eval_id, "holdout");
      } else {
        leftovers.push(ev);
      }
    });
  }

  // A stratum with no new evals cannot fill its quota. Fill from the rest.
  let holdoutCount = [...out.values()].filter((s) => s === "holdout").length;
  for (const ev of leftovers.sort(byHash(salt))) {
    if (holdoutCount < target) {
      out.set(ev.eval_id, "holdout");
      holdoutCount += 1;
    } else {
      out.set(ev.eval_id, "train");
    }
  }
  return out;
}

/** The first eval set version. Copy-forward versions share its split. */
export function lineageRootId(db: Database.Database, evalSetId: string): string {
  const prev = db.prepare(`SELECT previous_eval_set_id FROM eval_sets WHERE id = ?`);
  let current = evalSetId;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const row = prev.get(current) as { previous_eval_set_id: string | null } | undefined;
    if (!row?.previous_eval_set_id) {
      return current;
    }
    current = row.previous_eval_set_id;
  }
  return current;
}

/** The secret salt of a lineage. It is made on first use. */
export function splitSalt(db: Database.Database, rootId: string): string {
  const row = db
    .prepare(`SELECT salt FROM eval_split_salts WHERE eval_set_id = ?`)
    .get(rootId) as { salt: string } | undefined;
  if (row) {
    return row.salt;
  }
  db.prepare(
    `INSERT OR IGNORE INTO eval_split_salts (eval_set_id, salt, created_at) VALUES (?, ?, ?)`,
  ).run(rootId, randomBytes(32).toString("hex"), new Date().toISOString());
  return (
    db.prepare(`SELECT salt FROM eval_split_salts WHERE eval_set_id = ?`).get(rootId) as {
      salt: string;
    }
  ).salt;
}

function storedSplits(db: Database.Database, rootId: string): Map<string, Split> {
  const rows = db
    .prepare(`SELECT eval_id, split FROM eval_splits WHERE eval_set_id = ?`)
    .all(rootId) as Array<{ eval_id: string; split: Split }>;
  return new Map(rows.map((r) => [r.eval_id, r.split]));
}

/**
 * The train/holdout split for the trusted evals of a set. It is made on first
 * use and stored per lineage, so an eval keeps its split in later versions.
 */
export function ensureEvalSplit(db: Database.Database, evalSetId: string): EvalSplit {
  const rootId = lineageRootId(db, evalSetId);
  const trusted = listMembers(db, evalSetId).filter((m) => m.status === "trusted");
  const stored = storedSplits(db, rootId);

  if (trusted.length < MIN_EVALS_TO_SPLIT) {
    // A stored holdout eval stays hidden, also in a small set.
    const splits = new Map<string, Split>(
      trusted.map((m) => [m.eval_id, stored.get(m.eval_id) === "holdout" ? "holdout" : "train"]),
    );
    return { splits, directional: true };
  }

  const splits = assignSplits(
    trusted.map((m) => ({ eval_id: m.eval_id, archetype_id: m.archetype_id })),
    stored,
    HOLDOUT_FRACTION,
    splitSalt(db, rootId),
  );
  const fresh = [...splits].filter(([id]) => !stored.has(id));
  if (fresh.length > 0) {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO eval_splits (eval_set_id, eval_id, split, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const [id, split] of fresh) {
        insert.run(rootId, id, split, now);
      }
    })();
  }
  return { splits, directional: false };
}
