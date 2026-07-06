import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/theme.css";

// Follow the OS appearance; Lattice-style [data-theme="dark"] swaps tokens.
// Per-Space theming (Phase 2) layers on top of this same mechanism.
const media = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  document.documentElement.dataset.theme = media.matches ? "dark" : "light";
}
applyTheme();
media.addEventListener("change", applyTheme);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
