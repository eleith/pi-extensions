import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WorkingTimeTracker, workingMessage } from "./working-time.ts";

type WorkingContext = Pick<ExtensionContext, "mode"> & {
  ui: Pick<ExtensionContext["ui"], "setWorkingMessage">;
};

/** The working label counts model segments, excluding time spent executing tools. */
export class WorkingController {
  private readonly tracker = new WorkingTimeTracker();
  private tick: ReturnType<typeof setInterval> | undefined;
  private generation = 0;
  private disposed = false;

  sessionStarted(): void {
    this.stopTick();
    this.tracker.settle();
  }

  beforeAgentStart(): void {
    if (this.disposed) return;
    this.stopTick();
    this.tracker.beginRun();
  }

  agentStarted(): void {
    if (!this.disposed) this.tracker.ensureRun();
  }

  beforeProviderRequest(ctx: WorkingContext): void {
    if (this.disposed) return;
    this.tracker.beginModelSegment();
    this.stopTick();
    if (ctx.mode !== "tui") return;
    const generation = this.generation;
    const update = (): void => {
      if (this.disposed || generation !== this.generation) return;
      ctx.ui.setWorkingMessage(workingMessage(this.tracker.modelMs()));
    };
    update();
    this.tick = setInterval(update, 1000);
  }

  messageEnded(role: string): void {
    if (this.disposed || role !== "assistant") return;
    this.tracker.endModelSegment();
    this.stopTick();
  }

  settled(ctx: WorkingContext): void {
    this.stopTick();
    if (!this.disposed && ctx.mode === "tui") ctx.ui.setWorkingMessage();
    this.tracker.settle();
  }

  dispose(ctx: WorkingContext): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTick();
    this.tracker.settle();
    if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
  }

  private stopTick(): void {
    this.generation++;
    if (this.tick !== undefined) clearInterval(this.tick);
    this.tick = undefined;
  }
}
