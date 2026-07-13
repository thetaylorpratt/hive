import { invoke } from "@tauri-apps/api/core";

/** Read by the Rust core from ~/.hive/config.json — never stored in the repo. */
export interface HiveConfig {
  notion_token: string | null;
  capture_page_id?: string | null;
  scratchpad_page_id?: string | null;
  // Non-Notion links open here when Hive is the default browser (Rust
  // forward_url reads the on-disk key "fallbackBrowser", default "Arc").
  fallback_browser?: string | null;
}

export function loadConfig(): Promise<HiveConfig> {
  return invoke<HiveConfig>("get_config");
}

/**
 * Shallow-merge a patch into ~/.hive/config.json (Rust "save_config_patch",
 * added alongside this by a concurrent change). A null value removes the
 * key. Patch keys must match the file's own on-disk convention — camelCase
 * (e.g. "fallbackBrowser"), matching what forward_url reads directly — NOT
 * the snake_case field names HiveConfig/get_config expose above.
 */
export function saveConfigPatch(patch: Record<string, unknown>): Promise<void> {
  return invoke("save_config_patch", { patch });
}
