/**
 * Air Traffic Control (Phase 6): local rules routing docs to Spaces by
 * ancestor. "Anything under <parent> opens in <Space>." Stored locally,
 * applied when a page opens and its breadcrumb chain resolves.
 */

export interface AtcRule {
  ancestorId: string;
  ancestorTitle: string;
  spaceId: string;
}

const KEY = "hive-atc-rules";

export function getRules(): AtcRule[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function addRule(rule: AtcRule) {
  const rules = getRules().filter((r) => r.ancestorId !== rule.ancestorId);
  rules.push(rule);
  localStorage.setItem(KEY, JSON.stringify(rules));
}

export function matchRule(crumbIds: string[]): AtcRule | null {
  const rules = getRules();
  for (const id of crumbIds) {
    const hit = rules.find((r) => r.ancestorId === id);
    if (hit) return hit;
  }
  return null;
}
