import { BashTiming } from "./bash-timing.ts";

/** One set of controls and row timers per extension factory, never module-global. */
export class RenderingState {
  enabled = true;
  readonly bashTiming = new BashTiming();
}
