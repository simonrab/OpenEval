export type RetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;

/** Rate limits, timeouts, server errors, and network errors can pass on a retry. */
export function isRetryableModelError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const match = /^OpenRouter (\d{3}):/.exec(message);
  if (!match) {
    return true;
  }
  const status = Number(match[1]);
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/** Retry with exponential backoff and full jitter. Returns the attempt count too. */
export async function withRetries<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<{ ok: true; value: T; attempts: number } | { ok: false; error: unknown; attempts: number }> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { ok: true, value: await fn(), attempts: attempt };
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isRetryableModelError(err)) {
        return { ok: false, error: err, attempts: attempt };
      }
      if (base > 0) {
        await sleep(Math.random() * base * 2 ** (attempt - 1));
      }
    }
  }
  return { ok: false, error: lastError, attempts };
}
