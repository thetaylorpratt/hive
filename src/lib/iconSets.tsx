import type { ComponentType } from "react";
import {
  Alarm, Atom, Bell, Book, BookOpen, Briefcase, Bug, Calendar, ChartBar,
  ChartLineUp, ChatCircle, CheckSquare, Clipboard, Cloud, Code, Compass,
  Cpu, Database, FileText, Fire, Flag, Flask, Folder, Gear, Globe,
  GraduationCap, Hammer, Heart, House, Key, Lightbulb, Lightning, Link,
  ListChecks, Lock, MagnifyingGlass, MapPin, Megaphone, Note, PaintBrush,
  PaperPlaneTilt, Pencil, Shield, Sparkle, Star, Sun, Tag, Target,
  Terminal, TestTube, Trophy, Users, Wrench,
} from "@phosphor-icons/react";

/**
 * Icon sets for Spaces and pages.
 * - Spaces (local-only): Phosphor — the same set Lattice wraps — stored as
 *   "ph:Name" in space.icon and rendered with currentColor.
 * - Pages: Notion's own tintable icon CDN (notion.so/icons/{slug}_{color}
 *   .svg), set via the API as an external icon so native Notion renders the
 *   exact same thing. Slugs below verified against the CDN (HTTP 200).
 */

export const PHOSPHOR_ICONS: Record<string, ComponentType<{ size?: number; weight?: "regular" | "bold" | "fill" }>> = {
  Alarm, Atom, Bell, Book, BookOpen, Briefcase, Bug, Calendar, ChartBar,
  ChartLineUp, ChatCircle, CheckSquare, Clipboard, Cloud, Code, Compass,
  Cpu, Database, FileText, Fire, Flag, Flask, Folder, Gear, Globe,
  GraduationCap, Hammer, Heart, House, Key, Lightbulb, Lightning, Link,
  ListChecks, Lock, MagnifyingGlass, MapPin, Megaphone, Note, PaintBrush,
  PaperPlaneTilt, Pencil, Shield, Sparkle, Star, Sun, Tag, Target,
  Terminal, TestTube, Trophy, Users, Wrench,
};

export const NOTION_ICONS = [
  "document", "book", "bookmark", "calendar", "checkmark", "checklist",
  "clipping", "code", "compose", "database", "folder", "gear", "globe",
  "graduate", "hammer", "heart", "home", "layers", "leaf", "light-bulb",
  "link", "list", "lock", "mail", "map-pin", "meeting", "megaphone",
  "pencil", "people", "phone", "playback-play", "priority-high", "puzzle",
  "rocket", "science", "search", "shield", "star", "sun", "tag", "target",
  "thought", "timeline", "trophy", "user", "warning", "wifi", "activity",
  "bell", "briefcase", "chart", "clock", "command-line", "compass",
  "computer-chip", "credit-card", "drink", "flag", "fire", "gift", "key",
  "laptop", "library",
];

export const NOTION_ICON_COLORS = [
  "gray", "lightgray", "brown", "yellow", "orange",
  "green", "blue", "purple", "pink", "red",
];

export const notionIconUrl = (slug: string, color: string) =>
  `https://www.notion.so/icons/${slug}_${color}.svg`;

/** Render any icon value: emoji string, "ph:Name", or an https URL. */
export function Glyph({ icon, size = 16 }: { icon: string | null; size?: number }) {
  if (!icon) return null;
  if (icon.startsWith("ph:")) {
    const Component = PHOSPHOR_ICONS[icon.slice(3)];
    return Component ? <Component size={size} weight="regular" /> : null;
  }
  if (icon.startsWith("http")) {
    return (
      <img
        src={icon}
        alt=""
        style={{ width: size, height: size, display: "inline-block", verticalAlign: "-0.15em" }}
      />
    );
  }
  return <>{icon}</>;
}
