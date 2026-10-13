import { readFile } from "node:fs/promises";
import { Defuddle } from "defuddle/node";
import { expect, it } from "vitest";
import { parseLinkedomHTML } from "./dom.ts";
import { extractContent } from "./extract.ts";

const noNetwork: typeof fetch = async () => {
  throw new Error("Unexpected site request");
};
const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

it.each([
  {
    name: "GitHub",
    file: "github-issue.html",
    url: "https://github.com/fixtures/project/issues/1",
    reply: "Actual issue reply can be excluded.",
    authored: "Legitimate authored Comments section remains part of the issue.",
  },
  {
    name: "Hacker News",
    file: "hackernews-post.html",
    url: "https://news.ycombinator.com/item?id=123",
    reply: "Actual story reply can be excluded.",
    authored: "Legitimate authored Comments section remains part of the story.",
  },
])(
  "lets Defuddle own $name reply filtering without removing authored headings/code",
  async ({ file, url, reply, authored }) => {
    const html = await fixture(file);
    for (const format of ["markdown", "html"] as const) {
      for (const includeReplies of [true, false]) {
        const result = await extractContent(
          html,
          url,
          { url, format, includeReplies },
          noNetwork,
          undefined,
          "text/html",
        );
        const library = await Defuddle(await parseLinkedomHTML(html, url), url, {
          markdown: format !== "html",
          includeReplies,
          fetch: noNetwork,
        });
        expect(result.content).toBe(library.content.trim());
        expect(result.content).toContain(authored);
        expect(result.content).toContain('const example = "## Comments";');
        expect(result.content.includes(reply)).toBe(includeReplies);
      }
    }
  },
);

it("delegates Reddit old HTML and rendered X replies to Defuddle across output formats", async () => {
  const reddit = "https://www.reddit.com/r/fixtures/comments/abc/offline";
  const old = await fixture("reddit-old.html");
  const thread = await fixture("x-thread.html");
  const x = "https://x.com/fixture/status/22222";
  for (const format of ["markdown", "html"] as const) {
    for (const includeReplies of [true, false]) {
      const post = await extractContent(
        "<html><body></body></html>",
        reddit,
        { url: reddit, format, includeReplies },
        async () => new Response(old, { headers: { "content-type": "text/html" } }),
        undefined,
        "text/html",
      );
      expect(post.content).toContain("A post about offline fixtures");
      expect(post.content.includes("Offline reply content")).toBe(includeReplies);
      const tweet = await extractContent(
        thread,
        x,
        { url: x, format, includeReplies },
        noNetwork,
        undefined,
        "text/html",
      );
      expect(tweet.content).toContain("Main offline thread post");
      expect(tweet.content).toContain("Self-reply remains part of the post");
      expect(tweet.content.includes("Other-author reply can be excluded")).toBe(includeReplies);
    }
  }
});

it("lets Defuddle exclude Reddit Atom replies while keeping the post", async () => {
  const url = "https://www.reddit.com/r/fixtures/comments/feedfixture/offline";
  const feed = await fixture("reddit-feed.xml");
  const fetcher: typeof fetch = async (target) => {
    if (String(target) === "https://old.reddit.com/r/fixtures/comments/feedfixture/offline")
      return new Response("blocked", { status: 403 });
    if (String(target) === `${url}/.rss`)
      return new Response(feed, { headers: { "content-type": "application/atom+xml" } });
    throw new Error("Unexpected controlled site request");
  };
  for (const includeReplies of [true, false]) {
    const result = await extractContent(
      "<html><body></body></html>",
      url,
      { url, includeReplies },
      fetcher,
      undefined,
      "text/html",
    );
    expect(result.content).toContain("Atom post body");
    expect(result.content.includes("Atom reply fixture content")).toBe(includeReplies);
  }
});
