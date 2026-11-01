import { expect, it } from "vitest";
import { CODEX_ACTIONS, completeCodexArguments } from "./commands.ts";

it("offers the four root actions with context, usage, and fast help", async () => {
  expect(CODEX_ACTIONS).toEqual(["extend", "restore", "usage", "fast"]);
  expect(await completeCodexArguments("")).toEqual([
    {
      value: "extend",
      label: "extend",
      description: "Extend the context window for the current supported Codex model",
    },
    {
      value: "restore",
      label: "restore",
      description: "Restore the standard context window",
    },
    {
      value: "usage",
      label: "usage",
      description: "Show account usage and allowance limits",
    },
    {
      value: "fast",
      label: "fast",
      description: "Show fast mode and its controls",
    },
  ]);
});

it.each([
  ["  EX", ["extend"]],
  ["\tRe", ["restore"]],
  ["US", ["usage"]],
  ["Fa", ["fast"]],
  ["fast", ["fast"]],
  [" \t ", ["extend", "restore", "usage", "fast"]],
])("completes normalized root prefix %j", async (prefix, values) => {
  expect((await completeCodexArguments(prefix))?.map(({ value }) => value)).toEqual(values);
});

it("offers fast controls with full replacement values and helpful descriptions", async () => {
  expect(await completeCodexArguments("fast ")).toEqual([
    {
      value: "fast on",
      label: "on",
      description: "Request priority processing (uses more allowance)",
    },
    {
      value: "fast off",
      label: "off",
      description: "Request standard processing instead of priority",
    },
    {
      value: "fast toggle",
      label: "toggle",
      description: "Switch fast mode on or off",
    },
    {
      value: "fast status",
      label: "status",
      description: "Show detailed fast-mode diagnostics",
    },
    {
      value: "fast reset",
      label: "reset",
      description: "Return to the provider's default for this model",
    },
  ]);
  expect(await completeCodexArguments(" \tFAST\t  ")).toEqual(
    await completeCodexArguments("fast "),
  );
});

it.each([
  ["fast o", ["fast on", "fast off"]],
  ["  FAST\tOf", ["fast off"]],
  ["fast t", ["fast toggle"]],
  ["fast S", ["fast status"]],
  ["fast re", ["fast reset"]],
  ["fast on", ["fast on"]],
])("completes only the matching fast argument for %j", async (prefix, values) => {
  expect((await completeCodexArguments(prefix))?.map(({ value }) => value)).toEqual(values);
});

it.each([
  "unknown",
  "fast unknown",
  "fa on",
  "extend ",
  "restore o",
  "usage fast",
  "fast on ",
  "fast off\t",
  "fast toggle extra",
  "fast status ",
  "fast reset on",
  "fast o ",
])("does not invent further arguments for %j", async (prefix) => {
  expect(await completeCodexArguments(prefix)).toBe(null);
});
