import { createHmac, timingSafeEqual } from "node:crypto";

export type ReportTokenPayload = {
  project_id: string;
  run_id: string;
};

function signPayload(apiKey: string, payload: string): string {
  return createHmac("sha256", apiKey)
    .update(`report:${payload}`)
    .digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export function signReportToken(
  apiKey: string,
  payload: ReportTokenPayload,
): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = signPayload(apiKey, encoded);
  return `${encoded}.${signature}`;
}

export function verifyReportToken(
  apiKey: string,
  token: string | undefined,
): ReportTokenPayload | null {
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [encoded, signature] = parts as [string, string];
  const expected = signPayload(apiKey, encoded);
  if (!safeEqual(expected, signature)) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<ReportTokenPayload>;
    if (
      typeof parsed.project_id !== "string" ||
      parsed.project_id.length === 0 ||
      typeof parsed.run_id !== "string" ||
      parsed.run_id.length === 0
    ) {
      return null;
    }
    return {
      project_id: parsed.project_id,
      run_id: parsed.run_id,
    };
  } catch {
    return null;
  }
}

export function buildReportUrl(
  baseUrl: string,
  apiKey: string,
  payload: ReportTokenPayload,
): string {
  const url = new URL("/report", baseUrl);
  url.searchParams.set("token", signReportToken(apiKey, payload));
  return url.toString();
}
