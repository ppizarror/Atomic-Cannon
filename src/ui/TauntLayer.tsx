/**
 * In-game taunt speech bubbles (Chatter). The controller publishes the active bubbles
 * each frame — one per speaking tank, as `"Name: line"` positioned in screen fractions
 * so they track the camera — and this overlay renders each as the shared green
 * <Tooltip> (title = the speaker's name, content = the taunt line). The bubble's tail
 * is fixed near its left edge and anchored to the tank's centre, so the bubble grows
 * up-and-right from the tank. Pure presentation: timing / selection lives in the engine.
 */
import {tauntBubbles} from './store';
import {Tooltip} from './Tooltip';

// Split `"Ice: I'm melting…"` into title `"Ice:"` and content `"I'm melting…"`.
function splitTaunt(text: string): {title: string; content: string} {
  const i = text.indexOf(':');
  if (i < 0) return {title: '', content: text};
  return {title: text.slice(0, i + 1), content: text.slice(i + 1).trim()};
}

export function TauntLayer() {
  const bubbles = tauntBubbles.value;
  if (!bubbles.length) return null;
  return (
    <div class="taunt-layer">
      {bubbles.map(b => {
        const {title, content} = splitTaunt(b.text);
        return (
          <div
            key={b.id}
            class="taunt-bubble"
            style={{left: `${b.xPct * 100}%`, top: `${b.yPct * 100}%`, opacity: b.alpha}}
          >
            <Tooltip title={title} content={content} tailLeft="14px" animated />
          </div>
        );
      })}
    </div>
  );
}
