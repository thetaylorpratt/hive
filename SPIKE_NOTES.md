# Render-vs-embed spike notes (Phase 1, ARCHITECTURE.md §10)

Goal: *feel* both rendering paths before Phase 5 commits to an editing
strategy. The formal decision (ADR) happens at the end of Phase 2.

## Implementation note

notion.so refuses to load in an iframe (`X-Frame-Options` / frame-ancestors),
so the "embedded" path is a **separate Tauri webview window** (label `embed`)
pointed at the page's notion.so URL, opened/refocused via the Embedded toggle
in the header. This is itself a spike finding: a true in-pane embed would
require Tauri's multiwebview (child webviews positioned inside the main
window), which is worth prototyping in Phase 2 if the embed path stays alive.

## Observations to record (fill in while daily-driving)

### Native render
- Fidelity: _how much of a real work doc renders correctly? Which fallback
  cards appear most?_
- Latency: _cold fetch vs. cache-first open._
- Scroll/interaction feel: _…_

### Embedded Notion
- Auth/session: _does the webview session persist? SSO friction? (Record
  whether login survives app restarts — WKWebView cookie persistence.)_
- Latency: _first load and warm load._
- Feel: _chrome, fonts, does it feel like "just Notion in a window"?_
- Deal-breakers: _anything that structurally blocks the hybrid (native read +
  embedded edit) approach?_

### Early read
_(fill in after a few days of use)_
