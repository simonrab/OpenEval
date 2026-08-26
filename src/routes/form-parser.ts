import type { FastifyInstance } from "fastify";

function parseUrlEncoded(raw: string): Record<string, unknown> {
  const params = new URLSearchParams(raw);
  const obj: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    obj[key] = all.length > 1 ? all : all[0];
  }
  return obj;
}

export function registerFormParser(app: FastifyInstance): void {
  if (app.hasContentTypeParser("application/x-www-form-urlencoded")) {
    return;
  }
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        done(null, parseUrlEncoded(String(body)));
      } catch (err) {
        done(err as Error);
      }
    },
  );
}

export { parseUrlEncoded };
