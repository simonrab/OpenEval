import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { z } from "zod";
import { programCheckSchema } from "../tools/schema.js";
import { dropSample, getSample, type SampleRow } from "../samples.js";
import { verifySampleToken } from "../sample-token.js";
import { promoteLiveSample } from "../tools/promote_live_sample.js";
import { registerFormParser } from "./form-parser.js";

export { buildSampleUrl, signSampleToken, verifySampleToken } from "../sample-token.js";

type ProgramCheck = z.infer<typeof programCheckSchema>;

const templatePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "sample.html",
);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
}

function renderSamplePage(opts: {
  sample: SampleRow;
  token: string;
  banner: string;
  programCheck: string;
}): string {
  const template = readFileSync(templatePath, "utf8");
  return template
    .replaceAll("{{SAMPLE_ID}}", escapeHtml(opts.sample.id))
    .replaceAll("{{TOKEN}}", escapeHtml(opts.token))
    .replaceAll("{{POLICY_ID}}", escapeHtml(opts.sample.policy_id))
    .replaceAll("{{MODEL_ID}}", escapeHtml(opts.sample.model_id))
    .replaceAll("{{WHY}}", escapeHtml(opts.sample.why))
    .replaceAll("{{INPUT_REDACTED}}", escapeHtml(opts.sample.input_redacted))
    .replaceAll("{{OUTPUT_REDACTED}}", escapeHtml(opts.sample.output_redacted))
    .replaceAll("{{PROGRAM_CHECK}}", escapeHtml(opts.programCheck))
    .replace("{{BANNER}}", opts.banner);
}

function bannerForDecision(decision: "promote" | "drop"): string {
  if (decision === "drop") {
    return "<p>This sample is dropped. It cannot be promoted.</p>";
  }
  return "<p>This sample is now an eval on a new eval set. Live policy did not change.</p>";
}

function parseProgramCheck(
  value: unknown,
): { ok: true; value: ProgramCheck | undefined } | { ok: false } {
  if (value == null || value === "") {
    return { ok: true, value: undefined };
  }
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return { ok: false };
    }
  }
  const checked = programCheckSchema.safeParse(parsed);
  if (!checked.success) {
    return { ok: false };
  }
  return { ok: true, value: checked.data };
}

export async function registerSampleScreen(
  app: FastifyInstance,
  db: Database.Database,
  apiKey: string,
  baseUrl: string,
): Promise<void> {
  registerFormParser(app);

  app.get("/sample", async (request, reply) => {
    const query = request.query as {
      sample_id?: string;
      token?: string;
    };
    const sampleId = query.sample_id;
    if (!sampleId) {
      return reply.code(400).send("sample_id is required");
    }
    if (!verifySampleToken(apiKey, sampleId, query.token)) {
      return reply.code(401).send("unauthorized");
    }
    const sample = getSample(db, sampleId);
    if (!sample) {
      return reply.code(404).send("sample not found");
    }
    const html = renderSamplePage({
      sample,
      token: query.token ?? "",
      banner: sample.dropped_at
        ? "<p>This sample is dropped. It cannot be promoted.</p>"
        : "",
      programCheck: "",
    });
    return reply.type("text/html").send(html);
  });

  app.post("/sample", async (request, reply) => {
    const body =
      request.body !== null &&
      typeof request.body === "object" &&
      !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : {};
    const sampleId = asString(body.sample_id);
    const token = asString(body.token);
    const decision = asString(body.decision);
    if (!sampleId) {
      return reply.code(400).send({ error: "sample_id is required" });
    }
    if (!verifySampleToken(apiKey, sampleId, token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (decision !== "promote" && decision !== "drop") {
      return reply.code(400).send({ error: "decision must be promote or drop" });
    }
    const sample = getSample(db, sampleId);
    if (!sample) {
      return reply.code(404).send({ error: "sample not found" });
    }

    const wantsJson =
      String(request.headers["content-type"] ?? "").includes("application/json") ||
      String(request.headers.accept ?? "").includes("application/json");

    if (decision === "drop") {
      dropSample(db, sampleId);
      const result = {
        sample_id: sampleId,
        dropped: true,
        live_traffic_changed: false as const,
      };
      if (wantsJson) {
        return reply.code(200).send(result);
      }
      const html = renderSamplePage({
        sample: {
          ...sample,
          dropped_at: sample.dropped_at ?? new Date().toISOString(),
        },
        token: token ?? "",
        banner: bannerForDecision("drop"),
        programCheck: "",
      });
      return reply.type("text/html").send(html);
    }

    const check = parseProgramCheck(body.program_check);
    if (!check.ok) {
      return reply.code(400).send({ error: "program_check is not valid" });
    }

    const result = promoteLiveSample(
      {
        project_id: sample.project_id,
        sample_id: sample.id,
        program_check: check.value,
        idempotency_key: `sample-screen:${sample.id}`,
      },
      { db, apiKey, baseUrl },
    );

    if (wantsJson || result.status !== 200) {
      return reply.code(result.status).send(result.body);
    }

    const html = renderSamplePage({
      sample,
      token: token ?? "",
      banner: bannerForDecision("promote"),
      programCheck:
        typeof body.program_check === "string" ? body.program_check : "",
    });
    return reply.type("text/html").send(html);
  });
}
