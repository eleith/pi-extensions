const MAX_ADDITIONAL_BUCKETS = 8;
const MAX_LABEL_LENGTH = 64;
const NUMBERS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

type JsonObject = Record<string, unknown>;

interface UsageSections {
  plan: string | undefined;
  codex: JsonObject | undefined;
  includeCodeReview: boolean;
  codeReview: JsonObject | undefined;
  additional: unknown[] | undefined;
  credits: JsonObject | undefined;
  spendingLimitReached: boolean;
  accountLimit: string | undefined;
}

/** Account allowance only; this is not Pi's context occupancy or a cost estimate. */
export function formatCodexUsage(value: unknown, now = Date.now()): string | undefined {
  const sections = readUsageSections(value);
  if (!sections) return undefined;

  const buckets = [{ name: "Codex", bucket: sections.codex }];
  if (sections.includeCodeReview) {
    buckets.push({ name: "Code review", bucket: sections.codeReview });
  }
  buckets.push(...additionalBuckets(sections.additional));

  const rows = ["codex account usage · openai-codex", `Plan: ${sections.plan ?? "unknown"}`];
  const warnings: string[] = [];
  if (sections.spendingLimitReached) warnings.push("Workspace spending limit: reached");
  if (sections.accountLimit)
    warnings.push(`Account limit: ${sections.accountLimit.replaceAll("_", " ")}`);
  for (const { name, bucket } of buckets) {
    const restrictions: string[] = [];
    if (bucket?.limit_reached === true) restrictions.push("limit reached");
    if (bucket?.allowed === false) restrictions.push("requests not currently allowed");
    if (restrictions.length) warnings.push(`${name}: ${restrictions.join("; ")}`);
  }
  if (warnings.length) rows.push("", ...warnings);
  if (sections.credits) rows.push(`Credits: ${creditStatus(sections.credits)}`);

  const notReported: string[] = [];
  for (const { name, bucket } of buckets) {
    const quotaRows = bucketRows(name, bucket, now);
    if (quotaRows.length) rows.push("", ...quotaRows);
    else notReported.push(`${name} quota`);
  }
  if (!sections.credits) notReported.push("credits");
  if (notReported.length) rows.push("", `Not reported: ${notReported.join(", ")}.`);
  if (sections.additional && sections.additional.length > MAX_ADDITIONAL_BUCKETS) {
    rows.push(
      "",
      `${sections.additional.length - MAX_ADDITIONAL_BUCKETS} additional entries omitted.`,
    );
  }
  return rows.join("\n");
}

function readUsageSections(value: unknown): UsageSections | undefined {
  const payload = readObject(value);
  if (!payload) return undefined;

  const plan = sanitizeDisplayLabel(payload.plan_type);
  const codex = readObject(payload.rate_limit);
  const codeReview = readObject(payload.code_review_rate_limit);
  const credits = readObject(payload.credits);
  const spendingControl = readObject(payload.spend_control);
  const reachedLimit = readObject(payload.rate_limit_reached_type);
  const additional = Array.isArray(payload.additional_rate_limits)
    ? payload.additional_rate_limits
    : undefined;
  const hasUsageData = [
    plan,
    codex,
    codeReview,
    credits,
    spendingControl,
    reachedLimit,
    additional,
  ].some((section) => section !== undefined);
  if (!hasUsageData) return undefined;

  const includeCodeReview = "code_review_rate_limit" in payload;
  const spendingLimitReached = spendingControl?.reached === true;
  const accountLimit = sanitizeDisplayLabel(reachedLimit?.type);
  return {
    plan,
    codex,
    includeCodeReview,
    codeReview,
    additional,
    credits,
    spendingLimitReached,
    accountLimit,
  };
}

function bucketRows(name: string, bucket: JsonObject | undefined, now: number): string[] {
  if (!bucket || (!readObject(bucket.primary_window) && !readObject(bucket.secondary_window)))
    return [];
  return [
    name,
    ...windowRows("Primary", bucket.primary_window, now),
    ...windowRows("Secondary", bucket.secondary_window, now),
  ];
}

function windowRows(name: string, value: unknown, now: number): string[] {
  const window = readObject(value);
  if (!window) return [`  ${name} window: not reported`];

  const seconds = finiteNonnegativeNumber(window.limit_window_seconds);
  let label = `${name} window (duration not reported)`;
  if (seconds !== undefined && Number.isSafeInteger(seconds) && seconds > 0)
    label = `${duration(seconds)} window`;
  const used = finiteNonnegativeNumber(window.used_percent);
  let usage = "remaining not reported";
  if (used !== undefined && used <= 100) {
    usage = `${NUMBERS.format(100 - used)}% remaining (${NUMBERS.format(used)}% used)`;
  }
  return [`  ${label}: ${usage}`, `    Resets: ${resetTime(window, now)}`];
}

function additionalBuckets(
  additional: unknown[] | undefined,
): { name: string; bucket: JsonObject | undefined }[] {
  return (additional ?? []).slice(0, MAX_ADDITIONAL_BUCKETS).map((value, index) => {
    const entry = readObject(value);
    const name =
      sanitizeDisplayLabel(entry?.limit_name) ??
      sanitizeDisplayLabel(entry?.metered_feature) ??
      `Additional ${index + 1}`;
    return { name, bucket: readObject(entry?.rate_limit) };
  });
}

function creditStatus(credits: JsonObject | undefined): string {
  if (!credits) return "not reported";
  if (credits.unlimited === true) {
    return credits.has_credits === false ? "unlimited (unavailable)" : "unlimited";
  }
  let availability = "availability unknown";
  if (credits.has_credits === true) availability = "available";
  else if (credits.has_credits === false) availability = "unavailable";
  const balance = parseCreditBalance(credits.balance);
  if (balance === undefined) return `${availability}; balance not reported`;
  return `${NUMBERS.format(balance)} balance (${availability})`;
}

function parseCreditBalance(value: unknown): number | undefined {
  if (typeof value === "number") return finiteNonnegativeNumber(value);
  if (typeof value !== "string") return undefined;
  const decimal = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(decimal)) return undefined;
  return finiteNonnegativeNumber(Number(decimal));
}

function resetTime(window: JsonObject, now: number): string {
  const absolute = finiteNonnegativeNumber(window.reset_at);
  const relative = finiteNonnegativeNumber(window.reset_after_seconds);
  let timestamp = NaN;
  if (absolute !== undefined) timestamp = absolute * 1000;
  else if (relative !== undefined) timestamp = now + relative * 1000;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "unknown";
  const time = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(date);
  const remaining = Math.ceil((timestamp - now) / 1000);
  return remaining > 0
    ? `${time} (in ${duration(remaining)})`
    : `${time} (reset time passed; refresh usage)`;
}

function duration(seconds: number): string {
  let remaining = Math.ceil(seconds);
  const parts: string[] = [];
  for (const [unit, size] of [
    ["d", 86_400],
    ["h", 3600],
    ["m", 60],
    ["s", 1],
  ] as const) {
    const amount = Math.floor(remaining / size);
    if (amount > 0) parts.push(`${amount}${unit}`);
    remaining %= size;
  }
  return parts.join(" ") || "0s";
}

function readObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function sanitizeDisplayLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return (
    value
      // oxlint-disable-next-line no-control-regex -- Strip terminal controls from backend labels.
      .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_LABEL_LENGTH) || undefined
  );
}

function finiteNonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
