import { registerAccount, loginAccount, tokenToBytes, AccountApiError } from "../net/accountApi.js";
import { Stage } from "../lobby/ui/LayoutRenderer.ts";
import { canOfferInstall, installHint, onInstallChange, promptInstall } from "../pwa/install.ts";

export interface AccountSession {
  token: Uint8Array;
  username: string;
}

const STYLE_ID = "pb-modern-account-screen-style";
const LOGIN_ART = "/assets/ui/cross/brand/login-bg.jpg";

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800&family=Barlow:wght@400;500;600&display=swap');

    .pb-acc {
      --pb-bg: #0c1117;
      --pb-panel: #121922;
      --pb-field: #0c1117;
      --pb-line: #243040;
      --pb-line-strong: #3a4a60;
      --pb-text: #e8edf3;
      --pb-muted: #8a99ad;
      --pb-accent: #4cc3ff;
      --pb-accent-hover: #7ad3ff;
      --pb-on-accent: #06121c;
      --pb-danger: #ff6b6b;

      position: fixed;
      inset: 0;
      z-index: 10000;
      display: flex;
      background: var(--pb-bg);
      color: var(--pb-text);
      font-family: 'Barlow', system-ui, sans-serif;
      height: 100vh;
      height: 100dvh;
      overflow: hidden;
      box-sizing: border-box;
      -webkit-text-size-adjust: 100%;
      text-size-adjust: 100%;
    }
    .pb-acc *, .pb-acc *::before, .pb-acc *::after { box-sizing: border-box; }
    .pb-acc [hidden] { display: none !important; }

    /* Background art: desaturated and darkened, no glow */
    .pb-acc__bg {
      position: absolute;
      inset: 0;
      background: #0c1117 url(${LOGIN_ART}) no-repeat 30% center;
      background-size: cover;
      filter: grayscale(0.7) brightness(0.5) contrast(1.1);
      transform: scale(1.02);
    }
    .pb-acc__shade {
      position: absolute;
      inset: 0;
      background:
        linear-gradient(90deg, rgba(12,17,23,0.35) 0%, rgba(12,17,23,0.75) 55%, rgba(12,17,23,0.96) 100%),
        linear-gradient(0deg, rgba(12,17,23,0.85) 0%, rgba(12,17,23,0) 40%);
    }

    /* Hero (left) */
    .pb-acc__hero {
      position: relative;
      flex: 1 1 auto;
      display: none;
      flex-direction: column;
      justify-content: flex-end;
      padding: 56px 64px;
      min-width: 0;
    }
    .pb-acc__hero { overflow: hidden; }

    /* Wordmark: solid accent tile + heavy condensed type, slightly italicised */
    .pb-acc__wordmark {
      display: flex;
      align-items: stretch;
      margin: 0;
      font-family: 'Barlow Condensed', sans-serif;
      font-weight: 800;
      font-size: clamp(64px, 9vw, 176px);
      line-height: 0.9;
      letter-spacing: -0.015em;
      text-transform: uppercase;
      color: var(--pb-text);
      transform: skewX(-7deg);
      transform-origin: left bottom;
      white-space: nowrap;
    }
    .pb-acc__wm-pb {
      padding: 0.05em 0.2em 0.02em 0.1em;
      background: var(--pb-accent);
      color: var(--pb-on-accent);
      clip-path: polygon(0 0, 100% 0, calc(100% - 0.14em) 100%, 0 100%);
    }
    .pb-acc__wm-labs {
      padding: 0.05em 0 0.02em 0.14em;
    }
    .pb-acc__rule {
      position: relative;
      width: min(100%, 420px);
      height: 1px;
      margin-top: 26px;
      background: var(--pb-line-strong);
    }
    .pb-acc__rule::before {
      content: '';
      position: absolute;
      left: 0;
      top: -1px;
      width: 72px;
      height: 3px;
      background: var(--pb-accent);
    }
    .pb-acc__tagline {
      margin: 20px 0 0;
      max-width: 420px;
      font-size: 18px;
      line-height: 1.5;
      color: var(--pb-muted);
    }

    /* Panel (right) */
    .pb-acc__panel {
      position: relative;
      width: 100%;
      flex: 0 0 auto;
      min-height: 100%;
      overflow-y: auto;
      overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding:
        max(32px, env(safe-area-inset-top))
        max(24px, env(safe-area-inset-right))
        max(32px, env(safe-area-inset-bottom))
        max(24px, env(safe-area-inset-left));
      background: var(--pb-panel);
      border-left: 1px solid var(--pb-line);
      animation: pb-acc-in 0.45s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    @keyframes pb-acc-in {
      from { opacity: 0; transform: translateX(24px); }
      to   { opacity: 1; transform: translateX(0); }
    }

    .pb-acc__panel > * { width: 100%; max-width: 420px; flex: 0 0 auto; }
    .pb-acc__brand {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: auto;
      margin-bottom: 32px;
    }
    .pb-acc__brand-mark {
      padding: 1px 9px 1px 6px;
      background: var(--pb-accent);
      color: var(--pb-on-accent);
      font-family: 'Barlow Condensed', sans-serif;
      font-weight: 800;
      font-size: 24px;
      line-height: 1.15;
      text-transform: uppercase;
      clip-path: polygon(0 0, 100% 0, calc(100% - 5px) 100%, 0 100%);
    }
    .pb-acc__brand-name {
      font-family: 'Barlow Condensed', sans-serif;
      font-weight: 800;
      font-size: 26px;
      letter-spacing: 0.01em;
      text-transform: uppercase;
    }
    .pb-acc__brand-tag {
      font-size: 13px;
      color: var(--pb-muted);
    }

    /* Mode switch */
    .pb-acc__tabs {
      display: grid;
      grid-template-columns: 1fr 1fr;
      border-bottom: 1px solid var(--pb-line);
      margin-bottom: 28px;
    }
    .pb-acc__tab {
      position: relative;
      appearance: none;
      background: none;
      border: 0;
      padding: 0 0 14px;
      font-family: 'Barlow Condensed', sans-serif;
      font-weight: 600;
      font-size: 22px;
      letter-spacing: 0.02em;
      color: var(--pb-muted);
      cursor: pointer;
      text-align: left;
      transition: color 0.15s ease;
    }
    .pb-acc__tab:hover { color: var(--pb-text); }
    .pb-acc__tab[aria-selected="true"] { color: var(--pb-text); }
    .pb-acc__tab[aria-selected="true"]::after {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      bottom: -1px;
      height: 3px;
      background: var(--pb-accent);
    }

    .pb-acc__heading {
      font-family: 'Barlow Condensed', sans-serif;
      font-weight: 700;
      font-size: 40px;
      line-height: 1;
      margin: 0 0 6px;
    }
    .pb-acc__sub {
      margin: 0 0 26px;
      font-size: 15px;
      color: var(--pb-muted);
    }

    /* Fields */
    .pb-acc__group { margin-bottom: 16px; }
    .pb-acc__label {
      display: block;
      margin-bottom: 7px;
      font-size: 13px;
      font-weight: 600;
      color: var(--pb-muted);
    }
    .pb-acc__field {
      display: flex;
      align-items: center;
      height: 48px;
      background: var(--pb-field);
      border: 1px solid var(--pb-line);
      border-radius: 2px;
      transition: border-color 0.15s ease, background-color 0.15s ease;
    }
    .pb-acc__field:hover { border-color: var(--pb-line-strong); }
    .pb-acc__field:focus-within {
      border-color: var(--pb-accent);
      background: #0e151d;
    }
    .pb-acc__icon {
      flex: 0 0 auto;
      width: 44px;
      display: grid;
      place-items: center;
      color: var(--pb-muted);
    }
    .pb-acc__field:focus-within .pb-acc__icon { color: var(--pb-accent); }
    .pb-acc__icon svg { width: 18px; height: 18px; }

    .pb-account-input {
      flex: 1 1 auto;
      min-width: 0;
      height: 100%;
      padding: 0 14px 0 0;
      background: transparent;
      border: 0;
      outline: none;
      color: var(--pb-text);
      font-family: 'Barlow', sans-serif;
      font-size: 16px; /* 16px agar tidak auto-zoom di HP */
      font-weight: 500;
      caret-color: var(--pb-accent);
    }
    .pb-account-input::placeholder { color: #55657a; }
    .pb-account-input:-webkit-autofill,
    .pb-account-input:-webkit-autofill:hover,
    .pb-account-input:-webkit-autofill:focus {
      -webkit-text-fill-color: #e8edf3 !important;
      -webkit-box-shadow: 0 0 0 1000px #0c1117 inset !important;
      transition: background-color 5000s ease-in-out 0s;
    }

    .pb-acc__peek {
      flex: 0 0 auto;
      width: 44px;
      height: 100%;
      display: grid;
      place-items: center;
      background: none;
      border: 0;
      color: var(--pb-muted);
      cursor: pointer;
    }
    .pb-acc__peek:hover { color: var(--pb-text); }
    .pb-acc__peek svg { width: 18px; height: 18px; }

    .pb-acc__hint {
      margin-top: 6px;
      font-size: 12px;
      color: #66768b;
    }

    /* Submit */
    .pb-account-btn {
      width: 100%;
      height: 52px;
      margin-top: 10px;
      border: 0;
      border-radius: 2px;
      background: var(--pb-accent);
      color: var(--pb-on-accent);
      font-family: 'Barlow Condensed', sans-serif;
      font-weight: 700;
      font-size: 22px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      cursor: pointer;
      transition: background-color 0.15s ease, transform 0.1s ease;
    }
    .pb-account-btn:hover:not(:disabled) { background: var(--pb-accent-hover); }
    .pb-account-btn:active:not(:disabled) { transform: translateY(1px); }
    .pb-account-btn:disabled { opacity: 0.55; cursor: not-allowed; }

    /* Install Application (iOS / Android only, under the submit button) */
    .pb-account-btn--install {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      background: transparent;
      color: var(--pb-text);
      border: 1px solid var(--pb-line-strong);
    }
    .pb-account-btn--install:hover:not(:disabled) { background: rgba(76, 195, 255, 0.1); border-color: var(--pb-accent); }
    .pb-account-btn--install svg { width: 20px; height: 20px; flex: 0 0 auto; }
    .pb-acc__install-hint {
      margin-top: 10px;
      padding: 10px 12px;
      background: #0e151d;
      border: 1px solid var(--pb-line);
      border-left: 3px solid var(--pb-accent);
      border-radius: 2px;
      font-size: 13px;
      line-height: 1.45;
      color: var(--pb-muted);
    }
    .pb-account-error {
      display: none;
      margin-top: 16px;
      padding: 11px 14px;
      background: rgba(255, 107, 107, 0.1);
      border: 1px solid rgba(255, 107, 107, 0.35);
      border-left: 3px solid var(--pb-danger);
      border-radius: 2px;
      color: #ffb3b3;
      font-size: 14px;
      font-weight: 500;
      line-height: 1.4;
    }
    .pb-account-error.visible { display: block; }

	.pb-acc__foot {
	  margin-top: 32px;
	  margin-bottom: auto;
	  padding-top: 18px;
	  border-top: 1px solid var(--pb-line);
	  font-size: 12px;
	  color: #98a6b8;
	  text-align: center;
	}

    .pb-acc :focus-visible {
      outline: 2px solid var(--pb-accent);
      outline-offset: 2px;
    }
    .pb-acc__field :focus-visible { outline: none; }

    /* Touch devices: bigger tap targets */
    @media (pointer: coarse) {
      .pb-acc__tab { min-height: 44px; padding-bottom: 14px; }
      .pb-acc__peek { width: 48px; }
      .pb-acc__field { height: 50px; }
    }

    /* Small phones, portrait */
    @media (max-width: 480px) {
      .pb-acc__panel {
        justify-content: flex-start;
        padding:
          max(24px, env(safe-area-inset-top))
          max(18px, env(safe-area-inset-right))
          max(24px, env(safe-area-inset-bottom))
          max(18px, env(safe-area-inset-left));
      }
      .pb-acc__brand { margin-bottom: 24px; }
      .pb-acc__heading { font-size: 34px; }
      .pb-account-btn { height: 50px; }
    }
    @media (max-width: 360px) {
      .pb-acc__heading { font-size: 30px; }
      .pb-acc__tab { font-size: 19px; }
      .pb-acc__sub { font-size: 14px; }
    }

    /* Tablet landscape and desktop: hero plus angled panel */
    @media (min-width: 900px) and (min-height: 561px) {
      .pb-acc__hero { display: flex; }
      .pb-acc__panel {
        width: 480px;
        padding:
          max(48px, env(safe-area-inset-top))
          max(56px, env(safe-area-inset-right))
          max(48px, env(safe-area-inset-bottom))
          88px;
        border-left: 0;
        clip-path: polygon(56px 0, 100% 0, 100% 100%, 0 100%);
      }
    }
    @media (min-width: 1400px) and (min-height: 561px) {
      .pb-acc__panel { width: 540px; }
    }

    /* Phones in landscape and any short window: compact two-column layout */
    @media (orientation: landscape) and (max-height: 560px) {
      .pb-acc__hero {
        display: flex;
        padding: 20px 28px 20px max(28px, env(safe-area-inset-left));
      }
      .pb-acc__wordmark { font-size: min(26vh, 104px, 11vw); }
      .pb-acc__tagline { display: none; }
      .pb-acc__rule { margin-top: 14px; }

      .pb-acc__panel {
        width: clamp(340px, 48vw, 460px);
        justify-content: flex-start;
        padding:
          max(14px, env(safe-area-inset-top))
          max(20px, env(safe-area-inset-right))
          max(14px, env(safe-area-inset-bottom))
          24px;
        border-left: 1px solid var(--pb-line);
        clip-path: none;
      }
      .pb-acc__brand, .pb-acc__sub, .pb-acc__foot { display: none; }
      .pb-acc__tabs { margin-top: auto; margin-bottom: 12px; }
      .pb-acc__tab { font-size: 20px; min-height: 0; padding-bottom: 8px; }
      .pb-acc__heading { font-size: 28px; margin-bottom: 12px; }
      .pb-acc__group { margin-bottom: 10px; }
      .pb-acc__label { margin-bottom: 4px; font-size: 12px; }
      .pb-acc__field { height: 42px; }
      .pb-acc__peek { width: 44px; }
      .pb-account-btn { height: 44px; margin-top: 4px; font-size: 20px; }
      .pb-account-error { margin-top: 10px; padding: 8px 12px; font-size: 13px; }
      .pb-acc__panel > :last-child { margin-bottom: auto; }
    }
    /* Very narrow landscape: form only */
    @media (orientation: landscape) and (max-height: 560px) and (max-width: 639px) {
      .pb-acc__hero { display: none; }
      .pb-acc__panel { width: 100%; }
    }

    @media (prefers-reduced-motion: reduce) {
      .pb-acc__panel { animation: none; }
      .pb-account-btn, .pb-acc__field { transition: none; }
    }
  `;
  document.head.appendChild(style);
}

const ICON_USER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>`;
const ICON_MAIL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="m3.5 6.5 8.5 7 8.5-7"/></svg>`;
const ICON_LOCK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="1.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>`;
const ICON_EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>`;
const ICON_EYE_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A16.6 16.6 0 0 0 2 12s3.5 7 10 7c1.5 0 2.9-.4 4.1-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>`;

const ICON_INSTALL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/></svg>`;

export function showAccountScreen(): Promise<AccountSession> {
  ensureStyles();

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "pb-acc";

    overlay.innerHTML = `
      <div class="pb-acc__bg"></div>
      <div class="pb-acc__shade"></div>

      <section class="pb-acc__hero" aria-hidden="true">
        <h1 class="pb-acc__wordmark" aria-label="PB Labs"><span class="pb-acc__wm-pb">PB</span><span class="pb-acc__wm-labs">Labs</span></h1>
        <div class="pb-acc__rule"></div>
        <p class="pb-acc__tagline">Experience the legendary PBLabs FPS action directly in your browser—no downloads required!</p>
      </section>

      <main class="pb-acc__panel">
        <div class="pb-acc__brand">
          <span class="pb-acc__brand-mark">PB</span>
          <span class="pb-acc__brand-name">Labs</span>
          <span class="pb-acc__brand-tag">0.0.4</span>
        </div>

        <div class="pb-acc__tabs" role="tablist" aria-label="Account mode">
          <button class="pb-acc__tab" id="pb-acc-tab-login" role="tab" type="button" aria-selected="true">Sign in</button>
          <button class="pb-acc__tab" id="pb-acc-tab-register" role="tab" type="button" aria-selected="false">Create account</button>
        </div>

        <h2 class="pb-acc__heading" id="pb-auth-main-title">Welcome back</h2>
        <p class="pb-acc__sub" id="pb-auth-sub-title">Sign in with your username and password.</p>

        <div class="pb-acc__group">
          <label class="pb-acc__label" for="pb-acc-username">Username</label>
          <div class="pb-acc__field">
            <span class="pb-acc__icon">${ICON_USER}</span>
            <input class="pb-account-input" id="pb-acc-username" type="text" autocomplete="username" maxlength="16" placeholder="Your username" spellcheck="false" autocapitalize="off" />
          </div>
        </div>

        <div class="pb-acc__group" id="pb-acc-email-group" hidden>
          <label class="pb-acc__label" for="pb-acc-email">Email</label>
          <div class="pb-acc__field">
            <span class="pb-acc__icon">${ICON_MAIL}</span>
            <input class="pb-account-input" id="pb-acc-email" type="email" autocomplete="email" maxlength="255" placeholder="you@example.com" spellcheck="false" autocapitalize="off" />
          </div>
        </div>

        <div class="pb-acc__group">
          <label class="pb-acc__label" for="pb-acc-password">Password</label>
          <div class="pb-acc__field">
            <span class="pb-acc__icon">${ICON_LOCK}</span>
            <input class="pb-account-input" id="pb-acc-password" type="password" autocomplete="current-password" maxlength="64" placeholder="At least 6 characters" />
            <button class="pb-acc__peek" id="pb-acc-peek" type="button" aria-label="Show password">${ICON_EYE}</button>
          </div>
        </div>

        <button class="pb-account-btn" id="pb-acc-submit" type="button">Sign in</button>
        <button class="pb-account-btn pb-account-btn--install" id="pb-acc-install" type="button" hidden>${ICON_INSTALL}<span>Install Application</span></button>
        <div class="pb-acc__install-hint" id="pb-acc-install-hint" role="status" hidden></div>

        <div class="pb-account-error" id="pb-acc-error" role="alert"></div>

        <div class="pb-acc__foot">Pull the Trigger, Push Beyond the Limits.</div>
      </main>
    `;

    document.body.appendChild(overlay);

    // Suppress the browser context menu only while the account screen is open.
    // This does not block mouse button events used by game controls elsewhere.
    const protectionController = new AbortController();

    overlay.addEventListener(
      "contextmenu",
      (event) => {
        event.preventDefault();
      },
      { capture: true, signal: protectionController.signal }
    );

    // Discourage common DevTools / view-source shortcuts while this screen is active.
    // Browser-level menus and external DevTools access cannot be disabled by page code.
    window.addEventListener(
      "keydown",
      (event) => {
        const key = event.key.toLowerCase();
        const devtoolsShortcut =
          event.key === "F12" ||
          (event.ctrlKey && event.shiftKey && ["i", "j", "c"].includes(key)) ||
          (event.ctrlKey && key === "u");

        if (devtoolsShortcut) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      { capture: true, signal: protectionController.signal }
    );

    let mode: "login" | "register" = "login";
    const tabLogin = overlay.querySelector<HTMLButtonElement>("#pb-acc-tab-login")!;
    const tabRegister = overlay.querySelector<HTMLButtonElement>("#pb-acc-tab-register")!;
    const submitBtn = overlay.querySelector<HTMLButtonElement>("#pb-acc-submit")!;
    const peekBtn = overlay.querySelector<HTMLButtonElement>("#pb-acc-peek")!;
    const usernameInput = overlay.querySelector<HTMLInputElement>("#pb-acc-username")!;
    const emailGroup = overlay.querySelector<HTMLElement>("#pb-acc-email-group")!;
    const emailInput = overlay.querySelector<HTMLInputElement>("#pb-acc-email")!;
    const passwordInput = overlay.querySelector<HTMLInputElement>("#pb-acc-password")!;
    const errorBox = overlay.querySelector<HTMLElement>("#pb-acc-error")!;
    const mainTitle = overlay.querySelector<HTMLElement>("#pb-auth-main-title")!;
    const subTitle = overlay.querySelector<HTMLElement>("#pb-auth-sub-title")!;
    const installBtn = overlay.querySelector<HTMLButtonElement>("#pb-acc-install")!;
    const installHintBox = overlay.querySelector<HTMLElement>("#pb-acc-install-hint")!;

    function setMode(next: "login" | "register"): void {
      mode = next;
      const isLogin = next === "login";
      tabLogin.setAttribute("aria-selected", String(isLogin));
      tabRegister.setAttribute("aria-selected", String(!isLogin));
      mainTitle.textContent = isLogin ? "Welcome back" : "Create your account";
      subTitle.textContent = isLogin
        ? "Sign in with your username and password."
        : "Pick a username and register to start playing.";
      submitBtn.textContent = isLogin ? "Sign in" : "Create account";
      passwordInput.autocomplete = isLogin ? "current-password" : "new-password";
      emailGroup.hidden = isLogin;
      if (isLogin) emailInput.value = "";
      hideError();
    }

    function showError(message: string): void {
      errorBox.textContent = message;
      errorBox.classList.add("visible");
    }

    function hideError(): void {
      errorBox.classList.remove("visible");
    }

    tabLogin.addEventListener("click", () => setMode("login"));
    tabRegister.addEventListener("click", () => setMode("register"));

    peekBtn.addEventListener("click", () => {
      const showing = passwordInput.type === "text";
      passwordInput.type = showing ? "password" : "text";
      peekBtn.innerHTML = showing ? ICON_EYE : ICON_EYE_OFF;
      peekBtn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
    });

    async function submit(): Promise<void> {
      hideError();
      const username = usernameInput.value.trim();
      const email = emailInput.value.trim();
      const password = passwordInput.value;

      if (!/^[a-zA-Z0-9_]{4,16}$/.test(username)) {
        showError("Username must be 4-16 characters (letters, numbers, _)");
        return;
      }
      if (password.length < 6) {
        showError("Password must be at least 6 characters long");
        return;
      }
      if (mode === "register" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showError("Please enter a valid email address");
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = "Authenticating...";

      try {
        const result = mode === "login"
          ? await loginAccount(username, password)
          : await registerAccount(username, password, email);

        protectionController.abort();
        offInstall();
        overlay.remove();
        resolve({ token: tokenToBytes(result.token), username: result.nickname });
      } catch (err) {
        const message = err instanceof AccountApiError ? err.message : "Connection failed with the authentication server.";
        showError(message);
        submitBtn.disabled = false;
        submitBtn.textContent = mode === "login" ? "Sign in" : "Create account";
      }
    }

    submitBtn.addEventListener("click", () => void submit());
    // PWA: the button exists on iOS / Android only and goes away once the app is installed
    const syncInstall = (): void => {
      installBtn.hidden = !canOfferInstall();
      if (installBtn.hidden) installHintBox.hidden = true;
    };
    syncInstall();
    const offInstall = onInstallChange(syncInstall);
    installBtn.addEventListener("click", () => {
      void promptInstall().then((r) => {
        if (r === "manual") {
          installHintBox.textContent = installHint();
          installHintBox.hidden = false;
        } else syncInstall();
      });
    });
    for (const input of [usernameInput, emailInput, passwordInput]) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void submit();
      });
    }

    // Keep the focused field visible when the on-screen keyboard opens.
    for (const input of [usernameInput, emailInput, passwordInput]) {
      input.addEventListener("focus", () => {
        setTimeout(() => input.scrollIntoView({ block: "center", behavior: "smooth" }), 300);
      });
    }

    // Only auto-focus with a mouse/keyboard; on touch it would pop the keyboard open immediately.
    if (window.matchMedia("(pointer: fine)").matches) {
      setTimeout(() => usernameInput.focus(), 100);
    }
  });
}