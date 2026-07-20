/**
 * UI root. Switches between screens via the `screen` signal. The game canvas
 * (Pixi) renders underneath, independent of this tree; screens overlay it.
 *
 * Battle HUD is built; menu / settings / depot are scaffolded here so they slot
 * in as components without touching the game or the canvas.
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
} from './store';
import {hexToRgb} from '../math/color';
import {Button} from './Button';
import {BmpText} from './BmpText';
import {Hud} from './Hud';
import {DepotPanel} from './DepotPanel';
import {PauseMenu} from './PauseMenu';
import {HelpOverlay} from './HelpOverlay';
import {MainMenu} from './MainMenu';
import {About} from './About';
import {Settings} from './Settings';

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
    const els = ['hud', 'battle-status']
      .map(id => document.getElementById(id))
      .filter((e): e is HTMLElement => !!e);
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
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.012 0.028"
          numOctaves="2"
          seed="7"
          result="noise"
        />
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

// Jet-flight indicator: shows remaining fuel + controls while the human flies.
function FlightHud() {
  if (!flying.value) return null;
  return (
    <div class="flight-hud">
      <div class="flight-fuel">JET FUEL {jetFuel.value.toFixed(1)}s</div>
      <div class="flight-hint">◀ ▲ ▶ / A W D to fly · Space to cut engine</div>
    </div>
  );
}

// Minimum playable window. Below this the layout is too cramped to use, so we cover
// everything with a brushed-steel notice asking the player to enlarge the window
// rather than let the HUD/controls collapse.
const MIN_W = 768;
const MIN_H = 432;

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
  // All text is the game's bitmap fonts (ASCII 33..126, no wrapping) on the
  // `atomic/dialog.bmp` panel — same chrome as the Help overlay, no CSS text.
  return (
    <div class="overlay too-small">
      <div class="too-small-card dialog-frame">
        <div class="too-small-title">
          <BmpText font="bazouk-28" text="RESOLUTION TOO SMALL" />
        </div>
        <div class="too-small-msg">
          <BmpText font="beijing-16-out" text="Atomic Cannon needs a window of at least" />
        </div>
        <div class="too-small-msg">
          <BmpText font="beijing-16-out" text={`${MIN_W} x ${MIN_H} pixels to play.`} />
        </div>
        <div class="too-small-sub">
          <BmpText font="arial-14-out" text="Enlarge the window to continue." />
        </div>
        <div class="too-small-size">
          <BmpText font="arial-14-out" text={`Current:  ${size.w} x ${size.h}`} />
        </div>
      </div>
    </div>
  );
}

function Placeholder({
  title,
  backLabel,
  onBack,
}: {
  title: string;
  backLabel?: string;
  onBack?: () => void;
}) {
  return (
    <div class="overlay screen-overlay">
      <div class="screen-card">
        <h1>{title}</h1>
        <p>Coming soon.</p>
        <Button
          label={backLabel ?? 'Back to battle'}
          onClick={onBack ?? (() => (screen.value = 'battle'))}
        />
      </div>
    </div>
  );
}

function CurrentScreen() {
  switch (screen.value) {
    case 'battle':
      return <Hud />;
    case 'menu':
      return <MainMenu />;
    case 'about':
      return <About />;
    case 'settings':
      return <Settings />;
    case 'depot':
      return <Placeholder title="Weapons Depot" />;
    default:
      return <Hud />;
  }
}

export function App() {
  return (
    <>
      <CurrentScreen />
      <PauseMenu />
      <HelpOverlay />
      <DepotPanel />
      <FlightHud />
      <ScreenFlash />
      <HudWave />
      <TooSmallOverlay />
    </>
  );
}
