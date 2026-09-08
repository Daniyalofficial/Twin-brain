/**
 * CURSOR MATH — pure helpers for the pyautogui-style coordinate replay.
 *
 * A Chrome extension can never move the OS mouse pointer (that is an
 * OS-level privilege; pyautogui runs outside the browser). The closest real
 * thing inside Chrome is synthesising TRUE input events at saved viewport
 * coordinates via the debugger channel — the page receives genuine
 * mouseMoved/mousePressed/mouseWheel events, hover and focus follow, and the
 * clicks land exactly where you recorded them. These helpers compute the
 * glide path and wheel deltas; mt.js dispatches them.
 */

/**
 * A straight glide path from `from` to `to` (exclusive of `from`, inclusive
 * of `to`), eased so the movement accelerates then settles — like a hand.
 * @returns {Array<{x:number,y:number}>}
 */
export function interpolatePath(from, to, steps = 8) {
  const out = [];
  const n = Math.max(1, steps | 0);
  for (let i = 1; i <= n; i += 1) {
    const t = i / n;
    const ease = t * t * (3 - 2 * t); // smoothstep
    out.push({
      x: Math.round(from.x + (to.x - from.x) * ease),
      y: Math.round(from.y + (to.y - from.y) * ease),
    });
  }
  return out;
}

/**
 * Wheel deltas (pixels) that scroll a document from one scroll-percent to
 * another, chunked so the page renders between events like a real wheel.
 * @returns {Array<number>} positive = scroll down
 */
export function wheelDeltas(fromPct, toPct, scrollHeight, clientHeight, chunk = 240) {
  const max = Math.max(0, (scrollHeight || 0) - (clientHeight || 0));
  if (!max) return [];
  const pixels = ((toPct - fromPct) / 100) * max;
  const whole = Math.trunc(pixels / chunk) * chunk;
  const rest = Math.trunc(pixels - whole);
  const deltas = [];
  for (let done = 0; Math.abs(done) < Math.abs(whole); done += Math.sign(pixels) * chunk) {
    deltas.push(Math.sign(pixels) * chunk);
  }
  if (rest) deltas.push(rest);
  return deltas;
}

/**
 * Expand loopStart/loopEnd segments across the group list ({group} aware),
 * shared by the coordinate player. Content-script player keeps its own copy
 * (content scripts cannot import modules).
 */
export function expandLoopSteps(steps, groups) {
  const list = (groups && groups.length) ? groups : [''];
  const out = [];
  let buf = null;
  for (const step of steps) {
    if (step.type === 'loopStart') { buf = []; continue; }
    if (step.type === 'loopEnd') {
      for (const group of list) for (const inner of (buf || [])) out.push({ ...inner, group });
      buf = null;
      continue;
    }
    if (buf) buf.push(step); else out.push({ ...step, group: '' });
  }
  return out;
}

/**
 * resolveStepTarget — where should the cursor actually go?
 *
 * Positioning accuracy comes from preferring the FRESH element location (the
 * content script re-found the element and scrolled it into view) over the
 * stale recorded one. Fallback chain:
 *   1. fresh element center (info.found)
 *   2. recorded document coords (docY) minus current scroll
 *   3. recorded viewport coords, clamped inside the viewport
 */
export function resolveStepTarget(step, info, viewport) {
  const vw = (info && info.vw) || (viewport && viewport.w) || 1280;
  const vh = (info && info.vh) || (viewport && viewport.h) || 800;
  if (info && info.found) {
    return { x: Math.round(info.x), y: Math.round(info.y), source: 'element' };
  }
  let x = step.x != null ? step.x : vw / 2;
  let y = step.y != null ? step.y : vh / 2;
  if (step.docY != null && info && typeof info.scrollY === 'number') {
    y = step.docY - info.scrollY;
  }
  x = Math.max(4, Math.min(vw - 4, x));
  y = Math.max(4, Math.min(vh - 4, y));
  return { x: Math.round(x), y: Math.round(y), source: 'saved' };
}
