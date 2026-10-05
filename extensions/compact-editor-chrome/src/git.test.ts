import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitStatusPoller, parsePorcelainStatus, readGitStatus } from "./git.ts";
import type { GitStatus } from "./types.ts";

type Reader = NonNullable<ConstructorParameters<typeof GitStatusPoller>[2]>;
type Execute = NonNullable<Parameters<typeof readGitStatus>[2]>;
const clean: GitStatus = { staged: 0, unstaged: 0, untracked: 0 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function flush() {
  await vi.runAllTimersAsync();
}

describe("Git status reader", () => {
  it("counts staged, unstaged, mixed, renamed, and untracked paths", () => {
    expect(
      parsePorcelainStatus("M  staged\n M unstaged\nMM both\nR  old -> new\n?? untracked\n"),
    ).toEqual({ staged: 3, unstaged: 2, untracked: 1 });
    expect(parsePorcelainStatus("")).toEqual(clean);
  });

  it("runs read-only Git with bounded, cancellable execution", async () => {
    const execute = vi.fn<Execute>().mockResolvedValue({ stdout: "?? file\n" });
    const signal = new AbortController().signal;
    expect(await readGitStatus("/project", signal, execute)).toEqual({
      staged: 0,
      unstaged: 0,
      untracked: 1,
    });
    expect(execute).toHaveBeenCalledWith(
      "git",
      ["status", "--porcelain"],
      expect.objectContaining({
        cwd: "/project",
        timeout: 500,
        maxBuffer: 65536,
        signal,
        killSignal: "SIGKILL",
        encoding: "utf8",
        env: expect.objectContaining({ GIT_OPTIONAL_LOCKS: "0" }),
      }),
    );
  });

  it.each(["missing Git", "timeout", "output limit"])(
    "returns unknown status on %s",
    async (message) => {
      const execute = vi.fn<Execute>().mockRejectedValue(new Error(message));
      expect(await readGitStatus("/project", new AbortController().signal, execute)).toBeNull();
    },
  );

  it("avoids a process for an aborted signal and discards late process output", async () => {
    const execute = vi.fn<Execute>().mockResolvedValue({ stdout: "?? file\n" });
    const request = new AbortController();
    request.abort();
    expect(await readGitStatus("/project", request.signal, execute)).toBeNull();
    expect(execute).not.toHaveBeenCalled();
    const next = new AbortController();
    const response = pending<{ stdout: string }>();
    execute.mockReturnValue(response.promise);
    const status = readGitStatus("/project", next.signal, execute);
    next.abort();
    response.resolve({ stdout: "?? old file\n" });
    expect(await status).toBeNull();
  });
});

describe("Git poller ownership", () => {
  it("refreshes immediately at clock zero, deduplicates pending work, and respects TTL", async () => {
    const read = vi.fn<Reader>().mockResolvedValue(clean);
    const render = vi.fn();
    const poller = new GitStatusPoller(render, 2000, read);
    poller.refresh("/project");
    poller.refresh("/project");
    expect(read).toHaveBeenCalledTimes(1);
    await flush();
    expect(poller.snapshot()).toEqual(clean);
    expect(render).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1999);
    poller.refresh("/project");
    expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    poller.refresh("/project");
    expect(read).toHaveBeenCalledTimes(2);
    await flush();
    poller.dispose();
  });

  it("aborts stale directory reads and refreshes the current directory", async () => {
    const first = pending<GitStatus | null>(),
      second = pending<GitStatus | null>();
    const read = vi
      .fn<Reader>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const render = vi.fn();
    const poller = new GitStatusPoller(render, 2000, read);
    poller.refresh("/old");
    const signal = read.mock.calls[0]?.[1];
    poller.refresh("/new");
    expect(signal?.aborted).toBe(true);
    first.resolve({ staged: 1, unstaged: 0, untracked: 0 });
    await flush();
    expect(poller.snapshot()).toBeNull();
    expect(render).not.toHaveBeenCalled();
    expect(read).toHaveBeenLastCalledWith("/new", expect.any(AbortSignal));
    second.resolve(clean);
    await flush();
    expect(poller.snapshot()).toEqual(clean);
    expect(render).toHaveBeenCalledTimes(1);
    poller.dispose();
  });

  it("invalidates a pending branch read even when cwd is unchanged", async () => {
    const first = pending<GitStatus | null>();
    const read = vi.fn<Reader>().mockReturnValueOnce(first.promise).mockResolvedValue(clean);
    const render = vi.fn();
    const poller = new GitStatusPoller(render, 2000, read);
    poller.refresh("/project");
    poller.invalidate();
    expect(read.mock.calls[0]?.[1].aborted).toBe(true);
    first.resolve({ staged: 10, unstaged: 0, untracked: 0 });
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(poller.snapshot()).toEqual(clean);
    expect(render).toHaveBeenCalledTimes(1);
    poller.dispose();
  });

  it("disposes active requests without late renders or refreshes", async () => {
    const first = pending<GitStatus | null>();
    const read = vi.fn<Reader>().mockReturnValue(first.promise);
    const render = vi.fn();
    const poller = new GitStatusPoller(render, 2000, read);
    poller.refresh("/project");
    poller.dispose();
    poller.dispose();
    expect(read.mock.calls[0]?.[1].aborted).toBe(true);
    first.resolve(clean);
    await flush();
    poller.refresh("/new");
    poller.invalidate();
    expect(read).toHaveBeenCalledTimes(1);
    expect(render).not.toHaveBeenCalled();
    expect(poller.snapshot()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caches a reader failure as unknown until the next refresh", async () => {
    const read = vi.fn<Reader>().mockRejectedValue(new Error("Git unavailable"));
    const render = vi.fn();
    const poller = new GitStatusPoller(render, 2000, read);
    poller.refresh("/project");
    await flush();
    expect(poller.snapshot()).toBeNull();
    expect(render).toHaveBeenCalledTimes(1);
    poller.refresh("/project");
    expect(read).toHaveBeenCalledTimes(1);
    poller.dispose();
  });
});
