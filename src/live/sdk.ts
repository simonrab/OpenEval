import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { newSampleId } from "../ids.js";
import {
  formatEtag,
  parseRuntimePolicyDocument,
  policyEtag,
  type PolicyModel,
  type RuntimePolicyDocument,
  type SignedPolicy,
} from "../policy.js";
import {
  CANARY_PERCENT,
  stickyId,
} from "./sticky.js";
import { ErrorCode } from "../tools/types.js";
import { assessLiveRequest } from "./assess.js";
import {
  redactSampleFields,
  type LiveSample,
  type SampleWhy,
} from "./redact.js";
import { readSpoolSamples, removeSpoolSample, writeSpoolSample } from "./spool.js";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_POLL_MS = 30_000;

export class LiveSdkError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LiveSdkError";
    this.code = code;
  }
}

class VendorError extends Error {
  readonly retryable: boolean;
  readonly sampleWhy: SampleWhy;

  constructor(message: string, retryable: boolean, sampleWhy: SampleWhy = "vendor_error") {
    super(message);
    this.name = "VendorError";
    this.retryable = retryable;
    this.sampleWhy = sampleWhy;
  }
}

export type LiveSdkOptions = {
  projectId: string;
  evalrouterUrl: string;
  evalrouterKey: string;
  vendorKey: string;
  lastKnownPath: string;
  spoolPath?: string;
  spoolMaxFiles?: number;
  pollMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
};

export type LiveCompleteInput = {
  prompt: string;
  user_id?: string;
  request_id?: string;
};

export type LiveCompleteResult = {
  content: string;
  model_id: string;
  policy_id: string;
};

export type LiveStreamToken = {
  content: string;
  model_id: string;
  policy_id: string;
};

export type LiveSdkStats = {
  request_count: number;
  fallback_count: number;
  fallback_rate: number;
  pii_blocked_count: number;
  intended_percent: number;
  observed_percent: number;
};

export type LiveReportMissInput = {
  prompt: string;
  output: string;
};

export type LiveSdk = {
  start(): Promise<void>;
  complete(input: LiveCompleteInput): Promise<LiveCompleteResult>;
  completeStream(input: LiveCompleteInput): AsyncIterable<LiveStreamToken>;
  reportMiss(input: LiveReportMissInput): Promise<void>;
  stats(): LiveSdkStats;
  stop(): void;
};

function noLastKnownError(): LiveSdkError {
  return new LiveSdkError(
    ErrorCode.NO_LAST_KNOWN_POLICY,
    "This SDK has no last-known policy that passed the seal check.",
  );
}

function policyUrl(evalrouterUrl: string, projectId: string): string {
  const base = evalrouterUrl.replace(/\/+$/, "");
  return `${base}/v1/runtime/policies/${encodeURIComponent(projectId)}`;
}

function samplesUrl(evalrouterUrl: string): string {
  const base = evalrouterUrl.replace(/\/+$/, "");
  return `${base}/v1/runtime/samples`;
}

function statsUrl(evalrouterUrl: string): string {
  const base = evalrouterUrl.replace(/\/+$/, "");
  return `${base}/v1/runtime/stats`;
}

function capPollMs(value: number | undefined): number {
  const requested = value ?? DEFAULT_POLL_MS;
  if (requested <= 0) {
    return DEFAULT_POLL_MS;
  }
  return Math.min(requested, DEFAULT_POLL_MS);
}

async function atomicWriteFile(path: string, text: string): Promise<void> {
  const tmpPath = `${path}.${process.pid}.tmp`;
  await writeFile(tmpPath, text, "utf8");
  await rename(tmpPath, path);
}

async function readVerifiedLastKnown(
  path: string,
  evalrouterKey: string,
): Promise<{ doc: RuntimePolicyDocument; text: string } | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  if (text.length === 0) {
    return null;
  }
  const doc = parseRuntimePolicyDocument(evalrouterKey, text);
  if (!doc) {
    return null;
  }
  return { doc, text };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError";
}

function vendorHttpError(status: number): VendorError {
  return new VendorError(`The vendor returned HTTP ${status}.`, isRetryableStatus(status));
}

function vendorTimeoutError(): VendorError {
  return new VendorError("The vendor call exceeded the time limit.", true, "timeout");
}

function isRetryableVendor(err: unknown): boolean {
  return err instanceof VendorError && err.retryable;
}

function startDeadline(timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
    },
  };
}

async function cancelBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    return;
  }
}

function parseSseLine(line: string): string | "done" | null {
  if (!line.startsWith("data:")) {
    return null;
  }
  const data = line.slice(5).trim();
  if (data.length === 0) {
    return null;
  }
  if (data === "[DONE]") {
    return "done";
  }
  try {
    const json = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.delta?.content;
    if (typeof content === "string" && content.length > 0) {
      return content;
    }
  } catch {
    return null;
  }
  return null;
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    throw vendorTimeoutError();
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(vendorTimeoutError());
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted || isAbortError(err)) {
          reject(vendorTimeoutError());
          return;
        }
        reject(err);
      },
    );
  });
}

async function* readSseContent(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await readChunk(reader, signal);
      if (done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const parsed = parseSseLine(line);
        if (parsed === "done") {
          return;
        }
        if (parsed !== null) {
          yield parsed;
        }
        idx = buffer.indexOf("\n");
      }
    }
    if (buffer.length > 0) {
      const parsed = parseSseLine(buffer);
      if (parsed !== null && parsed !== "done") {
        yield parsed;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      return;
    }
  }
}

export function createLiveSdk(options: LiveSdkOptions): LiveSdk {
  const fetchFn = options.fetch ?? fetch;
  const pollMs = capPollMs(options.pollMs);
  const getUrl = policyUrl(options.evalrouterUrl, options.projectId);
  const ingestUrl = samplesUrl(options.evalrouterUrl);
  const hopStatsUrl = statsUrl(options.evalrouterUrl);
  const spoolDir = options.spoolPath ?? join(dirname(options.lastKnownPath), "sample-spool");
  const spoolMaxFiles = options.spoolMaxFiles ?? 64;

  let lastFull: SignedPolicy | null = null;
  let canary: SignedPolicy | null = null;
  let intendedPercent = 0;
  let etag: string | null = null;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let requestCount = 0;
  let fallbackCount = 0;
  let piiBlockedCount = 0;
  let hashedRequestCount = 0;
  let canaryRequestCount = 0;
  let lastModelId: string | null = null;
  let lastPolicyId: string | null = null;
  let lastKnownLoadedAt: string | null = null;

  function applyDocument(doc: RuntimePolicyDocument): void {
    lastFull = doc.last_full;
    canary = doc.canary;
    intendedPercent =
      doc.canary && doc.canary_percent === CANARY_PERCENT ? CANARY_PERCENT : 0;
    lastKnownLoadedAt = new Date(options.now?.() ?? Date.now()).toISOString();
  }

  function pickPolicy(input: LiveCompleteInput): SignedPolicy {
    const cached = lastFull;
    if (!cached) {
      throw noLastKnownError();
    }
    return assessLiveRequest(input, {
      last_full: cached,
      canary,
      canary_percent: intendedPercent,
    });
  }

  function noteRequest(input: LiveCompleteInput, used: SignedPolicy): void {
    requestCount += 1;
    lastPolicyId = used.policy_id;
    if (stickyId(input) !== null) {
      hashedRequestCount += 1;
      if (canary && used.policy_id === canary.policy_id) {
        canaryRequestCount += 1;
      }
    }
  }

  function queueSample(args: {
    prompt: string;
    output: string;
    why: SampleWhy;
    modelId: string;
    policyId: string;
  }): void {
    void persistSample(args).catch(() => undefined);
  }

  function queueFromError(
    prompt: string,
    err: unknown,
    modelId: string,
    policyId: string,
  ): void {
    const why: SampleWhy =
      err instanceof VendorError ? err.sampleWhy : "vendor_error";
    const output =
      err instanceof Error ? err.message : "The vendor call failed.";
    queueSample({
      prompt,
      output,
      why,
      modelId,
      policyId,
    });
  }

  async function persistSample(args: {
    prompt: string;
    output: string;
    why: SampleWhy;
    modelId: string;
    policyId: string;
  }): Promise<void> {
    const redacted = redactSampleFields(args.prompt, args.output);
    if (!redacted.ok) {
      piiBlockedCount += 1;
      return;
    }
    const sample: LiveSample = {
      sample_id: newSampleId(),
      project_id: options.projectId,
      policy_id: args.policyId,
      model_id: args.modelId,
      why: args.why,
      input_redacted: redacted.input_redacted,
      output_redacted: redacted.output_redacted,
      captured_at: new Date(options.now?.() ?? Date.now()).toISOString(),
    };
    await uploadOrSpool(sample);
  }

  async function postSample(sample: LiveSample): Promise<Response> {
    return fetchFn(ingestUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.evalrouterKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sample),
    });
  }

  async function uploadOrSpool(sample: LiveSample): Promise<void> {
    try {
      const res = await postSample(sample);
      if (!res.ok) {
        await cancelBody(res);
        return;
      }
    } catch {
      await writeSpoolSample(spoolDir, sample, spoolMaxFiles);
    }
  }

  async function drainSpool(): Promise<void> {
    const queued = await readSpoolSamples(spoolDir);
    for (const sample of queued) {
      try {
        const res = await postSample(sample);
        if (res.ok) {
          await removeSpoolSample(spoolDir, sample.sample_id);
          continue;
        }
        await cancelBody(res);
        await removeSpoolSample(spoolDir, sample.sample_id);
      } catch {
        return;
      }
    }
  }

  async function uploadHopStats(): Promise<void> {
    if (requestCount === 0) {
      return;
    }
    try {
      const res = await fetchFn(hopStatsUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.evalrouterKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          project_id: options.projectId,
          hashed_request_count: hashedRequestCount,
          canary_request_count: canaryRequestCount,
          fallback_count: fallbackCount,
          request_count: requestCount,
          pii_blocked_count: piiBlockedCount,
          last_known_loaded_at: lastKnownLoadedAt,
        }),
      });
      if (!res.ok) {
        await cancelBody(res);
      }
    } catch {
      return;
    }
  }

  async function loadLastKnownFile(): Promise<void> {
    if (lastFull) {
      return;
    }
    const loaded = await readVerifiedLastKnown(
      options.lastKnownPath,
      options.evalrouterKey,
    );
    if (!loaded) {
      return;
    }
    applyDocument(loaded.doc);
    etag = formatEtag(policyEtag(loaded.text));
  }

  async function refreshFromControlPlane(): Promise<void> {
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${options.evalrouterKey}`,
      };
      if (etag) {
        headers["If-None-Match"] = etag;
      }
      const res = await fetchFn(getUrl, { method: "GET", headers });
      if (res.status === 304) {
        await drainSpool();
        await uploadHopStats();
        return;
      }
      if (res.status !== 200) {
        await uploadHopStats();
        return;
      }
      const text = await res.text();
      const doc = parseRuntimePolicyDocument(options.evalrouterKey, text);
      if (!doc) {
        await uploadHopStats();
        return;
      }
      await atomicWriteFile(options.lastKnownPath, text);
      applyDocument(doc);
      etag = res.headers.get("etag") ?? formatEtag(policyEtag(text));
      await drainSpool();
      await uploadHopStats();
    } catch {
      return;
    }
  }

  function ensurePoll(): void {
    if (pollTimer !== undefined) {
      return;
    }
    pollTimer = setInterval(() => {
      void refreshFromControlPlane();
    }, pollMs);
  }

  async function postVendor(
    model: PolicyModel,
    prompt: string,
    stream: boolean,
    signal: AbortSignal,
  ): Promise<Response> {
    try {
      return await fetchFn(OPENROUTER_CHAT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.vendorKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: model.model_id,
          messages: [{ role: "user", content: prompt }],
          ...(stream ? { stream: true } : {}),
        }),
        signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw vendorTimeoutError();
      }
      throw err;
    }
  }

  async function completeJson(
    model: PolicyModel,
    prompt: string,
    policyId: string,
  ): Promise<LiveCompleteResult> {
    const deadline = startDeadline(model.timeout_ms);
    try {
      const res = await postVendor(model, prompt, false, deadline.signal);
      if (!res.ok) {
        await cancelBody(res);
        throw vendorHttpError(res.status);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      return {
        content,
        model_id: model.model_id,
        policy_id: policyId,
      };
    } catch (err) {
      if (err instanceof VendorError) {
        throw err;
      }
      if (isAbortError(err)) {
        throw vendorTimeoutError();
      }
      throw err;
    } finally {
      deadline.clear();
    }
  }

  async function* streamModel(
    model: PolicyModel,
    prompt: string,
    policyId: string,
  ): AsyncGenerator<LiveStreamToken> {
    const deadline = startDeadline(model.timeout_ms);
    let sawToken = false;
    try {
      const res = await postVendor(model, prompt, true, deadline.signal);
      if (!res.ok) {
        await cancelBody(res);
        throw vendorHttpError(res.status);
      }
      if (!res.body) {
        throw new VendorError("The vendor sent an empty stream.", true);
      }
      for await (const content of readSseContent(res.body, deadline.signal)) {
        if (!sawToken) {
          deadline.clear();
          sawToken = true;
        }
        yield {
          content,
          model_id: model.model_id,
          policy_id: policyId,
        };
      }
    } catch (err) {
      if (err instanceof VendorError) {
        throw err;
      }
      if (isAbortError(err)) {
        throw vendorTimeoutError();
      }
      throw new VendorError(
        sawToken
          ? "The vendor stream failed after the first token."
          : "The vendor stream failed before the first token.",
        !sawToken,
      );
    } finally {
      deadline.clear();
    }
  }

  function oneBackup(cached: SignedPolicy): PolicyModel | undefined {
    return cached.backups[0];
  }

  return {
    async start() {
      await loadLastKnownFile();
      await refreshFromControlPlane();
      if (!lastFull) {
        throw noLastKnownError();
      }
      ensurePoll();
    },

    async complete(input) {
      const cached = pickPolicy(input);
      noteRequest(input, cached);
      try {
        const result = await completeJson(
          cached.primary,
          input.prompt,
          cached.policy_id,
        );
        lastModelId = result.model_id;
        return result;
      } catch (err) {
        const backup = oneBackup(cached);
        if (!backup || !isRetryableVendor(err)) {
          queueFromError(input.prompt, err, cached.primary.model_id, cached.policy_id);
          throw err;
        }
        fallbackCount += 1;
        try {
          const result = await completeJson(
            backup,
            input.prompt,
            cached.policy_id,
          );
          lastModelId = result.model_id;
          return result;
        } catch (backupErr) {
          queueFromError(input.prompt, backupErr, backup.model_id, cached.policy_id);
          throw backupErr;
        }
      }
    },

    async *completeStream(input) {
      const cached = pickPolicy(input);
      noteRequest(input, cached);
      let sawToken = false;
      try {
        for await (const token of streamModel(
          cached.primary,
          input.prompt,
          cached.policy_id,
        )) {
          sawToken = true;
          lastModelId = token.model_id;
          yield token;
        }
      } catch (err) {
        const backup = oneBackup(cached);
        if (sawToken || !backup || !isRetryableVendor(err)) {
          queueFromError(
            input.prompt,
            err,
            cached.primary.model_id,
            cached.policy_id,
          );
          throw err;
        }
        fallbackCount += 1;
        try {
          for await (const token of streamModel(
            backup,
            input.prompt,
            cached.policy_id,
          )) {
            lastModelId = token.model_id;
            yield token;
          }
        } catch (backupErr) {
          queueFromError(input.prompt, backupErr, backup.model_id, cached.policy_id);
          throw backupErr;
        }
      }
    },

    async reportMiss(input) {
      const cached = lastFull;
      if (!cached) {
        throw noLastKnownError();
      }
      queueSample({
        prompt: input.prompt,
        output: input.output,
        why: "app_reported",
        modelId: lastModelId ?? cached.primary.model_id,
        policyId: lastPolicyId ?? cached.policy_id,
      });
    },

    stats() {
      return {
        request_count: requestCount,
        fallback_count: fallbackCount,
        fallback_rate: requestCount === 0 ? 0 : fallbackCount / requestCount,
        pii_blocked_count: piiBlockedCount,
        intended_percent: intendedPercent,
        observed_percent:
          hashedRequestCount === 0
            ? 0
            : (canaryRequestCount / hashedRequestCount) * 100,
      };
    },

    stop() {
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    },
  };
}
