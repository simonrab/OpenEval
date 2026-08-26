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
import type { OpenRouterClient } from "../runner/openrouter.js";

type ProxyBody = {
  project_id?: unknown;
  messages?: unknown;
  stream?: unknown;
  user?: unknown;
};

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
        : headerValue(headers, "x-evalrouter-project-id");
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
    const result = await openRouter.chatCompletion({
      model: policy.primary.model_id,
      prompt,
      apiKey: vendorKey,
    });

    if (body.stream === true) {
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      });
      for (const token of result.content.split(/(\s+)/).filter((t) => t.length > 0)) {
        reply.raw.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: token } }],
            model: policy.primary.model_id,
            evalrouter: { policy_id: policy.policy_id },
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
      model: policy.primary.model_id,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: result.content },
          finish_reason: "stop",
        },
      ],
      evalrouter: {
        policy_id: policy.policy_id,
        live_traffic_changed: false,
      },
    };
  });
}

