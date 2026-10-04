import { execFile } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { promisify } from "node:util";
import type { NotificationMessage } from "./message.ts";

const runFile = promisify(execFile);
const ESC = "\x1b";
const BEL = "\x07";

export type Delivery = "notify-send" | "osc777" | "none";

export interface NotificationTransport {
  paneTitle(signal: AbortSignal): Promise<string | undefined>;
  deliver(message: NotificationMessage, signal: AbortSignal): Promise<Delivery>;
}

type ExecuteFile = (
  command: string,
  args: string[],
  options: {
    timeout: number;
    maxBuffer: number;
    signal: AbortSignal;
    killSignal: "SIGKILL";
    encoding: "utf8";
  },
) => Promise<{ stdout: string }>;

export class DesktopTransport implements NotificationTransport {
  constructor(
    private readonly execute: ExecuteFile = runFile,
    private readonly writeTerminal: (sequence: string) => boolean = writeToTerminal,
  ) {}

  async paneTitle(signal: AbortSignal): Promise<string | undefined> {
    if (signal.aborted || !isTmuxTerminal()) return undefined;
    const pane = process.env.TMUX_PANE;
    const args = [
      "display-message",
      "-p",
      ...(pane && pane === pane.trim() && /^%\d+$/.test(pane) ? ["-t", pane] : []),
      "#{pane_title}",
    ];
    try {
      const { stdout } = await this.execute("tmux", args, {
        timeout: 1_000,
        maxBuffer: 4_096,
        signal,
        killSignal: "SIGKILL",
        encoding: "utf8",
      });
      return signal.aborted ? undefined : stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async deliver(message: NotificationMessage, signal: AbortSignal): Promise<Delivery> {
    if (signal.aborted) return "none";
    try {
      await this.execute(
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
        { timeout: 3_000, maxBuffer: 4_096, signal, killSignal: "SIGKILL", encoding: "utf8" },
      );
      return signal.aborted ? "none" : "notify-send";
    } catch {
      if (signal.aborted) return "none";
      const sequence = wrapForTmux(osc777(message.title, message.body));
      return this.writeTerminal(sequence) ? "osc777" : "none";
    }
  }
}

function osc777(title: string, body: string): string {
  return `${ESC}]777;notify;${sanitizeField(title)};${sanitizeField(body)}${BEL}`;
}

function wrapForTmux(sequence: string): string {
  if (!isTmuxTerminal()) return sequence;
  return `${ESC}Ptmux;${sequence.replaceAll(ESC, `${ESC}${ESC}`)}${ESC}\\`;
}

function isTmuxTerminal(): boolean {
  return Boolean(process.env.TMUX || process.env.TMUX_PANE || process.env.TERM?.startsWith("tmux"));
}

function sanitizeField(value: string): string {
  return (
    value
      // oxlint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
      .replace(/;/g, ",")
      .trim()
  );
}

function writeToTerminal(sequence: string): boolean {
  try {
    const fd = openSync("/dev/tty", "w");
    try {
      writeSync(fd, sequence);
      return true;
    } finally {
      closeSync(fd);
    }
  } catch {
    if (!process.stdout.isTTY) return false;
    try {
      process.stdout.write(sequence);
      return true;
    } catch {
      return false;
    }
  }
}
