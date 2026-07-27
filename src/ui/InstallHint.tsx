/**
 * InstallHint — a small, dismissible "install for fullscreen" nudge, shown only on the
 * title screen and never again once dismissed (persisted to localStorage).
 *
 * Two paths, because the platforms differ:
 *  • Android / desktop Chromium fire `beforeinstallprompt`; we stash it and show a real
 *    one-tap INSTALL button that triggers the browser's native install flow.
 *  • iOS Safari has no such event (and no Fullscreen API / toolbar control in a tab), so
 *    the only route is manual — we show "Tap Share, then Add to Home Screen".
 */
import {signal} from '@preact/signals';
import {screen} from './store';
import {strings} from '../i18n';
import {BmpText} from './BmpText';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{outcome: 'accepted' | 'dismissed'}>;
}

const KEY = 'atomic.installDismissed';

function lsGet(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}
function lsDismiss(): void {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    /* private mode — hide for this session only */
  }
}

// Dismissed state as a signal so tapping ✕ (or a successful install) hides it at once.
const dismissed = signal(lsGet());
// The captured Android/Chromium install event (null until the browser offers it).
const deferred = signal<BeforeInstallPromptEvent | null>(null);

// iOS (incl. iPadOS reporting as Mac) AND Safari (not Chrome/Firefox/Edge on iOS, whose
// share sheets differ) AND not already installed. Evaluated once.
const iosEligible = (() => {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  const ua = navigator.userAgent;
  const iOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  const standalone =
    (navigator as {standalone?: boolean}).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  return iOS && safari && !standalone;
})();

// Touch device? Mouse desktops (incl. desktop Chrome, which ALSO fires
// beforeinstallprompt) play in-browser and shouldn't get the install nudge — so the
// hint is touch-only. `pointer: coarse` is independent of window size, so a small
// desktop window never triggers it.
const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

if (typeof window !== 'undefined') {
  // Chromium fires this when the PWA is installable; keep it to drive our own button.
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferred.value = e as BeforeInstallPromptEvent;
  });
  // Installed (either path) → never nag again.
  window.addEventListener('appinstalled', () => {
    deferred.value = null;
    dismissed.value = true;
    lsDismiss();
  });
}

// iOS "Share" glyph — a box with an up-arrow rising from it.
function ShareIcon() {
  return (
    <svg class="install-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.5v11" />
      <path d="M8 7l4-4 4 4" />
      <path d="M7 11H5.5A1.5 1.5 0 0 0 4 12.5v6A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 18.5 11H17" />
    </svg>
  );
}

// Generic "install / download to device" glyph for the Android path.
function InstallIcon() {
  return (
    <svg class="install-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v10" />
      <path d="M8 11l4 4 4-4" />
      <path d="M5 20h14" />
    </svg>
  );
}

export function InstallHint() {
  const canPrompt = deferred.value != null; // Android / desktop Chromium
  // Touch-only, on the title screen, not dismissed, and something to offer.
  if (!isTouch || dismissed.value || screen.value !== 'menu' || !(canPrompt || iosEligible))
    return null;
  const a = strings.value.app;
  const dismiss = () => {
    lsDismiss();
    dismissed.value = true;
  };
  return (
    <div class="install-hint" role="note">
      {canPrompt ? <InstallIcon /> : <ShareIcon />}
      <div class="install-text">
        <BmpText font="beijing-16-out" text={a.installTitle} spacing={-1} />
        <BmpText font="arial-14-out" text={canPrompt ? a.installAndroid : a.installBody} />
      </div>
      {canPrompt && (
        <button
          class="install-go"
          onClick={async () => {
            const e = deferred.value;
            if (!e) return;
            deferred.value = null; // the event is single-use
            await e.prompt();
            // On 'accepted' the appinstalled handler dismisses; on 'dismissed' leave the
            // hint's ✕ for the user (the browser won't re-offer the prompt).
          }}
        >
          <BmpText font="beijing-16-out" text={a.installAction} spacing={-1} />
        </button>
      )}
      <button class="install-x" aria-label="Dismiss" onClick={dismiss}>
        ✕
      </button>
    </div>
  );
}
