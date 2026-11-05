import { rmSync } from "node:fs";
import { afterAll, expect, it, vi } from "vitest";
import {
  InMemoryModelsStore,
  type Api,
  type CredentialStore,
  type Model,
  type OAuthCredential,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import codex from "./index.ts";
import { customInteractionUI } from "./custom-interaction.test-helper.ts";

const directory = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "codex-usage-sdk-test-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_OFFLINE", "1");
  return directory;
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("SDK read-only aliases open local inspectors without network, auth reads, model turns or session entries", async () => {
  const accountRequest = vi.fn<typeof fetch>(async () => {
    throw new Error("Network forbidden");
  });
  vi.stubGlobal("fetch", accountRequest);
  const { runtime, model, credentialReads, credentialWrites, modelTurns } =
    await createOfflineCodexRuntime();
  const f = await openCodexExtensionSession(runtime, model);
  try {
    const entries = structuredClone(f.sessionManager.getEntries());
    const branch = structuredClone(f.sessionManager.getBranch());
    credentialReads.mockClear();
    let dashboard: string | undefined;
    for (const [index, command] of [
      "/eleith:codex",
      "/eleith:codex context",
      "/eleith:codex fast",
    ].entries()) {
      let settled = false;
      const request = f.session.prompt(command).then(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(f.modals[index]?.adopted).toBe(true));
      const modal = f.modals[index];
      const text = modal.lines.join("\n");
      expect(text).toContain("Codex · Overview");
      expect(text).toContain("Context:");
      expect(text).toContain("Fast:");
      if (dashboard === undefined) dashboard = text;
      else expect(text).toBe(dashboard);
      expect(settled).toBe(false);
      expect(modal.closed).toBe(false);
      modal.component!.handleInput!(index % 2 ? "\u001b" : "\r");
      await request;
      expect(modal.close).toHaveBeenCalledOnce();
    }
    expect(f.custom).toHaveBeenCalledTimes(3);
    for (const call of f.custom.mock.calls) expect(call[1]).toMatchObject({ overlay: true });
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.setStatus).not.toHaveBeenCalled();
    expect(accountRequest).not.toHaveBeenCalled();
    expect(credentialReads).not.toHaveBeenCalled();
    expect(credentialWrites).not.toHaveBeenCalled();
    expect(modelTurns).not.toHaveBeenCalled();
    expect(f.session.model).toEqual(model);
    expect(f.sessionManager.getEntries()).toEqual(entries);
    expect(f.sessionManager.getBranch()).toEqual(branch);
    expect(f.extensionErrors).toEqual([]);
  } finally {
    await f.closeSession();
  }
});

it("SDK usage reuses Pi OAuth and updates one loading modal to a persistent result without a model turn", async () => {
  const response = deferred<Response>();
  const accountRequest = vi.fn<typeof fetch>(() => response.promise);
  vi.stubGlobal("fetch", accountRequest);
  const { runtime, model, accessToken, credentialWrites, modelTurns } =
    await createOfflineCodexRuntime();
  const f = await openCodexExtensionSession(runtime, model);
  try {
    const entries = structuredClone(f.sessionManager.getEntries());
    let settled = false;
    const request = f.session.prompt("/eleith:codex usage").then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(f.modals[0]?.adopted).toBe(true));
    const modal = f.modals[0];
    const component = modal.component;
    expect(modal.lines.join("\n")).toContain("Codex · Usage");
    expect(modal.lines.join("\n")).toContain("Fetching Codex usage…");
    expect(modal.lines.join("\n")).toMatch(/esc.*cancel/i);
    response.resolve(
      new Response(
        JSON.stringify({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 25,
              limit_window_seconds: 18_000,
              reset_after_seconds: 1800,
            },
          },
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(modal.lines.join("\n")).toContain("5h window: 75% remaining (25% used)"),
    );
    expect(modal.component).toBe(component);
    expect(modal.renders.some((lines) => lines.join("\n").includes("Fetching Codex usage…"))).toBe(
      true,
    );
    expect(modal.closed).toBe(false);
    expect(settled).toBe(false);
    expect(f.custom).toHaveBeenCalledOnce();
    expect(f.custom.mock.calls[0][1]).toMatchObject({ overlay: true });
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.setStatus).not.toHaveBeenCalled();
    expect(accountRequest).toHaveBeenCalledOnce();
    expect(accountRequest.mock.calls[0][0]).toBe("https://chatgpt.com/backend-api/wham/usage");
    const headers = new Headers(accountRequest.mock.calls[0][1]?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(headers.get("chatgpt-account-id")).toBe("sdk-test-account");
    component!.handleInput!("\r");
    await request;
    expect(modal.close).toHaveBeenCalledOnce();
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.sessionManager.getEntries()).toEqual(entries);
    expect(f.session.model).toEqual(model);
    expect(credentialWrites).not.toHaveBeenCalled();
    expect(modelTurns).not.toHaveBeenCalled();
    expect(f.extensionErrors).toEqual([]);
  } finally {
    await f.closeSession();
  }
});

it("SDK local dashboard replaces pending usage and usage replaces an open dashboard on one shared surface", async () => {
  const response = deferred<Response>();
  const nextResponse = deferred<Response>();
  const accountRequest = vi
    .fn<typeof fetch>()
    .mockReturnValueOnce(response.promise)
    .mockReturnValueOnce(nextResponse.promise);
  vi.stubGlobal("fetch", accountRequest);
  const { runtime, model, credentialWrites, modelTurns } = await createOfflineCodexRuntime();
  const f = await openCodexExtensionSession(runtime, model);
  try {
    const entries = structuredClone(f.sessionManager.getEntries());
    const usage = f.session.prompt("/eleith:codex usage");
    await vi.waitFor(() => expect(accountRequest).toHaveBeenCalledOnce());
    const first = f.modals[0];
    const signal = accountRequest.mock.calls[0][1]?.signal;
    const dashboard = f.session.prompt("/eleith:codex context");
    await usage; // Must settle even though the network promise ignores abort.
    await vi.waitFor(() => expect(f.modals[1]?.adopted).toBe(true));
    const second = f.modals[1];
    expect(first.closed).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(second.lines.join("\n")).toContain("Codex · Overview");
    expect(second.closed).toBe(false);
    expect(f.surface.focusedComponent).toBe(second.component);
    response.resolve(new Response(JSON.stringify({ plan_type: "stale-plan" })));
    await Promise.resolve();
    const nextUsage = f.session.prompt("/eleith:codex usage");
    await dashboard;
    await vi.waitFor(() => expect(accountRequest).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(f.modals[2]?.adopted).toBe(true));
    const third = f.modals[2];
    expect(second.closed).toBe(true);
    expect(third.lines.join("\n")).toContain("Codex · Usage");
    expect(third.lines.join("\n")).toContain("Fetching Codex usage…");
    expect(f.surface.focusedComponent).toBe(third.component);
    expect(f.surface.components).toEqual([f.surface.mainEditor, third.component]);
    nextResponse.resolve(new Response(JSON.stringify({ plan_type: "new-plan" })));
    await vi.waitFor(() => expect(third.lines.join("\n")).toContain("Plan: new-plan"));
    expect(third.closed).toBe(false);
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    third.component!.handleInput!("\u001b");
    await nextUsage;
    expect(f.surface.focusedComponent).toBe(f.surface.mainEditor);
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.sessionManager.getEntries()).toEqual(entries);
    expect(credentialWrites).not.toHaveBeenCalled();
    expect(modelTurns).not.toHaveBeenCalled();
    expect(f.extensionErrors).toEqual([]);
  } finally {
    await f.closeSession();
  }
});

it.each(["model_select", "session_tree", "session_shutdown"] as const)(
  "SDK %s dismisses a pending TUI inspector immediately with no late result notification",
  async (event) => {
    const response = deferred<Response>();
    const accountRequest = vi.fn<typeof fetch>(() => response.promise);
    vi.stubGlobal("fetch", accountRequest);
    const { runtime, model } = await createOfflineCodexRuntime();
    const f = await openCodexExtensionSession(runtime, model);
    try {
      const request = f.session.prompt("/eleith:codex usage");
      await vi.waitFor(() => expect(accountRequest).toHaveBeenCalledOnce());
      if (event === "model_select")
        await f.session.extensionRunner.emit({
          type: event,
          model,
          previousModel: model,
          source: "set",
        });
      else if (event === "session_tree")
        await f.session.extensionRunner.emit({ type: event, newLeafId: null, oldLeafId: null });
      else await f.session.extensionRunner.emit({ type: event, reason: "quit" });
      await request;
      expect(accountRequest.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(f.modals[0].closed).toBe(true);
      response.resolve(new Response(JSON.stringify({ plan_type: "late-plan" })));
      await Promise.resolve();
      expect(f.notify).not.toHaveBeenCalled();
      expect(f.modals[0].close).toHaveBeenCalledOnce();
      expect(f.extensionErrors).toEqual([]);
    } finally {
      await f.closeSession();
    }
  },
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function createOfflineCodexRuntime() {
  const payload = { "https://api.openai.com/auth": { chatgpt_account_id: "sdk-test-account" } };
  const accessToken = `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fake-signature`;
  const credential: OAuthCredential = {
    type: "oauth",
    access: accessToken,
    refresh: "must-not-refresh",
    expires: Date.now() + 3_600_000,
  };
  const credentialWrites = vi.fn<CredentialStore["modify"]>(async () => {
    throw new Error("Credential writes forbidden");
  });
  const credentialReads = vi.fn<CredentialStore["read"]>(async (id) =>
    id === "openai-codex" ? credential : undefined,
  );
  const credentials: CredentialStore = {
    read: credentialReads,
    list: async () => [{ providerId: "openai-codex", type: "oauth" }],
    modify: credentialWrites,
    delete: async () => {
      throw new Error("Credential deletion forbidden");
    },
  };
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  // Populate Pi's auth-availability snapshot without probing other providers or the network.
  const refresh = await runtime.refresh({ providers: ["openai-codex"], allowNetwork: false });
  expect(refresh.errors.size).toBe(0);
  expect(runtime.isUsingOAuth("openai-codex")).toBe(true);
  const modelTurns = vi.spyOn(runtime, "streamSimple").mockImplementation(() => {
    throw new Error("Model turns forbidden");
  });
  const model = runtime.getModel("openai-codex", "gpt-6-sol");
  if (!model) throw new Error("Built-in Codex model missing");
  return { runtime, model, accessToken, credentialReads, credentialWrites, modelTurns };
}

async function openCodexExtensionSession(runtime: ModelRuntime, model: Model<Api>) {
  initTheme("dark", false);
  const settingsManager = SettingsManager.inMemory({
    packages: [],
    enableInstallTelemetry: false,
    enableAnalytics: false,
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [codex],
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.inMemory(directory);
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    resourceLoader,
    settingsManager,
    modelRuntime: runtime,
    model,
    sessionManager,
    noTools: "all",
  });
  const notify = vi.fn();
  const setStatus = vi.fn();
  const surface = customInteractionUI();
  const { custom, modals } = surface;
  const extensionErrors: unknown[] = [];
  await session.bindExtensions({
    mode: "tui",
    uiContext: { notify, setStatus, custom } as unknown as ExtensionUIContext,
    onError: (error) => extensionErrors.push(error),
  });
  return {
    session,
    sessionManager,
    notify,
    setStatus,
    custom,
    modals,
    surface,
    extensionErrors,
    async closeSession() {
      try {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        surface.dispose();
        session.dispose();
      }
    },
  };
}
