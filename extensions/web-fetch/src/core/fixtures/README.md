# Extraction fixtures

All files here are small original synthetic examples authored for this extension.
No captured user content, credentials, upstream fixture corpus or live-site snapshots.
Article, GitHub and Hacker News fixtures check Defuddle's structured extraction and
reply filtering. Reddit old HTML/Atom, X FxTwitter/oEmbed/rendered threads, and YouTube
player/next/caption payloads model the installed Defuddle 0.19.4 extractors' APIs.
These prove named offline paths, not universal compatibility with future site markup.

The extraction approach is adapted from pi-smart-fetch 0.3.17 (see package LICENSE).
Defuddle owns extraction/conversion; this extension has no secondary DOM cleaner or
Markdown renderer. On failure it can follow qualified alternates or suggest an explicit
raw retry. Tests compare successful article/reply output with the real library invocation;
raw output is bounded and bypasses extraction, console interception and fabricated statuses.
