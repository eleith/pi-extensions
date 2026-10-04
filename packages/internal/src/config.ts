import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface Settings {
  commandPrefix: string;
  [key: string]: unknown;
}

export async function getSettings(): Promise<Settings> {
  const path = resolve(getAgentDir(), "extensions", "eleith.json");
  try {
    const config: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      throw new Error("Expected a JSON object");
    }
    const prefix = "commandPrefix" in config ? config.commandPrefix : "eleith";
    if (
      typeof prefix !== "string" ||
      prefix !== prefix.trim() ||
      !/^[a-z][a-z0-9-]*$/.test(prefix)
    ) {
      throw new Error("commandPrefix must be a lowercase name matching ^[a-z][a-z0-9-]*$");
    }
    return { ...config, commandPrefix: prefix };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { commandPrefix: "eleith" };
    }
    throw new Error(
      `Cannot load ${path}: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
}
