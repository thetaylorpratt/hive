# Hive — demo script (~4 minutes)

The through-line: **"Notion is where our docs live. It's just a terrible
place to *visit* them."** Every beat answers "why not the Notion app or
notion.so in a tab?"

## Setup (before you present)
- Hive open on the start page, dark mode, sidebar visible.
- Slack open with a Notion link ready to click (and one Linear/Google link).
- The Notion desktop app ALSO open on the same doc — for the side-by-side.
- Quit/relaunch Hive once so caches are warm but honest.

## Beat 1 — Speed (30s)
> "This is Hive — our team's Notion, in a client I built. Watch the number."

Open 3–4 pages from the sidebar in quick succession. Point at the **⚡ ms
chip** in the meta line.

> "Every page renders from local cache in tens of milliseconds, then
> refreshes live. Now watch the same doc in Notion's own app…" (click the
> same page in Notion; let the spinner speak.)

Optional flex if wifi toggling is safe: turn wifi off, open another cached
page — it renders instantly with a quiet **"offline copy"** chip. Type a
sentence: an amber **"● 1 unsynced"** chip appears; wifi back on, it syncs
and toasts.
> "On a plane, Notion web is a white screen. Hive keeps working — reads
> AND writes. Edits queue locally and sync when I land."

## Beat 2 — Your org, not the team's (45s)
> "This sidebar is MINE. Notion gives everyone the same shared tree — if I
> reorganize, I reorganize it for the whole company."

- Flick between **Spaces** (⌃1/⌃2, or trackpad swipe) — work vs project views.
- Pin a doc, drag one into a folder, rename the folder.
> "Pins, folders, spaces — all local. Notion never knows. Nobody's sidebar
> changed but mine."

## Beat 3 — It's a browser (45s)
> "Hive is my default browser."

Click the Notion link in Slack → lands in Hive instantly.
Click the Linear/Google link in Slack → opens in Arc.

> "Notion links land here, in the fast client. Everything else passes
> through to my real browser. No app-switching tax, no 'open in app?'
> prompts."

Then, still in Slack: hit **⌃⌥N** — Hive leaps forward with the capture
box open. Type a thought, ⌘↵.
> "That's now a real Notion page. Global capture from any app on the Mac —
> Notion has nothing like it. An idea costs two keystrokes to keep."

## Beat 4 — Real work: edit, comment as YOU (60s)
- Type in a doc: markdown autoformat (`- `, `## `), `/database` mention,
  `@` someone, `:emoji:`.
- Highlight a sentence → 💬 → comment → show it in Notion **as Taylor
  Pratt, anchored to the exact words**.
> "The API only lets integrations comment as a bot. Hive OAuths into
> Notion's own MCP so comments post as me, anchored inline — the thing
> every other Notion client can't do."
- Open the comments panel: threads, block indicators, reply.

## Beat 5 — Command bar + close (40s)
- ⌘T → type a word that's only in a doc's BODY → open it.
> "Notion's search is title-only over the API. Hive indexes content
> locally — and ranks by what I actually use."
- ⌃Tab through recent docs. ⌘⇧F focus mode as the button.
> "Cache-first reads, private organization, browser-grade link handling,
> comments as a human. It auto-updates from GitHub releases — signed and
> notarized. Download the DMG and it's yours."

## Q&A ammo
- "Can I get my docs out?" — ⌘T → "Copy page as Markdown": the whole page,
  perfectly formatted GFM (tables, todos, code fences), straight to the
  clipboard. Notion makes this an export dialog and a zip file.
- "How do I catch up after PTO?" — ⌘T → "While you were away": every
  watched doc that changed since you last read it, with block-level diff
  summaries. Notion's Updates feed is notification spam; this is a briefing.
- "What links here?" — every page shows "Linked from N pages", computed
  locally from the cache. Zero API calls.
- Paste a bare Notion URL into any doc — it becomes a titled link
  automatically. And the 🐝 in the menu bar does capture + updates without
  touching the dock.
- "What about databases?" — show the table view: edit cells, change a
  column type, drag… (rows/columns move via the header/gutter arrows).
- "Does it write back safely?" — optimistic writes, one queue, ~3 rps,
  retries; failures toast and never eat content.
- "What can't it do?" — no real-time co-editing cursors; status options and
  option renames are API-immutable; databases created via /database land at
  the page end (API limit). Everything else you saw is live Notion data.
