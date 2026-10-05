import { afterEach, describe, expect, it, vi } from "vitest";
import { getBranchLabel } from "./git.ts";

type ExecuteFile = NonNullable<Parameters<typeof getBranchLabel>[2]>;
const cwd = "/virtual/project";

afterEach(() => vi.unstubAllEnvs());

describe("getBranchLabel", () => {
  it("reads the current branch and tracked status through bounded, abortable Git calls", async () => {
    vi.stubEnv("GIT_OPTIONAL_LOCKS", "1");
    const signal = new AbortController().signal;
    const execute = vi
      .fn<ExecuteFile>()
      .mockResolvedValueOnce({ stdout: "  feature/readable-tests\n" })
      .mockResolvedValueOnce({ stdout: " M src/index.ts\n" });

    await expect(getBranchLabel(cwd, signal, execute)).resolves.toBe(
      "feature/readable-tests · modified",
    );
    const options = {
      cwd,
      encoding: "utf8",
      timeout: 700,
      maxBuffer: 65536,
      killSignal: "SIGKILL",
      signal,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    };
    expect(execute.mock.calls).toEqual([
      ["git", ["branch", "--show-current"], options],
      ["git", ["status", "--porcelain", "--untracked-files=no"], options],
    ]);
    expect(process.env.GIT_OPTIONAL_LOCKS).toBe("1");
  });

  it("returns just the branch for a clean worktree", async () => {
    const execute = vi
      .fn<ExecuteFile>()
      .mockResolvedValueOnce({ stdout: "main\n" })
      .mockResolvedValueOnce({ stdout: " \n\t" });
    await expect(getBranchLabel(cwd, new AbortController().signal, execute)).resolves.toBe("main");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not run status when Git supplies no branch, including a detached HEAD", async () => {
    const execute = vi.fn<ExecuteFile>().mockResolvedValue({ stdout: " \n" });
    await expect(
      getBranchLabel(cwd, new AbortController().signal, execute),
    ).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns no label when Git is not installed", async () => {
    const execute = vi
      .fn<ExecuteFile>()
      .mockRejectedValue(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }));
    await expect(
      getBranchLabel(cwd, new AbortController().signal, execute),
    ).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("tolerates branch failures, such as a non-repository or timeout", async () => {
    const execute = vi.fn<ExecuteFile>().mockRejectedValue(new Error("git failed"));
    await expect(
      getBranchLabel(cwd, new AbortController().signal, execute),
    ).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps the known branch without claiming modifications if status fails", async () => {
    const execute = vi
      .fn<ExecuteFile>()
      .mockResolvedValueOnce({ stdout: "main\n" })
      .mockRejectedValueOnce(new Error("status timed out"));
    await expect(getBranchLabel(cwd, new AbortController().signal, execute)).resolves.toBe("main");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("never spawns Git for an already canceled request", async () => {
    const request = new AbortController();
    request.abort();
    const execute = vi.fn<ExecuteFile>();
    await expect(getBranchLabel(cwd, request.signal, execute)).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancellation after the branch result prevents the second spawn", async () => {
    const request = new AbortController();
    const execute = vi.fn<ExecuteFile>(async () => {
      request.abort();
      return { stdout: "main\n" };
    });
    await expect(getBranchLabel(cwd, request.signal, execute)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][2].signal).toBe(request.signal);
  });

  it("ignores a late successful branch result from an executor that did not stop on abort", async () => {
    const request = new AbortController();
    let finish!: (result: { stdout: string }) => void;
    const execute = vi.fn<ExecuteFile>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const label = getBranchLabel(cwd, request.signal, execute);
    request.abort();
    finish({ stdout: "main\n" });
    await expect(label).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not return a label if cancellation occurs during status", async () => {
    const request = new AbortController();
    const execute = vi
      .fn<ExecuteFile>()
      .mockResolvedValueOnce({ stdout: "main\n" })
      .mockImplementationOnce(async () => {
        request.abort();
        return { stdout: " M src/index.ts\n" };
      });
    await expect(getBranchLabel(cwd, request.signal, execute)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("absorbs an executor's abort rejection", async () => {
    const request = new AbortController();
    const execute = vi.fn<ExecuteFile>(async () => {
      request.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    await expect(getBranchLabel(cwd, request.signal, execute)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("sanitizes control and format characters in the branch label", async () => {
    const execute = vi
      .fn<ExecuteFile>()
      .mockResolvedValueOnce({ stdout: "\tfeature/\u0000\u202ename\n\t spaced\u200b\u0007\n" })
      .mockResolvedValueOnce({ stdout: " M file\n" });
    const label = await getBranchLabel(cwd, new AbortController().signal, execute);
    expect(label).toBe("feature/ name spaced · modified");
    expect(label).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });
});
