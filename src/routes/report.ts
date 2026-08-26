import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const templatePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "report.html",
);

export async function registerReport(app: FastifyInstance): Promise<void> {
  const html = readFileSync(templatePath, "utf8");
  app.get("/report", async (_request, reply) => {
    return reply.type("text/html").send(html);
  });
}
