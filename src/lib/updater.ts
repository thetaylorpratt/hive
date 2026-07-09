import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

/**
 * Auto-update via GitHub Releases (latest.json, built + signed by
 * scripts/release.sh). Both the startup check and the manual "check for
 * updates" flow run through here; the pending Update object is held so the
 * version badge's Update button can install the exact build check() found.
 */

let pending: Update | null = null;

export async function appVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return "dev";
  }
}

/** Returns the available version string, or null if current/offline. */
export async function checkForUpdate(): Promise<string | null> {
  try {
    const update = await check();
    if (!update) {
      pending = null;
      return null;
    }
    pending = update;
    return update.version;
  } catch {
    return null; // offline / dev build / unreachable — treat as current
  }
}

/** Download + install the update check() found, then relaunch. */
export async function applyPendingUpdate(): Promise<void> {
  if (!pending) return;
  await pending.downloadAndInstall();
  await relaunch();
}
