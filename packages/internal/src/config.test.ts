import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSettings } from "./config.ts";

const agentDir = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "eleith-config-test-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_OFFLINE", "1");
  return directory;
});
const directory = join(agentDir, "extensions");
const path = join(directory, "eleith.json");

beforeEach(() => {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory);
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(agentDir, { recursive: true, force: true });
});

describe("shared settings", () => {
  it("defaults for a missing file or key", async () => {
    expect(await getSettings()).toEqual({ commandPrefix: "eleith" });
    writeFileSync(path, "{}");
    expect(await getSettings()).toEqual({ commandPrefix: "eleith" });
  });

  it.each(["eleith", "personal", "personal-2"])("reads prefix %s", async (commandPrefix) => {
    writeFileSync(path, JSON.stringify({ commandPrefix }));
    expect((await getSettings()).commandPrefix).toBe(commandPrefix);
  });

  it("validates the consumed field and permits other configuration", async () => {
    writeFileSync(path, '{"commandPrefix":"personal","other":{"enabled":true}}');
    expect(await getSettings()).toEqual({ commandPrefix: "personal", other: { enabled: true } });
    writeFileSync(path, '{"other":true}');
    expect(await getSettings()).toEqual({ commandPrefix: "eleith", other: true });
  });

  it.each([
    "{",
    "null",
    "[]",
    '"personal"',
    ...[
      null,
      42,
      "",
      "Personal",
      "/personal",
      "personal:tools",
      "personal tools",
      "personal\n",
      "-personal",
    ].map((commandPrefix) => JSON.stringify({ commandPrefix })),
  ])("reports invalid configuration with its path: %s", async (config) => {
    writeFileSync(path, config);
    await expect(getSettings()).rejects.toThrow(path);
  });

  it("reports read errors instead of using the default", async () => {
    mkdirSync(path);
    await expect(getSettings()).rejects.toThrow(path);
  });

  it("returns a fresh settings object without persisting changes", async () => {
    writeFileSync(path, '{"commandPrefix":"personal"}');
    const settings = await getSettings();
    settings.commandPrefix = "changed";
    expect((await getSettings()).commandPrefix).toBe("personal");
  });
});
