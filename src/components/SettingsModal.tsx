import { useEffect, useState } from "react";
import { useAppStore } from "../store/appStore";
import { getThemePref, setThemePref, type ThemePref } from "../lib/theme";
import { loadConfig, saveConfigPatch } from "../lib/config";
import "../styles/settings.css";

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/**
 * The traditional preferences surface Hive otherwise lacks: appearance
 * (theme + reader text size), the fallback browser for non-Notion links,
 * the two Notion connections, and version/update info.
 *
 * Pattern-matches MovePageModal/CaptureModal: scrim backdrop + Escape both
 * close. Rendering is gated on store.settingsOpen only — the caller (App/
 * CommandBar) is responsible for wiring in the open/close triggers.
 */
export function SettingsModal() {
  const open = useAppStore((s) => s.settingsOpen);
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const textScale = useAppStore((s) => s.textScale);
  const adjustTextScale = useAppStore((s) => s.adjustTextScale);
  const auth = useAppStore((s) => s.auth);
  const mcpStatus = useAppStore((s) => s.mcpStatus);
  const connectPersonalNotion = useAppStore((s) => s.connectPersonalNotion);
  const appVersion = useAppStore((s) => s.appVersion);
  const updateState = useAppStore((s) => s.updateState);
  const availableVersion = useAppStore((s) => s.availableVersion);
  const checkForUpdates = useAppStore((s) => s.checkForUpdates);
  const applyUpdate = useAppStore((s) => s.applyUpdate);
  const showToast = useAppStore((s) => s.showToast);

  const [themePref, setThemePrefState] = useState<ThemePref>(() => getThemePref());
  const [fallbackBrowser, setFallbackBrowser] = useState("");
  const [loadedBrowser, setLoadedBrowser] = useState(false);

  useEffect(() => {
    if (!open) return;
    setThemePrefState(getThemePref());
    let cancelled = false;
    void loadConfig().then((cfg) => {
      if (cancelled) return;
      setFallbackBrowser(cfg.fallback_browser ?? "");
      setLoadedBrowser(true);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  const saveFallbackBrowser = () => {
    if (!loadedBrowser) return;
    const clean = fallbackBrowser.trim();
    void saveConfigPatch({ fallbackBrowser: clean || null })
      .then(() => showToast(clean ? `Fallback browser set to ${clean}` : "Fallback browser reset to default (Arc)"))
      .catch((err) =>
        showToast(`Couldn't save: ${err instanceof Error ? err.message : err}`),
      );
  };

  const authLabel =
    auth.status === "ready"
      ? `Connected${auth.userName ? ` as ${auth.userName}` : ""}`
      : auth.status === "checking"
        ? "Checking…"
        : auth.status === "missing-token"
          ? "No token configured"
          : `Error${auth.message ? `: ${auth.message}` : ""}`;

  return (
    <div className="hive-modal-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="hive-settings-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="hive-settings-head">
          <div className="hive-settings-title">Settings</div>
          <button className="hive-settings-close" onClick={() => setOpen(false)} aria-label="Close settings">
            ×
          </button>
        </div>

        <div className="hive-settings-body">
          <section className="hive-settings-section">
            <div className="hive-settings-heading">Appearance</div>

            <div className="hive-settings-row">
              <span className="label">Theme</span>
              <div className="hive-segmented">
                {THEME_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    className={`hive-segmented-opt${themePref === opt.value ? " selected" : ""}`}
                    onClick={() => {
                      setThemePref(opt.value);
                      setThemePrefState(opt.value);
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="hive-settings-row">
              <span className="label">Text size</span>
              <div className="hive-textsize-control">
                <button
                  className="hive-btn hive-btn-secondary"
                  onClick={() => adjustTextScale(-1)}
                  aria-label="Decrease text size"
                >
                  −
                </button>
                <span className="hive-textsize-value">{Math.round(textScale * 100)}%</span>
                <button
                  className="hive-btn hive-btn-secondary"
                  onClick={() => adjustTextScale(1)}
                  aria-label="Increase text size"
                >
                  +
                </button>
                {textScale !== 1 && (
                  <button className="hive-settings-link" onClick={() => adjustTextScale(0)}>
                    Reset
                  </button>
                )}
              </div>
            </div>
          </section>

          <section className="hive-settings-section">
            <div className="hive-settings-heading">Browsing</div>
            <div className="hive-settings-row column">
              <span className="label">Fallback browser</span>
              <input
                className="hive-input"
                placeholder="Arc"
                value={fallbackBrowser}
                disabled={!loadedBrowser}
                onChange={(e) => setFallbackBrowser(e.target.value)}
                onBlur={saveFallbackBrowser}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
              <span className="hive-settings-hint">
                Non-Notion links open here when Hive is your default browser.
              </span>
            </div>
          </section>

          <section className="hive-settings-section">
            <div className="hive-settings-heading">Connections</div>
            <div className="hive-settings-row">
              <span className="label">Notion workspace (integration)</span>
              <span className="hive-settings-status">{authLabel}</span>
            </div>
            <div className="hive-settings-row">
              <span className="label">Personal Notion (comments as you)</span>
              {mcpStatus === "connected" ? (
                <span className="hive-settings-status">Connected</span>
              ) : (
                <button
                  className="hive-btn hive-btn-secondary"
                  onClick={() => void connectPersonalNotion()}
                  disabled={mcpStatus === "pending"}
                >
                  {mcpStatus === "pending" ? "Waiting for approval…" : "Connect"}
                </button>
              )}
            </div>
          </section>

          <section className="hive-settings-section">
            <div className="hive-settings-heading">About</div>
            <div className="hive-settings-row">
              <span className="label">Version</span>
              <span className="hive-settings-status">{appVersion || "…"}</span>
            </div>
            <div className="hive-settings-row">
              <span className="label">
                {updateState === "available" && availableVersion
                  ? `Update available (${availableVersion})`
                  : "Updates"}
              </span>
              {updateState === "available" ? (
                <button className="hive-btn" onClick={() => void applyUpdate()}>
                  Restart to update
                </button>
              ) : (
                <button
                  className="hive-btn hive-btn-secondary"
                  onClick={() => void checkForUpdates(true)}
                  disabled={updateState === "checking"}
                >
                  {updateState === "checking" ? "Checking…" : "Check for updates"}
                </button>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
