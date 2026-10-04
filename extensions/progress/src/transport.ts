export const ACTIVE = "\x1b]9;4;3\x07";
export const START_AT_ZERO = "\x1b]9;4;1;0\x07";
export const CLEAR = "\x1b]9;4;0\x07";

function usesTmuxPassthrough(): boolean {
  // TMUX may be omitted by a launcher even though TERM still identifies tmux.
  return Boolean(process.env.TMUX) || /^tmux(?:-|$)/.test(process.env.TERM ?? "");
}

export function transportName(): string {
  return usesTmuxPassthrough() ? "tmux passthrough" : "direct OSC 9;4";
}

export function writeProgress(sequence: string): void {
  const output = usesTmuxPassthrough()
    ? `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`
    : sequence;
  try {
    process.stdout.write(output);
  } catch {
    // Progress is best-effort when the terminal is unavailable.
  }
}
