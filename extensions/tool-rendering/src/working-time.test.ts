import { expect, it } from "vitest";
import { WorkingTimeTracker, workingMessage, formatClock } from "./working-time.ts";

it("accumulates only open model segments and is safe to begin/end twice", () => {
  let now = 0;
  const tracker = new WorkingTimeTracker(() => now);
  tracker.beginRun();
  tracker.beginModelSegment();
  now = 1500;
  tracker.beginModelSegment();
  expect(tracker.modelMs()).toBe(1500);
  tracker.endModelSegment();
  tracker.endModelSegment();
  now = 10000;
  expect(tracker.modelMs()).toBe(1500);
  tracker.beginModelSegment();
  now = 12000;
  expect(tracker.modelMs()).toBe(3500);
  tracker.settle();
  expect(tracker.modelMs()).toBe(0);
  tracker.beginModelSegment();
  now = 13000;
  expect(tracker.modelMs()).toBe(1000);
});

it("never adds a negative interval when the clock moves backwards", () => {
  let now = 5000;
  const tracker = new WorkingTimeTracker(() => now);
  tracker.beginModelSegment();
  now = 4000;
  expect(tracker.modelMs()).toBe(0);
  tracker.endModelSegment();
  expect(tracker.modelMs()).toBe(0);
});

it.each([
  [0, "0.0s"],
  [-1, "0.0s"],
  [1234, "1.2s"],
  [59900, "59.9s"],
  [60000, "1m0s"],
  [61000, "1m1s"],
  [3600000, "1h0m0s"],
  [3661000, "1h1m1s"],
])("formats %s milliseconds as %s", (ms, expected) => {
  expect(formatClock(ms as number)).toBe(expected);
  expect(workingMessage(ms as number)).toBe(`Working... (${expected})`);
});
