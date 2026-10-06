import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expandItems, parseUsage, runHarness, runOne } from "../src/harness.js";
import { FIXTURE } from "./helpers.js";

const node = JSON.stringify(process.execPath);
const cmd = (mode: string, ...args: string[]) => [node, JSON.stringify(FIXTURE), mode, ...args].join(" ");
const item = { eval_id: "ev_1", input: "input-01-x", system_prompt: "Be brief.", rep: 2 };

describe("harness runner", () => {
  it("sends the item on stdin and reads the output on stdout", async () => {
    const out = await runOne(item, { cmd: cmd("echo") });
    assert.equal(out.output, "echo ev_1 rep 2 sp Be brief.");
    assert.equal(out.error, undefined);
    assert.equal(out.eval_id, "ev_1");
    assert.equal(out.rep, 2);
    assert.ok(out.time_ms >= 0);
  });

  it("reads usage from the OPENEVAL_USAGE stderr line", async () => {
    const out = await runOne(item, { cmd: cmd("good") });
    assert.equal(out.output, "fine answer");
    assert.equal(out.cost_usd, 0.001);
    assert.equal(out.prompt_tokens, 10);
    assert.equal(out.completion_tokens, 5);
    assert.equal(out.served_model, "fake/model");
  });

  it("turns a non-zero exit into an error entry with the last stderr line", async () => {
    const out = await runOne(item, { cmd: cmd("fail") });
    assert.equal(out.output, undefined);
    assert.match(out.error!, /exit code 3/);
    assert.match(out.error!, /something broke/);
  });

  it("turns a timeout into an error entry", async () => {
    const started = Date.now();
    const out = await runOne(item, { cmd: cmd("sleep", "5000"), timeoutMs: 200 });
    assert.equal(out.output, undefined);
    assert.match(out.error!, /timed out after 200 ms/);
    assert.ok(Date.now() - started < 4000, "the runner kills the harness");
  });

  it("does not give the OpenEval keys to the harness", async () => {
    const out = await runOne(item, {
      cmd: cmd("env"),
      env: { ...process.env, OPENEVAL_KEY: "oeo_secret", OPENEVAL_ADMIN_KEY: "full_secret" },
    });
    const seen = JSON.parse(out.output!);
    assert.equal(seen.key, null);
    assert.equal(seen.admin, null);
    assert.equal(seen.eval_id, "ev_1");
    assert.equal(seen.rep, "2");
  });

  it("expands every input times every rep", () => {
    const items = expandItems(
      [
        { eval_id: "a", input: "A" },
        { eval_id: "b", input: "B" },
      ],
      3,
      null,
    );
    assert.deepEqual(
      items.map((i) => `${i.eval_id}:${i.rep}`),
      ["a:0", "a:1", "a:2", "b:0", "b:1", "b:2"],
    );
    assert.equal(items[0]!.system_prompt, null);
  });

  it("runs calls in parallel up to the concurrency and keeps the order", async () => {
    const items = expandItems(
      Array.from({ length: 4 }, (_, i) => ({ eval_id: `ev_${i}`, input: "x" })),
      2,
      null,
    );
    const started = Date.now();
    const res = await runHarness(items, { cmd: cmd("sleep", "400"), concurrency: 8 });
    const parallelMs = Date.now() - started;
    assert.equal(res.outputs.length, 8);
    assert.equal(res.stopped, false);
    assert.deepEqual(
      res.outputs.map((o) => `${o.eval_id}:${o.rep}`),
      items.map((i) => `${i.eval_id}:${i.rep}`),
    );
    // Eight calls of 400 ms one by one take 3200 ms or more.
    assert.ok(parallelMs < 2500, `parallel run took ${parallelMs} ms`);

    const seqStart = Date.now();
    await runHarness(items.slice(0, 3), { cmd: cmd("sleep", "300"), concurrency: 1 });
    assert.ok(Date.now() - seqStart >= 900, "concurrency 1 runs one call at a time");
  });

  it("stops new calls at the cost limit", async () => {
    const items = expandItems(
      Array.from({ length: 6 }, (_, i) => ({ eval_id: `ev_${i}`, input: "x" })),
      1,
      null,
    );
    const res = await runHarness(items, { cmd: cmd("costly"), concurrency: 1, costLimitUsd: 2 });
    assert.equal(res.stopped, true);
    assert.equal(res.outputs.length, 2);
    assert.equal(res.cost_usd, 2);
  });

  it("parses the last valid usage line and ignores bad lines", () => {
    const { usage, rest } = parseUsage(
      'warn one\nOPENEVAL_USAGE {"cost_usd":1}\nOPENEVAL_USAGE {"cost_usd":0.5,"prompt_tokens":-1}\nOPENEVAL_USAGE not json\n',
    );
    assert.deepEqual(usage, { cost_usd: 0.5 });
    assert.deepEqual(rest, ["warn one", "OPENEVAL_USAGE not json"]);
  });
});
