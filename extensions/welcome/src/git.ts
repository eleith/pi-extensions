import { execFile } from "node:child_process";
import { safe } from "./format.ts";

type ExecuteFile = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    killSignal: "SIGKILL";
    signal: AbortSignal;
    env: NodeJS.ProcessEnv;
  },
) => Promise<{ stdout: string }>;

// execFile's signal path uses spawn's default SIGTERM, not its timeout killSignal.
// Own cancellation so a Git process that ignores SIGTERM is still reaped.
const runFile: ExecuteFile = (command, args, options) => {
  const { signal, ...execOptions } = options;
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Git read aborted"));
      return;
    }
    const child = execFile(command, args, execOptions, (error, stdout) => {
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve({ stdout });
    });
    function abort(): void {
      child.kill("SIGKILL");
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
};

async function git(
  cwd: string,
  args: string[],
  signal: AbortSignal,
  execute: ExecuteFile,
): Promise<string | undefined> {
  if (signal.aborted) return undefined;
  try {
    const { stdout } = await execute("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 700,
      maxBuffer: 64 * 1024,
      killSignal: "SIGKILL",
      signal,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return signal.aborted ? undefined : stdout.trim();
  } catch {
    return undefined;
  }
}

export async function getBranchLabel(
  cwd: string,
  signal: AbortSignal,
  execute: ExecuteFile = runFile,
): Promise<string | undefined> {
  const branch = await git(cwd, ["branch", "--show-current"], signal, execute);
  if (!branch || signal.aborted) return undefined;
  const changes = await git(
    cwd,
    ["status", "--porcelain", "--untracked-files=no"],
    signal,
    execute,
  );
  return signal.aborted ? undefined : safe(branch + (changes ? " · modified" : ""));
}
