import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { buildDraftPlan, type DraftPlanInput } from "../src/archetypes/drafts.js";
import { BUILTIN_ARCHETYPE_IDS } from "../src/archetypes/registry.js";
import { openDb } from "../src/db.js";
import {
  acceptToken,
  authHeaders,
  createTestApp,
  storeCustomerKey,
  waitForRunComplete,
} from "./helpers/run-fixtures.js";

describe("archetype generate", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-archetype-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    app = await createTestApp(sqlitePath);
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses supplied schema fields for generic JSON and does not inject invoice fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/generate_eval_suite",
      headers: authHeaders(),
      payload: {
        description: "Return JSON for a support route.",
        archetype_ids: ["output_contract"],
        evidence: {
          schemas: [
            {
              name: "route_response",
              fields: ["label", "reason", "totalCents"],
              schema: {
                type: "object",
                required: ["label", "reason", "totalCents"],
                properties: {
                  label: { type: "string" },
                  reason: { type: "string" },
                  totalCents: { type: "number" },
                },
              },
            },
          ],
        },
        idempotency_key: "generic-json-schema",
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      eval_set_id: string;
      registry_version: string;
      archetype_ids_used: string[];
    };
    assert.equal(body.registry_version, "evalrouter-archetypes-v1");
    assert.ok(body.archetype_ids_used.includes("output_contract"));

    const db = new Database(sqlitePath, { readonly: true });
    try {
      const evalRows = db
        .prepare(
          `SELECT e.title, e.archetype_id, e.scorer_primitive, e.program_check
           FROM eval_set_members m
           JOIN evals e ON e.id = m.eval_id
           WHERE m.eval_set_id = ?`,
        )
        .all(body.eval_set_id) as Array<{
        title: string;
        archetype_id: string | null;
        scorer_primitive: string | null;
        program_check: string | null;
      }>;
      assert.ok(evalRows.some((row) => row.title.includes("label")));
      assert.ok(evalRows.some((row) => row.title.includes("reason")));
      assert.ok(evalRows.some((row) => row.title.includes("totalCents")));
      assert.ok(evalRows.every((row) => !row.title.includes("line_items")));
      assert.ok(evalRows.every((row) => row.archetype_id === "output_contract"));
      assert.ok(evalRows.some((row) => row.scorer_primitive === "json_schema"));
      assert.ok(
        evalRows
          .map((row) => row.program_check)
          .filter((check): check is string => check != null)
          .some((check) => check.includes('"path":"totalCents"')),
      );

      const job = db
        .prepare(
          `SELECT j.registry_version, j.archetype_plan
           FROM eval_sets s JOIN jobs j ON j.id = s.job_id
           WHERE s.id = ?`,
        )
        .get(body.eval_set_id) as {
        registry_version: string | null;
        archetype_plan: string | null;
      };
      assert.equal(job.registry_version, "evalrouter-archetypes-v1");
      assert.match(job.archetype_plan ?? "", /output_contract/);
    } finally {
      db.close();
    }
  });

  it("labeled examples can create classification route evals from caller labels", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/generate_eval_suite",
      headers: authHeaders(),
      payload: {
        archetype_ids: ["classification_route"],
        labeled_examples: [
          {
            text: "The refund has not arrived.",
            label: "billing",
            expected: { path: "label", value: "billing" },
          },
        ],
        idempotency_key: "route-labels",
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json() as { eval_set_id: string; archetype_ids_used: string[] };
    assert.deepEqual(body.archetype_ids_used, ["classification_route"]);

    const db = new Database(sqlitePath, { readonly: true });
    try {
      const row = db
        .prepare(
          `SELECT e.archetype_id, e.program_check
           FROM eval_set_members m
           JOIN evals e ON e.id = m.eval_id
           WHERE m.eval_set_id = ?`,
        )
        .get(body.eval_set_id) as {
        archetype_id: string | null;
        program_check: string;
      };
      assert.equal(row.archetype_id, "classification_route");
      const check = JSON.parse(row.program_check) as {
        kind: string;
        expected: { path: string; value: string };
      };
      assert.equal(check.kind, "field_equals");
      assert.equal(check.expected.path, "label");
      assert.equal(check.expected.value, "billing");
    } finally {
      db.close();
    }
  });

  it("preserves archetype metadata through generate, accept, run, and report", async () => {
    const gen = await app.inject({
      method: "POST",
      url: "/v1/tools/generate_eval_suite",
      headers: authHeaders(),
      payload: {
        description: "Return JSON for a support route.",
        archetype_ids: ["output_contract"],
        evidence: {
          schemas: [
            {
              fields: ["label", "reason"],
              schema: {
                type: "object",
                required: ["label", "reason"],
                properties: {
                  label: { type: "string" },
                  reason: { type: "string" },
                },
              },
            },
          ],
        },
        idempotency_key: "metadata-run-gen",
      },
    });
    assert.equal(gen.statusCode, 200);
    const suite = gen.json() as { project_id: string; eval_set_id: string };

    const db = new Database(sqlitePath);
    const rows = db
      .prepare(
        `SELECT e.id AS eval_id
         FROM eval_set_members m
         JOIN evals e ON e.id = m.eval_id
         WHERE m.eval_set_id = ? AND e.score_how = 'code'`,
      )
      .all(suite.eval_set_id) as Array<{ eval_id: string }>;
    const keysRef = await storeCustomerKey(db, suite.project_id);
    db.close();

    const accepted = await app.inject({
      method: "POST",
      url: "/accept",
      headers: { "content-type": "application/json" },
      payload: {
        eval_set_id: suite.eval_set_id,
        token: acceptToken(suite.eval_set_id),
        accept: rows.map((row) => row.eval_id),
        reject: [],
      },
    });
    assert.equal(accepted.statusCode, 200);

    const run = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: suite.project_id,
        eval_set_id: suite.eval_set_id,
        models: ["provider/model"],
        max_eval_spend_usd: 5,
        keys_ref: keysRef,
        idempotency_key: "metadata-run",
      },
    });
    assert.equal(run.statusCode, 200);
    const report = await waitForRunComplete(
      app,
      suite.project_id,
      (run.json() as { run_id: string }).run_id,
    );
    const items = report.items as Array<{
      archetype_id: string | null;
      scorer_primitive: string | null;
    }>;
    assert.ok(items.length > 0);
    assert.ok(items.every((item) => item.archetype_id === "output_contract"));
    assert.ok(items.some((item) => item.scorer_primitive === "json_schema"));
  });
});

describe("archetype planner", () => {
  it("can draft each draftable built-in archetype when evidence exists", () => {
    const cases: Record<string, DraftPlanInput> = {
      output_contract: {
        description: "Return JSON.",
        evidence: { schemas: [{ fields: ["label"] }] },
      },
      extraction_transform: {
        description: "Extract named fields vendor and amount from text.",
      },
      classification_route: {
        description: "Classify the message.",
        evidence: { labels: ["billing", "support"] },
      },
      tool_call: {
        description: "Call the search tool.",
        evidence: { tool_schemas: [{ name: "search" }] },
      },
      tool_result_use: {
        description: "Use returned data from the tool result.",
        evidence: { schemas: [{ fields: ["status"] }] },
      },
      rag_retrieval: {
        description: "Retrieve source context.",
        evidence: { source_docs: [{ id: "policy", text: "Refunds are 30 days." }] },
      },
      grounded_answer: {
        description: "Answer from the source.",
        evidence: { source_docs: [{ id: "policy", text: "Refunds are 30 days." }] },
      },
      citation_quality: {
        description: "Cite the source id.",
        evidence: { source_docs: [{ id: "policy", text: "Refunds are 30 days." }] },
      },
      math_exact: {
        description: "Calculate the total.",
        evidence: { user_notes: ["expected 42"] },
      },
      code_functional: {
        description: "Return code.",
        sample_files: [{ path: "fixtures/check.sh", content: "exit 0" }],
      },
      conversation_task: {
        description: "Resolve a support conversation.",
      },
      agent_trajectory: {
        description: "Use required steps.",
        evidence: { trace_summaries: [{ text: "tool then answer", steps: ["tool"] }] },
      },
      safety_policy: {
        description: "Follow the safety policy.",
        what_good_means: {
          how_it_should_behave: "answer safely",
          success: "safe completion",
          must_never: "secret token",
        },
      },
      fairness_invariance: {
        description: "Check invariant paired examples.",
        evidence: { schemas: [{ fields: ["a.route", "b.route"] }] },
      },
    };

    for (const id of BUILTIN_ARCHETYPE_IDS) {
      if (id === "cost_latency_fit") {
        continue;
      }
      const plan = buildDraftPlan({ ...cases[id], archetype_ids: [id] });
      assert.equal(plan.ok, true, id);
      if (!plan.ok) {
        continue;
      }
      assert.ok(plan.drafts.length > 0, id);
      assert.ok(plan.archetypeIdsUsed.includes(id), id);
    }
  });

  it("keeps cost latency fit as run metadata with no fake eval row", () => {
    const plan = buildDraftPlan({
      description: "Use the cheapest fast model.",
      archetype_ids: ["cost_latency_fit"],
      limits: { max_wait_ms: 1000, max_spend_usd_per_1k: 1 },
    });
    assert.equal(plan.ok, true);
    if (!plan.ok) {
      return;
    }
    assert.deepEqual(plan.drafts, []);
    assert.deepEqual(plan.archetypeIdsUsed, ["cost_latency_fit"]);
  });
});

describe("archetype migration", () => {
  it("adds metadata columns to an existing SQLite file", () => {
    const dir = mkdtempSync(join(tmpdir(), "evalrouter-migrate-archetype-"));
    const sqlitePath = join(dir, "evalrouter.sqlite");
    try {
      const legacy = new Database(sqlitePath);
      legacy.exec(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          description TEXT NOT NULL,
          limits TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE evals (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          score_how TEXT NOT NULL,
          status TEXT NOT NULL,
          program_check TEXT,
          input_truncated TEXT,
          form_type TEXT,
          form_spec TEXT,
          draft_mark TEXT,
          trusted_mark TEXT,
          created_at TEXT NOT NULL
        );
      `);
      legacy.close();

      const db = openDb(sqlitePath);
      const jobCols = db.pragma("table_info(jobs)") as Array<{ name: string }>;
      const evalCols = db.pragma("table_info(evals)") as Array<{ name: string }>;
      db.close();
      assert.ok(jobCols.some((col) => col.name === "registry_version"));
      assert.ok(jobCols.some((col) => col.name === "archetype_plan"));
      assert.ok(evalCols.some((col) => col.name === "archetype_id"));
      assert.ok(evalCols.some((col) => col.name === "scorer_primitive"));
      assert.ok(evalCols.some((col) => col.name === "evidence_json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
