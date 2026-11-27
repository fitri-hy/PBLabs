// Battle loading screen.
// Background: fixed, responsive (cover) ui/cross/loading/loading.jpg, blurred + darkened.
// Foreground: player table, Red Rebel (left, even slots) vs CT Force (right, odd slots), each row with a very small weapon line.
// Spinner / "LOADING..." / tip keep the Cross 1024x768 design layout (CGameSupportSet::SetLoadingSpr 0x4db100, update 0x4dc730),
// stretched per axis (scale W/1024, H/768).
//  - FirstLoading.i3i: "LOADING..." uv (66,774)-(188,831) at (899,722) 106x42 and the spinner (852,722) 42x42, 23 frames of 58x58
//    from (7,833), 17 per row, 59 px pitch, one frame each 1/23 s (0x4dc759).
//  - tip (0x4dc200): icon Gui/Main/UI_Source03.i3i uv (323,429)-(372,464) at (12,728) 49x35; text rand() % 7: 0..1 ->
//    STBL_IDX_TIP_LOADING_SINGLE_%d at (70,737), 2..6 -> _DUAL_%d (n - 2) at (70,729); default font 14 pt, weight 400, white.
import { UI_BASE } from "../lobby/ui/assets.ts";
import { guiFont } from "../lobby/ui/i3Gui.ts";
import { tOr } from "../lobby/ui/i18n.ts";
import { CROSS_HUD } from "./pbHud/crossAssets.ts";

/** ready = green check, waiting = yellow clock, failed = red cross */
export type BattleLoadingStatus = "ready" | "waiting" | "failed";

export interface BattleLoadingPlayer {
  name: string;
  /** slot % 2: 0 = Red Rebel (left), 1 = CT Force (right) */
  team: 0 | 1;
  /** weapon names in use, e.g. ["M4A1", "P99", "Knife"] */
  weapons?: string[];
  /** patente (SlotInfo.rank): shown as an icon at the left of the row */
  rank?: number;
  /** load status shown at the right edge of the row (default: waiting) */
  status?: BattleLoadingStatus;
  /** the local player (highlighted row) */
  me?: boolean;
}

export interface BattleLoadingInfo {
  map: string;
  /** room stage ordinal (STAGE_ID & 0xff) */
  mapId: number;
  /** bot room */
  ai: boolean;
  /** local slot % 2: 0 = red, 1 = blue */
  team: 0 | 1;
  /** players of the room (playersFromRoom); more can follow through setBattlePlayers */
  players?: BattleLoadingPlayer[];
}

const DIR = `${UI_BASE}/cross/loading`;
const BG = `${DIR}/loading.jpg`;
const FIRST = `${UI_BASE}/cross/atlas/loading_firstloading.png`;
const SOURCE03 = `${UI_BASE}/cross/atlas/main_ui_source03.png`;

/** most players shown per team (a room has 16 seats = 8 per side; 10 is the hard cap): every row height derives from it, so the table fits without scrolling */
const MAX_PER_TEAM = 10;
const MIN_ROWS = 8;

const TEAMS = [
  { name: "RED REBEL", color: "#ff4a4a", glow: "rgba(255,74,74,.35)" },
  { name: "CT FORCE", color: "#4aa8ff", glow: "rgba(74,168,255,.35)" },
] as const;

/** rank -> icon element (null = none). Default = the Tab scoreboard's icon (crossScore.ts TabBoard): Gui/Interface/level_icon, cells of 24 px,
 * 10 per row, uv (rank % 10 * 24, rank / 10 * 24) + 22 (0x7320d0). Drawn into a 22x22 canvas; the row scales it by CSS. */
export type RankIconFn = (rank: number) => HTMLElement | null;
const RANK_SHEET = `${CROSS_HUD}/hud/level_icon.png`;
let rankIcon: RankIconFn = (rank) => {
  const r = Math.max(0, Math.trunc(rank));
  const u = (r % 10) * 24, v = Math.floor(r / 10) * 24;
  const c = document.createElement("canvas");
  c.width = 22; c.height = 22;
  const g = c.getContext("2d")!;
  image(RANK_SHEET).then((img) => g.drawImage(img, u, v, 22, 22, 0, 0, 22, 22), () => c.remove());
  return c;
};
export function setRankIconProvider(fn: RankIconFn): void { rankIcon = fn; }

const STATUS = {
  ready: { color: "#3ddc84", label: "Ready", svg: '<circle cx="12" cy="12" r="10" fill="currentColor" fill-opacity=".22" stroke="currentColor" stroke-width="2"/><path d="M7 12.5l3.5 3.5L17 9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>' },
  waiting: { color: "#ffc933", label: "Waiting", svg: '<circle cx="12" cy="12" r="10" fill="currentColor" fill-opacity=".22" stroke="currentColor" stroke-width="2"/><path d="M12 6.5V12l3.5 2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' },
  failed: { color: "#ff4a4a", label: "Failed", svg: '<circle cx="12" cy="12" r="10" fill="currentColor" fill-opacity=".22" stroke="currentColor" stroke-width="2"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>' },
} as const;

function statusIcon(st: BattleLoadingStatus): HTMLElement {
  const d = STATUS[st];
  const el = document.createElement("span");
  el.title = d.label;
  Object.assign(el.style, { display: "block", width: "calc(var(--rh) * 0.6)", height: "calc(var(--rh) * 0.6)", color: d.color });
  el.innerHTML = `<svg viewBox="0 0 24 24" width="100%" height="100%">${d.svg}</svg>`;
  if (st === "waiting") el.animate([{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }], { duration: 1200, iterations: Infinity });
  return el;
}

type Uv = [number, number, number, number];

let root: HTMLDivElement | null = null;
let wrap: HTMLDivElement | null = null;
/** last list given to setBattlePlayers: kept so a screen shown after the list was computed still gets it */
let lastPlayers: BattleLoadingPlayer[] = [];
let spin = 0;

const images = new Map<string, Promise<HTMLImageElement>>();
function image(url: string): Promise<HTMLImageElement> {
  let p = images.get(url);
  if (!p) {
    p = new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    images.set(url, p);
  }
  return p;
}

/** i3Sprite2D: SetRect(x, y, w, h) + SetTextureCoord(u1, v1, u2, v2), drawn once the image is in; returns the uv setter */
function sprite(into: HTMLElement, url: string, x: number, y: number, w: number, h: number, uv: Uv): (uv: Uv) => void {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  Object.assign(c.style, { position: "absolute", left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  into.append(c);
  const g = c.getContext("2d")!;
  let cur = uv;
  const draw = (img: HTMLImageElement) => { g.clearRect(0, 0, w, h); g.drawImage(img, cur[0], cur[1], cur[2] - cur[0], cur[3] - cur[1], 0, 0, w, h); };
  const img = image(url);
  img.then(draw, () => {});
  return (next) => { cur = next; void img.then(draw, () => {}); };
}

/** `{col:r,g,b,a}` colour markup of the STBL strings -> spans */
function markup(into: HTMLElement, s: string): void {
  let color = "";
  for (const part of s.split(/(\{col:[^}]*\})/)) {
    const m = /^\{col:(\d+),(\d+),(\d+)/.exec(part);
    if (m) { color = `rgb(${m[1]},${m[2]},${m[3]})`; continue; }
    if (!part) continue;
    const sp = document.createElement("span");
    sp.textContent = part;
    if (color) sp.style.color = color;
    into.append(sp);
  }
}

function cell(tag: "td" | "th", text: string, css: Partial<CSSStyleDeclaration> = {}): HTMLTableCellElement {
  const c = document.createElement(tag);
  c.textContent = text;
  Object.assign(c.style, { padding: "0 clamp(4px, 0.9vw, 10px)", textAlign: "left", fontWeight: "inherit", ...css });
  return c;
}

/** One team table: header (team name) + rows (rank icon, name + very small weapon line, one row) */
function teamTable(team: 0 | 1, players: BattleLoadingPlayer[]): HTMLElement {
  const t = TEAMS[team];
  const box = document.createElement("div");
  Object.assign(box.style, {
    flex: "1 1 0", minWidth: "0", borderRadius: "8px", overflow: "hidden",
    background: "rgba(10,12,18,.55)", border: `1px solid ${t.glow}`, boxShadow: `0 0 24px ${t.glow}`,
    backdropFilter: "blur(4px)",
  });

  const head = document.createElement("div");
  head.textContent = t.name;
  Object.assign(head.style, {
    padding: "calc(var(--rh) * 0.28) clamp(8px, 1.4vw, 14px)", color: "#fff", fontWeight: "700", letterSpacing: "2px",
    fontSize: "max(10px, calc(var(--rh) * 0.45))", background: `linear-gradient(90deg, ${t.color}66, transparent)`,
    borderBottom: `2px solid ${t.color}`, textAlign: team === 0 ? "left" : "right",
  });
  box.append(head);

  const table = document.createElement("table");
  Object.assign(table.style, { width: "100%", tableLayout: "fixed", borderCollapse: "collapse", color: "#fff", fontSize: "max(9px, calc(var(--rh) * 0.38))" });
  const tbody = document.createElement("tbody");
  if (!players.length) {
    const tr = document.createElement("tr");
    const empty = cell("td", "-", { textAlign: "center", opacity: "0.5", height: "var(--rh)" });
    empty.colSpan = 3;
    tr.append(empty);
    tbody.append(tr);
  }
  players.forEach((p, i) => {
    const tr = document.createElement("tr");
    Object.assign(tr.style, {
      height: "var(--rh)",
      borderBottom: "1px solid rgba(255,255,255,.08)",
      background: p.me ? `${t.color}2e` : i % 2 ? "rgba(255,255,255,.03)" : "transparent",
    });
    // rank icon (left)
    const iconTd = cell("td", "", { width: "calc(var(--rh) * 0.9)", padding: "0 0 0 clamp(4px, 0.9vw, 10px)", verticalAlign: "middle" });
    const ic = p.rank == null ? null : rankIcon(p.rank);
    if (ic) { Object.assign(ic.style, { display: "block", width: "calc(var(--rh) * 0.72)", height: "calc(var(--rh) * 0.72)", objectFit: "contain" }); iconTd.append(ic); }
    tr.append(iconTd);

    const nameTd = cell("td", "", { fontWeight: p.me ? "700" : "400", overflow: "hidden", maxWidth: "0" });
    const nm = document.createElement("div");
    nm.textContent = p.name;
    Object.assign(nm.style, { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
    nameTd.append(nm);
    if (p.weapons?.length) {
      const w = document.createElement("div");
      w.textContent = p.weapons.join(" · ");
      w.title = p.weapons.join(" · "); // full list on hover; the line itself is cut with an ellipsis and stays on one row
      // very small weapon info
      Object.assign(w.style, { fontSize: "max(6px, min(9px, calc(var(--rh) * 0.2)))", lineHeight: "1.15", color: "rgba(255,255,255,.6)", marginTop: "1px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
      nameTd.append(w);
    }
    tr.append(nameTd);

    // status (right edge)
    const stTd = cell("td", "", { width: "calc(var(--rh) * 0.9)", padding: "0 clamp(4px, 0.9vw, 10px) 0 0", verticalAlign: "middle" });
    stTd.append(statusIcon(p.status ?? "waiting"));
    tr.append(stTd);
    tbody.append(tr);
  });
  table.append(tbody);
  box.append(table);
  return box;
}

/** (Re)draws the player table. Call it again whenever the room's slots change: they fill in while the screen is up. */
export function setBattlePlayers(players: BattleLoadingPlayer[]): void {
  lastPlayers = players;
  if (!wrap) return;
  const red = players.filter((p) => p.team === 0).slice(0, MAX_PER_TEAM);
  const blue = players.filter((p) => p.team === 1).slice(0, MAX_PER_TEAM);
  // row height: 5.6vh at most, shrinking so MIN_ROWS..MAX_PER_TEAM rows always fit in ~60vh (desktop and short mobile landscape alike)
  const n = Math.max(MIN_ROWS, red.length, blue.length);
  wrap.style.setProperty("--rh", `min(5.6vh, calc(60vh / ${n}))`);
  wrap.replaceChildren(teamTable(0, red), teamTable(1, blue));
}

/** room.slots (+ room.mySlot) -> table rows. `weaponsOf(slot)` = the weapon names of that slot, when known. Empty slots (no nick) are skipped. */
export function playersFromRoom(
  room: { slots: { slot: number; nick: string; rank?: number }[]; mySlot: number },
  weaponsOf?: (slot: number) => string[] | undefined,
): BattleLoadingPlayer[] {
  const out: BattleLoadingPlayer[] = [];
  for (const s of room.slots) {
    if (!s.nick) continue;
    out.push({ name: s.nick, team: (s.slot % 2) as 0 | 1, weapons: weaponsOf?.(s.slot), rank: s.rank, me: s.slot === room.mySlot });
  }
  return out;
}

/** The Cross screen has no progress bar; kept for main.ts's load milestones. */
export function setBattleProgress(_p: number): void {}

/** Shows the loading screen (a second call while it is up does nothing). `_caption` = the room's start messages: no text box for them. */
export function showBattleLoading(info: BattleLoadingInfo, _caption?: string): void {
  if (root) return;
  const el = document.createElement("div");
  root = el;
  Object.assign(el.style, { position: "fixed", inset: "0", zIndex: "100000", background: "#000", overflow: "hidden", userSelect: "none", cursor: "default" });
  document.body.append(el);

  // background: fixed, cover, blurred (light blur; scaled up a bit so the edges stay filled) + dark overlay
  const bg = document.createElement("div");
  Object.assign(bg.style, {
    position: "absolute", inset: "0", background: `#000 url("${BG}") center / cover no-repeat`,
    filter: "blur(1px) brightness(.62)", transform: "scale(1.01)",
  });
  el.append(bg);
  const shade = document.createElement("div");
  Object.assign(shade.style, {
    position: "absolute", inset: "0",
    background: "radial-gradient(ellipse at center, rgba(0,0,0,.1) 0%, rgba(0,0,0,.55) 100%)",
  });
  el.append(shade);

  // player table: Red Rebel left, CT Force right (always shown; filled by info.players and later by setBattlePlayers)
  const w = document.createElement("div");
  wrap = w;
  Object.assign(w.style, {
    position: "absolute", left: "50%", top: "10%", transform: "translateX(-50%)",
    width: "min(1000px, 94vw)", display: "flex", gap: "clamp(8px, 2vw, 24px)", alignItems: "flex-start",
    fontFamily: "system-ui, 'Segoe UI', Roboto, sans-serif",
  });
  el.append(w);
  setBattlePlayers(info.players ?? lastPlayers);

  // 1024x768 design layer for the spinner / LOADING... / tip
  const sx = window.innerWidth / 1024, sy = window.innerHeight / 768;
  const ui = document.createElement("div");
  Object.assign(ui.style, { position: "absolute", left: "0", top: "0", width: "1024px", height: "768px", transformOrigin: "0 0", transform: `scale(${sx}, ${sy})` });
  el.append(ui);

  sprite(ui, FIRST, 899, 722, 106, 42, [66, 774, 188, 831]);
  const frame = (f: number): Uv => { const u = 7 + (f % 17) * 59, v = 833 + Math.floor(f / 17) * 59; return [u, v, u + 58, v + 58]; };
  const setSpin = sprite(ui, FIRST, 852, 722, 42, 42, frame(0));
  let f = 0;
  spin = window.setInterval(() => { f = f >= 22 ? 0 : f + 1; setSpin(frame(f)); }, 1000 / 23);

  sprite(ui, SOURCE03, 12, 728, 49, 35, [323, 429, 372, 464]);
  const n = Math.floor(Math.random() * 7);
  const font = guiFont(14, 400);
  // touch / short landscape screens: the tip text shrinks with the screen height like the mobile HUD
  const mobile = window.matchMedia("(pointer: coarse), (max-height: 520px)").matches;
  const k = mobile ? Math.min(1, Math.max(0.4, sy)) : 1;
  const tip = document.createElement("div");
  Object.assign(tip.style, {
    position: "absolute", left: `${70 * sx}px`, top: `${(n > 1 ? 729 : 737) * sy}px`, width: `${(1024 * sx) / k}px`, height: `${(80 * sy) / k}px`, transformOrigin: "0 0", transform: k === 1 ? "" : `scale(${k})`,
    font: font.css, lineHeight: `${font.lineH}px`, color: "#fff", whiteSpace: "pre-wrap",
  });
  markup(tip, tOr(n > 1 ? `STBL_IDX_TIP_LOADING_DUAL_${n - 2}` : `STBL_IDX_TIP_LOADING_SINGLE_${n}`, ""));
  el.append(tip);
}

export function hideBattleLoading(): void {
  clearInterval(spin);
  spin = 0;
  root?.remove();
  root = null;
  wrap = null;
  lastPlayers = [];
}