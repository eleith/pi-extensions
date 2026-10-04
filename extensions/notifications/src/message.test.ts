import { describe, expect, it } from "vitest";
import { completionBody, notificationTitle } from "./message.ts";

describe("notification messages", () => {
  it("prefers a pane title and preserves an existing Pi label", () => {
    expect(notificationTitle("work pane", "/work/project", "session")).toBe("π · work pane");
    expect(notificationTitle("π - work", "/work/project")).toBe("π - work");
    expect(notificationTitle("Pi - work", "/work/project")).toBe("Pi - work");
  });

  it("sanitizes session and folder fallbacks as well as pane titles", () => {
    expect(notificationTitle(undefined, "/work/project\nname", "session\x07\x1b name")).toBe(
      "π · session name - project name",
    );
    expect(notificationTitle("\x07\x1b", "/work/project", "session")).toBe("π · session - project");
    expect(notificationTitle(undefined, "/work/project")).toBe("π · project");
    expect(notificationTitle("x".repeat(200), "/work/project")).toBe(`π · ${"x".repeat(120)}`);
  });

  it.each([
    [1000, "1s"],
    [15_000, "15s"],
    [60_000, "1m"],
    [61_000, "1m1s"],
    [3_600_000, "1h"],
    [3_660_000, "1h1m"],
    [-1000, "0s"],
  ] as const)("formats a completed run of %d ms", (duration, label) => {
    expect(completionBody("completed", duration)).toBe(`Ready for input · completed in ${label}`);
  });

  it("keeps distinct stopped/error/unknown outcome text", () => {
    expect(completionBody("aborted", 1000)).toBe("Run stopped · 1s");
    expect(completionBody("error", 1000)).toBe("Run ended with an error · 1s");
    expect(completionBody(undefined, 1000)).toBe("Ready for input · 1s");
  });
});
