import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createLiveSdk } from "../src/live/sdk.js";
import { signPolicy, type UnsignedPolicy } from "../src/policy.js";
import type { ArmDelta } from "../src/live/arms.js";

const openevalKey = "openeval-seal-key-not-a-secret";
const projectId = "prj_live_sdk_arms";
const openevalUrl = "http://127.0.0.1:3000";
const policyId = "pol_live_sdk_arms";

function policy(extra?: Partial<UnsignedPolicy>) {
  return signPolicy(openevalKey, {
    policy_id: policyId,
    version: 1,
    previous_policy_id: null,
    project_id: projectId,
    rec_id: "rec_arms",
    ste_id: "ste_arms",
    compiled_at: "2026-11-01T12:00:00.000Z",
    primary: { model_id: "m/primary", timeout_ms: 2500 },
    backups: [{ model_id: "m/backup", timeout_ms: 2500 }],
    canary: null,
    live_checks: [{ kind: "json_valid", expected: true }],
    ...extra,
  });
}

type Post = { url: string; body: Record<string, unknown> };

describe("Live SDK per-policy stats", () => {
  let dir: string;
  let posts: Post[];
  let clock: number;
  let vendor: () => Response;
  let statsStatus: number;
  let sdk: ReturnType<typeof createLiveSdk>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openeval-live-sdk-arms-"));
    posts = [];
    clock = 1_000_000;
    statsStatus = 200;
    vendor = () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '{"a":1}' } }], usage: { cost: 0.002 } }),
        { status: 200 },
      );
    const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      }
      if (url.startsWith("https://openrouter.ai/")) {
        clock += 300;
        return vendor();
      }
      if (url.endsWith("/v1/runtime/stats")) {
        return new Response("{}", { status: statsStatus });
      }
      if (url.endsWith("/v1/runtime/samples")) {
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify(policy()), { status: 200 });
    }) as typeof fetch;
    sdk = createLiveSdk({
      projectId,
      openevalUrl,
      openevalKey,
      vendorKey: "sk-or-test",
      lastKnownPath: join(dir, "last-known.json"),
      pollMs: 30_000,
      fetch: fetchMock,
      now: () => clock,
    });
  });

  afterEach(() => {
    sdk.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function statsPosts(): Array<Record<string, unknown>> {
    return posts.filter((p) => p.url.endsWith("/v1/runtime/stats")).map((p) => p.body);
  }

  /** start() refreshes the policy and uploads stats. */
  async function flush(): Promise<ArmDelta[]> {
    await sdk.start();
    const last = statsPosts().at(-1);
    return (last?.arms as ArmDelta[] | undefined) ?? [];
  }

  it("sends latency, provider cost, and live check results per policy", async () => {
    await sdk.start();
    const ok = await sdk.complete({ prompt: "Give JSON." });
    assert.deepEqual(ok.failed_checks, []);
    vendor = () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), {
        status: 200,
      });
    const bad = await sdk.complete({ prompt: "Give JSON." });
    assert.equal(bad.failed_checks.length, 1);
    assert.match(bad.failed_checks[0]!, /^json_valid/);

    const arms = await flush();
    assert.equal(arms.length, 1);
    const arm = arms[0]!;
    assert.equal(arm.policy_id, policyId);
    assert.equal(arm.request_count, 2);
    assert.equal(arm.latency_count, 2);
    assert.equal(arm.latency_ms_sum, 600);
    assert.equal(arm.cost_count, 1, "only the answer with provider cost counts");
    assert.equal(arm.cost_usd_sum, 0.002);
    assert.equal(arm.quality_checked, 2);
    assert.equal(arm.quality_failed, 1);
  });

  it("sends only the change since the last upload", async () => {
    await sdk.start();
    await sdk.complete({ prompt: "one" });
    assert.equal((await flush())[0]?.request_count, 1);
    await sdk.complete({ prompt: "two" });
    await sdk.complete({ prompt: "three" });
    assert.equal((await flush())[0]?.request_count, 2);
  });

  it("keeps stats when the upload fails and sends them next time", async () => {
    await sdk.start();
    await sdk.complete({ prompt: "one" });
    statsStatus = 503;
    await flush();
    statsStatus = 200;
    await sdk.complete({ prompt: "two" });
    assert.equal((await flush())[0]?.request_count, 2);
  });

  it("counts a fallback only when the backup answers, and an error when it does not", async () => {
    await sdk.start();
    let n = 0;
    vendor = () => {
      n += 1;
      return n === 1
        ? new Response("down", { status: 503 })
        : new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 });
    };
    await sdk.complete({ prompt: "fallback" });
    vendor = () => new Response("down", { status: 503 });
    await assert.rejects(sdk.complete({ prompt: "error" }));
    const arm = (await flush())[0]!;
    assert.equal(arm.request_count, 2);
    assert.equal(arm.fallback_count, 1);
    assert.equal(arm.error_count, 1);
  });

  it("app checks and reportQuality add to the quality counts", async () => {
    sdk.stop();
    sdk = createLiveSdk({
      projectId,
      openevalUrl,
      openevalKey,
      vendorKey: "sk-or-test",
      lastKnownPath: join(dir, "last-known-2.json"),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String(input);
        if (init?.method === "POST") {
          posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        }
        if (url.startsWith("https://openrouter.ai/")) {
          return new Response(
            JSON.stringify({ choices: [{ message: { content: '{"secret":"x"}' } }] }),
            { status: 200 },
          );
        }
        if (url.endsWith("/v1/runtime/stats") || url.endsWith("/v1/runtime/samples")) {
          return new Response("{}", { status: 200 });
        }
        return new Response(JSON.stringify(policy({ live_checks: undefined })), { status: 200 });
      }) as typeof fetch,
      liveChecks: [
        { kind: "must_not_contain", expected: "secret" },
        // Tied to one example, so it never runs live.
        { kind: "field_equals", expected: { path: "a", value: 1 } },
      ],
    });
    await sdk.start();
    const result = await sdk.complete({ prompt: "p" });
    assert.equal(result.failed_checks.length, 1);
    sdk.reportQuality({ policy_id: result.policy_id, ok: true });
    const arm = (await flush())[0]!;
    assert.equal(arm.quality_checked, 2);
    assert.equal(arm.quality_failed, 1);
  });

  it("a miss held back by the PII check still counts for its policy", async () => {
    await sdk.start();
    const result = await sdk.complete({ prompt: "p" });
    await sdk.reportMiss({
      // An SSN cannot be redacted, so the sample is held back.
      prompt: "SSN 123-45-6789 stays raw.",
      output: "bad",
      policy_id: result.policy_id,
    });
    await new Promise((r) => setImmediate(r));
    const arm = (await flush())[0]!;
    assert.equal(arm.pii_blocked_miss_count, 1);
    assert.equal(
      posts.filter((p) => p.url.endsWith("/v1/runtime/samples")).length,
      0,
      "the PII sample is not sent",
    );
  });
});
