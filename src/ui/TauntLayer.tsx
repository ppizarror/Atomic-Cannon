/**
 * In-game taunt speech bubbles (Chatter). The controller publishes the active bubbles
 * each frame — one per speaking tank, as `"Name: line"` in scene fractions so they
 * track the camera. This just renders one ANCHORED <Tooltip> per bubble (title =
 * speaker, content = line); the Tooltip points its tail at the tank and keeps itself on
 * screen. The only local concern is turning the scene fractions into viewport pixels,
 * which `useSceneSize` provides.
 */
import {tauntBubbles} from './store';
import {Tooltip} from './Tooltip';
import {useSceneSize} from './useSceneSize';

// Split `"Ice: I'm melting…"` into title `"Ice:"` and content `"I'm melting…"`.
function splitTaunt(text: string): {title: string; content: string} {
  const i = text.indexOf(':');
  if (i < 0) return {title: '', content: text};
  return {title: text.slice(0, i + 1), content: text.slice(i + 1).trim()};
}

export function TauntLayer() {
  const {w, h} = useSceneSize();
  const bubbles = tauntBubbles.value;
  if (!bubbles.length || !w) return null;
  return (
    <>
      {bubbles.map(b => {
        const {title, content} = splitTaunt(b.text);
        return (
          <Tooltip
            key={b.id}
            title={title}
            content={content}
            anchorX={b.xPct * w + 4}
            anchorY={b.yPct * h - 24}
            fade={b.alpha}
            tipPosition="down"
            animated
          />
        );
      })}
    </>
  );
}
