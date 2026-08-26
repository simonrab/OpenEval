import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createLiveSdk } from "../src/live/sdk.js";
import { INPUT_TRUNCATE } from "../src/eval-set.js";
import { signPolicy, type SignedPolicy, type UnsignedPolicy } from "../src/policy.js";
import { ErrorCode } from "../src/tools/types.js";

const evalrouterKey = "evalrouter-seal-key-not-a-secret";
const vendorKey = "sk-or-v1-app-vendor-key";
const projectId = "prj_live_sdk_l4";
const evalrouterUrl = "http://127.0.0.1:3000";
const primaryModel = "openai/gpt-4.1-nano";
const backupModel = "anthropic/claude-haiku-4.5";
const ingestUrl = `${evalrouterUrl}/v1/runtime/samples`;

function sampleUnsigned(extra?: Partial<UnsignedPolicy>): UnsignedPolicy {
  return {
    policy_id: "pol_live_sdk_l4",
    version: 1,
    previous_policy_id: null,
    project_id: projectId,
    rec_id: "rec_live_sdk_l4",
    ste_id: "ste_live_sdk_l4",
    compiled_at: "2026-08-26T12:00:00.000Z",
    primary: { model_id: primaryModel, timeout_ms: 2500 },
    backups: [],
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

type SampleBody = {
  sample_id: string;
  project_id: string;
  policy_id: string;
  model_id: string;
  why: string;
  input_redacted: string;
  output_redacted: string;
  captured_at: string;
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

async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 1500) {
    if (pred()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out: ${label}`);
}

function parseSample(body: string | null): SampleBody {
  return JSON.parse(body ?? "{}") as SampleBody;
}

describe("Live SDK samples R3", () => {
  let dir: string;
  let lastKnownPath: string;
  let spoolPath: string;
  let calls: FetchCall[];
  let ingestPosts: FetchCall[];
  let policyReply: () => Response | Promise<Response>;
  let vendorReply: (init?: RequestInit) => Response | Promise<Response>;
  let ingestReply: () => Response | Promise<Response>;
  let evalrouterDown: boolean;
  let ingestHold: Promise<void> | null;
  let ingestFinished: boolean;
  let sdk: ReturnType<typeof createLiveSdk>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-live-sdk-l4-"));
    lastKnownPath = join(dir, "last-known.json");
    spoolPath = join(dir, "spool");
    calls = [];
    ingestPosts = [];
    evalrouterDown = false;
    ingestHold = null;
    ingestFinished = false;
    policyReply = () =>
      new Response(JSON.stringify(signedPolicy()), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"etag-l4"' },
      });
    vendorReply = () => openRouterOk("ok");
    ingestReply = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

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
      if (evalrouterDown) {
        throw new TypeError("fetch failed");
      }
      if (method === "POST" && url === ingestUrl) {
        ingestPosts.push({ method, url, authorization, body });
        if (ingestHold) {
          await ingestHold;
        }
        ingestFinished = true;
        return ingestReply();
      }
      return policyReply();
    }) as typeof fetch;

    sdk = createLiveSdk({
      projectId,
      evalrouterUrl,
      evalrouterKey,
      vendorKey,
      lastKnownPath,
      spoolPath,
      spoolMaxFiles: 8,
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

  function spoolFiles(): string[] {
    if (!existsSync(spoolPath)) {
      return [];
    }
    return readdirSync(spoolPath).filter((name) => name.endsWith(".json"));
  }

  function spoolText(): string {
    return spoolFiles()
      .map((name) => readFileSync(join(spoolPath, name), "utf8"))
      .join("\n");
  }

  it("queues a vendor_error sample after backup also fails and does not wait for ingest", async () => {
    policyReply = () =>
      new Response(
        JSON.stringify(
          signedPolicy({
            backups: [{ model_id: backupModel, timeout_ms: 2500 }],
          }),
        ),
        {
          status: 200,
          headers: { "content-type": "application/json", etag: '"etag-l4-backup"' },
        },
      );
    vendorReply = () => new Response("vendor down", { status: 503 });

    let releaseIngest: () => void = () => undefined;
    ingestHold = new Promise<void>((resolve) => {
      releaseIngest = resolve;
    });

    await sdk.start();
    const getsAfterStart = getCalls().length;
    let completeSettled = false;
    const completeDone = sdk
      .complete({ prompt: "All models fail." })
      .then(
        () => {
          completeSettled = true;
        },
        () => {
          completeSettled = true;
        },
      );

    await completeDone;
    assert.equal(completeSettled, true);
    assert.equal(ingestFinished, false);
    await waitUntil(() => ingestPosts.length === 2, "ingest POST started");
    assert.equal(ingestFinished, false);
    assert.equal(getCalls().length, getsAfterStart);

    const primarySample = parseSample(ingestPosts[0].body);
    assert.equal(primarySample.why, "vendor_error");
    assert.equal(primarySample.policy_id, "pol_live_sdk_l4");
    assert.equal(primarySample.model_id, primaryModel);
    assert.equal(primarySample.project_id, projectId);
    assert.match(primarySample.sample_id, /^smp_/);
    const backupSample = parseSample(ingestPosts[1].body);
    assert.equal(backupSample.model_id, backupModel);
    assert.equal(ingestPosts[0].authorization, `Bearer ${evalrouterKey}`);
    assert.notEqual(ingestPosts[0].authorization, `Bearer ${vendorKey}`);

    releaseIngest();
    await waitUntil(() => ingestFinished, "ingest POST finished");
  });

  it("queues a timeout sample when the vendor exceeds the time limit", async () => {
    policyReply = () =>
      new Response(
        JSON.stringify(
          signedPolicy({
            primary: { model_id: primaryModel, timeout_ms: 40 },
            backups: [],
          }),
        ),
        {
          status: 200,
          headers: { "content-type": "application/json", etag: '"etag-l4-timeout"' },
        },
      );
    vendorReply = (init) => hangUntilAbort(init?.signal);

    await sdk.start();
    await assert.rejects(() => sdk.complete({ prompt: "Wait too long." }));
    await waitUntil(() => ingestPosts.length === 1, "timeout ingest");
    const sample = parseSample(ingestPosts[0].body);
    assert.equal(sample.why, "timeout");
    assert.equal(sample.model_id, primaryModel);
    assert.equal(sample.input_redacted.includes("Wait too long."), true);
  });

  it("does not POST an ingest sample after a successful complete", async () => {
    await sdk.start();
    const result = await sdk.complete({ prompt: "Name the total." });
    assert.equal(result.content, "ok");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(ingestPosts.length, 0);
  });

  it("queues the primary failure sample when the backup returns content", async () => {
    policyReply = () =>
      new Response(
        JSON.stringify(
          signedPolicy({
            backups: [{ model_id: backupModel, timeout_ms: 2500 }],
          }),
        ),
        {
          status: 200,
          headers: { "content-type": "application/json", etag: '"etag-l4-ok-backup"' },
        },
      );
    let vendorPosts = 0;
    vendorReply = () => {
      vendorPosts += 1;
      if (vendorPosts === 1) {
        return new Response("vendor down", { status: 503 });
      }
      return openRouterOk("from-backup");
    };
    await sdk.start();
    const result = await sdk.complete({ prompt: "Backup worked." });
    assert.equal(result.content, "from-backup");
    assert.equal(result.model_id, backupModel);
    await waitUntil(() => ingestPosts.length === 1, "primary failure ingest");
    const sample = parseSample(ingestPosts[0].body);
    assert.equal(sample.why, "vendor_error");
    assert.equal(sample.model_id, primaryModel);
    assert.equal(sample.policy_id, "pol_live_sdk_l4");
  });

  it("complete() still does not GET policy when it queues a sample", async () => {
    vendorReply = () => new Response("vendor down", { status: 503 });
    await sdk.start();
    const getsAfterStart = getCalls().length;
    await assert.rejects(() => sdk.complete({ prompt: "No GET on miss." }));
    await waitUntil(() => ingestPosts.length === 1, "ingest after miss");
    assert.equal(getCalls().length, getsAfterStart);
  });

  it("reportMiss queues app_reported and does not wait for ingest", async () => {
    let releaseIngest: () => void = () => undefined;
    ingestHold = new Promise<void>((resolve) => {
      releaseIngest = resolve;
    });
    await sdk.start();
    await sdk.complete({ prompt: "Name the total." });
    assert.equal(ingestPosts.length, 0);

    let reportSettled = false;
    const reportDone = sdk
      .reportMiss({ prompt: "Name the total.", output: "bad json" })
      .then(() => {
        reportSettled = true;
      });
    await reportDone;
    assert.equal(reportSettled, true);
    assert.equal(ingestFinished, false);
    await waitUntil(() => ingestPosts.length === 1, "reportMiss ingest");
    assert.equal(ingestFinished, false);
    const sample = parseSample(ingestPosts[0].body);
    assert.equal(sample.why, "app_reported");
    assert.equal(sample.output_redacted.includes("bad json"), true);
    assert.equal(sample.policy_id, "pol_live_sdk_l4");
    releaseIngest();
    await waitUntil(() => ingestFinished, "reportMiss ingest finished");
  });

  it("strips secret-shaped fields from the stored sample", async () => {
    vendorReply = () => new Response("vendor down", { status: 503 });
    const secretBearer = "Bearer supersecret-live-token";
    const secretOr = "sk-or-v1-abcdefghijklmnopqrstuvwx";
    const secretSk = "sk-abcdefghijklmnopqrstuvwxyz12";
    await sdk.start();
    await assert.rejects(() =>
      sdk.complete({
        prompt: `Auth ${secretBearer} key ${secretOr} also ${secretSk} authorization: raw-header-token`,
      }),
    );
    await waitUntil(() => ingestPosts.length === 1, "secret ingest");
    const raw = ingestPosts[0].body ?? "";
    assert.equal(raw.includes("supersecret-live-token"), false);
    assert.equal(raw.includes(secretOr), false);
    assert.equal(raw.includes(secretSk), false);
    assert.equal(raw.includes("raw-header-token"), false);
    const sample = parseSample(raw);
    assert.equal(sample.input_redacted.includes("Auth"), true);
  });

  it("hashes or strips email, phone, and card-like numbers", async () => {
    vendorReply = () => new Response("vendor down", { status: 503 });
    const email = "user@example.com";
    const phone = "415-555-1234";
    const card = "4111111111111111";
    await sdk.start();
    await assert.rejects(() =>
      sdk.complete({
        prompt: `Contact ${email} at ${phone} card ${card} please.`,
      }),
    );
    await waitUntil(() => ingestPosts.length === 1, "pii ingest");
    const sample = parseSample(ingestPosts[0].body);
    assert.equal(sample.input_redacted.includes(email), false);
    assert.equal(sample.input_redacted.includes(phone), false);
    assert.equal(sample.input_redacted.includes(card), false);
    assert.equal(sample.input_redacted.includes("Contact"), true);
    assert.equal(sample.input_redacted.includes("please."), true);
  });

  it("drops unredactable PII, counts PII_BLOCKED, and keeps no raw example", async () => {
    vendorReply = () => new Response("vendor down", { status: 503 });
    const ssn = "123-45-6789";
    await sdk.start();
    await assert.rejects(() => sdk.complete({ prompt: `SSN ${ssn} stays raw.` }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(ingestPosts.length, 0);
    assert.equal(sdk.stats().pii_blocked_count, 1);
    assert.equal(ErrorCode.PII_BLOCKED, "PII_BLOCKED");
    assert.equal(spoolFiles().length, 0);
    assert.equal(spoolText().includes(ssn), false);
    assert.equal(JSON.stringify(ingestPosts).includes(ssn), false);
  });

  it("drops the sample when ingest returns 500 and still returns the vendor error", async () => {
    vendorReply = () => new Response("vendor down", { status: 503 });
    ingestReply = () => new Response("ingest down", { status: 500 });
    await sdk.start();
    await assert.rejects(() => sdk.complete({ prompt: "Keep the vendor error." }));
    await waitUntil(() => ingestPosts.length === 1, "ingest 500");
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(spoolFiles().length, 0);
  });

  it("writes a spool file when the control plane is down and drains later", async () => {
    vendorReply = () => new Response("vendor down", { status: 503 });
    await sdk.start();
    evalrouterDown = true;
    await assert.rejects(() => sdk.complete({ prompt: "Spool this miss." }));
    await waitUntil(() => spoolFiles().length === 1, "spool write");
    assert.equal(ingestPosts.length, 0);
    const stored = JSON.parse(spoolText()) as SampleBody;
    assert.equal(stored.why, "vendor_error");
    assert.equal(stored.input_redacted.includes("Spool this miss."), true);
    assert.match(stored.sample_id, /^smp_/);

    evalrouterDown = false;
    await sdk.start();
    await waitUntil(() => ingestPosts.length === 1, "spool drain");
    await waitUntil(() => spoolFiles().length === 0, "spool empty");
    const drained = parseSample(ingestPosts[0].body);
    assert.equal(drained.sample_id, stored.sample_id);
    assert.equal(drained.why, "vendor_error");
  });

  it("drops samples when the spool is full and does not fail the user", async () => {
    sdk.stop();
    sdk = createLiveSdk({
      projectId,
      evalrouterUrl,
      evalrouterKey,
      vendorKey,
      lastKnownPath,
      spoolPath,
      spoolMaxFiles: 1,
      pollMs: 30_000,
      fetch: (async (
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
        if (evalrouterDown) {
          throw new TypeError("fetch failed");
        }
        if (method === "POST" && url === ingestUrl) {
          ingestPosts.push({ method, url, authorization, body });
          return ingestReply();
        }
        return policyReply();
      }) as typeof fetch,
    });
    vendorReply = () => new Response("vendor down", { status: 503 });
    await sdk.start();
    evalrouterDown = true;
    await assert.rejects(() => sdk.complete({ prompt: "First spool." }));
    await waitUntil(() => spoolFiles().length === 1, "first spool");
    await assert.rejects(() => sdk.complete({ prompt: "Second drop." }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(spoolFiles().length, 1);
    assert.equal(spoolText().includes("Second drop."), false);
  });
});
