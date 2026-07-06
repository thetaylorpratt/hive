# Architecture — "Hive": An Arc-style Notion client

Companion to `PRD.md`. This describes *how* to build the product, structured so it can be handed to Claude Code as a build spec.

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | **Tauri 2** (Rust core + system webview) | Native windows, tabs, global shortcuts, tray, low memory. Better Arc-feel than Electron; smaller binary. |
| UI | **React + TypeScript** | Reuses your existing muscle memory; huge ecosystem for command bars, DnD, split panes. |
| Styling | **Tailwind + CSS variables** | Per-Space theming maps naturally to CSS custom properties swapped at the Space level. |
| Local store | **SQLite** (via `tauri-plugin-sql`) | Organizational metadata, cache, frecency index. Single-file, fast, transactional. |
| Notion access | **Notion REST API** (`@notionhq/client`), internal integration token | Direct API at runtime; MCP is a build-time tool only (see §7). |
| State | **Zustand** (or Redux Toolkit) | Sidebar/tab/Space state is the app's core; needs predictable, serializable state. |

macOS first (Apple Silicon). Tauri keeps a Windows/Linux port open later, but don't design for it in v1.

## 2. Two-plane model

The single most important architectural idea, flowing from the PRD's local-first principle:

```
┌─────────────────────────────────────────────────────────┐
│  ORGANIZATION PLANE (local, private, mutable)            │
│  Spaces · Favorites · Pins · Folders · Tab order ·       │
│  Split layouts · ATC rules · Frecency                    │
│  → lives entirely in local SQLite. NEVER written to      │
│    Notion.                                               │
└─────────────────────────────────────────────────────────┘
                          │ references pages by Notion ID
                          ▼
┌─────────────────────────────────────────────────────────┐
│  CONTENT PLANE (remote, shared, source of truth)         │
│  Page bodies · block trees · properties · tree parentage │
│  → always read from Notion API. Cached locally read-only.│
│    Only user-authored edits (§5) are written back.       │
└─────────────────────────────────────────────────────────┘
```

The organization plane holds only *pointers* (Notion page/block IDs) plus local metadata. A page can appear in three Spaces or none; reordering it locally moves the pointer, not the page. This is what makes "self-organize without messing it up for everyone" structurally guaranteed rather than a matter of discipline.

## 3. Component map

```
App
├─ SpaceBar            vertical rail of Space icons; Ctrl-Space-<n> switch
├─ Sidebar             per-active-Space
│  ├─ FavoritesRow     cross-Space icon row (top)
│  ├─ PinnedList       persistent, per-Space
│  ├─ FolderTree       local drag/drop/nest
│  └─ TodayList        ephemeral; auto-archive timer
├─ CommandBar          Cmd-T floating overlay (portal)
├─ Workspace           the content area
│  ├─ TabStrip         open docs in active Space
│  ├─ SplitContainer   1..n panes, H/V; a split is a saveable sidebar entry
│  │  └─ DocumentView  ×N
│  │     ├─ BlockRenderer   read
│  │     └─ BlockEditor     write (text-class blocks)
│  └─ PeekLayer        hover preview portal
└─ QuickCapture        separate small Tauri window (Cmd-Opt-N)
```

## 4. Data model (local SQLite)

```sql
-- Contexts
space(id, name, color, theme, sort_order, created_at)

-- Sidebar entries. A "reference" to a Notion page with local placement.
sidebar_item(
  id, space_id, notion_page_id,
  tier,          -- 'favorite' | 'pinned' | 'today'
  parent_folder_id NULL,
  sort_order,
  title_cache,   -- denormalized for instant render
  icon_cache,
  last_opened_at,
  auto_archive_at NULL  -- set for 'today' tier
)
folder(id, space_id, name, parent_folder_id NULL, sort_order)

-- Saveable split layouts
split_layout(id, space_id, name, orientation, created_at)
split_pane(id, split_layout_id, notion_page_id, pane_order)

-- Air Traffic Control
atc_rule(id, match_type, match_value, target_space_id, enabled)
-- match_type: 'url_contains' | 'parent_id' | 'property_tag'

-- Navigation intelligence
frecency(notion_page_id, hit_count, last_hit_at, score_cache)

-- Read-only content cache (content plane mirror)
page_cache(notion_page_id, blocks_json, properties_json, fetched_at, etag)
```

Favorites are just `sidebar_item` rows with `tier='favorite'` and a null `space_id` (or a sentinel), so they transcend Spaces per the PRD tab hierarchy.

## 5. Notion integration

### Reads
- Page body: `blocks.children.list` (paginate; recurse for nested blocks).
- Metadata: `pages.retrieve`, `databases.query` for database pages.
- Search / command bar: `search` endpoint, merged with local frecency ranking.
- **Cache aggressively** into `page_cache` with `fetched_at`. Serve cache instantly on open, then revalidate in the background and diff-patch the view ("content changed" per PRD risk on concurrent edits).

### Writes (v1 scope — text-class blocks only)
- `blocks.update` for editing existing text/heading/list/to-do/callout blocks.
- `blocks.children.append` for new blocks.
- Everything else is read-only in v1 → fallback UI + "Open in Notion".
- Write path is deliberately narrow; expand block-type coverage in later phases.

### Block rendering strategy
A `BlockRenderer` dispatch keyed by block type:
- **Tier 1 (render + edit):** paragraph, headings, bulleted/numbered list, to-do, quote, callout, divider, code.
- **Tier 2 (render only):** image, bookmark, table, toggle, columns, equation.
- **Tier 3 (fallback):** synced blocks, linked databases, unsupported embeds → placeholder card with type label + "Open in Notion" button.

Keep the dispatch table data-driven so tiers can be promoted without touching call sites.

## 6. Rate limiting & caching

Notion averages ~3 req/s; bursts get 429'd. Required infrastructure:

- **Central request queue** in the Rust core (or a single TS module) with a token-bucket limiter (~3 rps, small burst). All Notion calls funnel through it.
- **Respect `Retry-After`** on 429 with exponential backoff.
- **Cache-first reads.** Open = show cached blocks immediately, revalidate async.
- **Lazy prefetch, bounded.** On Space switch, prefetch only pinned/favorite docs, throttled and capped (e.g. 5 concurrent, rest on demand). Do NOT eagerly fetch every doc — this is the named PRD risk.
- **ETag / hash** stored per page to skip re-render when unchanged.

## 7. MCP vs. runtime API (build strategy)

Per the PRD and prior discussion:
- **Build time:** use the **Notion MCP** with Claude Code to explore the workspace, discover page/database IDs and shapes, and scaffold the block-type inventory. Great for one-off introspection and generating the Tier 1/2/3 mapping.
- **Runtime:** the shipped app calls the **Notion REST API directly** via a queued client. An interactive desktop app makes hundreds of calls; routing those through an MCP layer at runtime adds latency and fragility for no benefit.

Treat the MCP as the workshop, the REST API as the engine.

## 8. Keyboard model (Arc parity)

| Shortcut | Action |
|---|---|
| `Cmd-T` | Command bar |
| `Ctrl-Space-<n>` | Switch to Space n |
| `Cmd-Shift-+` | New split from current doc |
| `Cmd-Opt-N` | Quick-capture window |
| `Cmd-Opt-<1-9>` | Jump to favorite n |
| `Cmd-\` | Toggle sidebar |
| `Cmd-O` (in a doc) | Open in native Notion |

Global shortcuts registered via Tauri's `globalShortcut`. In-app shortcuts via a single keymap module so they're remappable later.

## 9. Build phases

1. **Skeleton** — Tauri + React shell, SQLite wired, Notion auth, fetch + render one page (Tier 1 blocks read-only). Proves the pipe end to end.
2. **Sidebar + Spaces** — local org plane, drag/drop, tab tiers, Space switching, theming. The differentiator lands here.
3. **Command bar + frecency** — search, fuzzy match, actions. Navigation becomes fast.
4. **Split View + Peek** — multi-doc workspace, saveable splits, hover preview.
5. **Editing** — Tier 1 write-back, background revalidation, concurrent-edit refresh.
6. **ATC + Quick capture + polish** — routing rules, Little-Arc window, auto-archive, escape hatches everywhere.

Ship phase 1–2 before touching anything past it; the sidebar/Spaces experience is the whole thesis and worth validating before investing in the rendering long tail.

## 10. Decision: shell-render vs. embed (revisit before phase 5)

Two rendering paths, from the prior discussion:
- **Native render** (this doc's default): full control, best Arc feel, pays the block long-tail cost.
- **Embed native Notion webview** inside the Arc shell: skip block rendering entirely, get editing parity free, lose interior customization.

A defensible hybrid: **native render for Tier 1/2 reading + Arc navigation, embedded Notion webview as the editing surface and the Tier 3 fallback.** Spike both a native Tier-1 renderer and an embedded webview in phase 1 and measure feel before committing phase 5's editing investment.
