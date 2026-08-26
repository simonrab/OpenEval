import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { createEvalSetVersion1, type DraftEval } from "../src/eval-set.js";
import { insertEvalFile } from "../src/eval-files.js";
import { newJobId } from "../src/ids.js";
import { marksAgree } from "../src/mark/agreement.js";
import type { MarkPayload } from "../src/mark/forms.js";
import { signMarkToken } from "../src/mark/tokens.js";
import {
  authHeaders,
  createTestApp,
  fiveCodeDrafts,
  TEST_API_KEY,
} from "./helpers/run-fixtures.js";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_1x1 = Buffer.from(PNG_B64, "base64");

function personRegionDraft(): DraftEval {
  return {
    title: "Mark the total on the image",
    score_how: "person",
    status: "draft",
    program_check: null,
    input_truncated: "Where is the total?",
    form_type: "pass_fail",
    form_spec: { needs_region: true, region_tolerance: 8 },
  };
}

function seedRegionSet(
  db: Database.Database,
  projectId: string,
): { evalSetId: string; personEvalId: string } {
  const jobId = newJobId();
  db.prepare(
    `INSERT INTO jobs (id, project_id, description, limits, created_at)
     VALUES (?, ?, ?, NULL, ?)`,
  ).run(
    jobId,
    projectId,
    "Judge this invoice image and mark the region of the total",
    new Date().toISOString(),
  );
  const created = createEvalSetVersion1(db, {
    projectId,
    jobId,
    drafts: [...fiveCodeDrafts().slice(0, 1), personRegionDraft()],
  });
  const personEvalId = created.evals.find((e) => e.score_how === "person")!.eval_id;
  db.prepare(`UPDATE evals SET status = 'trusted' WHERE score_how = 'code'`).run();
  insertEvalFile(db, {
    evalId: personEvalId,
    path: "fixtures/invoice.png",
    mime: "image/png",
    content: PNG_1x1,
  });
  return { evalSetId: created.evalSetId, personEvalId };
}

describe("mark region on image/PDF", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let evalSetId: string;
  let personEvalId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-mark-region-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    app = await createTestApp(sqlitePath);
    const proj = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authHeaders(),
      payload: {},
    });
    projectId = (proj.json() as { project_id: string }).project_id;
    const db = new Database(sqlitePath);
    const seeded = seedRegionSet(db, projectId);
    evalSetId = seeded.evalSetId;
    personEvalId = seeded.personEvalId;
    db.close();

    await app.inject({
      method: "POST",
      url: "/v1/tools/queue_for_labeling",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        idempotency_key: "mark-region-queue",
      },
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("two marks with regions within tolerance agree and become trusted", async () => {
    const db = new Database(sqlitePath, { readonly: true });
    const people = db
      .prepare(`SELECT id, slot FROM people WHERE project_id = ? ORDER BY slot`)
      .all(projectId) as Array<{ id: string; slot: string }>;
    db.close();
    const marker1 = people.find((p) => p.slot === "marker1")!.id;
    const marker2 = people.find((p) => p.slot === "marker2")!.id;
    const token = signMarkToken(TEST_API_KEY, evalSetId);
    const base = {
      eval_set_id: evalSetId,
      eval_id: personEvalId,
      token,
      action: "submit",
      pass_fail: "pass",
      region_x: "10",
      region_y: "10",
      region_width: "40",
      region_height: "20",
    };
    const a = await app.inject({
      method: "POST",
      url: "/mark",
      headers: { "content-type": "application/json" },
      payload: { ...base, person_id: marker1 },
    });
    assert.equal(a.statusCode, 200);
    const b = await app.inject({
      method: "POST",
      url: "/mark",
      headers: { "content-type": "application/json" },
      payload: {
        ...base,
        person_id: marker2,
        region_x: "14",
        region_y: "12",
      },
    });
    assert.equal(b.statusCode, 200);
    const body = b.json() as { state: string; trusted: boolean };
    assert.equal(body.trusted, true);
    assert.equal(body.state, "trusted");
  });

  it("regions outside tolerance disagree and third screen shows both regions", async () => {
    const db = new Database(sqlitePath, { readonly: true });
    const people = db
      .prepare(`SELECT id, slot FROM people WHERE project_id = ? ORDER BY slot`)
      .all(projectId) as Array<{ id: string; slot: string }>;
    db.close();
    const marker1 = people.find((p) => p.slot === "marker1")!.id;
    const marker2 = people.find((p) => p.slot === "marker2")!.id;
    const third = people.find((p) => p.slot === "third")!.id;
    const token = signMarkToken(TEST_API_KEY, evalSetId);
    const base = {
      eval_set_id: evalSetId,
      eval_id: personEvalId,
      token,
      action: "submit",
      pass_fail: "pass",
      region_width: "40",
      region_height: "20",
    };
    await app.inject({
      method: "POST",
      url: "/mark",
      headers: { "content-type": "application/json" },
      payload: { ...base, person_id: marker1, region_x: "10", region_y: "10" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/mark",
      headers: { "content-type": "application/json" },
      payload: { ...base, person_id: marker2, region_x: "40", region_y: "10" },
    });
    const body = second.json() as { state: string; trusted: boolean };
    assert.equal(body.trusted, false);
    assert.equal(body.state, "disagree");

    const html = await app.inject({
      method: "GET",
      url: `/mark/third?eval_set_id=${encodeURIComponent(evalSetId)}&eval_id=${encodeURIComponent(personEvalId)}&token=${token}&person_id=${third}`,
    });
    assert.equal(html.statusCode, 200);
    assert.match(html.body, /<img/);
    assert.match(html.body, /region/i);
    assert.match(html.body, /10/);
    assert.match(html.body, /40/);
    assert.doesNotMatch(html.body, /form_type": "file"/);
  });

  it("mark screen shows the image and region controls, not form_type file", async () => {
    const token = signMarkToken(TEST_API_KEY, evalSetId);
    const page = await app.inject({
      method: "GET",
      url: `/mark?eval_set_id=${encodeURIComponent(evalSetId)}&token=${token}`,
    });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<img /);
    assert.match(page.body, /region_x/);
    assert.match(page.body, /region_y/);
    assert.match(page.body, /region_width/);
    assert.match(page.body, /region_height/);
    assert.doesNotMatch(page.body, /form_type": "file"/);
  });
});

describe("generate image-location job", () => {
  let app: FastifyInstance;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-gen-region-"));
    app = await createTestApp(join(dir, "evalrouter.sqlite"));
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("generate an image-location job includes region controls on the mark screen", async () => {
    const gen = await app.inject({
      method: "POST",
      url: "/v1/tools/generate_eval_suite",
      headers: authHeaders(),
      payload: {
        description:
          "Judge this invoice image and mark the bounding box where the total is",
        sample_files: [{ path: "fixtures/invoice.png", content: PNG_B64 }],
        idempotency_key: "gen-region-job",
      },
    });
    assert.equal(gen.statusCode, 200);
    const suite = gen.json() as {
      project_id: string;
      eval_set_id: string;
      n_person: number;
    };
    assert.ok(suite.n_person > 0);

    const queued = await app.inject({
      method: "POST",
      url: "/v1/tools/queue_for_labeling",
      headers: authHeaders(),
      payload: {
        project_id: suite.project_id,
        eval_set_id: suite.eval_set_id,
        idempotency_key: "gen-region-queue",
      },
    });
    assert.equal(queued.statusCode, 200);
    const token = signMarkToken(TEST_API_KEY, suite.eval_set_id);
    const page = await app.inject({
      method: "GET",
      url: `/mark?eval_set_id=${encodeURIComponent(suite.eval_set_id)}&token=${token}`,
    });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<img/);
    assert.match(page.body, /region_x/);
    assert.doesNotMatch(page.body, /form_type": "file"/);
  });
});

describe("region agreement helper", () => {
  it("compares each edge within tolerance", () => {
    const a: MarkPayload = {
      form_type: "pass_fail",
      pass_fail: "pass",
      region: { x: 0, y: 0, width: 10, height: 10 },
    };
    const b: MarkPayload = {
      form_type: "pass_fail",
      pass_fail: "pass",
      region: { x: 8, y: 0, width: 10, height: 10 },
    };
    assert.equal(
      marksAgree(a, b, { needs_region: true, region_tolerance: 8 }).agree,
      true,
    );
    assert.equal(
      marksAgree(a, b, { needs_region: true, region_tolerance: 7 }).agree,
      false,
    );
  });
});
