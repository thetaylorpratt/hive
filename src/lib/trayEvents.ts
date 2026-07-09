/**
 * Menu bar (tray) presence: the Rust side (src-tauri/src/lib.rs) builds a
 * TrayIcon with Open Hive / Quick Capture / Check for Updates… / Quit Hive.
 * "capture" reuses the exact same show+focus+emit sequence as the global
 * shortcut and already lands on the "hive://global-capture" event that
 * globalCapture.ts listens for — no double-handling needed here.
 * "updates" emits its own "hive://check-updates" event, which this module
 * listens for and forwards into the store's manual update-check flow (the
 * same one Sidebar's VersionFooter triggers via its "Check for Updates"
 * button).
 *
 * Guarded for plain-browser/preview dev, same pattern as globalCapture.ts:
 * outside Tauri there's no tray and no event to listen for.
 */
import { useAppStore } from "../store/appStore";

const CHECK_UPDATES_EVENT = "hive://check-updates";

const isTauri = "__TAURI_INTERNALS__" in window;

/**
 * Starts listening for the tray's "Check for Updates…" event and returns an
 * unlisten function. Safe to call in non-Tauri environments (no-ops there).
 */
export async function installTrayListeners(): Promise<() => void> {
  if (!isTauri) return () => undefined;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen(CHECK_UPDATES_EVENT, () => {
      void useAppStore.getState().checkForUpdates(true);
    });
    return unlisten;
  } catch {
    // Best-effort — if the event API isn't available for some reason,
    // manual update checks still work via the Sidebar's VersionFooter button.
    return () => undefined;
  }
}
