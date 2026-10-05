export class WorkingTimeTracker {
  private runActive = false;
  private segmentStartMs: number | undefined;
  private accumulatedModelMs = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  beginRun(): void {
    this.runActive = true;
    this.segmentStartMs = undefined;
    this.accumulatedModelMs = 0;
  }

  ensureRun(): void {
    if (!this.runActive) this.beginRun();
  }

  beginModelSegment(): void {
    this.ensureRun();
    this.segmentStartMs ??= this.now();
  }

  endModelSegment(): void {
    if (this.segmentStartMs === undefined) return;
    this.accumulatedModelMs += Math.max(0, this.now() - this.segmentStartMs);
    this.segmentStartMs = undefined;
  }

  modelMs(): number {
    const openSegmentMs =
      this.segmentStartMs === undefined ? 0 : Math.max(0, this.now() - this.segmentStartMs);
    return this.accumulatedModelMs + openSegmentMs;
  }

  settle(): void {
    this.endModelSegment();
    this.runActive = false;
    this.segmentStartMs = undefined;
    this.accumulatedModelMs = 0;
  }
}

export function workingMessage(modelMs: number): string {
  return `Working... (${formatClock(modelMs)})`;
}

export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, ms) / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const wholeSeconds = Math.floor(totalSeconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const seconds = wholeSeconds % 60;
  let out = "";
  if (hours > 0) out += `${hours}h`;
  if (hours > 0 || minutes > 0) out += `${minutes}m`;
  return `${out}${seconds}s`;
}
