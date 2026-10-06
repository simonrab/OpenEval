import assert from "node:assert/strict";
import { inspect } from "node:util";
import { describe, it } from "node:test";
import { isOptimizerKey, OpenEvalClient, OpenEvalError } from "../src/client.js";
import { fetchAllInputs } from "../src/ops.js";
import { fakeOpenEval, OPT_KEY } from "./helpers.js";

describe("OpenEvalClient", () => {
  it("posts JSON to /v1/tools/{name} with a bearer key", async () => {
    const fake = fakeOpenEval({ get_verdict: () => ({ body: { verdict: "keep" } }) });
    const client = new OpenEvalClient({ url: "http://oe.test/", key: OPT_KEY, fetch: fake.fetch });
    const res = await client.tool<{ verdict: string }>("get_verdict", { project_id: "prj_1" });
    assert.equal(res.verdict, "keep");
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0]!.path, "/v1/tools/get_verdict");
    assert.equal(fake.calls[0]!.auth, `Bearer ${OPT_KEY}`);
    assert.deepEqual(fake.calls[0]!.body, { project_id: "prj_1" });
  });

  it("turns an agent error into OpenEvalError with code and status", async () => {
    const fake = fakeOpenEval({
      compile_policy: () => ({
        status: 403,
        body: { code: "SCOPE_FORBIDDEN", message: "An optimizer key cannot call compile_policy." },
      }),
    });
    const client = new OpenEvalClient({ url: "http://oe.test", key: OPT_KEY, fetch: fake.fetch });
    await assert.rejects(client.tool("compile_policy", {}), (err: unknown) => {
      assert.ok(err instanceof OpenEvalError);
      assert.equal(err.status, 403);
      assert.equal(err.code, "SCOPE_FORBIDDEN");
      assert.ok(!err.message.includes(OPT_KEY));
      return true;
    });
  });

  it("does not show the key in inspect or JSON output", () => {
    const client = new OpenEvalClient({ url: "http://oe.test", key: OPT_KEY });
    assert.ok(!inspect(client).includes(OPT_KEY));
    assert.ok(!JSON.stringify(client).includes(OPT_KEY));
  });

  it("reports a transport error without the key", async () => {
    const client = new OpenEvalClient({
      url: "http://oe.test",
      key: OPT_KEY,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await assert.rejects(client.tool("get_eval_inputs", {}), (err: unknown) => {
      assert.ok(err instanceof OpenEvalError);
      assert.equal(err.status, 0);
      assert.match(err.message, /Cannot connect/);
      assert.ok(!err.message.includes(OPT_KEY));
      return true;
    });
  });

  it("knows the optimizer key prefix", () => {
    assert.equal(isOptimizerKey("oeo_abc"), true);
    assert.equal(isOptimizerKey("sk-full"), false);
  });
});

describe("fetchAllInputs", () => {
  it("reads every page with the cursor", async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ eval_id: `ev_${i}`, input: `in ${i}` }));
    const fake = fakeOpenEval({
      get_eval_inputs: (body) => {
        const offset = body.cursor ? Number(body.cursor) : 0;
        const limit = Number(body.limit);
        const page = all.slice(offset, offset + limit);
        const next = offset + page.length < all.length ? String(offset + page.length) : null;
        return {
          body: {
            eval_set_id: "ste_1",
            eval_set_version: 1,
            system_prompt: "Be brief.",
            n_evals: all.length,
            inputs: page,
            next_cursor: next,
            truncated: next !== null,
          },
        };
      },
    });
    const client = new OpenEvalClient({ url: "http://oe.test", key: OPT_KEY, fetch: fake.fetch });
    const res = await fetchAllInputs(client, "prj_1", "ste_1", 2);
    assert.deepEqual(res.inputs, all);
    assert.equal(res.system_prompt, "Be brief.");
    assert.equal(fake.calls.length, 3);
    assert.equal(fake.calls[0]!.body.cursor, undefined);
    assert.equal(fake.calls[1]!.body.cursor, "2");
    assert.equal(fake.calls[2]!.body.cursor, "4");
    assert.deepEqual(
      fake.calls.map((c) => [c.body.project_id, c.body.eval_set_id, c.body.limit]),
      [
        ["prj_1", "ste_1", 2],
        ["prj_1", "ste_1", 2],
        ["prj_1", "ste_1", 2],
      ],
    );
  });
});
