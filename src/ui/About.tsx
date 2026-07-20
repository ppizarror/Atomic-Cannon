/**
 * About / credits screen. Shows the game's `about.txt` story over the `steel.webp`
 * backdrop, with a Back button. Uses the shared <Modal> (dialog.bmp frame) — the same
 * dialog chrome as Help, so the two no longer look like different dialogs.
 */
import { useEffect, useState } from 'preact/hooks';
import { backToMenu } from './store';
import { BmpText } from './BmpText';
import { ClassicScrollbar } from './ClassicScrollbar';
import { Modal } from './Modal';

export function About() {
  const [text, setText] = useState('');
  useEffect(() => {
    let ok = true;
    fetch('/assets/about.txt').then(r => r.text()).then(t => { if (ok) setText(t); }).catch(() => {});
    return () => { ok = false; };
  }, []);

  return (
    <Modal backdrop="steel" width="min(680px, 92vw)" maxHeight="86vh" class="about-card">
      <div class="about-head"><BmpText font="bazouk-28" text="ATOMIC CANNON" /></div>
      <div class="about-sub"><BmpText font="msans-14" text="v3.0  ·  a preservation port" tint="#c9d0d7" /></div>
      <ClassicScrollbar class="about-body">{text || 'Loading…'}</ClassicScrollbar>
      <button class="metal-btn about-back" onClick={backToMenu}>Back</button>
    </Modal>
  );
}
