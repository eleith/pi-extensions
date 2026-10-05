import type { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { builtinContext } from "./frame.ts";

type BuiltinBash = ReturnType<typeof createBashToolDefinition>;
type RenderCall = NonNullable<BuiltinBash["renderCall"]>;
type RenderResult = NonNullable<BuiltinBash["renderResult"]>;
type Context = Parameters<RenderResult>[3];
type Options = Parameters<RenderResult>[1];
type Theme = Parameters<RenderResult>[2];

// Native renderer state is opaque. Only Pi's renderers read or change its contents.
type NativeRowState = Context["state"];
interface LastResult {
  renderer: RenderResult;
  result: Parameters<RenderResult>[0];
  options: Options;
  theme: Theme;
  context: Context;
}
interface NativeState {
  owner: NativeBash;
  generation: number;
  alive: boolean;
  restartable: boolean;
  state: NativeRowState;
  invalidate?: () => void;
  lastResult?: LastResult;
}
const nativeKey = Symbol("tool-rendering.nativeBash");
type RowState = { [nativeKey]?: NativeState };
const noop = (): void => {};

/** Own native rendering lifetimes without depending on native timer/state internals. */
export class NativeBash {
  private readonly active = new Map<string, NativeState>();
  private readonly suspended = new Map<string, NativeState>();
  private generation = 0;
  private disposed = false;

  renderCall(
    renderer: RenderCall | undefined,
    args: Parameters<RenderCall>[0],
    theme: Theme,
    context: Context,
  ): Component {
    if (!renderer) return new Text("", 0, 0);
    const row = this.row(context, context.executionStarted);
    const captured = this.capture(context, row);
    if (captured.executionStarted) this.activate(captured.toolCallId, row);
    return renderer(args, theme, captured);
  }

  renderResult(
    renderer: RenderResult | undefined,
    result: Parameters<RenderResult>[0],
    options: Options,
    theme: Theme,
    context: Context,
  ): Component {
    if (!renderer) return new Text("", 0, 0);
    const row = this.row(
      context,
      context.executionStarted && options.isPartial && !context.isError,
    );
    const captured = this.capture(context, row);
    const capturedOptions: Options = {
      expanded: options.expanded,
      isPartial: options.isPartial && row.alive && !this.disposed,
    };
    const running =
      capturedOptions.isPartial &&
      !captured.isError &&
      (captured.executionStarted || this.active.get(captured.toolCallId) === row);
    if (running) {
      this.activate(captured.toolCallId, row);
      // Save only plain public values, never the host's live render context or component.
      row.lastResult = {
        renderer,
        result,
        options: { ...capturedOptions, isPartial: false },
        theme,
        context: { ...captured, isPartial: false, lastComponent: undefined, invalidate: noop },
      };
    }
    const component = renderer(result, capturedOptions, theme, captured);
    if (!capturedOptions.isPartial || captured.isError) this.retire(captured.toolCallId, row);
    return component;
  }

  stop(toolCallId: string): void {
    const row = this.active.get(toolCallId) ?? this.suspended.get(toolCallId);
    if (row) this.finish(toolCallId, row);
  }

  clear(restartable = false): void {
    for (const [toolCallId, row] of [...this.active, ...this.suspended]) {
      this.finish(toolCallId, row);
      // A mode toggle may resume a row; lifecycle cleanup must freeze stale partial rows.
      if (restartable) row.state = {} as NativeRowState;
      row.restartable = restartable;
      if (restartable) this.suspended.set(toolCallId, row);
    }
    this.generation++;
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private row(context: Context, restarting: boolean): NativeState {
    const state = context.state as RowState;
    let row = state[nativeKey];
    if (
      !row ||
      row.owner !== this ||
      (!this.disposed &&
        restarting &&
        (row.restartable || (row.alive && row.generation !== this.generation)))
    ) {
      row = {
        owner: this,
        generation: this.generation,
        alive: !this.disposed,
        restartable: false,
        state: {} as NativeRowState,
      };
      state[nativeKey] = row;
    }
    return row;
  }

  private capture(context: Context, row: NativeState): Context {
    const {
      args,
      toolCallId,
      cwd,
      invalidate,
      lastComponent,
      executionStarted,
      argsComplete,
      isPartial,
      expanded,
      showImages,
      isError,
    } = context;
    row.invalidate = row.alive && !this.disposed ? invalidate : undefined;
    const generation = row.generation;
    return builtinContext({
      args,
      toolCallId,
      cwd,
      state: row.state,
      lastComponent,
      executionStarted: executionStarted && row.alive && !this.disposed,
      argsComplete,
      isPartial: isPartial && row.alive && !this.disposed,
      expanded,
      showImages,
      isError,
      invalidate: () => {
        if (
          this.disposed ||
          row.owner !== this ||
          generation !== this.generation ||
          !row.alive ||
          this.active.get(toolCallId) !== row
        )
          return;
        const capturedInvalidate = row.invalidate;
        capturedInvalidate?.();
      },
    });
  }

  private activate(toolCallId: string, row: NativeState): void {
    const previous = this.active.get(toolCallId) ?? this.suspended.get(toolCallId);
    if (previous && previous !== row) this.finish(toolCallId, previous);
    this.active.set(toolCallId, row);
  }

  private retire(toolCallId: string, row: NativeState): void {
    row.alive = false;
    row.restartable = false;
    row.invalidate = undefined;
    row.lastResult = undefined;
    if (this.active.get(toolCallId) === row) this.active.delete(toolCallId);
    if (this.suspended.get(toolCallId) === row) this.suspended.delete(toolCallId);
  }

  private finish(toolCallId: string, row: NativeState): void {
    const last = row.lastResult;
    this.retire(toolCallId, row);
    // A normal final render is the public native cleanup contract.
    if (last) last.renderer(last.result, last.options, last.theme, last.context);
  }
}
