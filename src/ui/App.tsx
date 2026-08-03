/**
 * UI root. Switches between screens via the `screen` signal, then layers the always-mounted
 * overlays (net banners, bubbles, pause/quit/help, depot, HUD readouts, flash, gates) over
 * whichever is showing. The game canvas (Pixi) renders underneath, independent of this tree.
 */
import {useRef, useState, useEffect} from 'preact/hooks';
import {useSignalEffect} from '@preact/signals';
import {
  screen,
  screenFlash,
  screenFlashColor,
  flying,
  jetFuel,
  hudWave,
  hudWaveStrength,
  paused,
  showFramerate,
  fps,
  showFrameCount,
  frameCount,
  warStandings,
  loading,
} from './store';
import {hexToRgb} from '../math/color';
import {strings, fmt} from '../i18n';
import {BmpText} from './BmpText';
import {Hud} from './Hud';
import {InstallHint} from './InstallHint';
import {DepotPanel} from './DepotPanel';
import {TauntLayer} from './TauntLayer';
import {PauseMenu} from './PauseMenu';
import {QuitConfirm} from './QuitConfirm';
import {HelpOverlay} from './HelpOverlay';
import {MainMenu} from './MainMenu';
import {LoadingScreen} from './LoadingScreen';
import {About} from './About';
import {Manual} from './Manual';
import {Changelog} from './Changelog';
import {HighScores} from './HighScores';
import {Settings} from './Settings';
import {PlaySetup} from './PlaySetup';
import {Network} from './Network';
import {NetStatusBanner} from './NetStatusBanner';
import {NetChat} from './NetChat';
import {WarStandings} from './WarStandings';

// ==========================================================================
// OVERLAYS & HUD WIDGETS
// ==========================================================================

/**
 * Full-viewport flash for big blasts — sits above everything, incl. the HUD.
 * It inherits the bomb's colour, mixed toward white by intensity: a blinding
 * near-white at the peak that recedes to the weapon's hue (uranium red, …).
 */
function ScreenFlash() {
  const a = screenFlash.value;
  if (a <= 0.001) return null;
  let {r: cr, g: cg, b: cb} = hexToRgb(screenFlashColor.value);
  // Saturate toward the dominant hue so a warm tint reads vivid (uranium's light
  // orange → red-orange), not washed-out sepia — then mix toward white by intensity.
  const mx = Math.max(cr, cg, cb, 1);
  const sat = (ch: number) => (ch >= mx ? ch : ch * 0.5);
  cr = sat(cr);
  cg = sat(cg);
  cb = sat(cb);
  const w = Math.min(1, a * a); // whiter near the peak, hue shows as it fades
  const mix = (ch: number) => Math.round(ch + (255 - ch) * w);
  return (
    <div
      class="screen-flash"
      style={{background: `rgb(${mix(cr)},${mix(cg)},${mix(cb)})`, opacity: Math.min(1, a * 1.15)}}
    />
  );
}

/**
 * HUD shockwave ripple. The WebGL wave filter only warps the game scene sprite —
 * it can't reach the DOM HUD — so we mirror it here with an SVG displacement filter
 * applied to #ui-root, its scale animated from a strength-scaled peak down to 0 as a
 * damped ripple (~0.85s), fired in sync with each `compositor.shockwave`.
 */
function HudWave() {
  const disp = useRef<SVGFEDisplacementMapElement>(null);

  useSignalEffect(() => {
    const n = hudWave.value; // subscribe; bumped once per impact
    if (n === 0) return; // no impulse yet
    const el = disp.current;
    // Target the HUD elements themselves (NOT #ui-root): a filter on an ancestor
    // of a position:fixed panel changes its containing block and breaks its layout;
    // a filter on the fixed element itself leaves its own position untouched.
    const els = ['hud', 'battle-status'].map(id => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
    if (!el || !els.length) return;
    const peak = Math.min(34, 10 + hudWaveStrength.peek() * 6); // px of displacement
    const dur = 1200; // ms — ~matches the game wave lifetime
    let last = performance.now(),
      elapsed = 0;
    for (const e of els) e.style.filter = 'url(#hud-wave)';
    let raf = requestAnimationFrame(function tick(now) {
      const fdt = now - last;
      last = now;
      if (!paused.peek()) elapsed += fdt; // freeze the ripple while the sim is paused
      const t = Math.min(1, elapsed / dur);
      const env = 1 - t;
      const s = peak * env * env * Math.cos(t * Math.PI * 3.5); // damped ripple → 0
      el.setAttribute('scale', s.toFixed(2));
      if (t < 1) raf = requestAnimationFrame(tick);
      else {
        el.setAttribute('scale', '0');
        for (const e of els) e.style.filter = '';
      }
    });
    return () => {
      cancelAnimationFrame(raf);
      el.setAttribute('scale', '0');
      for (const e of els) e.style.filter = '';
    };
  });

  return (
    <svg width="0" height="0" style={{position: 'absolute'}} aria-hidden="true">
      <filter id="hud-wave" x="-15%" y="-15%" width="130%" height="130%">
        <feTurbulence type="fractalNoise" baseFrequency="0.012 0.028" numOctaves="2" seed="7" result="noise" />
        <feDisplacementMap
          ref={disp}
          in="SourceGraphic"
          in2="noise"
          scale="0"
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
    </svg>
  );
}

// FPS counter (More Graphics Options → Show Framerate) — top-right, in the game's outlined
// bitmap font.
function FramerateHud() {
  if (!showFramerate.value) return null;
  return (
    <div id="fps-hud">
      <BmpText font="beijing-16-out" text={fmt(strings.value.app.fps, {n: fps.value})} spacing={-1} />
    </div>
  );
}

// Frame counter (Show Framerate → Full).
function FrameCountHud() {
  if (!showFrameCount.value) return null;
  return (
    <div id="frame-hud">
      <BmpText font="beijing-16-out" text={fmt(strings.value.app.frame, {n: frameCount.value})} spacing={-1} />
    </div>
  );
}

// Jet-flight indicator: remaining fuel + a control hint while the human flies. Sits
// low-centre, clear of the top-left minimap / status text, in the game's bitmap font.
function FlightHud() {
  if (!flying.value) return null;
  return (
    <div class="flight-hud">
      <div class="flight-fuel">
        <BmpText
          font="beijing-20-out"
          text={fmt(strings.value.app.jetFuel, {s: jetFuel.value.toFixed(1)})}
          spacing={-1}
        />
      </div>
      <div class="flight-hint">
        <BmpText font="beijing-16-out" text={strings.value.app.flyHint} spacing={-1} />
      </div>
    </div>
  );
}

// ==========================================================================
// RESOLUTION GATE
// ==========================================================================

// Absolute floor below which even the compact mobile HUD can't be laid out — we
// cover everything with a brushed-steel notice asking the player to enlarge the
// window. Real phones clear this comfortably; narrow desktop windows and phones
// below MOBILE_W get the mobile HUD (see store MOBILE_W), not this gate.
const MIN_W = 320;
const MIN_H = 240;

// Full-screen "resolution too small" gate. Watches the viewport and, while it's under
// the minimum, covers the game (above every other layer) with a steel-plate notice.
function TooSmallOverlay() {
  const tooSmall = () => window.innerWidth < MIN_W || window.innerHeight < MIN_H;
  const [small, setSmall] = useState(tooSmall);
  const [size, setSize] = useState(() => ({w: window.innerWidth, h: window.innerHeight}));
  useEffect(() => {
    const onResize = () => {
      setSmall(tooSmall());
      setSize({w: window.innerWidth, h: window.innerHeight});
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  if (!small) return null;
  const a = strings.value.app;
  // All text is the game's bitmap fonts (ASCII 33..126, no wrapping) on the
  // `atomic/dialog.bmp` panel — same chrome as the Help overlay, no CSS text.
  return (
    <div class="overlay too-small">
      <div class="too-small-card dialog-frame">
        <div class="too-small-title">
          <BmpText font="bazouk-28" text={a.tooSmallTitle} />
        </div>
        <div class="too-small-msg">
          <BmpText font="beijing-16-out" text={a.tooSmallLead} />
        </div>
        <div class="too-small-msg">
          <BmpText font="beijing-16-out" text={fmt(a.tooSmallSize, {w: MIN_W, h: MIN_H})} />
        </div>
        <div class="too-small-sub">
          <BmpText font="arial-14-out" text={a.tooSmallEnlarge} />
        </div>
        <div class="too-small-size">
          <BmpText font="arial-14-out" text={fmt(a.tooSmallCurrent, {w: size.w, h: size.h})} />
        </div>
      </div>
    </div>
  );
}

// Portrait-orientation nudge: the battlefield is landscape, so on a phone held
// upright we cover everything with a steel plate + an animated "rotate" phone.
// Visibility is pure CSS (an orientation media query on `.rotate-gate`), so it flips
// the instant the device turns — no JS/resize listener, and it's always in the DOM.
function RotateOverlay() {
  const a = strings.value.app;
  return (
    <div class="rotate-gate">
      <div class="rotate-card dialog-frame">
        <div class="rotate-phone" aria-hidden="true" />
        <div class="rotate-title">
          <BmpText font="bazouk-28" text={a.rotateTitle} />
        </div>
        <div class="rotate-msg">
          <BmpText font="beijing-16-out" text={a.rotateHint} />
        </div>
      </div>
    </div>
  );
}

// ==========================================================================
// SCREEN ROUTER
// ==========================================================================

function CurrentScreen() {
  switch (screen.value) {
    case 'battle':
      // Between battles the HUD is hidden and the standings screen takes its place.
      return warStandings.value ? <WarStandings /> : <Hud />;
    case 'menu':
      return <MainMenu />;
    case 'about':
      return <About />;
    case 'manual':
      return <Manual />;
    case 'changelog':
      return <Changelog />;
    case 'highscores':
      return <HighScores />;
    case 'settings':
      return <Settings />;
    case 'setup':
      return <PlaySetup />;
    case 'network':
      return <Network />;
    default:
      return <Hud />;
  }
}

// ==========================================================================
// ROOT COMPONENT
// ==========================================================================

export function App() {
  return (
    <>
      <CurrentScreen />
      <NetStatusBanner />
      <NetChat />
      <TauntLayer />
      <PauseMenu />
      <QuitConfirm />
      <HelpOverlay />
      <DepotPanel />
      <FlightHud />
      <FramerateHud />
      <FrameCountHud />
      <ScreenFlash />
      <HudWave />
      {loading.value && <LoadingScreen />}
      <InstallHint />
      <RotateOverlay />
      <TooSmallOverlay />
    </>
  );
}
