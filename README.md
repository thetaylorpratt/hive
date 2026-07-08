# 🐝 Hive

A personal, Arc-style desktop client for Notion (macOS). All organization —
Spaces, pins, folders, tab tiers — is local and private; Notion stays the
untouched source of truth for content. Full docs live in `docs/` (PRD,
architecture, project plan, editor-parity and API-workaround maps).

**Highlights**

- Arc-style Spaces with per-Space accents, pinned/today tab tiers, favorites
- Native block renderer with real editing: markdown autoformat, `/` menu,
  `:emoji:`, selection toolbar, tables, toggles, indent/move/duplicate
- ⌘T command bar (frecency recents + full-text search over a local index —
  the API's search is title-only, so Hive builds its own)
- Comments: threaded panel, inline-anchored comments **posted as you** (via
  a personal OAuth connection to Notion's hosted MCP — integration tokens
  can only post as a bot), per-block 💬 indicators, comment/mention inbox
- Default-browser mode: set Hive as your macOS browser and Notion links open
  in Hive while everything else forwards to your real browser
- Unread awareness: sidebar dots, Space badges, dock badge (the API has no
  notifications endpoint — Hive polls watched pages politely)

## Install (prebuilt app)

Requirements: **Apple Silicon** Mac (the release DMG is aarch64-only).

1. Download `Hive_x.y.z_aarch64.dmg` from the repo's Releases page and drag
   Hive.app to /Applications.
2. The app is **not notarized** (hackweek build). macOS will block the first
   launch — either allow it via System Settings → Privacy & Security →
   "Open Anyway", or clear quarantine in a terminal:

   ```sh
   xattr -dr com.apple.quarantine /Applications/Hive.app
   ```

3. Connect Notion — two paths:
   - **Sign in with Notion** (if this build has OAuth credentials baked in):
     launch Hive and click the button on the welcome screen. Notion's own
     consent page lets you pick which pages Hive can see — no token, no IT
     ticket. You can widen access later from Notion's Connections settings.
   - **Manual token**: create an internal integration at
     notion.so/my-integrations (read/update/insert content + read/insert
     comments + read user information), share pages/teamspaces with it
     (page → ⋯ → Connections; teamspace sharing inherits down), and put the
     token in the config below.
4. Optional `~/.hive/config.json` (created automatically by Sign-in;
   chmod 600 recommended):

   ```json
   {
     "notionToken": "ntn_...",
     "capturePageId": "<page id for ⌘⌥N quick captures>",
     "scratchpadPageId": "<page id where sidebar New-page lands>",
     "fallbackBrowser": "Arc"
   }
   ```

   Only `notionToken` is required; the rest are optional.

   Hive auto-updates from this repo's Releases (a toast offers
   "Restart & update" when a new version ships).
5. Launch Hive. To comment under your own name (instead of the integration
   bot), open the comments panel (💬) and click **"Comment as you — connect
   Notion"** — approve in the browser, then close that tab (its spinner
   never resolves; the handoff already happened).
6. Optional, for the Arc-style link routing: System Settings → Desktop &
   Dock → default web browser → Hive, and in the Notion desktop app disable
   Settings → "Open links in desktop app" so links don't get hijacked
   before they reach the browser.

## Develop

1. Toolchain: Node 20+, Rust (rustup), Xcode Command Line Tools.
2. `npm install`, then `npm run tauri dev` (config as above).
3. `npm run tauri build` produces the .app and DMG. Note: the packaged
   binary is lowercase `hive` — kill with `pkill -x hive` before replacing
   /Applications/Hive.app or the stale process keeps running.

## Release (maintainer)

`./scripts/release.sh` builds, signs the updater artifact
(`~/.tauri/hive-updater.key`), optionally codesigns + notarizes (fill
`~/.hive/signing.env` from `scripts/signing.env.example`; needs a
"Developer ID Application" cert in the keychain), writes `latest.json`,
and publishes everything as a GitHub release — which existing installs
pick up automatically.

To enable **Sign in with Notion** for users: flip the integration to
Public in notion.so/my-integrations (redirect URI
`https://thetaylorpratt.github.io/hive-oauth/` — the bounce page source
lives in `oauth-bounce/`), then paste the OAuth client id/secret into
`src/lib/notionRestOauth.ts` and cut a release.

## Architecture in one breath

Two planes: the **organization plane** (Spaces/pins/folders — local SQLite,
never written to Notion) and the **content plane** (page bodies — read from
the Notion REST API through a token-bucket queue at ~3 req/s, cached
cache-first in `page_cache`). A third **identity plane** holds a personal
OAuth token for Notion's hosted MCP (`~/.hive/mcp_auth.json`) used for
user-identity actions: comments-as-you, inline anchors, page moves, private
page creation. Unknown blocks degrade to a fallback card, never crash.
Theme tokens are value-extracts from Honeycomb's Lattice design system
(light + dark).
