import type { ReactNode } from "react";
import type { RichTextItem } from "../lib/types";

/**
 * Properties header for pages that are database rows (BLOCK_INVENTORY gap #1:
 * ~half of real work docs are DB rows — RFCs, meeting notes, projects — and
 * their status/people/dates carry context Notion shows above the title).
 * Pure render over `page.properties`; unknown property types are skipped.
 */

interface PropertyValue {
  type: string;
  [key: string]: unknown;
}

const CHIP_COLORS: Record<string, string> = {
  default: "var(--hive-color-bg-subtle)",
  gray: "var(--hive-color-bg-subtle)",
  blue: "var(--hive-color-accent-subtle)",
  green: "var(--hive-color-success-bg)",
  yellow: "var(--hive-color-warning-bg)",
  orange: "var(--hive-color-warning-bg)",
  red: "var(--hive-color-critical-bg)",
  pink: "var(--hive-color-critical-bg)",
  purple: "var(--hive-color-accent-subtle)",
  brown: "var(--hive-color-bg-subtle)",
};

function Chip({ name, color }: { name: string; color?: string }) {
  return (
    <span
      className="hive-prop-chip"
      style={{ background: CHIP_COLORS[color ?? "default"] ?? CHIP_COLORS.default }}
    >
      {name}
    </span>
  );
}

function renderValue(prop: PropertyValue): ReactNode | null {
  switch (prop.type) {
    case "select":
    case "status": {
      const v = prop[prop.type] as { name?: string; color?: string } | null;
      return v?.name ? <Chip name={v.name} color={v.color} /> : null;
    }
    case "multi_select": {
      const v = prop.multi_select as { name: string; color?: string }[] | undefined;
      if (!v?.length) return null;
      return v.map((s) => <Chip key={s.name} name={s.name} color={s.color} />);
    }
    case "people": {
      const v = prop.people as { name?: string }[] | undefined;
      const names = v?.map((p) => p.name).filter(Boolean);
      return names?.length ? names.join(", ") : null;
    }
    case "date": {
      const v = prop.date as { start?: string; end?: string } | null;
      if (!v?.start) return null;
      return v.end ? `${v.start} → ${v.end}` : v.start;
    }
    case "rich_text": {
      const v = prop.rich_text as RichTextItem[] | undefined;
      const text = v?.map((t) => t.plain_text).join("");
      return text || null;
    }
    case "number": {
      const v = prop.number as number | null;
      return v ?? null;
    }
    case "checkbox":
      return (prop.checkbox as boolean) ? "✓" : "—";
    case "url": {
      const v = prop.url as string | null;
      return v ? (
        <a href={v} target="_blank" rel="noreferrer">
          {v.replace(/^https?:\/\//, "").slice(0, 40)}
        </a>
      ) : null;
    }
    case "email":
      return (prop.email as string) || null;
    default:
      return null; // formulas, rollups, relations etc. — skip in v1
  }
}

export function PropertiesHeader({ page }: { page: Record<string, unknown> }) {
  const properties = page.properties as Record<string, PropertyValue> | undefined;
  if (!properties) return null;

  const rows = Object.entries(properties)
    .filter(([, p]) => p.type !== "title")
    .map(([name, p]) => ({ name, value: renderValue(p) }))
    .filter((r) => r.value !== null)
    .slice(0, 8);

  if (rows.length === 0) return null;

  return (
    <div className="hive-props">
      {rows.map((r) => (
        <div className="hive-prop" key={r.name}>
          <span className="label">{r.name}</span>
          <span className="value">{r.value}</span>
        </div>
      ))}
    </div>
  );
}
