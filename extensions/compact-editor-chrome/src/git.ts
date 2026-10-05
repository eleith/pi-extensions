import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitStatus } from "./types.ts";

const runFile = promisify(execFile);
const DEFAULT_TTL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 500;

type StatusReader = (cwd: string, signal: AbortSignal) => Promise<GitStatus | null>;

export class GitStatusPoller {
  private status: GitStatus | null = null;
  private lastRefreshAt = -Infinity;
  private generation = 0;
  private pending: AbortController | undefined;
  private cwd: string | undefined;
  private disposed = false;

  constructor(
    private readonly requestRender: () => void,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly read: StatusReader = readGitStatus,
  ) {}

  snapshot(): GitStatus | null {
    return this.status;
  }

  invalidate(): void {
    if (this.disposed) return;
    this.generation++;
    this.status = null;
    this.lastRefreshAt = -Infinity;
    this.pending?.abort();
  }

  refresh(cwd: string): void {
    if (this.disposed) return;
    if (this.cwd !== cwd) {
      this.cwd = cwd;
      this.invalidate();
    }
    if (this.pending || Date.now() - this.lastRefreshAt < this.ttlMs) return;
    const request = new AbortController();
    const generation = this.generation;
    this.pending = request;

    void this.read(cwd, request.signal)
      .catch(() => null)
      .then((status) => {
        if (
          this.disposed ||
          request.signal.aborted ||
          this.cwd !== cwd ||
          this.generation !== generation
        )
          return;
        this.status = status;
        this.lastRefreshAt = Date.now();
        this.requestRender();
      })
      .finally(() => {
        if (this.pending !== request) return;
        this.pending = undefined;
        // An invalidated request must not block the next directory or branch refresh.
        if (!this.disposed && this.cwd && (this.cwd !== cwd || this.generation !== generation))
          this.refresh(this.cwd);
      });
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.pending?.abort();
    this.pending = undefined;
    this.cwd = undefined;
    this.status = null;
  }
}

type ExecuteFile = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeout: number;
    maxBuffer: number;
    signal: AbortSignal;
    killSignal: "SIGKILL";
    encoding: "utf8";
    env: NodeJS.ProcessEnv;
  },
) => Promise<{ stdout: string }>;

export async function readGitStatus(
  cwd: string,
  signal: AbortSignal,
  execute: ExecuteFile = runFile,
): Promise<GitStatus | null> {
  if (signal.aborted) return null;
  try {
    const { stdout } = await execute("git", ["status", "--porcelain"], {
      cwd,
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      signal,
      killSignal: "SIGKILL",
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return signal.aborted ? null : parsePorcelainStatus(stdout);
  } catch {
    return null;
  }
}

export function parsePorcelainStatus(output: string): GitStatus {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of output.split("\n")) {
    if (!line) continue;
    const indexStatus = line[0];
    const worktreeStatus = line[1];
    if (indexStatus === "?" && worktreeStatus === "?") {
      untracked++;
      continue;
    }
    if (indexStatus && indexStatus !== " " && indexStatus !== "?") staged++;
    if (worktreeStatus && worktreeStatus !== " ") unstaged++;
  }
  return { staged, unstaged, untracked };
}
