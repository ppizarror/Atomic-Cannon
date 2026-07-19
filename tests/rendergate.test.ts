/**
 * Logic tests for the present-on-demand render gate.
 * Run: npx tsx tests/rendergate.test.ts
 */
import {RenderGate} from '../src/game/RenderGate';

let pass = 0, fail = 0;

function ok(name: string, cond: boolean, extra = '') {
    if (cond) {
        pass++;
        console.log(`  ✓ ${name}`);
    } else {
        fail++;
        console.log(`  ✗ ${name}  ${extra}`);
    }
}

const GRACE = 1500;
// A time far past any grace window, so cosmetic-grace never keeps a frame alive
// unless we explicitly interact just before it.
const T = 1_000_000;

console.log('RenderGate');

// 1. Starts dirty → the very first frame always draws.
{
    const g = new RenderGate(GRACE);
    ok('first frame draws', g.shouldRedraw(false, false, T) === true);
}

// 2. After the initial draw, an idle scene stops redrawing.
{
    const g = new RenderGate(GRACE);
    ok('frame 0 draws (initial dirty)', g.shouldRedraw(false, false, T) === true);
    ok('idle frame skips', g.shouldRedraw(false, false, T) === false);
    ok('stays skipped while idle', g.shouldRedraw(false, false, T) === false);
}

// 3. markDirty() resumes drawing on the next frame.
{
    const g = new RenderGate(GRACE);
    g.shouldRedraw(false, false, T);
    g.shouldRedraw(false, false, T); // settle to idle
    ok('idle', g.shouldRedraw(false, false, T) === false);
    g.markDirty(T);
    ok('markDirty forces a redraw', g.shouldRedraw(false, false, T) === true);
}

// 4. Gameplay motion always draws, and leaves exactly one trailing frame when it stops.
{
    const g = new RenderGate(GRACE);
    g.shouldRedraw(false, false, T);
    g.shouldRedraw(false, false, T);   // reach idle
    ok('idle before motion', g.shouldRedraw(false, false, T) === false);
    ok('animating draws', g.shouldRedraw(false, true, T) === true);
    ok('animating keeps drawing', g.shouldRedraw(false, true, T) === true);
    ok('motion just stopped → trailing frame draws', g.shouldRedraw(false, false, T) === true);
    ok('then idle again', g.shouldRedraw(false, false, T) === false);
}

// 5. Cosmetic grace: after an interaction, idle frames keep drawing until the window
//    elapses, then go static.
{
    const g = new RenderGate(GRACE);
    g.shouldRedraw(false, false, T);
    g.shouldRedraw(false, false, T);   // idle baseline (far past grace)
    g.markDirty(10_000);                                    // interact at t=10s
    ok('interaction frame draws', g.shouldRedraw(false, false, 10_000) === true);
    ok('within grace still draws', g.shouldRedraw(false, false, 10_000 + 1000) === true);
    ok('within grace edge still draws', g.shouldRedraw(false, false, 10_000 + 1499) === true);
    ok('past grace goes static', g.shouldRedraw(false, false, 10_000 + 1600) === false);
}

// 6. Paused: draws only on explicit invalidation; gameplay motion and grace are ignored.
{
    const g = new RenderGate(GRACE);
    g.shouldRedraw(false, false, T);                        // consume the initial dirty
    ok('paused + clean skips even if animating', g.shouldRedraw(true, true, T) === false);
    g.markDirty(T);
    ok('paused draws the invalidated frame', g.shouldRedraw(true, false, T) === true);
    ok('paused then clean skips again', g.shouldRedraw(true, false, T) === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
