# PRD — "Hive" (working title): An Arc-style client for Notion

## 1. Problem

Honeycomb migrated from Quip to Notion. Notion's shared workspace model conflates *organization* with *content*: rearranging the page tree to suit yourself changes it for everyone. Notion is also a single-document surface — opening multiple pages side by side, keeping a persistent set of working docs, and moving quickly between contexts are all awkward. Navigation is slow and mouse-heavy.

The result is friction for a power user who thinks in terms of *contexts* (SRE work, Security Engineering, a specific launch, personal notes) and wants to keep many documents in flight at once.

## 2. Goal

A personal desktop client that sits on top of the Notion API and reshapes the experience to mirror the interaction model of **Arc from The Browser Company** — vertical sidebar, Spaces, pinned items, a command bar, split view, and peek — while leaving the shared Notion workspace completely untouched.

The core principle: **all organization is local and private.** Notion remains the source of truth for content. Spaces, pins, tab order, and folders live only on this machine and are never written back to Notion, so nothing this app does can disrupt a teammate's view.

## 3. Non-goals

- Not a full reimplementation of Notion's block editor. Text and common blocks are editable; exotic block types degrade gracefully or open in native Notion.
- Not real-time multiplayer. No live cursors or presence (the Notion API does not expose these).
- Not a mobile app. Desktop only (macOS first).
- Not a team product. Single-user, single-machine. No shared state, no server-side accounts.
- Not a general web browser. It renders Notion content only.

## 4. Target user

One person: a technical power user (you) who lives in keyboard shortcuts, juggles work across many teams, and misses Arc. Success is measured by whether daily Notion use feels faster and less disruptive than the native client — not by adoption metrics.

## 5. Core features (leaning hard into Arc)

The Arc feature set below is the north star. Each maps a specific Arc behavior onto Notion content.

### 5.1 Vertical sidebar (the heart of the app)
Everything starts in a left-hand vertical sidebar, exactly as in Arc. Horizontal space is premium, vertical space is abundant — so document titles get room to breathe instead of shrinking into an unreadable tab strip. The sidebar houses Favorites, pinned items, folders, Spaces, and today's open documents in a single vertical stack.

### 5.2 Spaces
A **Space** is a self-contained context with its own set of pinned documents, folders, open tabs, and color/theme. Switching Spaces swaps the entire sidebar. Model contexts directly: an "SRE" Space, a "Security Eng" Space, a "Launch" Space, a "Personal" Space. Context-switching is a single keystroke (`Ctrl-Space-<n>`), and each Space's color makes the current context obvious at a glance.

Crucially, Spaces are a *local overlay* on the flat Notion page graph — a Notion page can appear in multiple Spaces, or none, without moving in Notion itself.

### 5.3 Tab hierarchy (Favorites / Pinned / Today)
Three tiers of persistence, mirroring Arc:
- **Favorites** — top of the sidebar, shown as icons, *transcend all Spaces* (e.g. a team wiki root or a personal daily-notes page always reachable).
- **Pinned (per-Space)** — persistent within one Space; never auto-closed.
- **Today** — ephemeral open documents; auto-archive from the sidebar after a configurable interval (default 24h). This kills the "300 stale tabs" problem without losing anything, since the doc still exists in Notion.

### 5.4 Command bar
`Cmd-T` opens a centered floating command bar (Arc's signature muscle-memory feature). One input searches across: open tabs, pinned items, recent documents, full Notion search, and app actions ("Add Right Split", "New Space", "Pin", "Open in Notion"). Fuzzy matching, keyboard-driven, with a local frecency index so the docs you touch most surface first. This is the primary navigation surface — it removes the need for perfect organization.

### 5.5 Split View
View two (or more) documents side by side in one window — horizontal or vertical. A split becomes its own entry in the sidebar so a working pair (e.g. a runbook + an incident doc) can be reopened later as a unit. This directly solves the "can't have multiple documents open" complaint.

### 5.6 Peek / hover preview
Hovering a pinned or favorited item shows a live preview of the document without switching to it — Arc's Notion-hover behavior, applied to Notion itself. Fast glance without navigation.

### 5.7 Little-Arc-style quick capture
`Cmd-Opt-N` opens a small floating window to jot a quick note or open a link without disturbing the current Space layout. Can be discarded or promoted into a Space afterward.

### 5.8 Air Traffic Control (routing rules)
Local rules that route documents to the right Space automatically: "any page under the SRE parent opens in the SRE Space," "anything with the `#personal` tag opens in Personal." Turns the client into a lightweight workflow engine.

### 5.9 Local self-organization (the differentiator)
Drag to reorder, group into folders, nest, and pin — all stored locally. This is the feature Notion actively prevents and the main reason the project exists. None of it touches the shared workspace.

### 5.10 Notifications / unread awareness
Native Notion never makes it obvious that you have unread notifications. Hive maintains a local *attention engine*: unread-change dots on sidebar items (from background revalidation), badge counts per Space and on the dock icon, and a lightweight inbox fed by polling comments/mentions on watched (pinned/favorited) pages. Note: the Notion API exposes no notifications endpoint, so this is change-detection over pages Hive tracks — not a mirror of the native inbox. Full-fidelity fallback: open notion.so's inbox in an embedded view.

## 6. Feature priority

| Priority | Feature | Rationale |
|---|---|---|
| P0 | Sidebar + Spaces + local org | The reason the app exists |
| P0 | Command bar | Primary navigation; unblocks everything else |
| P0 | Document read rendering | Nothing works without displaying pages |
| P0 | Basic text editing (write-back) | A read-only client is a dead end |
| P1 | Split View | Top-3 named pain point |
| P1 | Tab tiers + auto-archive | Core Arc workflow |
| P1 | Peek / hover preview | High delight, moderate effort |
| P1 | Unread awareness / notifications | Named pain point in native Notion; dots cheap via revalidation, inbox via comment polling |
| P2 | Air Traffic Control routing | Power-user polish |
| P2 | Quick-capture window | Nice-to-have |
| P3 | Richer block editing parity | Long tail; native-Notion fallback covers it |

## 7. Key product decisions

- **Local-first organization.** All Spaces/pins/order/folders persist locally (SQLite). Zero writes of organizational metadata to Notion.
- **Notion is source of truth for content.** Document body, properties, and tree parentage are always read from Notion; the app never forks content state.
- **Graceful degradation over perfect fidelity.** Any block type the renderer can't handle shows a clean fallback with an "Open in Notion" affordance rather than breaking.
- **Escape hatch always present.** Every document has a one-key "Open in native Notion" so the app is never a trap when it falls short.
- **Read-heavy, write-light v1.** Optimize for reading, navigating, and light editing first; full editing parity is explicitly deferred.

## 8. Open questions / risks

- **Rendering long tail.** Databases-as-pages, synced blocks, and some embeds are non-trivial to render from the block API. Mitigation: fallback + native open (decision in §7). Decide per-block-type what's worth rendering.
- **Rate limits.** Notion API averages ~3 req/s. An eager prefetch-all-tabs model needs a caching + throttling layer (see architecture doc). Risk if a Space has many pinned docs.
- **Auth model.** Internal integration token (simplest, single-user) vs. public OAuth integration. Leaning internal token for a personal tool — fewer moving parts, no callback server. Confirm it can see all needed pages.
- **Editing round-trips.** The block API's write surface is partial; some blocks are read-only or awkward to construct. Scope v1 editing to text, headings, lists, to-dos, callouts.
- **Sync/conflict.** With no presence API, a teammate could edit a doc you have open. Need a lightweight "content changed, refresh?" check on focus.

## 9. Success criteria

- Daily driver within two weeks: you reach for this instead of native Notion for reading and navigation.
- Opening a second document side-by-side takes one keystroke.
- Reorganizing your own working set never prompts a "did this change it for everyone?" worry — because it structurally can't.
- Command bar gets you to any document in under two seconds without knowing where it lives in the tree.
