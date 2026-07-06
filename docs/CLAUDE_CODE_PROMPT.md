# Claude Code kickoff — "Hive" Phase 1

You are building **Hive**, a personal desktop client that puts an Arc-browser-style shell on top of Notion. Read `PRD.md` and `ARCHITECTURE.md` in this repo before writing any code — they are the source of truth. This prompt scaffolds **Phase 1 only** (the skeleton). Do not build sidebar, Spaces, command bar, split view, or editing yet; those are later phases.

## What Phase 1 must prove

An end-to-end pipe: **authenticate to Notion → fetch one page → render its Tier 1 blocks read-only in a Tauri window → cache it in local SQLite.** Plus a parallel spike (see §7) to inform the render-vs-embed decision. Nothing more. If the pipe works and the spike gives us a feel, Phase 1 is done.

## Stack (from ARCHITECTURE.md §1 — do not substitute)

- Tauri 2 (Rust core + system webview), macOS / Apple Silicon target
- React + TypeScript on the frontend
- Tailwind + CSS variables for styling
- SQLite via `tauri-plugin-sql`
- `@notionhq/client` for Notion REST
- Zustand for state

## Build order

### 1. Project scaffold
- Scaffold a Tauri 2 + React + TypeScript app (Vite). Confirm `npm run tauri dev` opens a window.
- Add Tailwind. Set up a `theme.css` with CSS custom properties for colors (we'll swap these per-Space later — just establish the variable structure now, don't build theming).
- Wire Zustand with a single `useAppStore` and a placeholder slice.

### 2. Secrets & auth
- Use a Notion **internal integration token** (single-user tool — no OAuth callback server; see ARCHITECTURE.md §7 and the PRD auth risk).
- Read the token from a local, git-ignored config (env var or a `~/.hive/config.json`). Never hardcode it, never commit it. Add the config path to `.gitignore`.
- On startup, instantiate the Notion client and verify auth with a lightweight call (e.g. `users.me`). Surface a clear error state in the UI if the token is missing or invalid.

### 3. SQLite layer
- Initialize the DB on first run with a migration.
- For Phase 1, create **only** the `page_cache` table from ARCHITECTURE.md §4:
  `page_cache(notion_page_id, blocks_json, properties_json, fetched_at, etag)`.
- Do NOT create the org-plane tables (`space`, `sidebar_item`, `folder`, etc.) yet — those belong to Phase 2. Keep the migration file structured so adding them later is clean.

### 4. Notion fetch, through a queued client
- Implement the **central request queue** with a token-bucket limiter (~3 rps, small burst) from ARCHITECTURE.md §6. Every Notion call — even in Phase 1 — must funnel through it. Respect `Retry-After` on 429 with exponential backoff. This is infrastructure we rely on later, so build it correctly now even though Phase 1 is low-volume.
- Implement `fetchPage(pageId)`:
  - Serve from `page_cache` immediately if present (cache-first).
  - Fetch `pages.retrieve` + paginated `blocks.children.list` (recurse into nested blocks).
  - Write/refresh `page_cache` with `fetched_at`.
- Accept a page ID from a simple input field for now (no navigation UI yet).

### 5. Block renderer (Tier 1 read-only)
- Build a data-driven `BlockRenderer` with a dispatch table keyed by block type (ARCHITECTURE.md §5). Keep the mapping in one table so block types can be promoted between tiers without touching call sites.
- **Tier 1, render only (no editing in Phase 1):** paragraph, heading_1/2/3, bulleted_list_item, numbered_list_item, to_do, quote, callout, divider, code.
- **Everything else:** render the Tier 3 fallback card — a small placeholder showing the block type label and a disabled/stub "Open in Notion" affordance. (The real deep-link wiring can be a stub in Phase 1.)
- Render Notion rich text correctly (bold, italic, code, links, color) — this is foundational and worth getting right now.

### 6. Minimal shell
- One window: a header with the page-ID input + auth status, and a scrollable content area showing the rendered page.
- No sidebar, no tabs. This is deliberately bare — Phase 1 is about the pipe, not the Arc UI.

### 7. Render-vs-embed spike (required — see ARCHITECTURE.md §10)
Alongside the native renderer, stand up a second minimal view that loads the **same page as an embedded Notion webview**. Add a toggle to flip between "native render" and "embedded Notion." The goal is to *feel* both before Phase 5 commits to an editing strategy. Write a short `SPIKE_NOTES.md` capturing: fidelity, latency, scroll/interaction feel, and any auth/session friction with the embed. Do not build on top of either yet — just make both viewable and record observations.

## Guardrails

- **Never write organizational state to Notion.** Phase 1 doesn't write anything, but internalize the two-plane model (ARCHITECTURE.md §2) now.
- **Cache-first everywhere.** Show cached content instantly, revalidate in the background.
- **Fallback, never crash.** An unknown or malformed block renders the Tier 3 card, never throws.
- **Secrets stay local and git-ignored.** No tokens in the repo, ever.
- **Stay in scope.** If you find yourself building a sidebar, Spaces, a command bar, or edit write-back, stop — that's Phase 2+.

## Definition of done for Phase 1

1. `npm run tauri dev` launches a macOS window.
2. With a valid token in local config, entering a Notion page ID renders that page's Tier 1 blocks with correct rich-text formatting.
3. Unsupported blocks show the fallback card instead of breaking.
4. The page is cached in SQLite and served cache-first on the next open.
5. All Notion calls go through the rate-limited queue.
6. The embed toggle works and `SPIKE_NOTES.md` records the render-vs-embed comparison.

Start by reading both planning docs, then propose a file/folder structure for approval before scaffolding. After I approve the structure, build in the order above and pause after step 4 so I can verify the pipe before you build the renderer.
