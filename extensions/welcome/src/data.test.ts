import { homedir } from "node:os";
import { join } from "node:path";
import type { SlashCommandInfo, SourceInfo, ToolInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { collect } from "./data.ts";
import type { WelcomeAPI, WelcomeHost } from "./types.ts";

type ReadBranch = NonNullable<Parameters<typeof collect>[3]>;
type LoadContext = NonNullable<Parameters<typeof collect>[4]>;

const sourceInfo: SourceInfo = {
  path: "/virtual/resources",
  source: "local",
  scope: "project",
  origin: "top-level",
};
// A catalog record only; no registry, credentials, or provider requests.
const fakeModel: NonNullable<WelcomeHost["model"]> = {
  id: "test-model",
  name: "Test model",
  provider: "local",
  api: "openai-completions",
  baseUrl: "http://unused.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
};

function fixture() {
  const state = {
    cwd: "/virtual/project",
    name: "Planning",
    model: { ...fakeModel } as WelcomeHost["model"],
    thinking: "high" as WelcomeHost["thinkingLevel"],
    stale: false,
  };
  function live() {
    if (state.stale) throw new Error("event context expired");
  }
  const pi = {
    appendEntry: vi.fn<WelcomeAPI["appendEntry"]>(),
    getCommands: vi.fn<WelcomeAPI["getCommands"]>(() => {
      live();
      return [];
    }),
    getActiveTools: vi.fn<WelcomeAPI["getActiveTools"]>(() => {
      live();
      return [];
    }),
    getAllTools: vi.fn<WelcomeAPI["getAllTools"]>(() => {
      live();
      return [];
    }),
  } satisfies WelcomeAPI;
  const ctx: WelcomeHost = {
    mode: "tui",
    get cwd() {
      live();
      return state.cwd;
    },
    get model() {
      live();
      return state.model;
    },
    get thinkingLevel() {
      live();
      return state.thinking;
    },
    get sessionManager() {
      live();
      return sessionManager;
    },
  };
  const sessionManager = {
    getSessionName: vi.fn(() => {
      live();
      return state.name;
    }),
    getSessionId: vi.fn(() => {
      throw new Error("collect does not need a session id");
    }),
    getLeafId: vi.fn(() => {
      throw new Error("collect does not need a leaf");
    }),
    getEntries: vi.fn(() => {
      throw new Error("collect does not need entries");
    }),
    getBranch: vi.fn(() => {
      throw new Error("collect does not need session history");
    }),
  } satisfies WelcomeHost["sessionManager"];
  const readBranch = vi.fn<ReadBranch>(async () => "main");
  const loadContext = vi.fn<LoadContext>(() => []);
  const signal = new AbortController().signal;
  return { state, pi, ctx, sessionManager, readBranch, loadContext, signal };
}

describe("collect", () => {
  it("captures plain model, cwd, session and resources before awaiting Git", async () => {
    const { state, pi, ctx, sessionManager, readBranch, loadContext, signal } = fixture();
    loadContext.mockReturnValue([{ path: "/virtual/project/AGENTS.md", content: "instructions" }]);
    pi.getCommands.mockReturnValue([{ name: "review", source: "skill", sourceInfo }]);
    pi.getActiveTools.mockReturnValue(["read"]);
    const tool: ToolInfo = {
      name: "read",
      description: "Read",
      parameters: { type: "object", properties: {} },
      exposure: "direct",
      sourceInfo,
    };
    pi.getAllTools.mockReturnValue([tool, { ...tool, name: "bash" }]);
    let finishGit!: (branch: string) => void;
    readBranch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishGit = resolve;
        }),
    );

    const collecting = collect(pi, ctx, signal, readBranch, loadContext);
    expect(readBranch).toHaveBeenCalledExactlyOnceWith("/virtual/project", signal);
    expect(loadContext).toHaveBeenCalledExactlyOnceWith({
      cwd: "/virtual/project",
      agentDir: expect.any(String),
    });
    expect(pi.getCommands).toHaveBeenCalledTimes(1);
    expect(pi.getActiveTools).toHaveBeenCalledTimes(1);
    expect(pi.getAllTools).toHaveBeenCalledTimes(1);
    expect(sessionManager.getSessionName).toHaveBeenCalledTimes(1);

    state.cwd = "/virtual/changed";
    state.name = "Changed";
    state.model!.id = "changed-model";
    state.model!.contextWindow = 1;
    state.thinking = "off";
    // Even reading the event context now would throw.
    state.stale = true;
    finishGit("main · modified");
    await expect(collecting).resolves.toEqual({
      directory: "/virtual/project",
      session: "Planning",
      model: "local / test-model",
      contextWindow: 128_000,
      thinking: "high",
      context: "AGENTS.md",
      skills: "review",
      prompts: "0 found",
      tools: "1 active / 2 available",
      branch: "main · modified",
    });
    expect(pi.getCommands).toHaveBeenCalledTimes(1);
    expect(pi.getActiveTools).toHaveBeenCalledTimes(1);
    expect(pi.getAllTools).toHaveBeenCalledTimes(1);
    expect(sessionManager.getSessionName).toHaveBeenCalledTimes(1);
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("deduplicates, sorts and shows only three context, skill and prompt names without mutating inputs", async () => {
    const { pi, ctx, readBranch, loadContext, signal } = fixture();
    const commands: SlashCommandInfo[] = [
      { name: "zeta", source: "skill", sourceInfo },
      { name: "beta", source: "skill", sourceInfo },
      { name: "alpha", source: "skill", sourceInfo },
      { name: "delta", source: "skill", sourceInfo },
      { name: "beta", source: "skill", sourceInfo },
      { name: "epsilon", source: "skill", sourceInfo },
      { name: "zeta", source: "prompt", sourceInfo },
      { name: "beta", source: "prompt", sourceInfo },
      { name: "alpha", source: "prompt", sourceInfo },
      { name: "delta", source: "prompt", sourceInfo },
      { name: "beta", source: "prompt", sourceInfo },
      { name: "not-a-resource", source: "extension", sourceInfo },
    ];
    const files = [
      { path: "/virtual/ZEBRA.md", content: "z" },
      { path: "/virtual/README.md", content: "r" },
      { path: "/virtual/AGENTS.md", content: "a" },
      { path: "/elsewhere/AGENTS.md", content: "duplicate basename" },
      { path: "/virtual/NOTES.md", content: "n" },
    ];
    const beforeCommands = structuredClone(commands);
    const beforeFiles = structuredClone(files);
    Object.freeze(commands);
    commands.forEach(Object.freeze);
    Object.freeze(files);
    files.forEach(Object.freeze);
    pi.getCommands.mockReturnValue(commands);
    loadContext.mockReturnValue(files);

    const data = await collect(pi, ctx, signal, readBranch, loadContext);
    expect(data.context).toBe("AGENTS.md, NOTES.md, README.md +1");
    expect(data.skills).toBe("alpha, beta, delta +2");
    expect(data.prompts).toBe("/alpha, /beta, /delta +1");
    expect(commands).toEqual(beforeCommands);
    expect(files).toEqual(beforeFiles);
  });

  it("uses zero-resource labels and the no-model fallback", async () => {
    const { state, pi, ctx, readBranch, loadContext, signal } = fixture();
    state.model = undefined;
    state.name = "";
    state.thinking = undefined;
    readBranch.mockResolvedValue(undefined);
    await expect(collect(pi, ctx, signal, readBranch, loadContext)).resolves.toEqual({
      directory: "/virtual/project",
      session: "",
      model: "no model selected",
      contextWindow: undefined,
      thinking: undefined,
      context: "0 found",
      skills: "0 found",
      prompts: "0 found",
      tools: "0 active / 0 available",
      branch: undefined,
    });
  });

  it("reports unavailable context without losing the other metadata", async () => {
    const { pi, ctx, readBranch, loadContext, signal } = fixture();
    loadContext.mockImplementation(() => {
      throw new Error("context loader failed");
    });
    const data = await collect(pi, ctx, signal, readBranch, loadContext);
    expect(data.context).toBe("unavailable");
    expect(data.model).toBe("local / test-model");
    expect(data.branch).toBe("main");
    expect(readBranch).toHaveBeenCalledTimes(1);
  });

  it("shortens home and its descendants, but not a similarly prefixed sibling", async () => {
    const { state, pi, ctx, readBranch, loadContext, signal } = fixture();
    state.cwd = homedir();
    expect((await collect(pi, ctx, signal, readBranch, loadContext)).directory).toBe("~");
    state.cwd = join(homedir(), "work", "project");
    expect((await collect(pi, ctx, signal, readBranch, loadContext)).directory).toBe(
      "~/work/project",
    );
    state.cwd = `${homedir()}-sibling/project`;
    expect((await collect(pi, ctx, signal, readBranch, loadContext)).directory).toBe(state.cwd);
  });

  it("sanitizes metadata and resource names while leaving source records unchanged", async () => {
    const { state, pi, ctx, readBranch, loadContext, signal } = fixture();
    state.cwd = "/virtual/\u0000project\n  dir\u200b";
    state.name = "\tPlan\u202e now\u0007";
    state.model = { ...fakeModel, provider: "local\u0000", id: "test\n model\u200b" };
    const commands: SlashCommandInfo[] = [
      { name: "review\u0007\n code", source: "skill", sourceInfo },
      { name: "explain\u202e\t code", source: "prompt", sourceInfo },
    ];
    const files = [{ path: "/virtual/AGENTS\u200b\n.md", content: "unchanged\u0000" }];
    pi.getCommands.mockReturnValue(commands);
    loadContext.mockReturnValue(files);
    const modelBefore = structuredClone(state.model);
    const commandsBefore = structuredClone(commands);
    const filesBefore = structuredClone(files);
    Object.freeze(state.model);
    Object.freeze(commands);
    Object.freeze(files);
    const data = await collect(pi, ctx, signal, readBranch, loadContext);
    expect(data.directory).toBe("/virtual/ project dir");
    expect(data.session).toBe("Plan now");
    expect(data.model).toBe("local / test model");
    expect(data.context).toBe("AGENTS .md");
    expect(data.skills).toBe("review code");
    expect(data.prompts).toBe("/explain code");
    expect(state.model).toEqual(modelBefore);
    expect(commands).toEqual(commandsBefore);
    expect(files).toEqual(filesBefore);
  });
});
