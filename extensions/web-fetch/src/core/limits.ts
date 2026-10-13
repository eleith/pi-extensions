// Deliberately bounded defaults, not a user-configurable policy framework.
export const LIMITS = {
  defaultMaxChars: 50_000,
  maxChars: 100_000,
  defaultTimeoutMs: 15_000,
  maxTimeoutMs: 120_000,
  maxUrlChars: 8_192,
  textBytes: 2 * 1024 * 1024,
  downloadBytes: 32 * 1024 * 1024,
  requestBytes: 40 * 1024 * 1024,
  batchBytes: 64 * 1024 * 1024,
  batchChars: 200_000,
  // Includes the structured/text copies and worst-case bounded canonical source metadata.
  toolOutputChars: 3_000_000,
  maxRequests: 24,
  batchConcurrency: 4,
  networkConcurrency: 8,
  maxPending: 96,
  maxHops: 8,
  maxSecondaryRequests: 16,
  maxMetadataChars: 512,
  maxFilePathChars: 4096,
} as const;
