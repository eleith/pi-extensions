import { collect } from "./data.ts";
import { ENTRY_TYPE, type TreeSize, type WelcomeAPI, type WelcomeHost } from "./types.ts";

type Collector = (
  pi: WelcomeAPI,
  ctx: WelcomeHost,
  signal: AbortSignal,
) => ReturnType<typeof collect>;

export class WelcomeController {
  private disposed = false;
  private pending: AbortController | undefined;
  private startedSession: string | undefined;

  constructor(
    private readonly pi: WelcomeAPI,
    private readonly getData: Collector = collect,
  ) {}

  async sessionStarted(ctx: WelcomeHost): Promise<void> {
    if (this.disposed || ctx.mode !== "tui") return;
    this.cancelPending();
    const sessionId = ctx.sessionManager.getSessionId();
    if (this.startedSession === sessionId) return;
    if (this.hasStartupOrMessages(ctx)) {
      this.startedSession = sessionId;
      return;
    }
    if (await this.appendCard(ctx, "auto", true)) this.startedSession = sessionId;
  }

  async show(ctx: WelcomeHost, size: TreeSize = "auto"): Promise<void> {
    if (this.disposed || ctx.mode !== "tui") return;
    await this.appendCard(ctx, size, false);
  }

  sessionChanged(): void {
    this.cancelPending();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPending();
  }

  private async appendCard(ctx: WelcomeHost, size: TreeSize, startup: boolean): Promise<boolean> {
    const sessionId = ctx.sessionManager.getSessionId();
    const leafId = ctx.sessionManager.getLeafId();
    const cwd = ctx.cwd;
    this.cancelPending();
    const request = new AbortController();
    this.pending = request;
    try {
      const data = await this.getData(this.pi, ctx, request.signal);
      if (request.signal.aborted || this.disposed) return false;
      if (ctx.sessionManager.getSessionId() !== sessionId || ctx.cwd !== cwd) return false;
      // The leaf changes before session_tree listeners run; cancellation alone can arrive late.
      if (ctx.sessionManager.getLeafId() !== leafId) return false;
      if (startup && this.hasStartupOrMessages(ctx)) return false;
      this.pi.appendEntry(ENTRY_TYPE, { ...data, treeSize: size });
      return true;
    } finally {
      if (this.pending === request) this.pending = undefined;
    }
  }

  private hasStartupOrMessages(ctx: WelcomeHost): boolean {
    return (
      ctx.sessionManager
        .getEntries()
        .some((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE) ||
      ctx.sessionManager.getBranch().some((entry) => entry.type === "message")
    );
  }

  private cancelPending(): void {
    this.pending?.abort();
    this.pending = undefined;
  }
}
