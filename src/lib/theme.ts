/**
 * Theme preference: system (follow macOS), or forced light/dark.
 * Applied as [data-theme] on <html>, which swaps the Lattice-derived tokens.
 */

export type ThemePref = "system" | "light" | "dark";

const KEY = "hive-theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

export function getThemePref(): ThemePref {
  const raw = localStorage.getItem(KEY);
  return raw === "light" || raw === "dark" ? raw : "system";
}

function apply() {
  const pref = getThemePref();
  const dark = pref === "dark" || (pref === "system" && media.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function setThemePref(pref: ThemePref) {
  if (pref === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, pref);
  apply();
}

export function initTheme() {
  apply();
  media.addEventListener("change", apply);
}
