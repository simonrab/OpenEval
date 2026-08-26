import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import {
  authHeaders,
  storeCustomerKey,
  TEST_API_KEY,
  waitForRunComplete,
} from "./helpers/run-fixtures.js";

function acceptToken(evalSetId: string): string {
  return createHmac("sha256", TEST_API_KEY).update(`accept:${evalSetId}`).digest("hex");
}

const URGENT_TEXT = "Payment failed for order 8831.";
const LATER_TEXT = "Thanks for the update.";
const SYSTEM_PROMPT =
  'Classify the ticket. Return JSON {"priority":"urgent"|"later"}.';

function labeledPayload(key: string) {
  return {
    description: "Classify each support ticket as Urgent or Later.",
    system_prompt: SYSTEM_PROMPT,
    labeled_examples: [
      {
        text: URGENT_TEXT,
        label: "Urgent",
        expected: { path: "priority", value: "urgent" },
      },
      {
        text: LATER_TEXT,
        label: "Later",
        expected: { path: "priority", value: "later" },
      },
    ],
    idempotency_key: key,
  };
}

const SCORING_EXAMPLES = [
  {
    text: URGENT_TEXT,
    label: "Urgent",
    expected: { path: "priority", value: "urgent" },
  },
  {
    text: LATER_TEXT,
    label: "Later",
    expected: { path: "priority", value: "later" },
  },
  {
    text: "Cannot log in to the account.",
    label: "Urgent",
    expected: { path: "priority", value: "urgent" },
  },
  {
    text: "Happy holidays.",
    label: "Later",
    expected: { path: "priority", value: "later" },
  },
  {
    text: "Charge was declined twice.",
    label: "Urgent",
    expected: { path: "priority", value: "urgent" },
  },
] as const;

function scoringPayload(key: string) {
  return {
    description: "Classify each support ticket as Urgent or Later.",
    system_prompt: SYSTEM_PROMPT,
    labeled_examples: [...SCORING_EXAMPLES],
    idempotency_key: key,
  };
}

function expectedPriority(text: string): "urgent" | "later" {
  return /failed|log in|declined/i.test(text) ? "urgent" : "later";
}

describe("labeled examples", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-labeled-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    app = await buildApp({ sqlitePath, apiKey: TEST_API_KEY });
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("labeled_examples alone write two exam rows and no library or what-good-means rows", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/generate_eval_suite",
      headers: authHeaders(),
      payload: labeledPayload("idem-labeled-only"),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { eval_set_id: string; counts: { total: number } };
    assert.equal(body.counts.total, 2);

    const db = new Database(sqlitePath, { readonly: true });
    const rows = db
      .prepare(
        `SELECT e.title, e.input_truncated, e.form_spec, e.program_check
         FROM eval_set_members m JOIN evals e ON e.id = m.eval_id
         WHERE m.eval_set_id = ?`,
      )
      .all(body.eval_set_id) as Array<{
      title: string;
      input_truncated: string;
      form_spec: string;
      program_check: string;
    }>;
    db.close();
    assert.equal(rows.length, 2);
    const byText = new Map(rows.map((r) => [r.input_truncated, r]));
    const urgent = byText.get(URGENT_TEXT);
    const later = byText.get(LATER_TEXT);
    assert.ok(urgent);
    assert.ok(later);
    assert.doesNotMatch(
      rows.map((r) => r.title).join("\n"),
      /Behaves:|Success:|Must never:|Sample /,
    );
    const spec0 = JSON.parse(urgent?.form_spec ?? "{}") as {
      text: string;
      label: string;
    };
    assert.equal(spec0.text, URGENT_TEXT);
    assert.equal(spec0.label, "Urgent");
    const check0 = JSON.parse(urgent?.program_check ?? "{}") as {
      kind: string;
      expected: { path: string; value: string };
    };
    assert.equal(check0.kind, "field_equals");
    assert.equal(check0.expected.path, "priority");
    assert.equal(check0.expected.value, "urgent");
  });

  it("does not attach invoice library drafts when the description mentions JSON", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/generate_eval_suite",
      headers: authHeaders(),
      payload: {
        description: "Return JSON with a priority field for each ticket.",
        labeled_examples: [
          {
            text: URGENT_TEXT,
            label: "Urgent",
            expected: { path: "priority", value: "urgent" },
          },
        ],
        idempotency_key: "idem-no-invoice",
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { eval_set_id: string; counts: { total: number } };
    assert.equal(body.counts.total, 1);
    const db = new Database(sqlitePath, { readonly: true });
    const titles = db
      .prepare(
        `SELECT e.title FROM eval_set_members m JOIN evals e ON e.id = m.eval_id
         WHERE m.eval_set_id = ?`,
      )
      .all(body.eval_set_id) as Array<{ title: string }>;
    db.close();
    assert.equal(titles.some((t) => t.title.includes("line_items")), false);
  });

  it("accept screen shows the example text and the label, not a filename", async () => {
    const gen = await app.inject({
      method: "POST",
      url: "/v1/tools/generate_eval_suite",
      headers: authHeaders(),
      payload: labeledPayload("idem-accept-lines"),
    });
    const body = gen.json() as { eval_set_id: string };
    const token = acceptToken(body.eval_set_id);
    const page = await app.inject({
      method: "GET",
      url: `/accept?eval_set_id=${encodeURIComponent(body.eval_set_id)}&token=${token}`,
    });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Classify each support ticket/);
    assert.match(page.body, /Urgent/);
    assert.match(page.body, /Later/);
    assert.match(page.body, /Payment failed for order 8831/);
    assert.match(page.body, /Thanks for the update/);
    assert.doesNotMatch(page.body, /code eval/);
    assert.doesNotMatch(page.body, /Sample /);
  });

  it("stores any label string as data, not as a product type", async () => {
    const exampleText = "The card was charged twice.";
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/generate_eval_suite",
      headers: authHeaders(),
      payload: {
        description: "Classify each support ticket as Escalate or Wait.",
        labeled_examples: [
          {
            text: exampleText,
            label: "Escalate",
            expected: { path: "priority", value: "escalate" },
          },
        ],
        idempotency_key: "idem-label-is-data",
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { eval_set_id: string };
    const db = new Database(sqlitePath, { readonly: true });
    const row = db
      .prepare(
        `SELECT e.form_spec FROM eval_set_members m JOIN evals e ON e.id = m.eval_id
         WHERE m.eval_set_id = ?`,
      )
      .get(body.eval_set_id) as { form_spec: string };
    db.close();
    const spec = JSON.parse(row.form_spec) as { text: string; label: string };
    assert.equal(spec.text, exampleText);
    assert.equal(spec.label, "Escalate");

    const token = acceptToken(body.eval_set_id);
    const page = await app.inject({
      method: "GET",
      url: `/accept?eval_set_id=${encodeURIComponent(body.eval_set_id)}&token=${token}`,
    });
    assert.match(page.body, /Escalate/);
    assert.match(page.body, /The card was charged twice/);
  });
});

describe("labeled example scoring uses system prompt plus example text", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let captured: Array<{ prompt: string; systemPrompt?: string }>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-labeled-run-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    captured = [];
    app = await buildApp({
      sqlitePath,
      apiKey: TEST_API_KEY,
      openRouterClient: {
        async chatCompletion(input) {
          captured.push({
            prompt: input.prompt,
            systemPrompt: input.systemPrompt,
          });
          return {
            content: JSON.stringify({ priority: expectedPriority(input.prompt) }),
            time_ms: 8,
            cost_usd: 0.01,
          };
        },
      },
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends system_prompt and the example text, then scores the expected field", async () => {
    const gen = await app.inject({
      method: "POST",
      url: "/v1/tools/generate_eval_suite",
      headers: authHeaders(),
      payload: scoringPayload("idem-run-lines"),
    });
    const suite = gen.json() as { project_id: string; eval_set_id: string };
    const db = new Database(sqlitePath);
    const ids = db
      .prepare(
        `SELECT e.id AS eval_id FROM eval_set_members m JOIN evals e ON e.id = m.eval_id
         WHERE m.eval_set_id = ?`,
      )
      .all(suite.eval_set_id) as Array<{ eval_id: string }>;
    db.prepare(
      `UPDATE evals SET status = 'trusted' WHERE id IN (${ids.map(() => "?").join(",")})`,
    ).run(...ids.map((r) => r.eval_id));
    const keysRef = await storeCustomerKey(db, suite.project_id);
    db.close();

    const runRes = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: suite.project_id,
        eval_set_id: suite.eval_set_id,
        models: ["openai/gpt-4.1-nano"],
        max_eval_spend_usd: 1,
        keys_ref: keysRef,
        idempotency_key: "idem-run-labeled",
      },
    });
    assert.equal(runRes.statusCode, 200);
    const run = runRes.json() as { run_id: string };
    await waitForRunComplete(app, suite.project_id, run.run_id);

    assert.equal(captured.length, 5);
    assert.ok(captured.every((c) => c.systemPrompt === SYSTEM_PROMPT));
    assert.deepEqual(
      captured.map((c) => c.prompt).sort(),
      SCORING_EXAMPLES.map((e) => e.text).slice().sort(),
    );

    const resultsDb = new Database(sqlitePath, { readonly: true });
    const results = resultsDb
      .prepare("SELECT passed FROM run_results WHERE run_id = ?")
      .all(run.run_id) as Array<{ passed: number }>;
    resultsDb.close();
    assert.equal(results.length, 5);
    assert.ok(results.every((r) => r.passed === 1));
  });
});
