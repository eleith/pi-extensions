import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopTransport } from "./transports.ts";

type Execute = NonNullable<ConstructorParameters<typeof DesktopTransport>[0]>;
const message = { title: "π · session", body: "Ready for input" };

beforeEach(() => {
  vi.stubEnv("TMUX", "");
  vi.stubEnv("TMUX_PANE", "");
  vi.stubEnv("TERM", "xterm-256color");
});
afterEach(() => vi.unstubAllEnvs());

function setup() {
  const execute = vi.fn<Execute>().mockResolvedValue({ stdout: "" });
  const write = vi.fn(() => true);
  const signal = new AbortController();
  return { execute, write, signal, transport: new DesktopTransport(execute, write) };
}

describe("notification transports", () => {
  it("delivers notify-send with argument boundaries and bounded, cancellable execution", async () => {
    const { transport, execute, write, signal } = setup();
    expect(await transport.deliver(message, signal.signal)).toBe("notify-send");
    expect(execute).toHaveBeenCalledWith(
      "notify-send",
      [
        "--app-name=Pi",
        "--icon=utilities-terminal",
        "--expire-time=8000",
        "--transient",
        "--",
        message.title,
        message.body,
      ],
      {
        timeout: 3000,
        maxBuffer: 4096,
        signal: signal.signal,
        killSignal: "SIGKILL",
        encoding: "utf8",
      },
    );
    expect(write).not.toHaveBeenCalled();
  });

  it.each([false, true])("falls back to sanitized OSC 777, tmux=%s", async (tmux) => {
    const { transport, execute, write, signal } = setup();
    vi.stubEnv("TMUX", tmux ? "tmux-session" : "");
    execute.mockRejectedValue(new Error("notify-send unavailable or timed out"));
    const dirty = { title: "title;\x1b\x07\x9c", body: "body;\n\x9f" };
    expect(await transport.deliver(dirty, signal.signal)).toBe("osc777");
    const sequence = "\x1b]777;notify;title,;body,\x07";
    expect(write).toHaveBeenCalledWith(
      tmux ? `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\` : sequence,
    );
  });

  it("returns none when notify-send and the terminal are unavailable", async () => {
    const { transport, execute, write, signal } = setup();
    execute.mockRejectedValue(new Error("notify-send unavailable"));
    write.mockReturnValue(false);
    expect(await transport.deliver(message, signal.signal)).toBe("none");
  });

  it("looks up a valid tmux pane with a one-second deadline", async () => {
    const { transport, execute, signal } = setup();
    vi.stubEnv("TMUX_PANE", "%7");
    execute.mockResolvedValue({ stdout: " pane title\n" });
    expect(await transport.paneTitle(signal.signal)).toBe("pane title");
    expect(execute).toHaveBeenCalledWith(
      "tmux",
      ["display-message", "-p", "-t", "%7", "#{pane_title}"],
      {
        timeout: 1000,
        maxBuffer: 4096,
        signal: signal.signal,
        killSignal: "SIGKILL",
        encoding: "utf8",
      },
    );
  });

  it.each(["--other-option", "%7\n", "%other"])(
    "does not pass invalid pane identifier %j",
    async (pane) => {
      const { transport, execute, signal } = setup();
      vi.stubEnv("TMUX_PANE", pane);
      await transport.paneTitle(signal.signal);
      expect(execute.mock.calls[0]?.[1]).toEqual(["display-message", "-p", "#{pane_title}"]);
    },
  );

  it("skips pane discovery outside tmux and tolerates missing tmux", async () => {
    const { transport, execute, signal } = setup();
    expect(await transport.paneTitle(signal.signal)).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    vi.stubEnv("TERM", "tmux-256color");
    execute.mockRejectedValue(new Error("tmux unavailable"));
    expect(await transport.paneTitle(signal.signal)).toBeUndefined();
  });

  it("does not spawn or write for an already cancelled request", async () => {
    const { transport, execute, write, signal } = setup();
    signal.abort();
    expect(await transport.paneTitle(signal.signal)).toBeUndefined();
    expect(await transport.deliver(message, signal.signal)).toBe("none");
    expect(execute).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("does not use the terminal fallback after aborting an active child", async () => {
    const { transport, execute, write, signal } = setup();
    execute.mockImplementation(
      (_command, _args, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const pending = transport.deliver(message, signal.signal);
    signal.abort();
    expect(await pending).toBe("none");
    expect(write).not.toHaveBeenCalled();
  });
});
