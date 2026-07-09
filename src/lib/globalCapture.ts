/**
 * System-wide quick capture: the Rust side (src-tauri/src/lib.rs) registers
 * an OS-level global shortcut (⌃⌥N / "ctrl+alt+n") via
 * tauri-plugin-global-shortcut, which works even while Hive is backgrounded.
 * On press it brings the main window forward and emits "hive://global-capture".
 * This module just listens for that event and opens the existing in-app
 * capture modal (see CaptureModal.tsx / appStore.setCaptureOpen) — no new UI.
 *
 * Guarded for plain-browser/preview dev, same pattern as notionMcp.ts and
 * notionRestOauth.ts: outside Tauri there's no global shortcut to listen for.
 */
import { useAppStore } from "../store/appStore";

const GLOBAL_CAPTURE_EVENT = "hive://global-capture";

const isTauri = "__TAURI_INTERNALS__" in window;

/**
 * Starts listening for the global-capture event and returns an unlisten
 * function. Safe to call in non-Tauri environments (no-ops there).
 */
export async function installGlobalCaptureListener(): Promise<() => void> {
  if (!isTauri) return () => undefined;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen(GLOBAL_CAPTURE_EVENT, () => {
      useAppStore.getState().setCaptureOpen(true);
    });
    return unlisten;
  } catch {
    // Best-effort — if the event API isn't available for some reason,
    // quick capture still works via the in-app ⌘⌥N binding.
    return () => undefined;
  }
}
