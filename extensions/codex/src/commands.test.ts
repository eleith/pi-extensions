import { expect, it } from "vitest";
import { CODEX_ACTIONS, completeCodexArguments } from "./commands.ts";

it("offers context, fast, and usage at the root", async () => {
  expect(CODEX_ACTIONS).toEqual(["context", "fast", "usage"]);
  expect(await completeCodexArguments("")).toEqual([
    {
      value: "context",
      label: "context",
      description: "Control the local context window",
    },
    {
      value: "fast",
      label: "fast",
      description: "Control priority processing and allowance use",
    },
    {
      value: "usage",
      label: "usage",
      description: "Show account usage and allowance limits",
    },
  ]);
});

it.each([
  ["  CO", ["context"]],
  ["\tFa", ["fast"]],
  ["US", ["usage"]],
  ["context", ["context"]],
  ["fast", ["fast"]],
  [" \t ", ["context", "fast", "usage"]],
])("completes normalized root prefix %j", async (prefix, values) => {
  expect((await completeCodexArguments(prefix))?.map(({ value }) => value)).toEqual(values);
});

it("offers local context controls with full replacement values and plain descriptions", async () => {
  expect(await completeCodexArguments("context ")).toEqual([
    {
      value: "context on",
      label: "on",
      description: "Use the larger local context window",
    },
    {
      value: "context off",
      label: "off",
      description: "Use the catalog baseline context window",
    },
    {
      value: "context toggle",
      label: "toggle",
      description: "Switch between the larger local window and catalog baseline",
    },
  ]);
  expect(await completeCodexArguments(" \tCONTEXT\t  ")).toEqual(
    await completeCodexArguments("context "),
  );
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
  ]);
  expect(await completeCodexArguments(" \tFAST\t  ")).toEqual(
    await completeCodexArguments("fast "),
  );
});

it.each([
  ["context o", ["context on", "context off"]],
  ["  CONTEXT\tOf", ["context off"]],
  ["context t", ["context toggle"]],
  ["context on", ["context on"]],
  ["fast o", ["fast on", "fast off"]],
  ["  FAST\tOf", ["fast off"]],
  ["fast t", ["fast toggle"]],
  ["fast on", ["fast on"]],
])("completes only the matching control for %j", async (prefix, values) => {
  expect((await completeCodexArguments(prefix))?.map(({ value }) => value)).toEqual(values);
});

it.each([
  "unknown",
  "extend",
  "restore",
  "status",
  "reset",
  "ex",
  "re",
  "fast unknown",
  "context unknown",
  "fa on",
  "con on",
  "extend ",
  "restore o",
  "usage fast",
  "fast on ",
  "fast off\t",
  "fast toggle extra",
  "fast status",
  "fast reset",
  "fast o ",
  "context on ",
  "context off\t",
  "context toggle extra",
  "context status",
  "context reset",
  "context extend",
  "context restore",
  "context o ",
])("does not offer aliases or invent further arguments for %j", async (prefix) => {
  expect(await completeCodexArguments(prefix)).toBe(null);
});
