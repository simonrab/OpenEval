import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createLiveSdk } from "../src/live/sdk.js";
import { stickyBucket } from "../src/live/sticky.js";
import {
  signPolicy,
  type SignedPolicy,
  type UnsignedPolicy,
} from "../src/policy.js";

const evalrouterKey = "evalrouter-seal-key-not-a-secret";
const vendorKey = "sk-or-v1-app-vendor-key";
const projectId = "prj_live_sdk_l6";
const evalrouterUrl = "http://127.0.0.1:3000";
const lastFullModel = "openai/gpt-4.1-mini";
const canaryModel = "anthropic/claude-3-haiku";

function sampleUnsigned(extra?: Partial<UnsignedPolicy>): UnsignedPolicy {
  return {
    policy_id: "pol_last_full_l6",
    version: 1,
    previous_policy_id: null,
    project_id: projectId,
    rec_id: "rec_last_full_l6",
    ste_id: "ste_last_full_l6",
    compiled_at: "2026-08-26T12:00:00.000Z",
    primary: { model_id: lastFullModel, timeout_ms: 2500 },
    backups: [],
    canary: null,
    ...extra,
  };
}

function signedLastFull(): SignedPolicy {
  return signPolicy(evalrouterKey, sampleUnsigned());
}

function signedCanary(): SignedPolicy {
  return signPolicy(
    evalrouterKey,
    sampleUnsigned({
      policy_id: "pol_canary_l6",
      version: 2,
      previous_policy_id: "pol_last_full_l6",
      rec_id: "rec_canary_l6",
      primary: { model_id: canaryModel, timeout_ms: 2500 },
    }),
  );
}

function envelope(
  lastFull: SignedPolicy,
  canary: SignedPolicy | null = null,
  percent: unknown = 0,
): { last_full: SignedPolicy; canary: SignedPolicy | null; canary_percent: unknown } {
  return { last_full: lastFull, canary, canary_percent: percent };
}

function idForBucket(wantCanary: boolean): string {
  for (let i = 0; i < 20_000; i++) {
    const id = `user_${i}`;
    if ((stickyBucket(id) < 5) === wantCanary) {
      return id;
    }
  }
  throw new Error("no sticky id");
}

type FetchCall = {
  method: string;
  url: string;
  authorization: string | null;
  body: string | null;
};

function headerValue(
  headers: HeadersInit | undefined,
  name: string,
): string | null {
  if (!headers) {
    return null;
  }
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found ? found[1] : null;
  }
  const rec = headers as Record<string, string>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? null : rec[key];
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) {
    return init.method.toUpperCase();
  }
  if (typeof input !== "string" && !(input instanceof URL) && input.method) {
    return input.method.toUpperCase();
  }
  return "GET";
}

function requestBody(input: RequestInfo | URL, init?: RequestInit): string | null {
  if (typeof init?.body === "string") {
    return init.body;
  }
  if (typeof input !== "string" && !(input instanceof URL) && typeof input.body === "string") {
    return input.body;
  }
  return null;
}

function requestAuth(input: RequestInfo | URL, init?: RequestInit): string | null {
  const fromInit = headerValue(init?.headers, "authorization");
  if (fromInit) {
    return fromInit;
  }
  if (typeof input !== "string" && !(input instanceof URL)) {
    return input.headers.get("authorization");
  }
  return null;
}

function openRouterOk(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function postModel(call: FetchCall): string {
  const payload = JSON.parse(call.body ?? "{}") as { model: string };
  return payload.model;
}

describe("Live SDK canary hop (R5, R6)", () => {
  let dir: string;
  let lastKnownPath: string;
  let calls: FetchCall[];
  let policyReply: () => Response;
  let vendorReply: () => Response;
  let sdk: ReturnType<typeof createLiveSdk>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-live-sdk-l6-"));
    lastKnownPath = join(dir, "last-known.json");
    calls = [];
    policyReply = () =>
      new Response(JSON.stringify(envelope(signedLastFull())), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"etag-l6"' },
      });
    vendorReply = () => openRouterOk("ok");

    const fetchMock = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = requestUrl(input);
      const method = requestMethod(input, init);
      const authorization = requestAuth(input, init);
      const body = requestBody(input, init);
      calls.push({ method, url, authorization, body });
      if (url.startsWith("https://openrouter.ai/")) {
        return vendorReply();
      }
      if (method === "POST" && url.includes("/v1/runtime/stats")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return policyReply();
    }) as typeof fetch;

    sdk = createLiveSdk({
      projectId,
      evalrouterUrl,
      evalrouterKey,
      vendorKey,
      lastKnownPath,
      pollMs: 30_000,
      fetch: fetchMock,
    });
  });

  afterEach(() => {
    sdk.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function getCalls(): FetchCall[] {
    return calls.filter((c) => c.method === "GET");
  }

  function openRouterPosts(): FetchCall[] {
    return calls.filter(
      (c) => c.method === "POST" && c.url.startsWith("https://openrouter.ai/"),
    );
  }

  function statsPosts(): FetchCall[] {
    return calls.filter(
      (c) => c.method === "POST" && c.url.includes("/v1/runtime/stats"),
    );
  }

  it("complete with only prompt sends last full when canary is on", async () => {
    policyReply = () =>
      new Response(JSON.stringify(envelope(signedLastFull(), signedCanary(), 5)), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"etag-canary"' },
      });
    await sdk.start();
    const result = await sdk.complete({ prompt: "No hash ids." });
    assert.equal(result.model_id, lastFullModel);
    assert.equal(result.policy_id, "pol_last_full_l6");
    assert.equal(postModel(openRouterPosts()[0]), lastFullModel);
  });

  it("complete GET count does not increase, including when canary is on", async () => {
    policyReply = () =>
      new Response(JSON.stringify(envelope(signedLastFull(), signedCanary(), 5)), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"etag-canary"' },
      });
    await sdk.start();
    const getsAfterStart = getCalls().length;
    const canaryUser = idForBucket(true);
    await sdk.complete({ prompt: "Hash me.", user_id: canaryUser });
    await sdk.complete({ prompt: "No ids." });
    assert.equal(getCalls().length, getsAfterStart);
    assert.equal(statsPosts().length, 0);
  });

  it("same user_id always gets the same policy; canary slice is sticky 5 percent", async () => {
    policyReply = () =>
      new Response(JSON.stringify(envelope(signedLastFull(), signedCanary(), 5)), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"etag-canary"' },
      });
    await sdk.start();
    const canaryUser = idForBucket(true);
    const fullUser = idForBucket(false);
    const a = await sdk.complete({ prompt: "A", user_id: canaryUser });
    const b = await sdk.complete({ prompt: "B", user_id: canaryUser });
    const c = await sdk.complete({ prompt: "C", user_id: fullUser });
    const d = await sdk.complete({ prompt: "D", user_id: fullUser });
    assert.equal(a.model_id, canaryModel);
    assert.equal(b.model_id, canaryModel);
    assert.equal(a.policy_id, "pol_canary_l6");
    assert.equal(c.model_id, lastFullModel);
    assert.equal(d.model_id, lastFullModel);

    const models: string[] = [];
    for (let i = 0; i < 200; i++) {
      const result = await sdk.complete({ prompt: "mix", user_id: `mix_${i}` });
      models.push(result.model_id);
    }
    const canaryCount = models.filter((m) => m === canaryModel).length;
    assert.ok(canaryCount >= 1 && canaryCount <= 40, `canary count ${canaryCount}`);
    const stats = sdk.stats();
    assert.equal(stats.intended_percent, 5);
    assert.ok(stats.observed_percent > 0);
    assert.notEqual(stats.intended_percent, 50);
  });

  it("uses request_id when user_id is missing", async () => {
    policyReply = () =>
      new Response(JSON.stringify(envelope(signedLastFull(), signedCanary(), 5)), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"etag-canary"' },
      });
    await sdk.start();
    const canaryReq = idForBucket(true);
    const fullReq = idForBucket(false);
    const a = await sdk.complete({ prompt: "req canary", request_id: canaryReq });
    const b = await sdk.complete({ prompt: "req full", request_id: fullReq });
    assert.equal(a.model_id, canaryModel);
    assert.equal(b.model_id, lastFullModel);
  });

  it("prefers user_id over request_id", async () => {
    policyReply = () =>
      new Response(JSON.stringify(envelope(signedLastFull(), signedCanary(), 5)), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"etag-canary"' },
      });
    await sdk.start();
    const canaryUser = idForBucket(true);
    const fullReq = idForBucket(false);
    const result = await sdk.complete({
      prompt: "user wins",
      user_id: canaryUser,
      request_id: fullReq,
    });
    assert.equal(result.model_id, canaryModel);
  });

  it("missing both ids always sends last full even when canary is on", async () => {
    policyReply = () =>
      new Response(JSON.stringify(envelope(signedLastFull(), signedCanary(), 5)), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"etag-canary"' },
      });
    await sdk.start();
    for (let i = 0; i < 30; i++) {
      const result = await sdk.complete({ prompt: `no-id-${i}` });
      assert.equal(result.model_id, lastFullModel);
    }
  });

  it("percent parse fail / invalid percent uses last full, never 50", async () => {
    const cases: unknown[] = [50, 100, "5", 5.5, null, undefined];
    for (const percent of cases) {
      const localCalls: FetchCall[] = [];
      const fetchMock = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = requestUrl(input);
        const method = requestMethod(input, init);
        localCalls.push({
          method,
          url,
          authorization: requestAuth(input, init),
          body: requestBody(input, init),
        });
        if (url.startsWith("https://openrouter.ai/")) {
          return openRouterOk("ok");
        }
        const body =
          percent === undefined
            ? { last_full: signedLastFull(), canary: signedCanary() }
            : envelope(signedLastFull(), signedCanary(), percent);
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
      const local = createLiveSdk({
        projectId,
        evalrouterUrl,
        evalrouterKey,
        vendorKey,
        lastKnownPath: join(dir, `last-known-${String(percent)}.json`),
        pollMs: 30_000,
        fetch: fetchMock,
      });
      await local.start();
      const canaryUser = idForBucket(true);
      const result = await local.complete({ prompt: "no fifty", user_id: canaryUser });
      assert.equal(result.model_id, lastFullModel, `percent ${String(percent)}`);
      assert.equal(local.stats().intended_percent, 0);
      assert.notEqual(local.stats().intended_percent, 50);
      local.stop();
    }
  });

  it("after refresh to last full only, all user_ids get the new primary", async () => {
    policyReply = () =>
      new Response(JSON.stringify(envelope(signedLastFull(), signedCanary(), 5)), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"etag-canary"' },
      });
    await sdk.start();
    const canaryUser = idForBucket(true);
    const first = await sdk.complete({ prompt: "canary slice", user_id: canaryUser });
    assert.equal(first.model_id, canaryModel);

    policyReply = () =>
      new Response(JSON.stringify(envelope(signedCanary(), null, 0)), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"etag-full"' },
      });
    await sdk.start();
    const after = await sdk.complete({ prompt: "now full", user_id: canaryUser });
    const other = await sdk.complete({ prompt: "other", user_id: idForBucket(false) });
    assert.equal(after.model_id, canaryModel);
    assert.equal(after.policy_id, "pol_canary_l6");
    assert.equal(other.model_id, canaryModel);
    assert.equal(sdk.stats().intended_percent, 0);
  });

  it("rollback refresh restores last full primary for every user_id", async () => {
    policyReply = () =>
      new Response(JSON.stringify(envelope(signedCanary(), null, 0)), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"etag-promoted"' },
      });
    await sdk.start();
    policyReply = () =>
      new Response(JSON.stringify(envelope(signedLastFull(), null, 0)), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"etag-rolled"' },
      });
    await sdk.start();
    const canaryUser = idForBucket(true);
    const result = await sdk.complete({ prompt: "rolled back", user_id: canaryUser });
    assert.equal(result.model_id, lastFullModel);
    assert.equal(result.policy_id, "pol_last_full_l6");
  });

  it("uploads observed counts on the poll refresh, not on complete", async () => {
    policyReply = () =>
      new Response(JSON.stringify(envelope(signedLastFull(), signedCanary(), 5)), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"etag-canary"' },
      });
    await sdk.start();
    assert.equal(statsPosts().length, 0);
    await sdk.complete({ prompt: "hash", user_id: idForBucket(true) });
    await sdk.complete({ prompt: "hash2", user_id: idForBucket(false) });
    assert.equal(statsPosts().length, 0);
    await sdk.start();
    assert.ok(statsPosts().length >= 1);
    const payload = JSON.parse(statsPosts()[0].body ?? "{}") as {
      hashed_request_count: number;
      canary_request_count: number;
      fallback_count: number;
      request_count: number;
    };
    assert.equal(payload.hashed_request_count, 2);
    assert.equal(payload.canary_request_count, 1);
    assert.equal(payload.request_count, 2);
  });

  it("tampered canary on GET keeps last-known last full", async () => {
    await sdk.start();
    const good = signedCanary();
    const tampered: SignedPolicy = {
      ...good,
      primary: { model_id: "openai/gpt-4.1", timeout_ms: 2500 },
    };
    policyReply = () =>
      new Response(JSON.stringify(envelope(signedLastFull(), tampered, 5)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    await sdk.start();
    const result = await sdk.complete({
      prompt: "do not take tampered canary",
      user_id: idForBucket(true),
    });
    assert.equal(result.model_id, lastFullModel);
  });
});
