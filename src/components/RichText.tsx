import type { CSSProperties } from "react";
import type { RichTextItem } from "../lib/types";

/** Notion text colors mapped onto Hive/Lattice-adjacent values. */
const TEXT_COLOR: Record<string, string> = {
  gray: "var(--hive-color-fg-muted)",
  brown: "#8d6e63",
  orange: "#d97706",
  yellow: "var(--hive-color-warning-fg)",
  green: "var(--hive-color-success-fg)",
  blue: "var(--hive-color-accent)",
  purple: "#7e57c2",
  pink: "#d81b60",
  red: "var(--hive-color-critical-fg)",
};

const BG_COLOR: Record<string, string> = {
  gray_background: "var(--hive-color-bg-subtle)",
  brown_background: "rgba(141, 110, 99, 0.16)",
  orange_background: "rgba(217, 119, 6, 0.14)",
  yellow_background: "var(--hive-color-warning-bg)",
  green_background: "var(--hive-color-success-bg)",
  blue_background: "var(--hive-color-accent-subtle)",
  purple_background: "rgba(126, 87, 194, 0.14)",
  pink_background: "rgba(216, 27, 96, 0.12)",
  red_background: "var(--hive-color-critical-bg)",
};

function Leaf({ item }: { item: RichTextItem }) {
  const { annotations, plain_text, href } = item;
  const style: CSSProperties = {};
  if (annotations.bold) style.fontWeight = 600;
  if (annotations.italic) style.fontStyle = "italic";
  if (annotations.strikethrough || annotations.underline) {
    style.textDecorationLine = [
      annotations.strikethrough ? "line-through" : "",
      annotations.underline ? "underline" : "",
    ]
      .join(" ")
      .trim();
  }
  if (annotations.color && annotations.color !== "default") {
    const fg = TEXT_COLOR[annotations.color];
    const bg = BG_COLOR[annotations.color];
    if (fg) style.color = fg;
    if (bg) {
      style.backgroundColor = bg;
      style.borderRadius = "2px";
      style.padding = "0 2px";
    }
  }

  let node = annotations.code ? (
    <code className="hive-inline-code" style={style}>
      {plain_text}
    </code>
  ) : (
    <span style={style}>{plain_text}</span>
  );

  if (href) {
    node = (
      <a href={href} target="_blank" rel="noreferrer">
        {node}
      </a>
    );
  }
  return node;
}

export function RichText({ items }: { items?: RichTextItem[] }) {
  if (!items?.length) return null;
  return (
    <>
      {items.map((item, i) => (
        <Leaf key={i} item={item} />
      ))}
    </>
  );
}
