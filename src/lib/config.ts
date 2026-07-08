import { invoke } from "@tauri-apps/api/core";

/** Read by the Rust core from ~/.hive/config.json — never stored in the repo. */
export interface HiveConfig {
  notion_token: string | null;
  capture_page_id?: string | null;
}

export function loadConfig(): Promise<HiveConfig> {
  return invoke<HiveConfig>("get_config");
}
