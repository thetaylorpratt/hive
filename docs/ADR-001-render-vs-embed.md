# ADR-001: Native rendering wins

Date: 2026-07-08 · Status: accepted

The Phase-1 spike kept both paths alive: native block rendering vs embedding
notion.so in a webview. Decision point was "end of Phase 2 + daily driving";
the evidence is now decisive in favor of **native everywhere**:

- Editing round-trips to Notion work natively (verified live), removing the
  embed's main justification ("editing parity for free").
- Native gets: instant cache-first loads, offline reading, block diffs,
  content search, focus mode, our keyboard model — none possible in an embed.
- The embed path aged badly: notion.so can't be iframed, a separate window
  breaks the Arc feel, and universal-link fighting made embedded auth
  fragile.

Consequences:
- The Native/Embedded header toggle is removed; the embedded window remains
  reachable as a command-palette action for the rare fidelity gap.
- Tier 3 fallbacks route to native Notion (notion:// escape hatch), not an
  embed.
- Phase 5's editing strategy is the already-built native write path.
