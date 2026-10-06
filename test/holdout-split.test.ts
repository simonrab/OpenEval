import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { copyEvalSetForward } from "../src/eval-set-copy.js";
import { insertDraftEvals } from "../src/eval-set.js";
import { assignSplits, ensureEvalSplit, lineageRootId } from "../src/splits.js";
import { caseDraft, insertProject, seedTrustedSet } from "./helpers/optimizer-fixtures.js";

function ids(n: number, archetype: string | null = null) {
  return Array.from({ length: n }, (_, i) => ({
    eval_id: `evl_${archetype ?? "none"}_${i}`,
    archetype_id: archetype,
  }));
}

function holdoutIds(splits: Map<string, string>): string[] {
  return [...splits].filter(([, s]) => s === "holdout").map(([id]) => id).sort();
}

describe("assignSplits", () => {
  it("is deterministic and does not depend on input order", () => {
    const evals = ids(20);
    const a = assignSplits(evals, new Map());
    const b = assignSplits([...evals].reverse(), new Map());
    assert.deepEqual(holdoutIds(a), holdoutIds(b));
    assert.equal(holdoutIds(a).length, 6);
    assert.equal(a.size, 20);
  });

  it("puts 30 percent in holdout and at least one eval in each split", () => {
    assert.equal(holdoutIds(assignSplits(ids(10), new Map())).length, 3);
    const many = assignSplits(
      Array.from({ length: 10 }, (_, i) => ({ eval_id: `evl_${i}`, archetype_id: `a${i}` })),
      new Map(),
    );
    assert.equal(holdoutIds(many).length, 3);
  });

  it("stratifies by archetype", () => {
    const evals = [...ids(10, "extraction"), ...ids(10, "routing")];
    const splits = assignSplits(evals, new Map());
    const held = holdoutIds(splits);
    assert.equal(held.filter((id) => id.includes("extraction")).length, 3);
    assert.equal(held.filter((id) => id.includes("routing")).length, 3);
  });

  it("never moves an eval that already has a split", () => {
    const first = assignSplits(ids(10), new Map());
    const grown = [...ids(10), ...Array.from({ length: 10 }, (_, i) => ({ eval_id: `evl_new_${i}`, archetype_id: null }))];
    const second = assignSplits(grown, first);
    for (const [id, split] of first) {
      assert.equal(second.get(id), split);
    }
    assert.equal(holdoutIds(second).length, 6);
  });
});

describe("ensureEvalSplit", () => {
  let dir: string;
  let db: Database.Database;
  let projectId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openeval-split-"));
    db = openDb(join(dir, "openeval.sqlite"));
    projectId = insertProject(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not split fewer than 10 trusted evals and marks it directional", () => {
    const { evalSetId, evalIds } = seedTrustedSet(db, projectId, 9);
    const split = ensureEvalSplit(db, evalSetId);
    assert.equal(split.directional, true);
    assert.equal(split.splits.size, 9);
    for (const id of evalIds) {
      assert.equal(split.splits.get(id), "train");
    }
    const stored = db.prepare(`SELECT COUNT(*) AS n FROM eval_splits`).get() as { n: number };
    assert.equal(stored.n, 0);
  });

  it("persists the split on first use and returns the same split after", () => {
    const { evalSetId } = seedTrustedSet(db, projectId, 12);
    const first = ensureEvalSplit(db, evalSetId);
    assert.equal(first.directional, false);
    assert.equal(holdoutIds(first.splits).length, 4);
    const stored = db.prepare(`SELECT COUNT(*) AS n FROM eval_splits`).get() as { n: number };
    assert.equal(stored.n, 12);
    const second = ensureEvalSplit(db, evalSetId);
    assert.deepEqual(holdoutIds(second.splits), holdoutIds(first.splits));
  });

  it("only splits trusted evals", () => {
    const { evalSetId, evalIds } = seedTrustedSet(db, projectId, 12);
    db.prepare(`UPDATE evals SET status = 'draft' WHERE id = ?`).run(evalIds[0]);
    const split = ensureEvalSplit(db, evalSetId);
    assert.equal(split.splits.has(evalIds[0]!), false);
    assert.equal(split.splits.size, 11);
  });

  it("keeps the split when the eval set is copied forward and assigns new evals", () => {
    const { evalSetId } = seedTrustedSet(db, projectId, 10);
    const v1 = ensureEvalSplit(db, evalSetId);
    const copied = copyEvalSetForward(db, { projectId, sourceEvalSetId: evalSetId });
    const added = insertDraftEvals(
      db,
      copied.newEvalSetId,
      Array.from({ length: 10 }, (_, i) => caseDraft(100 + i)),
    );
    for (const ev of added) {
      db.prepare(`UPDATE evals SET status = 'trusted' WHERE id = ?`).run(ev.eval_id);
    }
    assert.equal(lineageRootId(db, copied.newEvalSetId), evalSetId);
    const v2 = ensureEvalSplit(db, copied.newEvalSetId);
    for (const [id, split] of v1.splits) {
      assert.equal(v2.splits.get(id), split);
    }
    assert.equal(v2.splits.size, 20);
    assert.equal(holdoutIds(v2.splits).length, 6);
  });

  it("salts the split hash per lineage, so eval ids alone do not give the holdout", () => {
    const { evalSetId, evalIds } = seedTrustedSet(db, projectId, 20);
    const split = ensureEvalSplit(db, evalSetId);
    const salt = db.prepare(`SELECT salt FROM eval_split_salts WHERE eval_set_id = ?`).get(evalSetId) as
      | { salt: string }
      | undefined;
    assert.ok(salt && salt.salt.length >= 32);
    const unsalted = assignSplits(
      evalIds.map((id) => ({ eval_id: id, archetype_id: null })),
      new Map(),
    );
    assert.notDeepEqual(holdoutIds(split.splits), holdoutIds(unsalted));
    assert.deepEqual(
      holdoutIds(split.splits),
      holdoutIds(
        assignSplits(
          evalIds.map((id) => ({ eval_id: id, archetype_id: null })),
          new Map(),
          undefined,
          salt.salt,
        ),
      ),
    );
  });

  it("keeps a stored holdout eval hidden when a set drops under 10", () => {
    const { evalSetId } = seedTrustedSet(db, projectId, 10);
    const v1 = ensureEvalSplit(db, evalSetId);
    const held = holdoutIds(v1.splits);
    const train = [...v1.splits].filter(([, s]) => s === "train").map(([id]) => id);
    const copied = copyEvalSetForward(db, {
      projectId,
      sourceEvalSetId: evalSetId,
      omitEvalIds: train.slice(0, 2),
    });
    const v2 = ensureEvalSplit(db, copied.newEvalSetId);
    assert.equal(v2.directional, true);
    assert.deepEqual(holdoutIds(v2.splits), held);
  });
});
