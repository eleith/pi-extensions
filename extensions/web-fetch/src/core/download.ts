import { mkdtemp, open, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RequestOwner, TransportError } from "./transport.js";
import type { OpenResponse } from "./transport.js";
import type { FileResult } from "./types.js";

const SUFFIXES: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
  "application/json": ".json",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "audio/mpeg": ".mp3",
  "video/mp4": ".mp4",
};

export async function downloadResponse(
  owner: RequestOwner,
  response: OpenResponse,
  originalUrl: string,
): Promise<FileResult> {
  const reported = (response.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  const contentType = /^[a-z0-9!#$&^_.+-]{1,127}\/[a-z0-9!#$&^_.+-]{1,127}$/.test(reported)
    ? reported
    : "application/octet-stream";
  let directory: string | undefined;
  let handle: FileHandle | undefined;
  try {
    owner.check();
    // Never create a file whose real path cannot be returned intact in our schema.
    if (tmpdir().length + 80 > owner.limits.maxFilePathChars)
      throw new TransportError("download", "Selected temporary directory path is too long.");
    // mkdtemp creates a new private (0700) namespace; no shared/symlinkable cache dir.
    // Respect the environment-selected root, never silently relocate a denied root.
    directory = await mkdtemp(join(tmpdir(), "pi-web-fetch-"));
    const filePath = join(directory, randomUUID() + (SUFFIXES[contentType] ?? ".bin"));
    handle = await open(filePath, "wx", 0o600); // exclusive, before acquiring any reader
    owner.check();
    const fileSize = await owner.consume(response, owner.limits.downloadBytes, async (chunk) => {
      let offset = 0;
      while (offset < chunk.byteLength) {
        owner.check();
        const { bytesWritten } = await handle!.write(chunk, offset, chunk.byteLength - offset);
        if (bytesWritten <= 0) throw new Error("No write progress");
        offset += bytesWritten;
      }
    });
    owner.check();
    await handle.close();
    handle = undefined;
    owner.check();
    return {
      kind: "file",
      url: originalUrl,
      finalUrl: response.url,
      statusCode: response.status,
      contentType,
      filePath,
      fileSize,
    };
  } catch (error) {
    owner.cancel(response);
    try {
      await handle?.close();
    } catch {
      /* continue partial-file cleanup */
    }
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        throw new TransportError("download", "Download failed and temporary-file cleanup failed.");
      }
    }
    owner.check();
    if (error instanceof TransportError) throw error;
    throw new TransportError(
      "download",
      "Unable to save download in the selected temporary directory.",
    );
  }
}
