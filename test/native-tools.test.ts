import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { catalogModelFitsLimits, parseOpenRouterModels, pickDefaultModels } from "../src/runner/catalog.js";
import {
  createOpenRouterClient,
  scoredOutput,
  type ChatCompletionInput,
} from "../src/runner/openrouter.js";
import { scoreProgramCheck } from "../src/scoring/index.js";
import { scoreTrustedPersonMark } from "../src/scoring/person.js";
import { parseToolCalls } from "../src/scoring/tool-call.js";
import { buildApp } from "../src/server.js";
import {
  authHeaders,
  storeCustomerKey,
  TEST_API_KEY,
  waitForRunComplete,
} from "./helpers/run-fixtures.js";

const SEARCH_TOOL = {
  name: "search_orders",
  description: "Find orders for a customer.",
  parameters: {
    type: "object",
    properties: { order_id: { type: "string" } },
    required: ["order_id"],
  },
};
const REFUND_TOOL = { name: "refund", parameters: { type: "object", properties: { order_id: { type: "string" } } } };

function fakeFetch(body: unknown, capture: { body?: Record<string, unknown> }) {
  return (async (_url: string, init?: RequestInit) => {
    capture.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("OpenRouter client with native tools", () => {
  it("sends tools as function tools with tool_choice, and reads tool_calls", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const client = createOpenRouterClient(
      fakeFetch(
        {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "search_orders", arguments: '{"order_id":"8831"}' },
                  },
                ],
              },
            },
          ],
          usage: { cost: 0.001, prompt_tokens: 50, completion_tokens: 10 },
        },
        capture,
      ),
    );
    const res = await client.chatCompletion({
      model: "m/x",
      prompt: "Where is order 8831?",
      apiKey: "k",
      tools: [SEARCH_TOOL],
      toolChoice: "required",
    });
    assert.deepEqual(capture.body?.tools, [
      {
        type: "function",
        function: {
          name: "search_orders",
          description: "Find orders for a customer.",
          parameters: SEARCH_TOOL.parameters,
        },
      },
    ]);
    assert.equal(capture.body?.tool_choice, "required");
    assert.equal(res.content, "");
    assert.deepEqual(res.tool_calls, [{ name: "search_orders", arguments: { order_id: "8831" } }]);
    assert.deepEqual(JSON.parse(scoredOutput(res)), {
      content: null,
      tool_calls: [{ name: "search_orders", arguments: { order_id: "8831" } }],
    });
  });

  it("sends a named tool_choice and no tool fields when the job has no tools", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const client = createOpenRouterClient(
      fakeFetch({ choices: [{ message: { content: "hi" } }], usage: { cost: 0 } }, capture),
    );
    await client.chatCompletion({
      model: "m/x",
      prompt: "x",
      apiKey: "k",
      tools: [REFUND_TOOL],
      toolChoice: { name: "refund" },
    });
    assert.deepEqual(capture.body?.tool_choice, { type: "function", function: { name: "refund" } });

    const res = await client.chatCompletion({ model: "m/x", prompt: "x", apiKey: "k" });
    assert.equal("tools" in capture.body!, false);
    assert.equal("tool_choice" in capture.body!, false);
    assert.equal(scoredOutput(res), "hi");
  });
});

describe("tool call scoring", () => {
  const native = JSON.stringify({
    content: "Looking it up.",
    tool_calls: [
      { name: "search_orders", arguments: { order_id: "8831" } },
      { name: "refund", arguments: { order_id: "8831" } },
    ],
  });

  it("reads native, OpenAI, and flat tool call shapes", () => {
    assert.deepEqual(parseToolCalls(native)?.map((c) => c.name), ["search_orders", "refund"]);
    assert.deepEqual(
      parseToolCalls('{"tool_calls":[{"type":"function","function":{"name":"refund","arguments":"{\\"order_id\\":\\"1\\"}"}}]}'),
      [{ name: "refund", args: { order_id: "1" } }],
    );
    assert.deepEqual(parseToolCalls('{"name":"refund","arguments":{"order_id":"1"}}'), [
      { name: "refund", args: { order_id: "1" } },
    ]);
    assert.deepEqual(parseToolCalls('{"answer":"hi"}'), []);
    assert.equal(parseToolCalls("plain text"), null);
  });

  it("tool_args matches the named call, not only the first call", () => {
    const pass = scoreProgramCheck(native, {
      kind: "tool_args",
      expected: { name: "refund", args: { order_id: "8831" } },
    });
    assert.equal(pass.passed, true, pass.reason_short);
    const wrongArgs = scoreProgramCheck(native, {
      kind: "tool_args",
      expected: { name: "refund", args: { order_id: "1" } },
    });
    assert.equal(wrongArgs.passed, false);
    assert.equal(wrongArgs.reason_short, "order_id mismatch");
    const wrongTool = scoreProgramCheck(native, { kind: "tool_args", expected: { name: "cancel" } });
    assert.equal(wrongTool.passed, false);
    assert.match(wrongTool.reason_short, /tool name mismatch/);
  });

  it("tool_args with none passes only when the model calls no tool", () => {
    const check = { kind: "tool_args" as const, expected: { none: true } };
    assert.equal(scoreProgramCheck("Your order ships today.", check).passed, true);
    assert.equal(scoreProgramCheck('{"answer":"ships today"}', check).passed, true);
    const called = scoreProgramCheck(native, check);
    assert.equal(called.passed, false);
    assert.equal(called.reason_short, "unexpected tool call search_orders");
  });

  it("tool_name and person tool marks read native tool calls", () => {
    assert.equal(scoreProgramCheck(native, { kind: "tool_name", expected: "refund" }).passed, true);
    assert.equal(scoreProgramCheck(native, { kind: "tool_name", expected: "cancel" }).passed, false);
    const mark = JSON.stringify({ form_type: "tool", tool: { name: "refund", args: { order_id: "8831" } } });
    assert.equal(scoreTrustedPersonMark(native, mark).passed, true);
    const other = JSON.stringify({ form_type: "tool", tool: { name: "cancel", args: {} } });
    assert.equal(scoreTrustedPersonMark(native, other).reason_short, "tool name mismatch");
  });
});

describe("catalog tool support", () => {
  it("reads supported_parameters and skips models without tools for a tool job", () => {
    const catalog = parseOpenRouterModels({
      data: [
        { id: "a/tools", created: 1_740_000_000, pricing: { prompt: "0.000001", completion: "0.000001" }, supported_parameters: ["tools", "temperature"] },
        { id: "b/no-tools", created: 1_740_000_000, pricing: { prompt: "0.0000001", completion: "0.0000001" }, supported_parameters: ["temperature"] },
        { id: "c/unknown", created: 1_740_000_000, pricing: { prompt: "0.000002", completion: "0.000002" } },
      ],
    });
    assert.equal(catalog[0]!.supportsTools, true);
    assert.equal(catalog[1]!.supportsTools, false);
    assert.equal(catalog[2]!.supportsTools, undefined);
    assert.equal(catalogModelFitsLimits(catalog[1]!, { tools: [SEARCH_TOOL] }), false);
    assert.equal(catalogModelFitsLimits(catalog[1]!, {}), true);
    assert.deepEqual(
      pickDefaultModels(catalog, { tools: [SEARCH_TOOL] }).map((m) => m.id).sort(),
      ["a/tools", "c/unknown"],
    );
  });
});

describe("runs send job tools and score the native tool calls", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let captured: ChatCompletionInput[];

  const EXAMPLES = [
    { text: "Where is order 8831?", label: "Search", expected_tool_call: { name: "search_orders", args: { order_id: "8831" } } },
    { text: "Where is order 1200?", label: "Search", expected_tool_call: { name: "search_orders", args: { order_id: "1200" } } },
    { text: "Refund order 77 please.", label: "Refund", expected_tool_call: { name: "refund", args: { order_id: "77" } } },
    { text: "Refund order 91 please.", label: "Refund", expected_tool_call: { name: "refund", required: ["order_id"] } },
    { text: "Thanks, that is all.", label: "No tool", expected_tool_call: { none: true as const } },
  ];

  /** A model that calls the right tool, but reads the wrong id for order 1200. */
  function reply(prompt: string) {
    const id = /order (\d+)/.exec(prompt)?.[1];
    if (!id) {
      return { content: "You are welcome.", time_ms: 5, cost_usd: 0.001 };
    }
    const name = prompt.startsWith("Refund") ? "refund" : "search_orders";
    return {
      content: "",
      time_ms: 5,
      cost_usd: 0.001,
      tool_calls: [{ name, arguments: { order_id: id === "1200" ? "120" : id } }],
    };
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "openeval-native-tools-"));
    sqlitePath = join(dir, "openeval.sqlite");
    captured = [];
    app = await buildApp({
      sqlitePath,
      apiKey: TEST_API_KEY,
      openRouterClient: {
        async chatCompletion(input) {
          captured.push(input);
          return reply(input.prompt);
        },
      },
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function trustAndRun(evalSetId: string, projectId: string, key: string) {
    const db = new Database(sqlitePath);
    db.prepare(
      `UPDATE evals SET status = 'trusted' WHERE id IN
        (SELECT eval_id FROM eval_set_members WHERE eval_set_id = ?)`,
    ).run(evalSetId);
    const keysRef = await storeCustomerKey(db, projectId);
    db.close();
    const runRes = await app.inject({
      method: "POST",
      url: "/v1/tools/run_evals",
      headers: authHeaders(),
      payload: {
        project_id: projectId,
        eval_set_id: evalSetId,
        models: ["openai/gpt-4.1-nano"],
        reps: 1,
        max_eval_spend_usd: 1,
        keys_ref: keysRef,
        idempotency_key: key,
      },
    });
    assert.equal(runRes.statusCode, 200, runRes.body);
    const runId = (runRes.json() as { run_id: string }).run_id;
    await waitForRunComplete(app, projectId, runId);
    const rdb = new Database(sqlitePath, { readonly: true });
    const rows = rdb
      .prepare(
        `SELECT e.input_truncated AS input, r.passed, r.reason_short, r.output_truncated AS output
         FROM run_results r JOIN evals e ON e.id = r.eval_id WHERE r.run_id = ?`,
      )
      .all(runId) as Array<{ input: string; passed: number; reason_short: string; output: string | null }>;
    rdb.close();
    return rows;
  }

  it("drafts tool_args evals from labeled examples, sends the tools, and scores real calls", async () => {
    const gen = await app.inject({
      method: "POST",
      url: "/v1/tools/generate_eval_suite",
      headers: authHeaders(),
      payload: {
        description: "Answer order questions with the order tools.",
        tools: [SEARCH_TOOL, REFUND_TOOL],
        tool_choice: "auto",
        labeled_examples: EXAMPLES,
        idempotency_key: "native-tools-gen",
      },
    });
    assert.equal(gen.statusCode, 200, gen.body);
    const suite = gen.json() as { project_id: string; eval_set_id: string };

    const rows = await trustAndRun(suite.eval_set_id, suite.project_id, "native-tools-run");
    assert.equal(captured.length, 5);
    assert.ok(captured.every((c) => c.tools?.map((t) => t.name).join(",") === "search_orders,refund"));
    assert.ok(captured.every((c) => c.toolChoice === "auto"));

    const byInput = new Map(rows.map((r) => [r.input, r]));
    assert.equal(byInput.get("Where is order 8831?")?.passed, 1);
    assert.equal(byInput.get("Refund order 77 please.")?.passed, 1);
    assert.equal(byInput.get("Refund order 91 please.")?.passed, 1);
    assert.equal(byInput.get("Thanks, that is all.")?.passed, 1);
    const wrong = byInput.get("Where is order 1200?")!;
    assert.equal(wrong.passed, 0);
    assert.equal(wrong.reason_short, "order_id mismatch");
    assert.match(String(wrong.output), /"tool_calls"/);
  });

  it("uses evidence.tool_schemas as the job tools when tools is not set", async () => {
    const gen = await app.inject({
      method: "POST",
      url: "/v1/tools/generate_eval_suite",
      headers: authHeaders(),
      payload: {
        description: "Answer order questions with the order tools.",
        evidence: {
          tool_schemas: [
            { name: "search_orders", description: "Find orders.", schema: SEARCH_TOOL.parameters },
            { name: "not a valid name" },
          ],
        },
        labeled_examples: EXAMPLES,
        idempotency_key: "native-tools-evidence",
      },
    });
    assert.equal(gen.statusCode, 200, gen.body);
    const suite = gen.json() as { project_id: string; eval_set_id: string };
    await trustAndRun(suite.eval_set_id, suite.project_id, "native-tools-evidence-run");
    assert.deepEqual(captured[0]!.tools, [
      { name: "search_orders", description: "Find orders.", parameters: SEARCH_TOOL.parameters },
    ]);
    assert.equal(captured[0]!.toolChoice, undefined);
  });

  it("rejects a labeled example with both expected and expected_tool_call", async () => {
    const gen = await app.inject({
      method: "POST",
      url: "/v1/tools/generate_eval_suite",
      headers: authHeaders(),
      payload: {
        description: "x",
        labeled_examples: [
          { text: "a", label: "b", expected: { path: "x", value: 1 }, expected_tool_call: { none: true } },
        ],
        idempotency_key: "native-tools-bad",
      },
    });
    assert.equal(gen.statusCode, 400);
  });
});
