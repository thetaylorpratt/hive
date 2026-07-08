# Hive — Project Plan

Companion to `PRD.md`, `ARCHITECTURE.md`, and `CLAUDE_CODE_PROMPT.md`. This is the execution plan: an assessment of the proposed phasing, the adjusted phase sequence, and the concrete work items, gates, and risks for each phase.

Verified before writing this plan (2026-07-06):

- **Notion MCP access works** (authed as Taylor Pratt / taylorpratt@honeycomb.io) — usable as the build-time workshop per ARCHITECTURE §7.
- **GitHub is authed as the personal account `thetaylorpratt`** — the repo and all releases go here, never to the Honeycomb org.
- **Lattice design tokens are locally available** at `~/Documents/CanvasArtifacts/vendor/lattice/Tokens/dist/` (vendored from `hound`) — light theme, dark theme, and primitives. Token scheme confirmed as `--lat-*` (see §Design Language below).

---

## 1. Assessment: is the 6-phase approach right?

**Verdict: yes, keep the skeleton-first, sidebar-second ordering — with four adjustments.**

What the proposed phasing gets right:

- **Phase 1 de-risks the correct things.** Auth visibility, rate limiting, block-render feasibility, and the render-vs-embed feel are the four unknowns that could kill the project. Everything else (sidebar, spaces, command bar) is known-buildable UI over local SQLite.
- **The two-plane model makes phases 2–4 low-risk.** They build almost entirely on the local organization plane plus the read path proven in Phase 1. No dependency on Notion's write API until Phase 5.
- **Editing last is correct.** The Notion write surface is partial and conflict handling is genuinely hard. Deferring it until the app is already a daily driver for reading/navigation means Phase 5 investment is informed by real usage and by the Phase 1 spike.

The four adjustments:

1. **Add a Phase 0 (pre-flight, ~half day).** The PRD flags "confirm the internal integration token can see all needed pages" as an open risk — in a company workspace, creating an internal integration may require workspace-admin approval, and pages/teamspaces must be explicitly shared with the integration. This is the single biggest go/no-go and costs almost nothing to verify. Do it before writing any code, not during Phase 1.
2. **Pull a minimal command bar into Phase 2.** As specced, the only navigation until Phase 3 is pasting page IDs into an input field. You cannot validate "sidebar + Spaces is the thesis" as a daily driver if opening a document requires copying UUIDs from the Notion web app. Phase 2 gets a bare `Cmd-T` (Notion search endpoint → open page, no frecency, no actions); the full command bar (fuzzy match, frecency, app actions) stays Phase 3.
3. **Schedule Tier 2 rendering explicitly (Phase 3).** The original phasing tiers the blocks but never schedules Tier 2 (images, tables, toggles, bookmarks, columns, equations). Real Honeycomb docs are full of images and tables; without them the app won't clear the "reach for this instead of native Notion" bar, and Phase 4's peek previews would render gutted documents. Tier 2 lands in Phase 3 alongside the full command bar.
4. **Move the render-vs-embed decision gate earlier.** ARCHITECTURE §10 says revisit "before phase 5," but the decision also shapes how much Tier 2/3 rendering effort is worth spending in Phases 3–4. Make the call formally at the **end of Phase 2**, once the spike notes exist and you've daily-driven reading for a week. If the hybrid (native read + embedded webview for editing/Tier 3) wins, Tier 2 scope in Phase 3 can shrink.

Two smaller tweaks folded in below: "Today" auto-archive moves from Phase 6 to Phase 2 (it's core to the tab-tier model and cheap — a timestamp check on load), and the Honeycomb/Lattice design language is established as `theme.css` in Phase 1 rather than being retrofitted later.

---

## 2. Adjusted phase sequence

| Phase | Name | Contents | Exit gate |
|---|---|---|---|
| 0 | Pre-flight | Notion internal integration created + visibility confirmed; private GitHub repo | Integration can read the pages/teamspaces you actually use |
| 1 | Skeleton | Tauri shell, SQLite, queued Notion client, Tier 1 read-only render, Lattice-derived `theme.css`, render-vs-embed spike | Definition-of-done in `CLAUDE_CODE_PROMPT.md` §"Definition of done" |
| 2 | Sidebar + Spaces + minimal Cmd-T | Org plane tables, sidebar tiers, Space switching + theming, drag/drop, Today auto-archive, bare command bar (search → open) | Daily-drivable for reading; **render-vs-embed decision made** |
| 3 | Command bar (full) + Tier 2 blocks + unread dots | Frecency, fuzzy match, app actions; images/tables/toggles/bookmarks/columns; change-detection unread indicators (§Notifications Tier A) | Any doc reachable in <2s; real work docs render acceptably; changed docs visibly marked |
| 4 | Split View + Peek + Notifications inbox | Multi-pane workspace, saveable splits, hover preview; comments/mentions poller + macOS notifications (§Notifications Tier B) | Second doc side-by-side in one keystroke; a new comment on a pinned doc surfaces without opening Notion |
| 5 | Editing | Per the Phase 2 decision: native Tier 1 write-back **or** embedded-webview editing surface; conflict refresh-on-focus | Light editing without opening native Notion |
| 6 | ATC + Quick capture + polish | Routing rules, `Cmd-Opt-N` window, escape hatches, keymap remapping | PRD §9 success criteria hold |

Phases 1–2 remain the validation core: ship both before investing past them, exactly as ARCHITECTURE §9 says.

---

## 3. Phase detail

### Phase 0 — Pre-flight (~half day)

1. Create a Notion **internal integration** at notion.so/my-integrations under the Honeycomb workspace. If workspace settings block member-created integrations, this is the moment to find out — fallback options (request admin approval; scope to a personal workspace for development) are much cheaper to weigh now.
2. Share the teamspaces/pages you actually work in with the integration. Verify with a raw `curl` to `pages.retrieve` + `search` that it sees them.
3. Create a **private** repo `thetaylorpratt/hive`. Private is non-negotiable initially: the theme will embed Honeycomb Lattice-derived values, and spike notes will reference internal doc structure. Nothing gets published to the Honeycomb org.
4. Copy the three planning docs + this plan into the repo.

### Phase 1 — Skeleton (~1 week of evenings)

Build exactly per `CLAUDE_CODE_PROMPT.md` (scaffold → auth → SQLite → queued fetch → Tier 1 renderer → minimal shell → spike), with one addition:

- **`theme.css` is seeded from Lattice, not invented.** Extract token *values* (not Lattice source files) into Hive's own `--hive-*` variables — see §Design Language. This costs nothing extra since the prompt already requires establishing the variable structure, and it means every component built from Phase 1 onward looks Honeycomb-native by default.

Honor the prompt's checkpoint: pause after the fetch pipe (step 4) for verification before building the renderer.

Deliverables: working pipe per definition-of-done; `SPIKE_NOTES.md` with the render-vs-embed observations.

### Phase 2 — Sidebar + Spaces + minimal Cmd-T (~1–2 weeks)

- Migration 2: `space`, `sidebar_item`, `folder` tables (ARCHITECTURE §4).
- SpaceBar rail + `Ctrl-Space-<n>` switching; per-Space accent color swapped via CSS variables (`data-space-theme` attribute mirrors Lattice's `data-theme` pattern).
- Sidebar with Favorites / Pinned / Today tiers; drag to reorder, folders, nesting (use `dnd-kit`).
- Today auto-archive: on app focus/launch, archive `today` items past `auto_archive_at` (default 24h). No background timer needed.
- Minimal `Cmd-T`: input → Notion `search` endpoint (through the queue) → open page. List recent/open items when empty. No frecency yet.
- Dark mode from day one — Lattice ships `tokens-dark.css` values, and per-Space theming machinery is the same mechanism.

**Gate at exit: the render-vs-embed decision.** Inputs: `SPIKE_NOTES.md` + one week of daily-driving. Output: a short ADR in the repo committing to native, embed, or the hybrid (native read + embedded editing surface). This sets Phase 3's Tier 2 scope and Phase 5's entire shape.

### Phase 3 — Full command bar + Tier 2 rendering (~1 week)

- Migration 3: `frecency` table. Record hits on every open; score = frequency × recency decay.
- Command bar merges four sources: open tabs, sidebar items (title cache), frecency-ranked recents, live Notion search. Fuzzy matching via `fzf`-style scorer. App actions ("Pin", "New Space", "Add Right Split", "Open in Notion") as a command mode.
- Tier 2 block support, scoped by the Phase 2 ADR: image, table, toggle, bookmark, column_list/column, equation (KaTeX). Promote via the dispatch table — no call-site changes.

### Phase 4 — Split View + Peek (~1 week)

- Migration 4: `split_layout`, `split_pane` tables.
- SplitContainer with H/V panes; `Cmd-Shift-+` splits current doc; a saved split is a sidebar entry that reopens as a unit.
- PeekLayer: hover on sidebar item (400ms delay) renders the cached page in a floating portal. Cache-first means this is nearly free after Phase 1's `page_cache`.

### Phase 5 — Editing (~2+ weeks, shape depends on the ADR)

- **If native:** contentEditable-based editor for Tier 1 blocks only; `blocks.update` / `blocks.children.append` through the queue; optimistic UI with rollback on failure; refresh-on-focus staleness check (compare `last_edited_time` from `pages.retrieve`) with a "content changed — reload?" banner.
- **If embed/hybrid:** an authenticated Notion webview as the edit surface inside the Arc shell; the native renderer remains the fast read path. Session/auth friction observed in the Phase 1 spike determines feasibility.
- Either way: writes are text-class blocks only in v1 (PRD §8 editing risk).

### Phase 6 — ATC + Quick capture + polish

- Migration 5: `atc_rule` table; rules evaluated on every open (parent-ID matching needs the page's ancestry from `pages.retrieve` — cache it).
- `Cmd-Opt-N` quick-capture as a second Tauri window; promote-to-Space afterward.
- Keymap module cleanup, `Cmd-O` escape hatch everywhere, error/empty states, app icon.

---

## 3.5 Notifications / unread awareness (requirement added 2026-07-06)

**The pain point:** in native Notion it is never obvious that you have unread notifications. Hive should make "something you care about changed" impossible to miss.

**The hard constraint:** the Notion public API has **no notifications/inbox endpoint**. Your actual Notion notification state (the bell) is not readable, so inbox parity is impossible. Hive instead builds its own *attention engine* over the pages you've told it you care about (favorites + pins + recently opened) — which in practice is a better match for the two-plane model anyway: what you consider "worth alerting on" is organizational state, and organizational state is local.

Three tiers, shipped incrementally:

- **Tier A — unread-change indicators (Phase 3, nearly free).** Background revalidation already fetches `last_edited_time` for cached pages. Compare against a per-item `last_read_at`: newer → unread dot on the sidebar row, count badge on the Space icon in the SpaceBar, aggregate count on the macOS dock icon (Tauri badge API). Opening the doc clears it. This alone solves "I can't tell anything is new."
- **Tier B — comments & mentions poller (Phase 4).** Poll `comments.list` on watched pages (favorites + pins) through the rate-limited queue on a bounded budget (staggered, e.g. every 5 min per watched page, capped at ~10% of the token bucket, backoff when the app is idle/unfocused). New comment → inbox entry; comment rich text containing a mention of your user ID → higher-priority "mention" entry + native macOS notification (Tauri notification plugin). A small Inbox panel lives at the top of the sidebar with its own unread badge.
- **Tier C — embedded Notion inbox (contingent on the Phase 2 embed ADR).** If the embedded-webview path proves viable, `Cmd-Shift-I` opens notion.so's real inbox in a webview as the full-fidelity escape hatch for everything the API can't see (page shares, database reminders, workspace-level notices).

Schema additions (land with Phase 3/4 migrations):

```sql
watch(notion_page_id, last_seen_edited_at, last_seen_comment_at, muted)
notification(id, notion_page_id, kind,     -- 'edit' | 'comment' | 'mention'
             actor, snippet, created_at, read_at NULL)
```

Honors the two-plane model: all of this is local read-side state; nothing is written to Notion, and marking-as-read in Hive never touches your real Notion inbox (documented limitation).

---

## 4. Design language: making it feel Honeycomb

Lattice's generated tokens are available locally and are the source for Hive's theme. The approach:

- **Extract values, don't vendor source.** Hive's repo gets a `src/styles/theme.css` defining `--hive-*` variables whose *values* come from Lattice's dist tokens. Do not copy Lattice CSS/TS files into the personal repo — it's Honeycomb's design system; Hive only borrows the palette, type scale, and geometry. Keep the repo private regardless.
- **Canonical local sources** (read-only reference during development):
  - Light: `~/Documents/CanvasArtifacts/vendor/lattice/Tokens/dist/tokens.css`
  - Dark: `~/Documents/CanvasArtifacts/vendor/lattice/Tokens/dist/tokens-dark.css`
  - Primitives: `.../dist/primitives/tokens.css`

Key values to seed `theme.css` (confirmed from the vendored tokens — scheme is `--lat-color-*` etc., not `--lat-sys-*`):

| Category | Lattice basis | Hive usage |
|---|---|---|
| Interactive/primary | Sky palette — `#0077cc` (sky-700) default, sky-800 hover, sky-900 active, sky-50 subtle bg | Buttons, focus rings, selected sidebar items, default Space accent |
| Neutrals | Gray 50→1100; gray-100 surfaces, gray-300 dividers, gray-700 text, gray-950 dark-mode bg | Window chrome, sidebar, borders, body text |
| Semantic | Green (success), Gold (warning), Red (critical), Sky (info) — 100-level bg + 700–1000-level text | Toasts, error states, sync-status indicators |
| Radius | 2 / 4 / **8** (primary) / 12px | 8px on buttons, cards, inputs; 4px on sidebar rows |
| Spacing | `--lat-space-x0`→`x12` = 0→48px; card padding 12px | 4px-grid spacing scale mapped into Tailwind config |
| Type | Roboto / Roboto Mono; headings 600 wt 2rem→0.75rem; body 400/500 at 0.875rem default | Bundle Roboto with the app (desktop won't have it guaranteed) |
| Shadows | small / medium / large / popover / tooltip / focus | Command bar + peek use popover shadow; cards use small |
| Dark mode | `[data-theme="dark"]` swaps system tokens; refs stay constant | Same mechanism, plus `[data-space-theme="…"]` for per-Space accents |

Component idioms to mimic: primary buttons are borderless fills with hover-darkening; secondary/ghost use 1px subtle borders; density is compact (12px card padding, 0.875rem body); elevation is shadow-light and border-heavy. The Arc-style sidebar should read as a Lattice surface: `gray-100`-class background, sky-accent selection states, 8px radii.

Where the vendored copy falls short (component-level detail, iconography), reference the `honeycombio` GitHub repos read-only. Nothing flows the other direction: no pushes, PRs, or issues to Honeycomb repos.

---

## 5. Tooling strategy (per ARCHITECTURE §7, confirmed working)

- **Build time:** Notion MCP (already connected and authed) for workspace exploration — discovering page/database IDs for testing, block-type inventory for tier decisions, and generating fixture data. Read-only usage; never delete or modify workspace content through it.
- **Runtime:** `@notionhq/client` against the REST API with the internal integration token, always through the token-bucket queue (~3 rps). The MCP is the workshop, the REST API is the engine.
- **Repo/deploys:** everything on `thetaylorpratt` (personal). "Deploy" for a desktop app means tagged GitHub Releases carrying the `tauri build` `.dmg` — no store distribution, no signing/notarization until it annoys you (unsigned local builds run fine on your own machine via right-click-open). No Vercel, no CI on Honeycomb infrastructure.

---

## 6. Risks (beyond PRD §8)

| Risk | Phase | Mitigation |
|---|---|---|
| Workspace admins block internal integrations | 0 | Discover in pre-flight; escalate to admin request or develop against a personal workspace until approved |
| Integration can't see needed teamspaces even when created | 0 | Explicit share step per teamspace; verify with `search` before Phase 1 |
| Embedded-webview auth (SSO/session) breaks inside Tauri | 1 | Exactly what the spike measures; if embed auth is hostile, the hybrid collapses to native-only and Phase 5 scope grows |
| Rate limits during Space-switch prefetch | 2 | Already designed: bounded prefetch (pinned/favorites only, ≤5 concurrent), cache-first |
| Tier 2 tables/databases render poorly from block API | 3 | Databases-as-pages stay Tier 3 (fallback card) in v1; only simple tables get native render |
| Roboto not present on target machine | 1 | Bundle the font with the app |
| No notifications API — inbox parity impossible | 3–4 | Local attention engine over watched pages (§3.5); embedded notion.so inbox as Tier C escape hatch; document the gap (shares/reminders invisible to Hive) |
| Comment polling burns rate-limit budget | 4 | Poll only favorites+pins, staggered, capped at ~10% of the token bucket, idle backoff |
| Lattice values drift from upstream | ongoing | Acceptable — Hive snapshots values; refresh manually if Honeycomb rebrands |

---

## 6.5 Pending build-time research: block-type inventory

To validate the Tier 1/2/3 split against real Honeycomb docs, sample ~8
diverse pages (meeting notes, runbook, RFC, wiki home, retro, project plan,
onboarding, one database-heavy page) and tally construct frequency into
`docs/BLOCK_INVENTORY.md`. First attempt (2026-07-06) failed: the Notion MCP
connector returned 503/429 for the whole session. Preferred rerun path: once
the integration token exists, sample via the REST API directly — it returns
exact block types (better validation data than MCP's markdown-inferred
constructs). This feeds the Phase 3 Tier 2 scoping.

## 6.6 Scope updates (2026-07-06, while waiting on the token)

- **Phases 2 and 3 are built and verified** (sidebar/Spaces with Arc-style
  bottom switcher + icons + trackpad swipe; full command bar with frecency
  and app actions; Tier 2 rendering incl. KaTeX; attention-engine Tier A with
  dots/badges/dock badge).
- **Phase 5 editing pulled forward and built token-free**: contentEditable
  Tier 1 blocks with a rich-text ⇄ HTML round-trip, optimistic writes into
  page_cache, and a write-back layer routing `blocks.update` /
  `children.append` (with `after`) / `blocks.delete` through the queue. Demo
  page is fully editable (local sink); real pages become writable the moment
  the token exists (notion sink) — same code path. Remaining Phase 5 work:
  markdown autoformat, debounced write coalescing, conflict guard, and the
  render-vs-embed ADR itself.
- **Polish backlog established** from competitive research:
  `docs/POLISH_OPPORTUNITIES.md` (FTS5 search, autoformat, contextual
  palette actions, MRU switcher, block-diffs as the signature feature).

## 8. Phase completion (2026-07-08)

**All six phases are built.** ADR-001 accepted (native rendering). Phase 4:
split view (read-only pane) + comments/mentions inbox with macOS
notifications. Phase 5: native editing (shipped earlier, verified live).
Phase 6: ATC routing rules (ancestor → Space), in-app quick capture
(⌘⌥N → real Notion page under `capturePageId`), header v2 with breadcrumbs
+ sub-page navigation, keymap/escape hatches throughout. Known v1 scope
cuts: split panes are read-only and not yet saveable as sidebar entries;
quick capture is in-app (system-wide floating window needs the
global-shortcut plugin); ATC rules have no management UI (palette-add only,
localStorage). Project mode shifts to daily-driving + bug fixing.

## 7. Immediate next steps

*(updated 2026-07-07 — TOKEN LIVE: pipe verified end-to-end, including an
edit round-trip Hive→Notion and refresh-on-focus Notion→Hive. Phases 0–3
plus the editing write path, editor parity, deep links, and a 20-bug QA
pass are complete. Hive.app is installed in /Applications.)*

1. **Connect teamspaces to the integration** (teamspace settings →
   Connections → "Notion Hackweek App") — connections inherit down, and
   both live search quality and the block inventory depend on breadth.
2. Rerun the block inventory (§6.5) over the real corpus; decide database-
   view promotion with that data.
3. Daily-drive for a week; fill in `SPIKE_NOTES.md`; make the
   render-vs-embed ADR (§6.6).
4. Phase 4 proper: split view + comments/mentions triage inbox (Tier B),
   plus hover prefetch and the remaining token-gated parity items
   (@mentions, [[ page links, ⌘⌥9).
