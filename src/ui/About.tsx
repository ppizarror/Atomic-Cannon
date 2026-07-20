/**
 * About / credits screen (the original's mode-8). Shows the game's `about.txt` story
 * over the `steel.jpg` backdrop, with a Back button. Reuses the metal card styling.
 */
import { useEffect, useState } from 'preact/hooks';
import { backToMenu } from './store';
import { BmpText } from './BmpText';
import { ClassicScrollbar } from './ClassicScrollbar';

export function About() {
  const [text, setText] = useState('');
  useEffect(() => {
    let ok = true;
    fetch('/assets/about.txt').then(r => r.text()).then(t => { if (ok) setText(t); }).catch(() => {});
    return () => { ok = false; };
  }, []);

  return (
    <div class="about-screen">
      <div class="about-card">
        <div class="about-head"><BmpText font="bazouk-28" text="ATOMIC CANNON" /></div>
        <div class="about-sub"><BmpText font="msans-14" text="v3.0  ·  a preservation port" tint="#c9d0d7" /></div>
        <ClassicScrollbar class="about-body">{text || 'Loading…'}</ClassicScrollbar>
        <button class="metal-btn about-back" onClick={backToMenu}>Back</button>
      </div>
    </div>
  );
}
