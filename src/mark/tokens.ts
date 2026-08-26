import { createHmac, timingSafeEqual } from "node:crypto";

export function signMarkToken(apiKey: string, evalSetId: string): string {
  return createHmac("sha256", apiKey).update(`mark:${evalSetId}`).digest("hex");
}

export function verifyMarkToken(
  apiKey: string,
  evalSetId: string,
  token: string | undefined,
): boolean {
  if (typeof token !== "string" || token.length === 0) {
    return false;
  }
  const expected = signMarkToken(apiKey, evalSetId);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function buildMarkUrl(
  baseUrl: string,
  evalSetId: string,
  token: string,
  personId?: string,
): string {
  const url = new URL("/mark", baseUrl);
  url.searchParams.set("eval_set_id", evalSetId);
  url.searchParams.set("token", token);
  if (personId) {
    url.searchParams.set("person_id", personId);
  }
  return url.toString();
}

export function buildThirdMarkUrl(
  baseUrl: string,
  evalSetId: string,
  evalId: string,
  token: string,
  personId: string,
): string {
  const url = new URL("/mark/third", baseUrl);
  url.searchParams.set("eval_set_id", evalSetId);
  url.searchParams.set("eval_id", evalId);
  url.searchParams.set("token", token);
  url.searchParams.set("person_id", personId);
  return url.toString();
}
