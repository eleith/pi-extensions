import type { createBashToolDefinition } from "@earendil-works/pi-coding-agent";

type RenderResult = NonNullable<ReturnType<typeof createBashToolDefinition>["renderResult"]>;
type Context = Parameters<RenderResult>[3];
type Options = Parameters<RenderResult>[1];

const timingKey = Symbol("tool-rendering.bashTiming");
interface Timing {
  owner: BashTiming;
  generation: number;
  startedAt: number;
  endedAt?: number;
  interval?: ReturnType<typeof setInterval>;
  invalidate?: () => void;
}
type TimingState = { [timingKey]?: Timing };

/** Read-only paint path: drawing/resizing must never start or settle a timer. */
export function bashElapsed(state: object): number | undefined {
  const timing = (state as TimingState)[timingKey];
  return timing ? (timing.endedAt ?? Date.now()) - timing.startedAt : undefined;
}

/** Timers belong to one extension instance; completed times belong to their rows. */
export class BashTiming {
  private readonly active = new Map<string, Timing>();
  private generation = 0;
  private disposed = false;

  update(context: Context, options: Options): number | undefined {
    const state = context.state as TimingState;
    const running = context.executionStarted && Boolean(options.isPartial) && !context.isError;
    let timing = state[timingKey];
    if (!this.disposed && context.executionStarted && (!timing || timing.owner !== this)) {
      timing = { owner: this, generation: this.generation, startedAt: Date.now() };
      state[timingKey] = timing;
    }
    if (!timing || timing.owner !== this || this.disposed || timing.generation !== this.generation)
      return bashElapsed(state);

    if (!running) {
      this.settle(timing);
      if (this.active.get(context.toolCallId) === timing) this.active.delete(context.toolCallId);
    } else if (timing.endedAt === undefined && timing.interval === undefined) {
      // Retain only the invalidator, never the render context (or its host lifetime).
      const { toolCallId, invalidate } = context;
      const previous = this.active.get(toolCallId);
      if (previous && previous !== timing) this.settle(previous);
      timing.invalidate = invalidate;
      const record = timing;
      const generation = this.generation;
      record.interval = setInterval(() => {
        if (
          this.disposed ||
          generation !== this.generation ||
          record.endedAt !== undefined ||
          this.active.get(toolCallId) !== record
        )
          return;
        record.invalidate?.();
      }, 1000);
      this.active.set(toolCallId, record);
    } else if (timing.endedAt === undefined) {
      timing.invalidate = context.invalidate;
    }
    return bashElapsed(state);
  }

  stop(toolCallId: string): void {
    const timing = this.active.get(toolCallId);
    if (!timing) return;
    this.settle(timing);
    this.active.delete(toolCallId);
  }

  clear(): void {
    for (const timing of this.active.values()) this.settle(timing);
    this.active.clear();
    this.generation++;
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
  }

  private settle(timing: Timing): void {
    timing.endedAt ??= Date.now();
    if (timing.interval !== undefined) clearInterval(timing.interval);
    timing.interval = undefined;
    timing.invalidate = undefined;
  }
}
