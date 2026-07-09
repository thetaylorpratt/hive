# Demo-day polish — final pass (2 agents, disjoint files)

Goal: a first-time viewer says "I need that immediately." The pitch is NOT
"a Notion client" — it's the three things the Notion app/browser cannot do:

1. **Instant.** Cache-first pages render in milliseconds. Notion shows
   spinners; Hive shows the doc. We PROVE it with a load-time chip.
2. **Your organization, not the team's.** Arc-style Spaces, pins, folders,
   favorites — all local. Organize the company wiki YOUR way without
   touching anyone else's sidebar. Notion physically cannot do this.
3. **It's a browser, not an app.** Set Hive as the macOS default browser:
   Notion links from Slack/email land in Hive instantly; every other link
   forwards to your real browser. Plus: comment AS yourself with inline
   anchors, @mentions, and a real editor.

House rules: docs/DB_SPEC.md "House rules" apply (tokens, no deps, strict TS).
Dark mode is the demo default — polish dark FIRST, verify light still works.

## Agent P1 — HomeScreen as the pitch (sole owner: src/components/HomeScreen.tsx + NEW src/styles/home.css)

Rework the start page into the demo opener. Structure top→bottom:
- Hero: big 🐝 + "Hive" wordmark + one-liner: "Your Notion, at the speed
  of thought." Subtle honeycomb-hex background pattern (pure CSS/inline
  SVG, very low contrast, no external assets).
- THREE differentiator cards (the exact copy above, tightened): each with
  a Phosphor icon, a bold claim, and one supporting line:
  - Lightning icon — "Instant everything" — "Pages open from local cache in
    milliseconds — then refresh live. No spinners."
  - SquaresFour icon — "Your spaces, your rules" — "Pin, group, and organize
    the team wiki privately. Nobody else's sidebar changes."
  - Compass icon — "It's your browser" — "Notion links from anywhere open
    here. Everything else goes to Arc. Comments post as you."
- Keyboard row: the five money shortcuts as <kbd> chips: ⌘T search ·
  ⌘⌥N capture · ⌃Tab switch · ⌘\\ sidebar · ⌘⇧F focus.
- Recents grid (exists — keep, restyle to match).
- Keep the rotating tips but move them to a single subtle line under the
  keyboard row.
- The existing demo-link line stays (bottom, subtle).
- Styling: import "../styles/home.css" from the component; cards use
  --hive-color-bg-surface, hairline borders, 10px radius, hover lift
  (translateY(-1px) + shadow), generous whitespace. It must look DESIGNED,
  not templated: asymmetric hero spacing, tight type scale (hero ~2rem/700,
  cards 0.95rem/600 claim + 0.85rem secondary line).
- Verify: npm run build clean.

## Agent P2 — felt-speed + chrome polish (sole owner: src/store/appStore.ts [only the two spots below], src/App.tsx, src/styles/theme.css)

1. **Load-time chip** (the proof-of-speed moment):
   - appStore: in openPage, record t0 = performance.now() at entry; when the
     CACHED copy renders set `loadMs: Math.round(performance.now() - t0)`
     and `loadSource: "cache"`; if there was no cache, set them when the
     fresh fetch lands with source "notion". Add `loadMs: number | null`,
     `loadSource: "cache" | "notion" | null` to state (reset on each openPage).
   - App.tsx meta line (the "fresh from Notion · fetched … · editable · N
     words" row): prepend a chip: `⚡ 24 ms · cache` (accent-tinted mono
     chip) when loadSource === "cache", or `“ · fetched live` styling as
     today when "notion". Keep it subtle but visible — this is the line the
     presenter points at.
2. **Loading skeleton**: replace the "Loading — Fetching page from Notion…"
   Notice with a content skeleton (title bar + 4 gray lines, shimmer via
   CSS animation) inside the article layout, so even cold loads look alive.
3. **Chrome micro-polish (theme.css only, keep selectors, adjust values)**:
   - Header: slightly larger breadcrumb hit areas, hover bg on crumbs,
     consistent 6px radii on nav buttons.
   - Sidebar rows: 5px 8px padding, 6px radius, smoother hover
     (background-color .12s), active row uses accent-subtle bg + accent
     text; unread dot slightly larger.
   - Toasts: add a 1px accent-tinted left border; entrance animation
     (translateY(6px)+fade 160ms).
   - Page-in transition: soften to opacity+2px rise, 160ms.
   - :focus-visible ring consistency on header/sidebar buttons.
   - Dark-mode contrast: make hairlines slightly more visible on dark
     (border-subtle up a step), page bg vs surface differentiation.
4. Verify: npm run build clean; drive the demo page in the running preview
   (window.__hiveStore, openDemo) and confirm the chip renders and the
   skeleton appears during a simulated slow load.

Do NOT touch HomeScreen.tsx or home.css (P1 owns them). Do not change any
behavior beyond the loadMs plumbing.
