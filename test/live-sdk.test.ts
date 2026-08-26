import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createLiveSdk } from "../src/live/sdk.js";
import {
  signPolicy,
  verifyPolicy,
  type SignedPolicy,
  type UnsignedPolicy,
} from "../src/policy.js";
import { ErrorCode } from "../src/tools/types.js";

const evalrouterKey = "evalrouter-seal-key-not-a-secret";
const vendorKey = "sk-or-v1-app-vendor-key";
const projectId = "prj_live_sdk";
const evalrouterUrl = "http://127.0.0.1:3000";
const primaryModel = "openai/gpt-4.1-nano";
const backupModel = "anthropic/claude-haiku-4.5";
const otherModel = "openai/gpt-4.1";

function sampleUnsigned(extra?: Partial<UnsignedPolicy>): UnsignedPolicy {
  return {
    policy_id: "pol_live_sdk_1",
    version: 1,
    previous_policy_id: null,
    project_id: projectId,
    rec_id: "rec_live_sdk",
    ste_id: "ste_live_sdk",
    compiled_at: "2026-08-26T12:00:00.000Z",
    primary: { model_id: primaryModel, timeout_ms: 2500 },
    backups: [{ model_id: backupModel, timeout_ms: 2500 }],
    canary: null,
    ...extra,
  };
}

function signedPolicy(extra?: Partial<UnsignedPolicy>): SignedPolicy {
  return signPolicy(evalrouterKey, sampleUnsigned(extra));
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

describe("Live SDK hop", () => {
  let dir: string;
  let lastKnownPath: string;
  let calls: FetchCall[];
  let policyReply: () => Response;
  let vendorReply: () => Response;
  let sdk: ReturnType<typeof createLiveSdk>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-live-sdk-"));
    lastKnownPath = join(dir, "last-known.json");
    calls = [];
    policyReply = () =>
      new Response(JSON.stringify(signedPolicy()), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"etag-1"' },
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

  function postCalls(): FetchCall[] {
    return calls.filter((c) => c.method === "POST");
  }

  function openRouterPosts(): FetchCall[] {
    return postCalls().filter((c) => c.url.startsWith("https://openrouter.ai/"));
  }

  it("start() with a signed 200 policy then complete() posts the primary with the vendor key", async () => {
    await sdk.start();
    const result = await sdk.complete({ prompt: "Name the total." });

    assert.equal(result.content, "ok");
    assert.equal(result.model_id, primaryModel);
    assert.equal(result.policy_id, "pol_live_sdk_1");

    const gets = getCalls();
    assert.equal(gets.length, 1);
    assert.equal(
      gets[0].url,
      `${evalrouterUrl}/v1/runtime/policies/${projectId}`,
    );
    assert.equal(gets[0].authorization, `Bearer ${evalrouterKey}`);

    const posts = openRouterPosts();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(posts[0].authorization, `Bearer ${vendorKey}`);
    assert.notEqual(posts[0].authorization, `Bearer ${evalrouterKey}`);
    const payload = JSON.parse(posts[0].body ?? "{}") as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    assert.equal(payload.model, primaryModel);
    assert.notEqual(payload.model, backupModel);

    const saved = JSON.parse(readFileSync(lastKnownPath, "utf8")) as SignedPolicy;
    assert.equal(verifyPolicy(evalrouterKey, saved), true);
    assert.equal(saved.primary.model_id, primaryModel);
  });

  it("complete() does not call GET", async () => {
    await sdk.start();
    const getsAfterStart = getCalls().length;
    const postsAfterStart = openRouterPosts().length;
    await sdk.complete({ prompt: "Score this invoice." });
    assert.equal(getCalls().length, getsAfterStart);
    assert.equal(openRouterPosts().length, postsAfterStart + 1);
  });

  it("GET 500 after a good start still uses last-known primary", async () => {
    await sdk.start();
    policyReply = () => new Response("control plane down", { status: 500 });
    await sdk.start();
    const result = await sdk.complete({ prompt: "Keep last-known." });
    assert.equal(result.model_id, primaryModel);
    assert.equal(result.policy_id, "pol_live_sdk_1");
    const posts = openRouterPosts();
    assert.equal(posts.length, 1);
    const payload = JSON.parse(posts[0].body ?? "{}") as { model: string };
    assert.equal(payload.model, primaryModel);
  });

  it("keeps previous last-known when GET body seal fails", async () => {
    await sdk.start();
    const good = signedPolicy();
    const tampered: SignedPolicy = {
      ...good,
      primary: { model_id: otherModel, timeout_ms: 2500 },
    };
    assert.equal(verifyPolicy(evalrouterKey, tampered), false);
    policyReply = () =>
      new Response(JSON.stringify(tampered), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    await sdk.start();
    const result = await sdk.complete({ prompt: "Do not take tampered bytes." });
    assert.equal(result.model_id, primaryModel);
    assert.notEqual(result.model_id, otherModel);
    const payload = JSON.parse(openRouterPosts()[0].body ?? "{}") as {
      model: string;
    };
    assert.equal(payload.model, primaryModel);
    const saved = JSON.parse(readFileSync(lastKnownPath, "utf8")) as SignedPolicy;
    assert.equal(saved.primary.model_id, primaryModel);
    assert.equal(verifyPolicy(evalrouterKey, saved), true);
  });

  it("start() with an empty file and GET 404 fails; complete must not send", async () => {
    writeFileSync(lastKnownPath, "");
    policyReply = () =>
      new Response(
        JSON.stringify({ code: ErrorCode.NO_LAST_KNOWN_POLICY }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    await assert.rejects(
      () => sdk.start(),
      (err: unknown) => {
        assert.equal((err as { code: string }).code, ErrorCode.NO_LAST_KNOWN_POLICY);
        return true;
      },
    );
    await assert.rejects(
      () => sdk.complete({ prompt: "Must not send." }),
      (err: unknown) => {
        assert.equal((err as { code: string }).code, ErrorCode.NO_LAST_KNOWN_POLICY);
        return true;
      },
    );
    assert.equal(openRouterPosts().length, 0);
  });

  it("corrupt last-known file at start plus GET 404 fails and does not send", async () => {
    writeFileSync(lastKnownPath, "{not-json");
    policyReply = () =>
      new Response(
        JSON.stringify({ code: ErrorCode.NO_LAST_KNOWN_POLICY }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    await assert.rejects(
      () => sdk.start(),
      (err: unknown) => {
        assert.equal((err as { code: string }).code, ErrorCode.NO_LAST_KNOWN_POLICY);
        return true;
      },
    );
    await assert.rejects(() => sdk.complete({ prompt: "Must not send." }));
    assert.equal(openRouterPosts().length, 0);
  });

  it("vendor 5xx on primary and backup returns the error to the app", async () => {
    await sdk.start();
    vendorReply = () => new Response("vendor down", { status: 503 });
    await assert.rejects(() => sdk.complete({ prompt: "All models fail." }));
    const posts = openRouterPosts();
    assert.equal(posts.length, 2);
    const models = posts.map((p) => {
      const payload = JSON.parse(p.body ?? "{}") as { model: string };
      return payload.model;
    });
    assert.equal(models[0], primaryModel);
    assert.equal(models[1], backupModel);
  });

  it("sends prompt bytes unchanged in the OpenRouter body", async () => {
    await sdk.start();
    const prompt = 'Keep these bytes: <raw>&"\nInvoice 42';
    await sdk.complete({ prompt });
    const posts = openRouterPosts();
    assert.equal(posts.length, 1);
    const payload = JSON.parse(posts[0].body ?? "{}") as {
      messages: Array<{ role: string; content: string }>;
    };
    assert.equal(payload.messages.length, 1);
    assert.equal(payload.messages[0].role, "user");
    assert.equal(payload.messages[0].content, prompt);
    assert.equal(posts[0].body?.includes(JSON.stringify(prompt)), true);
  });
});
