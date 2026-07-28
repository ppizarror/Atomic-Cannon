/**
 * In-game taunt speech bubbles (Chatter). The controller publishes the active bubbles
 * each frame — one per speaking tank, as `"Name: line"` in scene fractions so they
 * track the camera. This just renders one ANCHORED <Tooltip> per bubble (title =
 * speaker, content = line); the Tooltip points its tail at the tank and keeps itself
 * inside the scene.
 *
 * Everything lives in a scene-sized clip box (`.taunt-layer`, painted-contained) rather
 * than free-floating over the viewport: on a world wider than the view, a speaker the
 * camera has scrolled past is OFF the scene, and its bubble must slide off and crop with
 * it instead of parking at the screen edge. Paint containment also makes the box the
 * containing block for the bubbles' fixed anchors, so their coordinates — and the
 * `bounds` they clamp into — are scene-relative, which is the space the fractions from
 * `useSceneSize` are already in.
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
  const {x, y, w, h} = useSceneSize();
  const bubbles = tauntBubbles.value;
  if (!bubbles.length || !w) return null;
  return (
    <div
      class="taunt-layer"
      style={{left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`}}
    >
      {bubbles.map(b => {
        const {title, content} = splitTaunt(b.text);
        return (
          <Tooltip
            key={b.id}
            title={title}
            content={content}
            anchorX={b.xPct * w + 4}
            anchorY={b.yPct * h - 24}
            bounds={{left: 0, right: w}}
            fade={b.alpha}
            tipPosition="down"
            animated
          />
        );
      })}
    </div>
  );
}
