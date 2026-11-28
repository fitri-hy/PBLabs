// Country flag of a lobby Waiting List / ready-room row. The layout already carries an `...Nation%d` control per row (the
// exe's 26-cell nation sheet of main_ui_source06, hidden with the other unported marks): app.ts moves it to the row's edge
// and repaints it here with the flag of the two-letter code the server resolved from the player's IP
// (server shared/geoip.ts -> LOBBY_GET_ROOMLIST / the room's slot record -> LobbyPlayer.country / SlotInfo.country).
// Source: flagcdn.com (free, CC0 flags); no code, or the image cannot be fetched -> the code as text. A player the GeoIP
// database could not place (loopback / private / outside every range) -> the unknown flag: a gray banner with a "?" in it,
// drawn as an inline SVG so it needs no fetch and works the same locally and in production. `country === null` = no player
// in this row, so the control stays hidden.
import type { I3Gui } from "../ui/i3Gui.ts";

const flagUrl = (cc: string): string => `https://flagcdn.com/w40/${cc.toLowerCase()}.png`;

/** the flag shows for 3 s and hides for 3 s (6 s cycle, smooth fades), for the real flags and the unknown one alike */
const CSS = `
.pb-flag, .pb-flag-code { animation: pb-flag-pulse 6s ease-in-out infinite; }
@keyframes pb-flag-pulse {
  0%, 45%   { opacity: 1; }
  50%, 95%  { opacity: 0; }
  100%      { opacity: 1; }
}
`;

function ensureCss(): void {
  if (document.getElementById("pb-flag-css")) return;
  const st = document.createElement("style");
  st.id = "pb-flag-css";
  st.textContent = CSS;
  document.head.appendChild(st);
}

/** the 3 s / 3 s pulse CSS, for every renderer that draws a flag (the i3Gui rows and plain DOM ones alike) */
export function ensureFlagCss(): void { ensureCss(); }

/** gray flag with a "?" in the banner: inline SVG data URI (no request), so it also renders offline */
const UNKNOWN_FLAG = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect x="4" y="2.5" width="1.6" height="15" rx="0.8" fill="#6b7280"/><path d="M6 3.5h10.5v9H6z" fill="#9ca3af" stroke="#6b7280" stroke-width="0.6"/><text x="11.2" y="10.7" font-family="Arial,Helvetica,sans-serif" font-size="8" font-weight="bold" text-anchor="middle" fill="#ffffff">?</text></svg>`,
)}`;

/** the image of a country's flag: the flagcdn file, the gray "?" for an unknown code; null = no player in this row */
export function flagSrc(country: string | null): string | null {
  if (country === null) return null;
  return /^[A-Z]{2}$/.test(country) ? flagUrl(country) : UNKNOWN_FLAG;
}

/**
 * Shows `country`'s flag in the Nation control `name`. `null` = no player in the row (hidden), `""` = a player whose IP
 * has no country (the gray "?" flag), a two-letter code = that country's flag. Idempotent per code.
 */
export function setNationFlag(gui: I3Gui, name: string, country: string | null): void {
  const b = gui.get(name);
  if (!b) return;
  if (country === null) { gui.show(name, false); delete b.el.dataset.flag; return; }
  const cc = /^[A-Z]{2}$/.test(country) ? country : "";
  const key = cc || "?";
  gui.show(name, true);
  if (b.el.dataset.flag === key) return;
  ensureFlagCss();
  b.el.dataset.flag = key;
  for (const s of b.states) s.style.display = "none"; // the template's own nation cells are not our flags
  b.el.querySelector(":scope > .pb-flag, :scope > .pb-flag-code")?.remove();

  // fallback shown by the img's onerror: the CDN blocked / offline -> the ISO code in the flag's box
  let code: HTMLElement | null = null;
  if (cc) {
    const el = document.createElement("span");
    el.className = "pb-flag-code";
    el.textContent = cc;
    el.title = cc;
    Object.assign(el.style, {
      display: "none", position: "absolute", inset: "0", alignItems: "center", justifyContent: "center",
      font: "bold 9px/1 Arial, sans-serif", color: "#fff", textShadow: "0 1px 1px #000, 0 0 2px #000", pointerEvents: "none",
    });
    code = el;
  }

  const img = document.createElement("img");
  img.className = "pb-flag";
  img.alt = cc || "?";
  img.title = cc || "unknown country";
  // the 20x20 box has no border of its own: a hairline keeps white flags (FRA / NLD ...) readable on the row art
  Object.assign(img.style, {
    position: "absolute", inset: "0", width: "100%", height: "100%", display: "block", objectFit: "cover",
    pointerEvents: "none", boxShadow: "inset 0 0 0 1px rgba(0,0,0,.4)",
  });
  if (code) img.onerror = () => { img.remove(); code!.style.display = "flex"; };
  img.src = flagSrc(country)!;
  if (code) b.el.append(code);
  b.el.append(img);
}
