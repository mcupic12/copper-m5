// Checks the Google key with one tiny call before the golden set runs, so a
// wrong key fails the eval in seconds instead of after retrying every
// question. It goes through lib/ai/call.ts like every AI call:
// { module: 5, feature: "eval-key-check" }.
import { callText } from "@/lib/ai/call";

// A free key's daily limit (e.g. 500 requests a day per model) won't pass
// during the run: it resets at midnight Pacific time.
const DAILY_LIMIT = /per ?day/i;

/** True for problems that may pass on their own (rate limits, server errors). */
function mayPass(error: unknown): boolean {
  const e = error as {
    isRetryable?: boolean;
    lastError?: unknown;
    message?: string;
  } | null;
  if (DAILY_LIMIT.test(String(e?.message ?? ""))) return false;
  return (
    Boolean(e?.isRetryable) || (e?.lastError != null && mayPass(e.lastError))
  );
}

/** Why Google won't take the key, or null when it works (or the problem may pass). */
export async function modelKeyProblem(): Promise<string | null> {
  try {
    await callText(
      { module: 5, feature: "eval-key-check" },
      { prompt: "Reply with the word OK.", maxRetries: 1 },
    );
    return null;
  } catch (error) {
    // The run retries rate limits and server errors itself.
    if (mayPass(error)) return null;
    return error instanceof Error ? error.message : String(error);
  }
}
