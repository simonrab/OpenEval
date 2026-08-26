import type { FastifyInstance } from "fastify";
import { stickyBucket } from "../../src/live/sticky.js";

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

export type HopFetchCall = {
  method: string;
  url: string;
  body: string | null;
  vendorWaitMs: number | null;
};

export type HopFetchHarness = {
  fetch: typeof fetch;
  calls: HopFetchCall[];
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

export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

export function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) {
    return init.method.toUpperCase();
  }
  if (typeof input !== "string" && !(input instanceof URL) && input.method) {
    return input.method.toUpperCase();
  }
  return "GET";
}

export function requestBody(input: RequestInfo | URL, init?: RequestInit): string | null {
  if (typeof init?.body === "string") {
    return init.body;
  }
  if (typeof input !== "string" && !(input instanceof URL) && typeof input.body === "string") {
    return input.body;
  }
  return null;
}

export function openRouterOk(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function injectHeaders(input: RequestInfo | URL, init?: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {};
  const authorization = headerValue(init?.headers, "authorization");
  const contentType = headerValue(init?.headers, "content-type");
  const ifNoneMatch = headerValue(init?.headers, "if-none-match");
  if (authorization) {
    headers.authorization = authorization;
  }
  if (contentType) {
    headers["content-type"] = contentType;
  }
  if (ifNoneMatch) {
    headers["if-none-match"] = ifNoneMatch;
  }
  if (typeof input !== "string" && !(input instanceof URL)) {
    input.headers.forEach((value, key) => {
      if (headers[key] === undefined) {
        headers[key] = value;
      }
    });
  }
  return headers;
}

function toFetchResponse(injected: {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
}): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(injected.headers)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, String(item));
      }
    } else {
      headers.set(key, String(value));
    }
  }
  const nullBody =
    injected.statusCode === 204 ||
    injected.statusCode === 205 ||
    injected.statusCode === 304;
  return new Response(nullBody ? null : injected.body, {
    status: injected.statusCode,
    headers,
  });
}

/** Live added wait: complete() wall minus vendor fetch wait. */
export function addedLatencyMs(completeWallMs: number, vendorWaitMs: number): number {
  return Math.max(0, completeWallMs - vendorWaitMs);
}

/** Nearest-rank p99 of added-latency samples, in milliseconds. */
export function p99Ms(samples: number[]): number {
  if (samples.length === 0) {
    throw new Error("p99 needs at least one sample.");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * 0.99) - 1);
  return sorted[index]!;
}

export function idForCanaryBucket(wantCanary: boolean): string {
  for (let i = 0; i < 20_000; i++) {
    const id = `user_${i}`;
    if ((stickyBucket(id) < 5) === wantCanary) {
      return id;
    }
  }
  throw new Error("no sticky id");
}

export function postModel(body: string | null): string {
  const payload = JSON.parse(body ?? "{}") as { model?: string };
  return payload.model ?? "";
}

export function createHopFetch(opts: {
  app: FastifyInstance;
  evalrouterUrl: string;
  isControlPlaneUp: () => boolean;
  vendorResponse: (model: string) => Response;
}): HopFetchHarness {
  const calls: HopFetchCall[] = [];
  const evalrouterBase = opts.evalrouterUrl.replace(/\/+$/, "");

  const fetchFn = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = requestUrl(input);
    const method = requestMethod(input, init);
    const body = requestBody(input, init);

    if (url.startsWith("https://openrouter.ai/")) {
      const vendorStart = performance.now();
      const response = opts.vendorResponse(postModel(body));
      const vendorWaitMs = performance.now() - vendorStart;
      calls.push({ method, url, body, vendorWaitMs });
      return response;
    }

    if (!opts.isControlPlaneUp()) {
      calls.push({ method, url, body, vendorWaitMs: null });
      throw new TypeError("The control plane is down.");
    }

    if (!url.startsWith(evalrouterBase)) {
      calls.push({ method, url, body, vendorWaitMs: null });
      throw new TypeError(`Unexpected fetch URL: ${url}`);
    }

    const parsed = new URL(url);
    const injected = await opts.app.inject({
      method,
      url: `${parsed.pathname}${parsed.search}`,
      headers: injectHeaders(input, init),
      payload: body && method !== "GET" ? JSON.parse(body) : undefined,
    });
    calls.push({ method, url, body, vendorWaitMs: null });
    return toFetchResponse(injected);
  }) as typeof fetch;

  return { fetch: fetchFn, calls };
}
