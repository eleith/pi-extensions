import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { getBranchLabel } from "./git.ts";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

// A real child is needed here: execFile abort and timeout use different kill paths.
function hangingGit(mode: "branch" | "status") {
  const directory = mkdtempSync(join(tmpdir(), "welcome-git-process-"));
  directories.push(directory);
  writeFileSync(join(directory, "package.json"), '{"type":"commonjs"}');
  const pidFile = join(directory, "pid");
  const executable = join(directory, "git");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
if (process.argv[2] === "branch" && ${JSON.stringify(mode)} === "status") {
  process.stdout.write("main\\n");
} else {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
`,
  );
  chmodSync(executable, 0o755);
  vi.stubEnv("PATH", directory + ":" + process.env.PATH);
  return { directory, pidFile };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function reaped(pidFile: string): Promise<void> {
  expect(existsSync(pidFile)).toBe(true);
  const pid = Number(readFileSync(pidFile, "utf8"));
  try {
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 1000, interval: 10 });
  } finally {
    // A regression must fail without leaving the deliberately stubborn child behind.
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
}

it.each(["branch", "status"] as const)(
  "reaps a SIGTERM-ignoring Git %s process on timeout",
  async (mode) => {
    const { directory, pidFile } = hangingGit(mode);
    const result = await getBranchLabel(directory, new AbortController().signal);
    expect(result).toBe(mode === "status" ? "main" : undefined);
    await reaped(pidFile);
  },
);

it("reaps a SIGTERM-ignoring Git process on abort, not just on timeout", async () => {
  const { directory, pidFile } = hangingGit("branch");
  const controller = new AbortController();
  const result = getBranchLabel(directory, controller.signal);
  try {
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 500, interval: 5 });
    // Let the child finish installing its signal handler after writing its PID.
    await delay(10);
  } finally {
    controller.abort();
  }
  expect(await result).toBeUndefined();
  await reaped(pidFile);
});
