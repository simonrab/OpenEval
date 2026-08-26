import { createHmac, timingSafeEqual } from "node:crypto";

export function signSampleToken(apiKey: string, sampleId: string): string {
  return createHmac("sha256", apiKey)
    .update(`sample:${sampleId}`)
    .digest("hex");
}

export function verifySampleToken(
  apiKey: string,
  sampleId: string,
  token: string | undefined,
): boolean {
  if (typeof token !== "string" || token.length === 0) {
    return false;
  }
  const expected = signSampleToken(apiKey, sampleId);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function buildSampleUrl(
  baseUrl: string,
  sampleId: string,
  token: string,
): string {
  const url = new URL("/sample", baseUrl);
  url.searchParams.set("sample_id", sampleId);
  url.searchParams.set("token", token);
  return url.toString();
}
