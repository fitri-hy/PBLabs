// PWA glue: service worker registration (public/sw.js) and the state of the "Install Application" button on the login
// screen (ui/accountScreen.ts). The button is offered on iOS / Android only, and not once the app runs installed.
//  - Android (Chrome): `beforeinstallprompt` is kept and the button opens the native install dialog.
//  - iOS (Safari / iPadOS) and Android browsers without that event: no API exists, the button shows how to add it by hand.
// This module is imported by accountScreen.ts, which boot.ts loads first: the event is caught before the screen is drawn.

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type MobileOs = "ios" | "android";
export type InstallResult = "accepted" | "dismissed" | "manual";

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((f) => f());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // keep it for the button instead of the browser's own mini-infobar
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    emit();
  });
}

/** "ios" / "android" on a phone or tablet, null on desktop. */
export function mobileOs(): MobileOs | null {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return "ios"; // iPadOS reports a Mac
  return null;
}

/** Running as the installed app (home-screen icon). */
export function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** The Install button shows only on iOS / Android and only while the app is not installed. */
export function canOfferInstall(): boolean {
  return mobileOs() !== null && !installed && !isStandalone();
}

/** Native dialog when the browser gave us one, else "manual" (show installHint()). */
export async function promptInstall(): Promise<InstallResult> {
  const e = deferred;
  if (!e) return "manual";
  deferred = null; // a prompt event works once
  await e.prompt();
  const { outcome } = await e.userChoice;
  if (outcome === "accepted") installed = true;
  emit();
  return outcome;
}

export function installHint(): string {
  return mobileOs() === "ios"
    ? "In Safari, tap the Share button, then choose \u201cAdd to Home Screen\u201d."
    : "Open the browser menu (\u22EE) and choose \u201cInstall app\u201d or \u201cAdd to Home screen\u201d.";
}

/** cb runs when the install state changes (prompt became available, app installed); returns the unsubscribe. */
export function onInstallChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/**
 * Registers /sw.js (asset + page cache, see public/sw.js). Builds with VITE_ASSET_BASE register it with
 * `?base=<asset origin>` in src/cache/register.ts (installAssetCache): not twice here.
 * Production always; the dev server only with `?pwa` in the URL (e.g. https://<lan-ip>:8000/?pwa), so a normal dev session
 * never serves cached assets. Needs a secure context with a TRUSTED certificate: a self-signed one makes the registration
 * fail (the reason is logged) and the browser never offers the install.
 */
export function installPwa(): void {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  if ((import.meta.env as Record<string, string | undefined>).VITE_ASSET_BASE) return;
  if (!import.meta.env.PROD && !new URLSearchParams(location.search).has("pwa")) return;
  const register = (): void => void navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("[pwa] service worker failed", e));
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}