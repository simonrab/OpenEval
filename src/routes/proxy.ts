import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import {
  getRuntimePolicyDocument,
  parseRuntimePolicyDocument,
  type SignedPolicy,
} from "../policy.js";
import { projectExists } from "../keys.js";
import { assessLiveRequest } from "../live/assess.js";
import { noLastKnownPolicyError, projectNotFoundError } from "../errors.js";
import type {
  ChatCompletionResult,
  ModelSettings,
  OpenRouterClient,
} from "../runner/openrouter.js";
import type { PolicyModel } from "../policy.js";
import {
  entryCandidateId,
  mergeSettings,
  pickSystemPrompt,
} from "../live/request.js";

type ProxyBody = {
  project_id?: unknown;
  messages?: unknown;
  stream?: unknown;
  user?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  max_tokens?: unknown;
  reasoning?: unknown;
  reasoning_effort?: unknown;
};

const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;

/** App settings from an OpenAI-style body. Bad values are ignored. */
export function appSettingsFromBody(body: ProxyBody): ModelSettings | undefined {
  const out: ModelSettings = {};
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (typeof body.max_tokens === "number") out.max_tokens = body.max_tokens;
  const effort =
    body.reasoning !== null && typeof body.reasoning === "object"
      ? (body.reasoning as { effort?: unknown }).effort
      : body.reasoning_effort;
  if (REASONING_EFFORTS.includes(effort as (typeof REASONING_EFFORTS)[number])) {
    out.reasoning_effort = effort as ModelSettings["reasoning_effort"];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function systemFromMessages(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }
  const system = messages.find(
    (item): item is { role: string; content: unknown } =>
      item !== null && typeof item === "object" && (item as { role?: unknown }).role === "system",
  );
  return typeof system?.content === "string" && system.content.length > 0
    ? system.content
    : undefined;
}

/** The call the proxy sends to OpenRouter for one policy setup. */
export function shapeProxyCall(
  entry: PolicyModel,
  body: ProxyBody,
  applyPolicySystemPrompt: boolean,
): { model: string; systemPrompt?: string; settings?: ModelSettings } {
  const system = pickSystemPrompt(
    entry,
    systemFromMessages(body.messages),
    applyPolicySystemPrompt,
  );
  const settings = mergeSettings(appSettingsFromBody(body), entry.settings);
  return {
    model: entry.model_id,
    ...(system.text ? { systemPrompt: system.text } : {}),
    ...(settings ? { settings } : {}),
  };
}

function headerValue(
  headers: Record<string, unknown>,
  name: string,
): string | null {
  const found = Object.keys(headers).find(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );
  const value = found ? headers[found] : undefined;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function promptFromMessages(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return "";
  }
  const lastUser = [...messages]
    .reverse()
    .find(
      (item): item is { role?: unknown; content?: unknown } =>
        item !== null && typeof item === "object" && !Array.isArray(item),
    );
  const content = lastUser?.content;
  if (typeof content === "string") {
    return content;
  }
  return JSON.stringify(content ?? "");
}

export function selectProxyPolicy(
  db: Database.Database,
  apiKey: string,
  projectId: string,
  input: { user_id?: string; request_id?: string },
): SignedPolicy | null {
  const runtime = getRuntimePolicyDocument(db, apiKey, projectId);
  if (!runtime) {
    return null;
  }
  const doc = parseRuntimePolicyDocument(apiKey, runtime.bodyJson);
  if (!doc) {
    return null;
  }
  return assessLiveRequest(input, {
    last_full: doc.last_full,
    canary: doc.canary,
    canary_percent: doc.canary_percent,
  });
}

export async function registerProxyRoutes(
  app: FastifyInstance,
  db: Database.Database,
  apiKey: string,
  openRouter: OpenRouterClient,
): Promise<void> {
  app.post("/proxy/chat/completions", async (request, reply) => {
    const body =
      request.body !== null &&
      typeof request.body === "object" &&
      !Array.isArray(request.body)
        ? (request.body as ProxyBody)
        : {};
    const headers = request.headers as Record<string, unknown>;
    const projectId =
      typeof body.project_id === "string" && body.project_id.length > 0
        ? body.project_id
        : headerValue(headers, "x-openeval-project-id");
    if (!projectId) {
      return reply.code(400).send({ error: "project_id is required" });
    }
    if (!projectExists(db, projectId)) {
      return reply.code(404).send(projectNotFoundError(projectId));
    }
    const vendorKey = headerValue(headers, "x-openrouter-api-key");
    if (!vendorKey) {
      return reply.code(400).send({ error: "x-openrouter-api-key is required" });
    }

    const userId = typeof body.user === "string" ? body.user : undefined;
    const requestId = headerValue(headers, "x-request-id") ?? undefined;
    const policy = selectProxyPolicy(db, apiKey, projectId, {
      user_id: userId,
      request_id: requestId,
    });
    if (!policy) {
      return reply.code(404).send(noLastKnownPolicyError(projectId));
    }

    const prompt = promptFromMessages(body.messages);
    const applySystem =
      headerValue(headers, "x-openeval-apply-system-prompt")?.toLowerCase() === "true";
    const callWith = (entry: PolicyModel): Promise<ChatCompletionResult> =>
      openRouter.chatCompletion({
        ...shapeProxyCall(entry, body, applySystem),
        prompt,
        apiKey: vendorKey,
      });
    let served = policy.primary;
    let result: ChatCompletionResult;
    try {
      result = await callWith(served);
    } catch (err) {
      const backup = policy.backups[0];
      if (!backup) {
        throw err;
      }
      served = backup;
      result = await callWith(served);
    }
    const openeval = {
      policy_id: policy.policy_id,
      candidate_id: entryCandidateId(served),
    };

    if (body.stream === true) {
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      });
      for (const token of result.content.split(/(\s+)/).filter((t) => t.length > 0)) {
        reply.raw.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: token } }],
            model: served.model_id,
            openeval,
          })}\n\n`,
        );
      }
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
      return reply;
    }

    return {
      id: `chatcmpl-${policy.policy_id}`,
      object: "chat.completion",
      model: served.model_id,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: result.content },
          finish_reason: "stop",
        },
      ],
      openeval: {
        ...openeval,
        live_traffic_changed: false,
      },
    };
  });
}

