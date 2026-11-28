// Rank (patente) icon drawn inside a gui control, for the clan lists (member list, management list, battle lobby roster).
// Same art as the Tab scoreboard (crossScore.ts TabBoard) and the battle loading screen: Gui/Interface/level_icon, cells of 24 px,
// 10 per row, uv (rank % 10 * 24, floor(rank / 10) * 24) + 22. The control's own text is left empty by the caller; the number stays as the tooltip.
import type { I3Gui } from "../ui/i3Gui.ts";
// NOTE: same CROSS_HUD that battleLoading.ts imports ("./pbHud/crossAssets.ts"); adjust this path if the folder differs
import { CROSS_HUD } from "../../game/pbHud/crossAssets.ts";

const SHEET = `${CROSS_HUD}/hud/level_icon.png`;
const CELL = 24, ICON = 22, PER_ROW = 10;

let sheet: Promise<HTMLImageElement> | null = null;
function loadSheet(): Promise<HTMLImageElement> {
  sheet ??= new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = SHEET; });
  return sheet;
}

/** one canvas per control, kept between paints (a setText on the control may clear its children, so it is put back each time) */
const canvases = new WeakMap<HTMLElement, HTMLCanvasElement>();

/** where the control's text ends, in the control's own pixels (the gui may be scaled by CSS); 0 when there is no text */
function textEnd(el: HTMLElement): number {
  const range = document.createRange();
  range.selectNodeContents(el);
  const rr = range.getBoundingClientRect(), er = el.getBoundingClientRect();
  if (!rr.width || !er.width) return 0;
  const k = er.width / (el.offsetWidth || er.width);
  return (rr.right - er.left) / k;
}

/** shows the icon of `rank` for control `name`; rank null = no icon. Call after the control's setText.
 * "center": inside the control, centred (a list cell). "after": right after the control's text, and "box": centred over the control's
 * box; both are drawn in the control's parent, so the control's own box (it clips, and its content is rewritten by setText /
 * paintNodeIcons) cannot hide or remove the icon. */
export function paintRankIcon(gui: I3Gui, name: string, rank: number | null, size = 20, side: "center" | "after" | "box" = "center"): void {
  const b = gui.get(name);
  if (!b) return;
  let c = canvases.get(b.el);
  if (rank === null || rank === undefined || !Number.isFinite(rank)) { if (c) c.style.display = "none"; return; }
  const r = Math.max(0, Math.trunc(rank));
  if (!c) {
    c = document.createElement("canvas");
    c.width = ICON; c.height = ICON;
    Object.assign(c.style, { position: "absolute", pointerEvents: "none" });
    c.setAttribute("data-pb-rank", "");
    canvases.set(b.el, c);
  }
  Object.assign(c.style, { width: `${size}px`, height: `${size}px` });
  if (side !== "center") {
    const host = (b.el.offsetParent as HTMLElement | null) ?? b.el.parentElement;
    // the control is not laid out (its window / tab is hidden): no icon
    if (!host || !b.el.getClientRects().length) { c.style.display = "none"; return; }
    if (c.parentElement !== host) host.appendChild(c);
    const left = side === "box" ? b.el.offsetLeft + (b.el.offsetWidth - size) / 2 : Math.min(b.el.offsetLeft + textEnd(b.el) + 4, Math.max(0, host.clientWidth - size));
    Object.assign(c.style, { display: "block", left: `${left}px`, top: `${b.el.offsetTop + (b.el.offsetHeight - size) / 2}px`, transform: "" });
  } else {
    b.el.style.overflow = "visible";
    if (c.parentElement !== b.el) b.el.appendChild(c); // a setText on the control may have cleared it
    Object.assign(c.style, { display: "block", left: "50%", top: "50%", transform: "translate(-50%, -50%)" });
  }
  c.title = `${r}`;
  if (c.dataset.rank === `${r}`) return;
  c.dataset.rank = `${r}`;
  const cv = c;
  void loadSheet().then((img) => {
    if (cv.dataset.rank !== `${r}`) return; // another rank was asked while the sheet loaded
    const g = cv.getContext("2d")!;
    g.clearRect(0, 0, ICON, ICON);
    g.drawImage(img, (r % PER_ROW) * CELL, Math.floor(r / PER_ROW) * CELL, ICON, ICON, 0, 0, ICON, ICON);
  }, () => { delete cv.dataset.rank; });
}

/** every control name of the window file (ClanPage registers them): the leader's own rank sprite is looked up here */
let controls: string[] = [];
export function registerControls(names: string[]): void { controls = names; ownCache.clear(); }
const ownCache = new Map<string, string | null>();
/** a leader-rank sprite: a "Master...Rank / Level / Icon / Image" control of the same window, not a label or a value */
const OWN_RANK = /Master.*(Rank|Level|Icon|Image)|(Rank|Level).*Master/i, NOT_RANK = /Static|Value|Bullet|Text|Nick|Name/i;
function ownControl(gui: I3Gui, valueName: string): string | null {
  if (ownCache.has(valueName)) return ownCache.get(valueName) ?? null;
  const at = valueName.indexOf("Master");
  const pre = at < 0 ? "" : valueName.slice(0, at).replace(/Clan$/, "");
  const hit = at < 0 || !controls.length ? undefined : controls.find((n) => n.startsWith(pre) && n !== valueName && OWN_RANK.test(n) && !NOT_RANK.test(n) && gui.get(n));
  if (controls.length) ownCache.set(valueName, hit ?? null);
  return hit ?? null;
}

/** the leader's rank icon. Where the window has its own leader-rank sprite, the icon sits over that control: the original position and size
 * (the control itself is only made invisible: paintNodeIcons rewrites its content after every paint, so nothing can live inside it).
 * Otherwise right after the nick in the "...MasterValue" control (clan info panels). */
export function paintLeaderRank(gui: I3Gui, valueName: string, rank: number | null, size = 18): void {
  const own = ownControl(gui, valueName);
  const b = own ? gui.get(own) : null;
  if (own && b) {
    gui.show(own, rank !== null);
    if (rank === null || (b.el.offsetWidth >= 4 && b.el.offsetHeight >= 4)) {
      b.el.style.visibility = "hidden"; // the fixed static picture
      paintRankIcon(gui, own, rank, Math.min(b.node.w, b.node.h) || size, "box");
      paintRankIcon(gui, valueName, null); // the beside-the-nick icon of an earlier paint
      return;
    }
    b.el.style.visibility = ""; // the sprite has no box here: use the nick's side
  }
  paintRankIcon(gui, valueName, rank, size, "after");
}