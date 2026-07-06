# 🐝 Hive

A personal, Arc-style desktop client for Notion. All organization (Spaces,
pins, folders, tab order) is local and private — Notion stays the untouched
source of truth for content. See `docs/PRD.md`, `docs/ARCHITECTURE.md`, and
`docs/PROJECT_PLAN.md`.

**Status: Phase 1 (skeleton).** Authenticate → fetch a page → render Tier 1
blocks read-only → cache in SQLite, plus the render-vs-embed spike
(`SPIKE_NOTES.md`).

## Setup

1. Toolchain: Node 20+, Rust (rustup), Xcode Command Line Tools.
2. `npm install`
3. Create an **internal integration** at notion.so/my-integrations and share
   the pages/teamspaces you care about with it (page → ⋯ → Connections).
4. Create `~/.hive/config.json` (never lives in this repo):

   ```json
   { "notionToken": "ntn_..." }
   ```

5. `npm run tauri dev`

Paste a Notion page URL or ID in the header to render it. The Native/Embedded
toggle is the Phase 1 rendering spike.

## Architecture in one breath

Two planes: the **organization plane** (Spaces/pins/folders — local SQLite,
never written to Notion) and the **content plane** (page bodies — read from
the Notion REST API through a token-bucket queue at ~3 req/s, cached
cache-first in `page_cache`). Unknown blocks degrade to a fallback card,
never crash. Theme tokens are value-extracts from Honeycomb's Lattice design
system (light + dark).
