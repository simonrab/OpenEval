import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createLiveSdk } from "../src/live/sdk.js";
import {
  signPolicy,
  type SignedPolicy,
  type UnsignedPolicy,
} from "../src/policy.js";

const evalrouterKey = "evalrouter-seal-key-not-a-secret";
const vendorKey = "sk-or-v1-app-vendor-key";
const projectId = "prj_live_sdk_l3";
const evalrouterUrl = "http://127.0.0.1:3000";
const primaryModel = "openai/gpt-4.1-nano";
const backupModel = "anthropic/claude-haiku-4.5";
const backupTwoModel = "openai/gpt-4.1";

function sampleUnsigned(extra?: Partial<UnsignedPolicy>): UnsignedPolicy {
  return {
    policy_id: "pol_live_sdk_l3",
    version: 1,
    previous_policy_id: null,
    project_id: projectId,
    rec_id: "rec_live_sdk_l3",
    ste_id: "ste_live_sdk_l3",
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

function sseChunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

function hangUntilAbort(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = (): void => {
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function postModel(call: FetchCall): string {
  const payload = JSON.parse(call.body ?? "{}") as { model: string };
  return payload.model;
}

describe("Live SDK hop L3", () => {
  let dir: string;
  let lastKnownPath: string;
  let calls: FetchCall[];
  let policyReply: () => Response;
  let vendorReply: (init?: RequestInit) => Response | Promise<Response>;
  let sdk: ReturnType<typeof createLiveSdk>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-live-sdk-l3-"));
    lastKnownPath = join(dir, "last-known.json");
    calls = [];
    policyReply = () =>
      new Response(JSON.stringify(signedPolicy()), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"etag-l3"' },
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
        return vendorReply(init);
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

  it("primary 200 posts once, skips backup, and fallback_count is 0", async () => {
    await sdk.start();
    const result = await sdk.complete({ prompt: "Name the total." });
    assert.equal(result.content, "ok");
    assert.equal(result.model_id, primaryModel);
    const posts = openRouterPosts();
    assert.equal(posts.length, 1);
    assert.equal(postModel(posts[0]), primaryModel);
    assert.notEqual(postModel(posts[0]), backupModel);
    const stats = sdk.stats();
    assert.equal(stats.request_count, 1);
    assert.equal(stats.fallback_count, 0);
    assert.equal(stats.fallback_rate, 0);
  });

  it("primary 503 then backup 200 posts twice and counts a fallback", async () => {
    await sdk.start();
    const getsAfterStart = getCalls().length;
    let vendorPosts = 0;
    vendorReply = () => {
      vendorPosts += 1;
      if (vendorPosts === 1) {
        return new Response("vendor down", { status: 503 });
      }
      return openRouterOk("from-backup");
    };
    const result = await sdk.complete({ prompt: "Use the backup." });
    assert.equal(result.content, "from-backup");
    assert.equal(result.model_id, backupModel);
    assert.equal(result.policy_id, "pol_live_sdk_l3");
    const posts = openRouterPosts();
    assert.equal(posts.length, 2);
    assert.equal(postModel(posts[0]), primaryModel);
    assert.equal(postModel(posts[1]), backupModel);
    assert.equal(posts[0].authorization, `Bearer ${vendorKey}`);
    assert.equal(posts[1].authorization, `Bearer ${vendorKey}`);
    assert.equal(getCalls().length, getsAfterStart);
    const stats = sdk.stats();
    assert.equal(stats.request_count, 1);
    assert.equal(stats.fallback_count, 1);
    assert.equal(stats.fallback_rate, 1);
  });

  it("primary 429 then backup 200 retries the backup", async () => {
    await sdk.start();
    let vendorPosts = 0;
    vendorReply = () => {
      vendorPosts += 1;
      if (vendorPosts === 1) {
        return new Response("rate limit", { status: 429 });
      }
      return openRouterOk("after-429");
    };
    const result = await sdk.complete({ prompt: "Retry on 429." });
    assert.equal(result.content, "after-429");
    assert.equal(result.model_id, backupModel);
    const posts = openRouterPosts();
    assert.equal(posts.length, 2);
    assert.equal(postModel(posts[0]), primaryModel);
    assert.equal(postModel(posts[1]), backupModel);
  });

  it("primary 400 does not post the backup", async () => {
    await sdk.start();
    vendorReply = () => new Response("bad input", { status: 400 });
    await assert.rejects(() => sdk.complete({ prompt: "Do not retry 400." }));
    const posts = openRouterPosts();
    assert.equal(posts.length, 1);
    assert.equal(postModel(posts[0]), primaryModel);
    const stats = sdk.stats();
    assert.equal(stats.request_count, 1);
    assert.equal(stats.fallback_count, 0);
  });

  it(
    "timeout before first token tries the backup",
    { timeout: 5000 },
    async () => {
      policyReply = () =>
        new Response(
          JSON.stringify(
            signedPolicy({
              primary: { model_id: primaryModel, timeout_ms: 40 },
              backups: [{ model_id: backupModel, timeout_ms: 2000 }],
            }),
          ),
          {
            status: 200,
            headers: { "content-type": "application/json", etag: '"etag-timeout"' },
          },
        );
      let vendorPosts = 0;
      vendorReply = (init) => {
        vendorPosts += 1;
        if (vendorPosts === 1) {
          return hangUntilAbort(init?.signal);
        }
        return openRouterOk("after-timeout");
      };
      await sdk.start();
      const result = await sdk.complete({ prompt: "Abort then backup." });
      assert.equal(result.content, "after-timeout");
      assert.equal(result.model_id, backupModel);
      const posts = openRouterPosts();
      assert.equal(posts.length, 2);
      assert.equal(postModel(posts[0]), primaryModel);
      assert.equal(postModel(posts[1]), backupModel);
      const stats = sdk.stats();
      assert.equal(stats.fallback_count, 1);
    },
  );

  it(
    "stream error after the first token does not post a backup",
    { timeout: 5000 },
    async () => {
      await sdk.start();
      const encoder = new TextEncoder();
      let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
      vendorReply = () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
              controller.enqueue(encoder.encode(sseChunk("Hi")));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      const iter = sdk.completeStream({ prompt: "One answer only." })[
        Symbol.asyncIterator
      ]();
      const first = await Promise.race([
        iter.next(),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error("SDK held the stream until the full body"));
          }, 1000);
        }),
      ]);
      assert.equal(first.done, false);
      assert.equal(first.value?.content, "Hi");
      streamController!.error(new Error("vendor drop"));
      await assert.rejects(() => iter.next());
      const posts = openRouterPosts();
      assert.equal(posts.length, 1);
      assert.equal(postModel(posts[0]), primaryModel);
      const payload = JSON.parse(posts[0].body ?? "{}") as { stream?: boolean };
      assert.equal(payload.stream, true);
      const stats = sdk.stats();
      assert.equal(stats.request_count, 1);
      assert.equal(stats.fallback_count, 0);
    },
  );

  it("two backups on the policy: only the first backup is tried", async () => {
    policyReply = () =>
      new Response(
        JSON.stringify(
          signedPolicy({
            backups: [
              { model_id: backupModel, timeout_ms: 2500 },
              { model_id: backupTwoModel, timeout_ms: 2500 },
            ],
          }),
        ),
        {
          status: 200,
          headers: { "content-type": "application/json", etag: '"etag-two"' },
        },
      );
    vendorReply = () => new Response("vendor down", { status: 503 });
    await sdk.start();
    await assert.rejects(() => sdk.complete({ prompt: "One backup only." }));
    const posts = openRouterPosts();
    assert.equal(posts.length, 2);
    assert.equal(postModel(posts[0]), primaryModel);
    assert.equal(postModel(posts[1]), backupModel);
    assert.equal(
      posts.some((p) => postModel(p) === backupTwoModel),
      false,
    );
  });

  it("empty backups plus 5xx returns the error after one POST", async () => {
    policyReply = () =>
      new Response(JSON.stringify(signedPolicy({ backups: [] })), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"etag-none"' },
      });
    vendorReply = () => new Response("vendor down", { status: 503 });
    await sdk.start();
    await assert.rejects(() => sdk.complete({ prompt: "No backup list." }));
    const posts = openRouterPosts();
    assert.equal(posts.length, 1);
    assert.equal(postModel(posts[0]), primaryModel);
    const stats = sdk.stats();
    assert.equal(stats.request_count, 1);
    assert.equal(stats.fallback_count, 0);
  });

  it("fallback_rate is fallback_count divided by request_count", async () => {
    await sdk.start();
    await sdk.complete({ prompt: "Primary ok." });
    let vendorPosts = 0;
    vendorReply = () => {
      vendorPosts += 1;
      if (vendorPosts === 1) {
        return new Response("vendor down", { status: 503 });
      }
      return openRouterOk("from-backup");
    };
    await sdk.complete({ prompt: "Need backup." });
    const stats = sdk.stats();
    assert.equal(stats.request_count, 2);
    assert.equal(stats.fallback_count, 1);
    assert.equal(stats.fallback_rate, 0.5);
  });

  it("complete() still does not GET after a backup hop", async () => {
    await sdk.start();
    const getsAfterStart = getCalls().length;
    let vendorPosts = 0;
    vendorReply = () => {
      vendorPosts += 1;
      if (vendorPosts === 1) {
        return new Response("vendor down", { status: 503 });
      }
      return openRouterOk("from-backup");
    };
    await sdk.complete({ prompt: "No control plane on the request." });
    assert.equal(getCalls().length, getsAfterStart);
    assert.equal(openRouterPosts().length, 2);
  });

  it("complete() and completeStream() send prompt bytes unchanged", async () => {
    await sdk.start();
    const prompt = 'Keep these bytes: <raw>&"\nInvoice 42';
    let vendorPosts = 0;
    vendorReply = () => {
      vendorPosts += 1;
      if (vendorPosts === 1) {
        return new Response("vendor down", { status: 503 });
      }
      return openRouterOk("from-backup");
    };
    await sdk.complete({ prompt });
    const jsonPosts = openRouterPosts();
    assert.equal(jsonPosts.length, 2);
    for (const post of jsonPosts) {
      const payload = JSON.parse(post.body ?? "{}") as {
        messages: Array<{ role: string; content: string }>;
      };
      assert.equal(payload.messages.length, 1);
      assert.equal(payload.messages[0].role, "user");
      assert.equal(payload.messages[0].content, prompt);
      assert.equal(post.body?.includes(JSON.stringify(prompt)), true);
    }

    const encoder = new TextEncoder();
    vendorReply = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(sseChunk("tok")));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    const streamPrompt = "Stream prompt unchanged.";
    const tokens: string[] = [];
    for await (const token of sdk.completeStream({ prompt: streamPrompt })) {
      tokens.push(token.content);
    }
    assert.deepEqual(tokens, ["tok"]);
    const streamPost = openRouterPosts()[2];
    const streamPayload = JSON.parse(streamPost.body ?? "{}") as {
      messages: Array<{ role: string; content: string }>;
      stream?: boolean;
    };
    assert.equal(streamPayload.messages[0].content, streamPrompt);
    assert.equal(streamPayload.stream, true);
    assert.equal(getCalls().length, 1);
  });

  it(
    "yields stream tokens as mock chunks arrive, not after the full body",
    { timeout: 5000 },
    async () => {
      await sdk.start();
      const encoder = new TextEncoder();
      let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
      vendorReply = () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      const iter = sdk.completeStream({ prompt: "Pass tokens through." })[
        Symbol.asyncIterator
      ]();
      const firstPromise = Promise.race([
        iter.next(),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error("SDK held the stream until the full body"));
          }, 1000);
        }),
      ]);
      const waitStart = Date.now();
      while (streamController === undefined) {
        if (Date.now() - waitStart > 1000) {
          throw new Error("vendor stream did not start");
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      streamController.enqueue(encoder.encode(sseChunk("Hello")));
      const first = await firstPromise;
      assert.equal(first.done, false);
      assert.equal(first.value?.content, "Hello");
      assert.equal(first.value?.model_id, primaryModel);
      streamController.enqueue(encoder.encode(sseChunk(" world")));
      streamController.enqueue(encoder.encode("data: [DONE]\n\n"));
      streamController.close();
      const second = await iter.next();
      assert.equal(second.value?.content, " world");
      const done = await iter.next();
      assert.equal(done.done, true);
      assert.equal(openRouterPosts().length, 1);
    },
  );
});
