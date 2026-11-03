# Log JSON extractor

Paste a log line, error message or any text, and every JSON-like structure in it is pulled out and shown as a tree.

**Open it:** https://vadimdulub.github.io/log-json-extractor/

It parses strict JSON and repairs broken input: unquoted keys, single quotes, comments, trailing or missing commas,
Python and JavaScript literals, Go `%+v` struct dumps and `map[...]`, backslash-escaped JSON, truncated text,
and JSON nested inside string values.

Everything runs in your browser; pasted text is never sent anywhere.

The whole app is `index.html`. Parser tests: `node test.mjs`.
