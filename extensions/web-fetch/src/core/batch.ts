import { LIMITS } from "./limits.ts";
import { limitContent } from "./format.ts";
import { executeFetch, failure, validateInput, type FetchDependencies } from "./fetch.ts";
import { TransportError, type ByteBudget } from "./transport.ts";
import type { BatchResult, FetchHooks, FetchInput, FetchPhase, FetchResult } from "./types.ts";

export interface BatchDependencies {
  execute?: (
    input: FetchInput,
    hooks: FetchHooks,
    dependencies: FetchDependencies,
  ) => Promise<FetchResult>;
  byteLimit?: number;
  concurrency?: number;
}

/** Ordered outcomes, bounded workers and shared accepted-byte budget; not a native socket quota. */
export async function executeBatch(
  requests: FetchInput[],
  hooks: FetchHooks = {},
  dependencies: BatchDependencies = {},
): Promise<BatchResult> {
  const startedAt = Date.now();
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > LIMITS.maxRequests) {
    const error = failure(
      {},
      new TransportError(
        "invalid_request",
        `Provide between 1 and ${LIMITS.maxRequests} requests.`,
      ),
    );
    return {
      kind: "batch",
      items: [error],
      total: 1,
      succeeded: 0,
      failed: 1,
      cancelled: false,
      truncated: false,
    };
  }
  const items = requests.map((request) =>
    failure(request, new TransportError("cancelled", "Request did not start.")),
  );
  const validated = requests.map((request, index) => {
    try {
      return validateInput(request);
    } catch (error) {
      items[index] = failure(request, error);
      return undefined;
    }
  });
  const budget: ByteBudget = { used: 0, limit: dependencies.byteLimit ?? LIMITS.batchBytes };
  const execute = dependencies.execute ?? executeFetch;
  let next = 0;
  let completed = validated.filter((request) => !request).length;
  let phase: FetchPhase = "connecting";
  const worker = async () => {
    while (next < requests.length) {
      const index = next++;
      const request = validated[index];
      if (!request) continue;
      if (hooks.signal?.aborted) {
        items[index] = failure(
          request,
          new TransportError("cancelled", "Request cancelled before starting."),
        );
        completed++;
        continue;
      }
      if (budget.used >= budget.limit) {
        items[index] = failure(
          request,
          new TransportError("limit", "Batch accepted-byte budget exhausted."),
        );
        completed++;
        continue;
      }
      try {
        items[index] = await execute(
          request,
          {
            signal: hooks.signal,
            onProgress(progress) {
              phase = progress.phase;
              hooks.onProgress?.({ ...progress, completed, total: requests.length });
            },
          },
          { budget, deadlineAt: startedAt + request.timeoutMs },
        );
      } catch (error) {
        items[index] = failure(request, error);
      }
      completed++;
      hooks.onProgress?.({ phase, completed, total: requests.length });
    }
  };
  const concurrency = Math.max(
    1,
    Math.min(LIMITS.batchConcurrency, dependencies.concurrency ?? LIMITS.batchConcurrency),
  );
  await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, worker));
  let remaining = LIMITS.batchChars;
  let truncated = false;
  // Allocate content in input order, not arrival order. Metadata/one summary per item stays available.
  for (const [index, item] of items.entries()) {
    if (item.kind !== "content") continue;
    if (item.content.length > remaining) {
      // Keep partial raw/JSON/HTML as data; notices belong in metadata, not invented body bytes.
      const limited = limitContent(item.content, remaining, validated[index]?.format ?? "markdown");
      item.content = limited.content;
      item.truncated = true;
      if (item.warnings.length < 3)
        item.warnings.push("Batch output budget reached; this item is incomplete.");
      truncated = true;
    }
    remaining -= item.content.length;
    truncated ||= item.truncated;
  }
  const succeeded = items.filter((item) => item.kind !== "error").length;
  return {
    kind: "batch",
    items,
    total: items.length,
    succeeded,
    failed: items.length - succeeded,
    cancelled:
      Boolean(hooks.signal?.aborted) ||
      items.some((item) => item.kind === "error" && item.code === "cancelled"),
    truncated,
  };
}
