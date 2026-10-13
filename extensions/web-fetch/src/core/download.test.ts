import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as crypto from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { RequestOwner } from "./transport.js";
import { downloadResponse } from "./download.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdtemp: vi.fn(actual.mkdtemp),
    open: vi.fn(actual.open),
    rm: vi.fn(actual.rm),
  };
});
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});
const actualFS = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const owners: RequestOwner[] = [];
const directories: string[] = [];
const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
function source(chunks: Uint8Array[] = [], close = true) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
        for (const chunk of chunks) c.enqueue(chunk);
        if (close) c.close();
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const acquire = vi.spyOn(body, "getReader");
  return { body, controller, cancel, acquire };
}
async function setup(
  body: ReadableStream<Uint8Array> | null,
  options: ConstructorParameters<typeof RequestOwner>[2] = {},
  signal?: AbortSignal,
  headers: HeadersInit = {},
) {
  const request = new RequestOwner(
    { url: "http://fixture.test/file" },
    { signal },
    {
      ...options,
      fetch: async () => ({
        url: "http://fixture.test/file",
        status: 200,
        statusText: "OK",
        headers: new Headers(headers),
        body,
      }),
    },
  );
  owners.push(request);
  return { request, response: await request.open("http://fixture.test/file") };
}
const bytes = (text: string) => new TextEncoder().encode(text);
beforeEach(() => {
  vi.mocked(fs.mkdtemp).mockImplementation(async (prefix) => {
    const directory = await actualFS.mkdtemp(prefix);
    directories.push(directory);
    return directory;
  });
  vi.mocked(fs.open).mockImplementation(actualFS.open);
  vi.mocked(fs.rm).mockImplementation(actualFS.rm);
});
afterEach(async () => {
  await Promise.all(owners.splice(0).map((o) => o.dispose()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => actualFS.rm(directory, { recursive: true, force: true })),
  );
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("private downloads", () => {
  it("opens an exclusive private random file before acquiring the actual body reader", async () => {
    const body = source([bytes("fixture bytes")]);
    const { request, response } = await setup(body.body, {}, undefined, {
      "content-type": "application/pdf; charset=binary",
      "content-disposition": 'attachment; filename="../../secret.sh"',
    });
    const open = vi.mocked(fs.open);
    open.mockImplementationOnce(async (...args) => {
      expect(body.acquire).not.toHaveBeenCalled();
      expect(args[1]).toBe("wx");
      expect(args[2]).toBe(0o600);
      return actualFS.open(...args);
    });
    const result = await downloadResponse(request, response, "http://fixture.test/original");
    expect(result).toMatchObject({
      kind: "file",
      url: "http://fixture.test/original",
      finalUrl: response.url,
      fileSize: 13,
      contentType: "application/pdf",
    });
    expect(dirname(dirname(result.filePath))).toBe(tmpdir());
    expect(result.filePath).toMatch(/pi-web-fetch-[^/]+\/[a-f0-9-]+\.pdf$/);
    expect((await fs.readFile(result.filePath)).toString()).toBe("fixture bytes");
    expect((await fs.stat(dirname(result.filePath))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(result.filePath)).mode & 0o777).toBe(0o600);
    await request.dispose();
    expect((await fs.readFile(result.filePath)).toString()).toBe("fixture bytes");
  });

  it("reports unknown MIME without trusting filenames or adding dangerous suffixes", async () => {
    const { request, response } = await setup(source([bytes("x")]).body, {}, undefined, {
      "content-type": "application/x-unknown",
      "content-disposition": "attachment; filename=run.exe",
    });
    const result = await downloadResponse(request, response, response.url);
    expect(result.contentType).toBe("application/x-unknown");
    expect(result.filePath.endsWith(".bin")).toBe(true);
  });

  it("saves empty/no-body responses safely", async () => {
    const { request, response } = await setup(null);
    const result = await downloadResponse(request, response, response.url);
    expect(result.fileSize).toBe(0);
    expect((await fs.stat(result.filePath)).size).toBe(0);
    expect(result.contentType).toBe("application/octet-stream");
  });

  it("does not acquire a reader on directory/open failure, cancels existing body, and never relocates", async () => {
    const body = source([], false);
    const { request, response } = await setup(body.body);
    vi.mocked(fs.mkdtemp).mockRejectedValueOnce(new Error("storage unavailable secret-path"));
    await expect(downloadResponse(request, response, response.url)).rejects.toMatchObject({
      code: "download",
      message: "Unable to save download in the selected temporary directory.",
    });
    expect(body.acquire).not.toHaveBeenCalled();
    expect(body.cancel).toHaveBeenCalledOnce();
    expect(fs.mkdtemp).toHaveBeenCalledTimes(1);
    expect(fs.open).not.toHaveBeenCalled();
    const other = source([], false);
    const second = await setup(other.body);
    vi.mocked(fs.open).mockRejectedValueOnce(new Error("storage open failed secret-path"));
    await expect(
      downloadResponse(second.request, second.response, second.response.url),
    ).rejects.toMatchObject({ code: "download" });
    expect(other.acquire).not.toHaveBeenCalled();
    expect(other.cancel).toHaveBeenCalledOnce();
    expect(
      await fs.readdir(tmpdir()).then((names) => names.includes(directories[0].split("/").pop()!)),
    ).toBe(false);
  });

  it("never overwrites a colliding exclusive filename and cleans its private namespace", async () => {
    const name = "00000000-0000-4000-8000-000000000000";
    vi.mocked(crypto.randomUUID).mockReturnValueOnce(name);
    vi.mocked(fs.mkdtemp).mockImplementationOnce(async (prefix) => {
      const directory = await actualFS.mkdtemp(prefix);
      directories.push(directory);
      await actualFS.writeFile(join(directory, name + ".bin"), "existing");
      return directory;
    });
    const body = source([], false);
    const { request, response } = await setup(body.body);
    await expect(downloadResponse(request, response, response.url)).rejects.toMatchObject({
      code: "download",
    });
    expect(body.acquire).not.toHaveBeenCalled();
    expect(body.cancel).toHaveBeenCalledOnce();
    await expect(fs.stat(directories[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a filename symlink collision without touching its target", async () => {
    const name = "00000000-0000-4000-8000-000000000000";
    vi.mocked(crypto.randomUUID).mockReturnValueOnce(name);
    const targetDirectory = await actualFS.mkdtemp(join(tmpdir(), "pi-web-fetch-test-"));
    directories.push(targetDirectory);
    const target = join(targetDirectory, "target");
    await actualFS.writeFile(target, "untouched");
    vi.mocked(fs.mkdtemp).mockImplementationOnce(async (prefix) => {
      const directory = await actualFS.mkdtemp(prefix);
      directories.push(directory);
      await actualFS.symlink(target, join(directory, name + ".bin"));
      return directory;
    });
    const body = source([], false);
    const { request, response } = await setup(body.body);
    await expect(downloadResponse(request, response, response.url)).rejects.toMatchObject({
      code: "download",
    });
    expect(body.acquire).not.toHaveBeenCalled();
    expect(body.cancel).toHaveBeenCalledOnce();
    expect(await actualFS.readFile(target, "utf8")).toBe("untouched");
    await expect(fs.stat(directories[1])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("handles partial writes sequentially with backpressure", async () => {
    const write = vi.fn(async (_chunk: Uint8Array, _offset: number, length: number) => ({
      bytesWritten: Math.min(2, length),
    }));
    const close = vi.fn(async () => {});
    vi.mocked(fs.open).mockResolvedValueOnce({ write, close } as unknown as FileHandle);
    const body = source([bytes("abcde"), bytes("fg")]);
    const { request, response } = await setup(body.body);
    const result = await downloadResponse(request, response, response.url);
    expect(result.fileSize).toBe(7);
    expect(write.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      [0, 5],
      [2, 3],
      [4, 1],
      [0, 2],
    ]);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["error", "zero", "close"])(
    "cleans partial namespace on %s storage failure",
    async (failure) => {
      const write = vi.fn(async () => {
        if (failure === "error") throw new Error("disk failed secret");
        return { bytesWritten: failure === "zero" ? 0 : 1 };
      });
      const close = vi.fn(async () => {
        if (failure === "close") throw new Error("close failed secret");
      });
      vi.mocked(fs.open).mockResolvedValueOnce({ write, close } as unknown as FileHandle);
      const body = source([bytes("x")], false);
      const { request, response } = await setup(body.body);
      if (failure === "close") body.controller.close();
      await expect(downloadResponse(request, response, response.url)).rejects.toMatchObject({
        code: "download",
      });
      expect(close).toHaveBeenCalled();
      if (failure !== "close") expect(body.cancel).toHaveBeenCalledOnce();
      await expect(fs.stat(directories[0])).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("removes actual partial files on per-file overflow and batch overflow", async () => {
    for (const options of [{ limits: { downloadBytes: 3 } }, { budget: { used: 0, limit: 3 } }]) {
      const body = source([bytes("12"), bytes("34")], false);
      const { request, response } = await setup(body.body, options);
      await expect(downloadResponse(request, response, response.url)).rejects.toMatchObject({
        code: "limit",
      });
      expect(body.cancel).toHaveBeenCalledOnce();
      await expect(fs.stat(directories.at(-1)!)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("cancels pending actual reads and removes partial files on abort", async () => {
    const body = source([bytes("partial")], false);
    const signal = new AbortController();
    const { request, response } = await setup(body.body, {}, signal.signal);
    const downloading = downloadResponse(request, response, response.url);
    await vi.waitFor(() => expect(body.acquire).toHaveBeenCalledOnce());
    await pause(10);
    signal.abort();
    await expect(downloading).rejects.toMatchObject({ code: "cancelled" });
    expect(body.cancel).toHaveBeenCalledOnce();
    await expect(fs.stat(directories[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for a pending file write before closing/removing aborted output", async () => {
    let resolveWrite!: (result: { bytesWritten: number }) => void;
    const write = vi.fn(
      () =>
        new Promise<{ bytesWritten: number }>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const close = vi.fn(async () => {});
    vi.mocked(fs.open).mockResolvedValueOnce({ write, close } as unknown as FileHandle);
    const signal = new AbortController();
    const body = source([bytes("partial")], false);
    const { request, response } = await setup(body.body, {}, signal.signal);
    const downloading = downloadResponse(request, response, response.url);
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    signal.abort();
    expect(body.cancel).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    resolveWrite({ bytesWritten: 7 });
    await expect(downloading).rejects.toMatchObject({ code: "cancelled" });
    expect(close).toHaveBeenCalledOnce();
    await expect(fs.stat(directories[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aborts during directory/open ownership transitions without taking a reader", async () => {
    const signal = new AbortController();
    const body = source([], false);
    const { request, response } = await setup(body.body, {}, signal.signal);
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actualFS.open(...args);
      signal.abort();
      return handle;
    });
    await expect(downloadResponse(request, response, response.url)).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(body.acquire).not.toHaveBeenCalled();
    expect(body.cancel).toHaveBeenCalledOnce();
    await expect(fs.stat(directories[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("times out pending body reads and cleans actual files", async () => {
    const body = source([bytes("partial")], false);
    const { request, response } = await setup(body.body, { deadlineAt: Date.now() + 40 });
    await expect(downloadResponse(request, response, response.url)).rejects.toMatchObject({
      code: "timeout",
    });
    expect(body.cancel).toHaveBeenCalledOnce();
    await expect(fs.stat(directories[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports cleanup failure truthfully rather than claiming no partial files remain", async () => {
    const body = source([], false);
    const { request, response } = await setup(body.body);
    vi.mocked(fs.open).mockRejectedValueOnce(new Error("open failed"));
    vi.mocked(fs.rm).mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(downloadResponse(request, response, response.url)).rejects.toMatchObject({
      code: "download",
      message: "Download failed and temporary-file cleanup failed.",
    });
    expect(body.cancel).toHaveBeenCalledOnce();
  });
});

describe("real native local download streams", () => {
  it("saves native streamed data and removes aborted native partial output (best effort network cancellation)", async () => {
    const timers: Array<ReturnType<typeof setInterval>> = [];
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.write("first");
      if (req.url === "/complete") {
        res.end("second");
        return;
      }
      const timer = setInterval(() => res.write("later"), 10);
      timers.push(timer);
      res.on("close", () => clearInterval(timer));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const request = new RequestOwner({ url });
      owners.push(request);
      const completed = await downloadResponse(request, await request.open(url + "/complete"), url);
      expect(completed.fileSize).toBe(11);
      expect((await fs.readFile(completed.filePath)).toString()).toBe("firstsecond");
      const signal = new AbortController();
      const aborted = new RequestOwner({ url }, { signal: signal.signal });
      owners.push(aborted);
      const downloading = downloadResponse(aborted, await aborted.open(url + "/slow"), url);
      await vi.waitFor(() => expect(directories).toHaveLength(2));
      await pause(30);
      signal.abort();
      await expect(downloading).rejects.toMatchObject({ code: "cancelled" });
      await expect(fs.stat(directories[1])).rejects.toMatchObject({ code: "ENOENT" });
      // No claim that settled JS work means the native response/socket stopped immediately.
    } finally {
      for (const timer of timers) clearInterval(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
