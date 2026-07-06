import type { HiveBlock } from "../lib/types";

/**
 * Tier 3 fallback (PRD §7: graceful degradation over perfect fidelity).
 * Unknown or unsupported blocks render this card, never throw.
 * "Open in Notion" is a stub in Phase 1; deep-link wiring lands later.
 */
export function FallbackCard({ block }: { block: HiveBlock }) {
  return (
    <div className="hive-fallback">
      <span>
        Unsupported block <span className="type">{block.type}</span>
      </span>
      <button
        className="hive-btn hive-btn-secondary"
        disabled
        title="Deep-link wiring lands in a later phase"
      >
        Open in Notion
      </button>
    </div>
  );
}
