import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Auto-update via GitHub Releases: the updater endpoint is latest.json on
 * the latest release (built + signed by scripts/release.sh). Silent on any
 * failure — offline, dev builds, or the repo being unreachable must never
 * bother the user.
 */
export async function checkForUpdate(
  onReady: (version: string, install: () => Promise<void>) => void,
): Promise<void> {
  try {
    const update = await check();
    if (!update) return;
    onReady(update.version, async () => {
      await update.downloadAndInstall();
      await relaunch();
    });
  } catch {
    /* best-effort */
  }
}
