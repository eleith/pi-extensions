/// <reference lib="dom" />
import { describe, expect, it } from "vitest";
import { inspectHtml } from "./extract.ts";
import { parseLinkedomHTML } from "./dom.ts";

const url = "https://example.test/start";

describe("HTML navigation hints", () => {
  it("uses DOM attribute ordering, entity decoding and base href for refresh and alternates", async () => {
    const html = `<html><head><base href="/docs/"><meta content="0.5; URL='next?a=1&amp;b=2'" http-equiv="Refresh"><link type="application/problem+json" href="data.json" rel="help ALTERNATE"></head><body><link rel="alternate" type="application/json" href="body.json"></body></html>`;
    expect(await inspectHtml(html, url, "json")).toEqual({
      redirect: "https://example.test/docs/next?a=1&b=2",
      alternates: ["https://example.test/docs/data.json"],
    });
  });
  it.each(["-1", "30", "NaN", "0oops", "Infinity"])(
    "ignores invalid/slow refresh delay %s",
    async (delay) => {
      expect(
        (
          await inspectHtml(
            `<html><head><meta http-equiv=refresh content="${delay};url=/next"></head></html>`,
            url,
            "markdown",
          )
        ).redirect,
      ).toBeUndefined();
    },
  );
  it("limits candidates to three qualified distinct HTTP(S) head alternates", async () => {
    const links = [
      "<link rel=alternate type=text/html href=/wrong>",
      '<link rel=alternate type=text/markdown href="javascript:bad()">',
      "<link rel=alternate type=text/markdown href=/start>",
      "<link rel=alternate type=text/markdown href=/one>",
      "<link rel=alternate type=text/markdown href=/one>",
      "<link rel=alternate type=text/x-markdown href=/two>",
      '<link rel=alternate type="text/markdown; charset=utf-8" href=/three>',
      "<link rel=alternate type=text/markdown href=/four>",
    ].join("");
    expect(await inspectHtml(`<html><head>${links}</head></html>`, url, "markdown")).toEqual({
      alternates: [
        "https://example.test/one",
        "https://example.test/two",
        "https://example.test/three",
      ],
    });
  });
  it("raw bypasses every hint and invalid schemes are never candidates", async () => {
    const html =
      '<html><head><meta http-equiv=refresh content="0;url=javascript:bad()"><link rel=alternate type=application/json href="file:///secret"></head></html>';
    expect(await inspectHtml(html, url, "json")).toEqual({ alternates: [] });
    expect(await inspectHtml(html, url, "raw")).toEqual({ alternates: [] });
  });
});

it("keeps DOM compatibility shims local and never executes page scripts", async () => {
  const keys = ["getComputedStyle", "Window", "document"] as const;
  const before = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const html =
    '<html><head><title>Document</title></head><body><article><p>Body</p><script>globalThis.document = "poison"</script></article></body></html>';
  const document = await parseLinkedomHTML(html, url);
  const second = await parseLinkedomHTML("<html><body>Other</body></html>", url);
  expect(document.defaultView).not.toBe(second.defaultView);
  expect(document.defaultView?.getComputedStyle(document.body).display).toBe("");
  expect(document.styleSheets).toEqual([]);
  expect(document.URL).toBe(url);
  expect(document.title).toBe("Document");
  expect(document.body.innerHTML).toContain("globalThis.document");
  expect(keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key))).toEqual(before);
});
