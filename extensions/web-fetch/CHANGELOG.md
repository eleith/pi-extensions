# Changelog

## Unreleased

- Add focused browser-fingerprinted `web_fetch` and `web_fetch_batch` tools with markdown, html, json, and raw output formats, readable extraction, streamed temporary downloads, and bounded ordered batches.
- Provide overridable default framed rendering without changing tool execution or model-facing results.
- Add the shared prefixed web-fetch command with on/off/toggle controls for both tools and test [URL] through the normal agent/tool pipeline.
- Adapt MIT-licensed pi-smart-fetch 0.3.17 with current wreq-js, Defuddle, and Linkedom; remove compatibility-only options, custom transport/header configuration, filename/MIME database machinery, global console interception, and fabricated HTTP statuses.
- Delegate site-specific extraction and reply filtering to Defuddle; remove inherited site-label and comment-section cleanup.
- Remove the secondary DOM cleaner/Markdown converter; retain navigation hints and suggest raw when extraction fails.
- Share lightweight initial request validation and return bounded extractor responses directly, without body-method interception.
- Drop the text output mode and handwritten Markdown-to-text conversion; plain-text inputs remain supported.
- Validate JSON without pretty-printing or reserializing; preserve source numbers, duplicate keys and whitespace, and remove the indentation-expansion guard.
- Document best-effort native cancellation and accepted-data limits without claiming immediate network shutdown.
