import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RenderingState } from "./state.ts";
import { WorkingController } from "./working-controller.ts";

export class ToolRenderingController {
  readonly state = new RenderingState();
  readonly working = new WorkingController();

  command(action: string, ctx: Pick<ExtensionContext, "ui">): void {
    if (action === "show") this.state.enabled = true;
    else if (action === "hide") this.state.enabled = false;
    else this.state.enabled = !this.state.enabled;
    this.state.nativeBash.clear(true);
    if (!this.state.enabled) this.state.bashTiming.pause();
    ctx.ui.notify(`Tool rendering chrome: ${this.state.enabled ? "shown" : "hidden"}`, "info");
  }

  sessionStarted(): void {
    this.state.nativeBash.clear();
    this.state.bashTiming.clear();
    this.working.sessionStarted();
  }

  settled(ctx: ExtensionContext): void {
    this.state.nativeBash.clear();
    this.state.bashTiming.clear();
    this.working.settled(ctx);
  }

  dispose(ctx: ExtensionContext): void {
    this.state.nativeBash.dispose();
    this.state.bashTiming.dispose();
    this.working.dispose(ctx);
  }
}
