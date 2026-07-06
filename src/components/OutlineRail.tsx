import { useAppStore } from "../store/appStore";

/**
 * In-document outline (Typora/Obsidian pattern): a collapsed strip of tick
 * marks on the right edge that expands into a heading TOC on hover.
 * Derived entirely from cached heading blocks — zero API cost.
 */
export function OutlineRail() {
  const page = useAppStore((s) => s.page);
  if (!page) return null;

  const headings = page.blocks
    .filter((b) => b.type.startsWith("heading_"))
    .map((b) => ({
      id: b.id,
      level: Number(b.type.slice(-1)),
      text:
        (b[b.type] as { rich_text?: { plain_text: string }[] })?.rich_text
          ?.map((t) => t.plain_text)
          .join("") ?? "",
    }))
    .filter((h) => h.text);

  if (headings.length < 2) return null;

  return (
    <nav className="hive-outline">
      <div className="ticks">
        {headings.map((h) => (
          <span key={h.id} className={`tick l${h.level}`} />
        ))}
      </div>
      <div className="panel">
        {headings.map((h) => (
          <div
            key={h.id}
            className={`entry l${h.level}`}
            onClick={() =>
              document
                .getElementById(`hb-${h.id}`)
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          >
            {h.text}
          </div>
        ))}
      </div>
    </nav>
  );
}
