/**
 * MarketerTwin — Facebook automation content script (v3).
 *
 *  PRECISE POSITIONING: every armed click saves five ways to find the target —
 *  a stable CSS selector (id / data-testid / name / placeholder / aria+tag /
 *  href / class-chain), the element's index path from <body>, a human hint
 *  (aria-label, visible text, role), the viewport x/y AND the document x/y.
 *  At play time the target is re-found fresh and scrolled into view; recorded
 *  coordinates are only the last-resort fallback.
 *
 *  MAPPER: arm one step at a time (click / scroll / write / wait / image-wait /
 *  loop), click the place on Facebook, set its timing. The live list reorders
 *  (↑↓), deletes (✕) and EDITS (✎): fix x/y, selector, hint text, wait
 *  seconds — or 🎯 re-pick the position straight from the page.
 *
 *  SETTINGS (⚙ in the mapper, mirrored in the Studio): default after-delay,
 *  cursor speed, visual cursor on/off, block armed clicks on/off, image-wait
 *  seconds. Stored in Chrome (settings.automation) — no backend anywhere.
 *
 *  VISUAL CURSOR: drawn pointer glides to every target, presses with a ripple,
 *  shows typing/scrolling/waiting bubbles — in element mode (animated locally)
 *  and cursor mode (driven by mt-cursor messages from the background, in sync
 *  with real debugger input events).
 */

(() => {
  if (window.__marketerTwinFb) return;
  window.__marketerTwinFb = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const AUTO_DEFAULTS = {
    defaultDelay: 1, cursorSpeed: 'normal', visualCursor: true,
    blockArmedClicks: true, imageWaitSec: 40,
  };
  const SPEED_MS = { slow: 700, normal: 420, fast: 200 };
  const auto = { ...AUTO_DEFAULTS };

  function sendBg(msg) {
    return new Promise((resolve) => {
      try { chrome.runtime.sendMessage(msg, (res) => resolve(res || {})); } catch { resolve({}); }
    });
  }

  async function loadAutoSettings() {
    const res = await sendBg({ type: 'tb-settings-get' });
    Object.assign(auto, AUTO_DEFAULTS, (res && res.settings && res.settings.automation) || {});
  }

  // ------------------------------------------------------------------ utils

  function attr(el, name) {
    try { return (el.getAttribute && el.getAttribute(name)) || ''; } catch { return ''; }
  }

  /** most stable selector we can build, in priority order */
  function selectorFor(el) {
    if (!el || el === document.body || el === document.documentElement) return 'body';
    if (el.id) return `#${CSS.escape(el.id)}`;
    const testid = attr(el, 'data-testid');
    if (testid) return `[data-testid="${CSS.escape(testid)}"]`;
    const tag = el.tagName.toLowerCase();
    const name = attr(el, 'name');
    if (name) return `${tag}[name="${CSS.escape(name)}"]`;
    const ph = attr(el, 'placeholder');
    if (ph) return `${tag}[placeholder="${CSS.escape(ph)}"]`;
    const aria = attr(el, 'aria-label');
    if (aria) return `${tag}[aria-label="${CSS.escape(aria)}"]`;
    if (tag === 'a' && el.href && !el.href.startsWith('javascript:')) {
      return `a[href="${CSS.escape(el.getAttribute('href') || '')}"]`;
    }
    const parts = [];
    let node = el;
    let guard = 0;
    while (node && node !== document.body && guard < 8) {
      guard += 1;
      if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
      let part = node.tagName.toLowerCase();
      const stable = [...(node.classList || [])]
        .filter((c) => c.length >= 4 && c.length <= 28 && !/^x[0-9a-z]{4,}$/i.test(c))
        .slice(0, 2);
      if (stable.length) part += '.' + stable.map((c) => CSS.escape(c)).join('.');
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ') || tag;
  }

  /** child-index path from <body> — survives class/attr churn entirely */
  function pathOf(el) {
    const path = [];
    let node = el;
    while (node && node !== document.body && path.length < 14) {
      const parent = node.parentElement;
      if (!parent) break;
      path.unshift([...parent.children].indexOf(node));
      node = parent;
    }
    return path;
  }

  function elementFromPath(path) {
    let node = document.body;
    for (const idx of (path || [])) {
      if (!node || !node.children || !node.children[idx]) return null;
      node = node.children[idx];
    }
    return node && node !== document.body ? node : null;
  }

  function hintFor(el) {
    return {
      aria: attr(el, 'aria-label'),
      text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
      role: attr(el, 'role'),
      tag: el.tagName.toLowerCase(),
      testid: attr(el, 'data-testid'),
      name: attr(el, 'name'),
      placeholder: attr(el, 'placeholder'),
    };
  }

  /** everything worth remembering about a position, in one object */
  function describe(el, ev) {
    const r = el.getBoundingClientRect();
    const x = ev ? ev.clientX : Math.round(r.left + r.width / 2);
    const y = ev ? ev.clientY : Math.round(r.top + r.height / 2);
    return {
      sel: selectorFor(el),
      path: pathOf(el),
      hint: hintFor(el),
      x: Math.round(x),
      y: Math.round(y),
      docX: Math.round(x + window.scrollX),
      docY: Math.round(y + window.scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  }

  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }

  /** re-find a step's element with the full fallback chain */
  function findStepElement(step) {
    const trySel = (sel) => { try { return sel ? document.querySelector(sel) : null; } catch { return null; } };
    let el = trySel(step.sel);
    if (el) return el;
    const hint = step.hint || {};
    if (hint.testid) { el = trySel(`[data-testid="${CSS.escape(hint.testid)}"]`); if (el) return el; }
    if (hint.aria) { el = trySel(`[aria-label="${CSS.escape(hint.aria)}"]`); if (el) return el; }
    if (hint.name) { el = trySel(`[name="${CSS.escape(hint.name)}"]`); if (el) return el; }
    if (hint.placeholder) { el = trySel(`[placeholder="${CSS.escape(hint.placeholder)}"]`); if (el) return el; }
    if (step.path && step.path.length) { el = elementFromPath(step.path); if (el) return el; }
    if (hint.text) {
      const wanted = hint.text.toLowerCase();
      for (const c of document.querySelectorAll(hint.tag || '*')) {
        if (c.children.length > 4) continue;
        const t = (c.innerText || c.textContent || '').trim().toLowerCase();
        if (t && (t === wanted || (t.length < 80 && t.includes(wanted)))) return c;
      }
    }
    return null;
  }

  function setText(el, text) {
    el.focus();
    if (el.isContentEditable) {
      document.execCommand('selectAll', false, null);
      const ok = document.execCommand('insertText', false, text);
      if (!ok) {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
      }
      return;
    }
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findComposeBox() {
    const sel = 'div[role="textbox"][contenteditable="true"], div[contenteditable="true"][aria-label], textarea[aria-label]';
    return [...document.querySelectorAll(sel)].find((b) => b.offsetParent !== null) || null;
  }

  function scrollToPercent(pct, smooth) {
    const target = document.scrollingElement || document.documentElement;
    const max = target.scrollHeight - target.clientHeight;
    target.scrollTo({ top: Math.max(0, Math.round(max * (pct / 100))), behavior: smooth ? 'smooth' : 'auto' });
  }

  function scrollPercentNow() {
    const t = document.scrollingElement || document.documentElement;
    const max = t.scrollHeight - t.clientHeight;
    return max > 0 ? Math.round((t.scrollTop / max) * 100) : 0;
  }

  // ---------------------------------------------------------- visual cursor

  const cursor = (() => {
    let root = null;
    let bubble = null;
    let pos = { x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) };
    let raf = 0;

    function ensure() {
      if (root && document.body.contains(root)) return;
      root = document.createElement('div');
      root.id = 'mt-cursor';
      root.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:26px;height:26px;margin:-2px 0 0 -3px;filter:drop-shadow(0 2px 6px rgba(0,0,0,.55));transition:none';
      root.innerHTML = `
        <svg width="26" height="26" viewBox="0 0 24 24">
          <path d="M4 2 L4 19 L8.6 15.2 L11.4 21.4 L14.2 20.1 L11.4 14 L17.5 13.6 Z"
                fill="#ffffff" stroke="#111827" stroke-width="1.4"/>
        </svg>`;
      bubble = document.createElement('div');
      bubble.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;background:#111827ee;color:#e5e7eb;font:11px/1.4 system-ui,sans-serif;border:1px solid #4f8cff;border-radius:99px;padding:3px 10px;opacity:0;transition:opacity .18s;white-space:nowrap';
      document.body.appendChild(root);
      document.body.appendChild(bubble);
      place();
    }

    function place() {
      if (!root) return;
      root.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
      bubble.style.transform = `translate(${pos.x + 18}px, ${pos.y + 16}px)`;
    }

    function show() { ensure(); root.style.opacity = '1'; }
    function hide() { if (root) { root.style.opacity = '0'; bubble.style.opacity = '0'; bubble._on = false; } }

    function moveTo(x, y, ms = 420) {
      ensure();
      cancelAnimationFrame(raf);
      const from = { ...pos };
      const t0 = performance.now();
      return new Promise((resolve) => {
        const step = (now) => {
          const t = Math.min(1, (now - t0) / Math.max(60, ms));
          const e = t * t * (3 - 2 * t);
          pos = { x: Math.round(from.x + (x - from.x) * e), y: Math.round(from.y + (y - from.y) * e) };
          place();
          if (t < 1) raf = requestAnimationFrame(step); else resolve();
        };
        raf = requestAnimationFrame(step);
      });
    }

    function press() {
      ensure();
      const ring = document.createElement('div');
      ring.style.cssText = `position:fixed;left:0;top:0;z-index:2147483646;pointer-events:none;width:34px;height:34px;margin:-17px 0 0 -17px;border:2px solid #4f8cff;border-radius:50%;transform:translate(${pos.x}px, ${pos.y}px) scale(.4);opacity:.95;transition:transform .35s ease-out, opacity .35s ease-out`;
      document.body.appendChild(ring);
      requestAnimationFrame(() => {
        ring.style.transform = `translate(${pos.x}px, ${pos.y}px) scale(1.5)`;
        ring.style.opacity = '0';
      });
      setTimeout(() => ring.remove(), 420);
      root.style.scale = '0.82';
      setTimeout(() => { root.style.scale = '1'; }, 130);
    }

    function label(text, ms = 900) {
      ensure();
      bubble.textContent = text;
      bubble._on = true;
      bubble.style.opacity = '1';
      place();
      clearTimeout(bubble._t);
      bubble._t = setTimeout(() => { bubble.style.opacity = '0'; bubble._on = false; }, ms);
    }

    return { show, hide, moveTo, press, label };
  })();

  // ---------------------------------------------------------------- recorder

  const rec = {
    active: false, mode: 'branding', steps: [], armed: null, overlay: null,
    pendingWrite: null, repick: null, editing: null, showSettings: false,
  };

  function stepLabel(s) {
    if (s.type === 'click') return (s.hint && (s.hint.text || s.hint.aria)) || s.sel || 'click';
    if (s.type === 'write') return `write: ${(s.text || '').slice(0, 30)}`;
    if (s.type === 'scroll') return `scroll → ${s.pct}%`;
    if (s.type === 'wait') return s.imageWait ? 'image-pick wait' : `wait ${(s.ms || 0) / 1000}s`;
    if (s.type === 'loopStart') return '🔁 loop START';
    if (s.type === 'loopEnd') return '🔁 loop END';
    return s.type;
  }

  const btnCss = 'padding:6px 9px;background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:6px;cursor:pointer;font-size:12px';
  const inpCss = 'padding:4px 6px;background:#0b1220;color:#e5e7eb;border:1px solid #374151;border-radius:5px;font-size:12px';

  function renderRecorder() {
    if (!rec.overlay) return;
    const p = rec.overlay;
    const hintTxt = rec.repick != null
      ? `🎯 RE-PICK armed for step ${rec.repick + 1}: click the NEW place on Facebook.`
      : rec.armed
        ? `ARMED: click the place on Facebook to save this ${rec.armed.toUpperCase()} step.`
        : 'Pick what to save next, then click the place on Facebook. Normal clicks pass through.';
    p.innerHTML = `
      <div id="mt-rec-head" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;cursor:move;user-select:none">
        <b style="color:#60a5fa">● MAPPING — ${rec.mode.toUpperCase()}</b>
        <span>
          <button data-act="settings" style="${btnCss};padding:3px 8px">⚙</button>
          <span style="margin-left:6px">${rec.steps.length} step(s)</span>
        </span>
      </div>
      <div style="font-size:11px;color:#9ca3af;margin-bottom:8px;min-height:16px">${esc(hintTxt)}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        <button data-arm="click">🖱 Click</button>
        <button data-arm="scroll">🖱 Scroll</button>
        <button data-arm="write">✍ Write</button>
        <button data-act="wait">⏱ Wait</button>
        <button data-act="imgwait">🖼 Image wait</button>
        <button data-act="loop">🔁 Loop mark</button>
      </div>
      <div id="mt-rec-steps" style="max-height:190px;overflow-y:auto;margin:8px 0;display:flex;flex-direction:column;gap:4px"></div>
      <div id="mt-rec-form"></div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <button data-act="undo" style="flex:1">↩ Undo</button>
        <button data-act="stop" style="flex:2;background:#dc2626;color:#fff;font-weight:600">⏹ Stop & Save</button>
      </div>`;
    p.querySelectorAll('button').forEach((b) => {
      if (!b.style.background) b.style.cssText = btnCss;
      if (b.dataset.arm) b.onclick = () => {
        rec.repick = null;
        rec.armed = rec.armed === b.dataset.arm ? null : b.dataset.arm;
        renderRecorder();
      };
      if (b.dataset.act === 'settings') b.onclick = () => { rec.showSettings = !rec.showSettings; renderSettings(); };
      if (b.dataset.act === 'wait') b.onclick = () => simpleForm('Wait seconds', 'number', '2', (v) => pushStep({ type: 'wait', ms: Math.max(0.5, Number(v) || 2) * 1000, delayAfter: 0.4 }));
      if (b.dataset.act === 'imgwait') b.onclick = () => pushStep({ type: 'wait', ms: 0, imageWait: true, delayAfter: 0.5 });
      if (b.dataset.act === 'loop') b.onclick = () => {
        const open = rec.steps.filter((s) => s.type === 'loopStart').length > rec.steps.filter((s) => s.type === 'loopEnd').length;
        pushStep({ type: open ? 'loopEnd' : 'loopStart', delayAfter: 0.3 });
      };
      if (b.dataset.act === 'undo') b.onclick = () => { rec.steps.pop(); renderRecorder(); };
      if (b.dataset.act === 'stop') b.onclick = () => stopRecording(true);
      if (b.dataset.arm === rec.armed) b.style.cssText = `${btnCss};background:#2563eb;border-color:#2563eb;color:#fff`;
    });
    const list = p.querySelector('#mt-rec-steps');
    rec.steps.forEach((s, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:5px;background:#0b1220;border:1px solid #1f2937;border-radius:6px;padding:4px 6px;font-size:11.5px';
      row.innerHTML = `<b style="color:#60a5fa;min-width:16px">${i + 1}</b>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(stepLabel(s))}">${esc(stepLabel(s))}</span>
        <label style="color:#9ca3af">after<input data-i="${i}" class="mt-delay" type="number" step="0.5" min="0" max="300" value="${s.delayAfter != null ? s.delayAfter : auto.defaultDelay}" style="width:52px;padding:2px 4px;background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:4px;margin:0 2px">s</label>`;
      const mk = (txt, fn, title) => {
        const b = document.createElement('button');
        b.textContent = txt; b.title = title || '';
        b.style.cssText = 'padding:2px 6px;background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:4px;cursor:pointer;font-size:11px';
        b.onclick = fn;
        return b;
      };
      row.appendChild(mk('✎', () => { rec.editing = rec.editing === i ? null : i; rec.showSettings = false; renderRecorder(); renderEditor(); }, 'edit this step'));
      if (s.type === 'click' || s.type === 'write') {
        row.appendChild(mk('🎯', () => { rec.repick = i; rec.armed = null; renderRecorder(); }, 're-pick position from the page'));
      }
      row.appendChild(mk('↑', () => { if (i > 0) { [rec.steps[i - 1], rec.steps[i]] = [rec.steps[i], rec.steps[i - 1]]; renderRecorder(); } }, 'move earlier'));
      row.appendChild(mk('↓', () => { if (i < rec.steps.length - 1) { [rec.steps[i + 1], rec.steps[i]] = [rec.steps[i], rec.steps[i + 1]]; renderRecorder(); } }, 'move later'));
      row.appendChild(mk('✕', () => { rec.steps.splice(i, 1); if (rec.editing === i) rec.editing = null; renderRecorder(); }, 'delete step'));
      list.appendChild(row);
      if (rec.editing === i) {
        const ed = document.createElement('div');
        ed.id = 'mt-edit-slot';
        list.appendChild(ed);
      }
    });
    list.querySelectorAll('.mt-delay').forEach((inp) => {
      inp.onchange = () => { rec.steps[Number(inp.dataset.i)].delayAfter = Math.max(0, Number(inp.value) || 0); };
    });
    if (rec.editing != null) renderEditor();
    if (rec.showSettings) renderSettings();
    makeDraggable(p);
  }

  /** inline editor for one step — fix position, timing, text, selector, hint */
  function renderEditor() {
    const slot = rec.overlay && rec.overlay.querySelector('#mt-edit-slot');
    if (!slot || rec.editing == null) return;
    const s = rec.steps[rec.editing];
    if (!s) return;
    const num = (labelText, key, val, stepV) => `<label style="font-size:11px;color:#9ca3af">${labelText}
      <input data-k="${key}" type="number" step="${stepV || 1}" value="${val != null ? val : ''}" style="${inpCss};width:76px"></label>`;
    const txt = (labelText, key, val, w) => `<label style="font-size:11px;color:#9ca3af;display:block;margin-top:4px">${labelText}
      <input data-k="${key}" type="text" value="${esc(val)}" style="${inpCss};width:${w || 100}%"></label>`;
    let fields = '';
    if (s.type === 'click' || s.type === 'write') {
      fields = num('x', 'x', s.x) + num('y', 'y', s.y) + num('after s', 'delayAfter', s.delayAfter, 0.5)
        + txt('hint text (to re-find it)', 'hintText', (s.hint && s.hint.text) || '')
        + txt('selector (advanced)', 'sel', s.sel || '');
      if (s.type === 'write') {
        fields += `<label style="font-size:11px;color:#9ca3af;display:block;margin-top:4px">text to write ({description}/{group} ok)
          <textarea data-k="text" rows="2" style="${inpCss};width:100%">${esc(s.text || '')}</textarea></label>`;
      }
    } else if (s.type === 'scroll') {
      fields = num('scroll %', 'pct', s.pct) + num('after s', 'delayAfter', s.delayAfter, 0.5);
    } else if (s.type === 'wait') {
      fields = s.imageWait
        ? num('image-pick seconds (play-time default)', 'imageSec', auto.imageWaitSec)
        : num('wait seconds', 'ms', (s.ms || 1000) / 1000, 0.5) + num('after s', 'delayAfter', s.delayAfter, 0.5);
    } else {
      fields = num('after s', 'delayAfter', s.delayAfter, 0.5);
    }
    slot.innerHTML = `<div style="background:#101a2e;border:1px solid #2563eb;border-radius:8px;padding:8px;margin-top:4px">
      <div style="display:flex;gap:6px;flex-wrap:wrap">${fields}</div>
      <div style="display:flex;gap:6px;margin-top:6px">
        <button data-ed="ok" style="flex:1;padding:4px;background:#2563eb;color:#fff;border:none;border-radius:5px;cursor:pointer">✔ Apply</button>
        <button data-ed="no" style="flex:1;padding:4px;background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:5px;cursor:pointer">Close</button>
      </div></div>`;
    slot.querySelector('[data-ed="no"]').onclick = () => { rec.editing = null; renderRecorder(); };
    slot.querySelector('[data-ed="ok"]').onclick = () => {
      const val = (k) => { const el = slot.querySelector(`[data-k="${k}"]`); return el ? el.value : undefined; };
      const n = (k, fb) => { const v = Number(val(k)); return Number.isFinite(v) ? v : fb; };
      if (s.type === 'click' || s.type === 'write') {
        s.x = n('x', s.x); s.y = n('y', s.y);
        s.delayAfter = n('delayAfter', s.delayAfter);
        const ht = val('hintText'); if (ht != null) { s.hint = s.hint || {}; s.hint.text = ht; }
        const sel = val('sel'); if (sel != null) s.sel = sel;
        if (s.type === 'write') { const t = val('text'); if (t != null) s.text = t; }
      } else if (s.type === 'scroll') {
        s.pct = Math.max(0, Math.min(100, n('pct', s.pct)));
        s.delayAfter = n('delayAfter', s.delayAfter);
      } else if (s.type === 'wait') {
        if (s.imageWait) { auto.imageWaitSec = Math.max(5, n('imageSec', auto.imageWaitSec)); saveAutoSettings(); }
        else { s.ms = Math.max(0.5, n('ms', (s.ms || 1000) / 1000)) * 1000; s.delayAfter = n('delayAfter', s.delayAfter); }
      } else {
        s.delayAfter = n('delayAfter', s.delayAfter);
      }
      rec.editing = null;
      renderRecorder();
    };
  }

  /** ⚙ mapper settings — persisted to settings.automation in Chrome storage */
  function renderSettings() {
    const box = rec.overlay && rec.overlay.querySelector('#mt-rec-form');
    if (!box) return;
    if (!rec.showSettings) { box.innerHTML = ''; return; }
    box.innerHTML = `<div style="background:#101a2e;border:1px solid #374151;border-radius:8px;padding:8px">
      <b style="font-size:12px;color:#60a5fa">⚙ Automation settings</b>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
        <label style="font-size:11px;color:#9ca3af">default after-delay s
          <input id="mt-set-delay" type="number" step="0.5" min="0" max="120" value="${auto.defaultDelay}" style="${inpCss};width:64px"></label>
        <label style="font-size:11px;color:#9ca3af">cursor speed
          <select id="mt-set-speed" style="${inpCss}">
            <option value="slow" ${auto.cursorSpeed === 'slow' ? 'selected' : ''}>slow</option>
            <option value="normal" ${auto.cursorSpeed === 'normal' ? 'selected' : ''}>normal</option>
            <option value="fast" ${auto.cursorSpeed === 'fast' ? 'selected' : ''}>fast</option>
          </select></label>
        <label style="font-size:11px;color:#9ca3af">image-wait s
          <input id="mt-set-img" type="number" min="5" max="300" value="${auto.imageWaitSec}" style="${inpCss};width:64px"></label>
      </div>
      <label style="font-size:11.5px;color:#e5e7eb;display:block;margin-top:6px"><input type="checkbox" id="mt-set-visual" ${auto.visualCursor ? 'checked' : ''}> show the moving visual cursor</label>
      <label style="font-size:11.5px;color:#e5e7eb;display:block"><input type="checkbox" id="mt-set-block" ${auto.blockArmedClicks ? 'checked' : ''}> block armed clicks from actually firing (safer mapping)</label>
      <button id="mt-set-save" style="${btnCss};margin-top:8px;width:100%;background:#2563eb;color:#fff;border:none">Save settings</button>
    </div>`;
    box.querySelector('#mt-set-save').onclick = () => {
      auto.defaultDelay = Math.max(0, Number(box.querySelector('#mt-set-delay').value) || 0);
      auto.cursorSpeed = box.querySelector('#mt-set-speed').value;
      auto.imageWaitSec = Math.max(5, Number(box.querySelector('#mt-set-img').value) || 40);
      auto.visualCursor = box.querySelector('#mt-set-visual').checked;
      auto.blockArmedClicks = box.querySelector('#mt-set-block').checked;
      saveAutoSettings();
      rec.showSettings = false;
      renderRecorder();
    };
  }

  function saveAutoSettings() {
    sendBg({ type: 'tb-settings-set', patch: { automation: { ...auto } } });
  }

  function simpleForm(labelText, kind, initial, onOk) {
    const box = rec.overlay.querySelector('#mt-rec-form');
    box.innerHTML = `<label style="font-size:11px;color:#9ca3af">${esc(labelText)}</label>
      <input id="mt-f-v" type="${kind}" value="${esc(initial)}" style="${inpCss};width:100%;margin:2px 0">
      <div style="display:flex;gap:6px;margin-top:4px">
        <button id="mt-f-ok" style="flex:1;padding:5px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer">Add step</button>
        <button id="mt-f-no" style="flex:1;padding:5px;background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:6px;cursor:pointer">Cancel</button>
      </div>`;
    box.querySelector('#mt-f-no').onclick = () => { box.innerHTML = ''; rec.pendingWrite = null; };
    box.querySelector('#mt-f-ok').onclick = () => {
      const v = box.querySelector('#mt-f-v').value;
      box.innerHTML = '';
      onOk(v);
    };
    box.querySelector('#mt-f-v').focus();
  }

  function onClickCapture(ev) {
    if (!rec.active) return;
    if (rec.overlay && rec.overlay.contains(ev.target)) return;
    const arming = rec.armed || rec.repick != null;
    if (!arming) return;                            // normal clicks pass through
    if (auto.blockArmedClicks || rec.repick != null) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    const el = ev.target;
    const at = { x: ev.clientX, y: ev.clientY };
    if (auto.visualCursor) cursor.moveTo(at.x, at.y, 160).then(() => cursor.press());

    if (rec.repick != null) {                       // 🎯 re-pick an existing step
      const s = rec.steps[rec.repick];
      if (s) Object.assign(s, describe(el, ev));
      rec.repick = null;
      renderRecorder();
      return;
    }
    if (rec.armed === 'click') {
      pushStep({ type: 'click', ...describe(el, ev) });
    } else if (rec.armed === 'scroll') {
      pushStep({ type: 'scroll', pct: scrollPercentNow(), x: at.x, y: at.y, docY: Math.round(at.y + window.scrollY) });
    } else if (rec.armed === 'write') {
      rec.pendingWrite = describe(el, ev);
      rec.armed = null;
      renderRecorder();
      writeForm();
    }
  }

  /** asks for the text of a write step whose target was just captured */
  function writeForm() {
    const box = rec.overlay && rec.overlay.querySelector('#mt-rec-form');
    if (!box || !rec.pendingWrite) return;
    box.innerHTML = `<label style="font-size:11px;color:#9ca3af">Text to write ({description} / {group} fill at play time)</label>
      <textarea id="mt-f-v" rows="3" style="${inpCss};width:100%;margin:2px 0"></textarea>
      <div style="display:flex;gap:6px;margin-top:4px">
        <button id="mt-f-ok" style="flex:1;padding:5px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer">Add step</button>
        <button id="mt-f-no" style="flex:1;padding:5px;background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:6px;cursor:pointer">Cancel</button>
      </div>`;
    box.querySelector('#mt-f-no').onclick = () => { box.innerHTML = ''; rec.pendingWrite = null; };
    box.querySelector('#mt-f-ok').onclick = () => {
      const v = box.querySelector('#mt-f-v').value;
      box.innerHTML = '';
      if (v.trim()) pushStep({ type: 'write', ...rec.pendingWrite, text: v });
      rec.pendingWrite = null;
    };
    box.querySelector('#mt-f-v').focus();
  }

  function pushStep(step) {
    if (step.delayAfter == null) step.delayAfter = auto.defaultDelay;
    rec.steps.push(step);
    rec.armed = null;
    renderRecorder();
  }

  function makeDraggable(panel) {
    const head = panel.querySelector('#mt-rec-head');
    if (!head || head._drag) return;
    head._drag = true;
    head.addEventListener('mousedown', (ev) => {
      if (ev.target.tagName === 'BUTTON') return;
      const startX = ev.clientX; const startY = ev.clientY;
      const r = panel.getBoundingClientRect();
      const move = (e) => {
        panel.style.left = `${Math.max(0, Math.min(innerWidth - 120, r.left + e.clientX - startX))}px`;
        panel.style.top = `${Math.max(0, Math.min(innerHeight - 60, r.top + e.clientY - startY))}px`;
        panel.style.bottom = 'auto';
      };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  async function startRecording(mode) {
    await loadAutoSettings();
    rec.active = true; rec.mode = mode || 'branding'; rec.steps = [];
    rec.armed = null; rec.repick = null; rec.editing = null; rec.showSettings = false;
    if (!rec.overlay) {
      rec.overlay = document.createElement('div');
      rec.overlay.id = 'mt-recorder-panel';
      rec.overlay.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;background:#111827f2;color:#e5e7eb;font:13px/1.5 system-ui,sans-serif;border:1px solid #374151;border-radius:12px;padding:12px 14px;width:380px;box-shadow:0 12px 40px rgba(0,0,0,.5)';
      document.body.appendChild(rec.overlay);
    }
    document.addEventListener('click', onClickCapture, true);
    renderRecorder();
  }

  function stopRecording(save) {
    rec.active = false; rec.armed = null; rec.repick = null; rec.editing = null;
    document.removeEventListener('click', onClickCapture, true);
    const steps = rec.steps.slice();
    if (rec.overlay) { rec.overlay.remove(); rec.overlay = null; }
    if (save && steps.length) {
      sendBg({ type: 'mt-flow-recorded', mode: rec.mode, steps });
    }
  }

  // ------------------------------------------------------------------ player

  const play = { running: false, cancel: false };
  const progress = (msg, extra) => { sendBg({ type: 'mt-progress', msg, ...extra }); };
  const delayOf = (step, speed) => {
    const sec = step.delayAfter != null ? step.delayAfter : ((step.delayMs || 0) / 1000);
    return Math.round((sec * 1000) / Math.max(0.25, speed));
  };

  async function waitForElement(step, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const el = findStepElement(step);
      if (el) return el;
      await sleep(400);
    }
    return null;
  }

  function expandLoops(steps, groups) {
    const list = (groups && groups.length) ? groups : [''];
    const out = [];
    let buf = null;
    for (const step of steps) {
      if (step.type === 'loopStart') { buf = []; continue; }
      if (step.type === 'loopEnd') {
        for (const g of list) for (const inner of (buf || [])) out.push({ ...inner, group: g });
        buf = null; continue;
      }
      if (buf) buf.push(step); else out.push({ ...step, group: '' });
    }
    return out;
  }

  async function runFlow(flow, options) {
    if (play.running) { progress('already playing — stop it first'); return { ok: false }; }
    play.running = true; play.cancel = false;
    const opts = {
      speed: 1, imageWaitSec: auto.imageWaitSec, elementTimeoutSec: 20,
      description: '', groups: [], scrollPct: null,
      visualCursor: auto.visualCursor, cursorSpeedMs: SPEED_MS[auto.cursorSpeed] || 420,
      ...options,
    };
    const visual = opts.visualCursor !== false;
    const moveMs = Math.round((opts.cursorSpeedMs || SPEED_MS[auto.cursorSpeed] || 420) / Math.max(0.25, opts.speed));
    const steps = expandLoops(flow.steps || [], opts.groups);
    if (visual) cursor.show();

    try {
      for (let i = 0; i < steps.length; i += 1) {
        if (play.cancel) { progress('stopped by user', { cancelled: true }); return { ok: false, cancelled: true, step: i }; }
        const step = steps[i];
        progress(`step ${i + 1}/${steps.length}: ${step.type} — ${stepLabel(step)}${step.group ? ` (${step.group})` : ''}`, { stepIndex: i });

        if (step.type === 'click') {
          const el = await waitForElement(step, opts.elementTimeoutSec * 1000);
          if (!el) throw new Error(`element not found: ${(step.hint && (step.hint.text || step.hint.aria)) || step.sel}`);
          el.scrollIntoView({ block: 'center' });
          await sleep(220);
          const c = centerOf(el);
          if (visual) { await cursor.moveTo(c.x, c.y, moveMs); cursor.press(); await sleep(140); }
          el.click();
        } else if (step.type === 'write') {
          const text = String(step.text || '')
            .replace(/\{description\}/g, opts.description || '')
            .replace(/\{group\}/g, step.group || '');
          const el = (step.sel && await waitForElement(step, opts.elementTimeoutSec * 1000)) || findComposeBox();
          if (!el) throw new Error('no text box found to write into');
          el.scrollIntoView({ block: 'center' });
          await sleep(160);
          const c = centerOf(el);
          if (visual) {
            await cursor.moveTo(c.x, c.y, moveMs);
            cursor.press();
            cursor.label(`typing ${text.length} chars…`, 1200);
            await sleep(160);
          }
          setText(el, text);
        } else if (step.type === 'wait') {
          const ms = step.imageWait ? opts.imageWaitSec * 1000 : (step.ms || 1000);
          if (visual) cursor.label(step.imageWait ? `pick your image — ${opts.imageWaitSec}s` : `waiting ${(ms / 1000).toFixed(1)}s`, Math.min(ms, 4000));
          progress(step.imageWait ? `waiting ${opts.imageWaitSec}s for you to pick the image…` : `waiting ${(ms / 1000).toFixed(1)}s…`, { stepIndex: i });
          const until = Date.now() + ms;
          while (Date.now() < until) { if (play.cancel) break; await sleep(Math.min(500, until - Date.now())); }
        } else if (step.type === 'scroll') {
          const pct = opts.scrollPct != null ? opts.scrollPct : step.pct;
          if (visual) cursor.label(`scrolling to ${pct}%`, 900);
          scrollToPercent(pct, true);
          await sleep(700);
        } else if (step.type !== 'loopStart' && step.type !== 'loopEnd') {
          progress(`skipping ${step.type}`, { stepIndex: i });
        }
        await sleep(delayOf(step, opts.speed));
      }
      progress('flow complete ✔', { done: true });
      return { ok: true };
    } catch (err) {
      progress(`FAILED: ${err.message}`, { error: err.message });
      return { ok: false, error: err.message };
    } finally {
      play.running = false;
      if (visual) cursor.hide();
    }
  }

  /** fresh position lookup for the background's cursor/coordinate engine */
  function stepPosition(step) {
    const base = { found: false, scrollY: Math.round(window.scrollY), vw: innerWidth, vh: innerHeight };
    const el = findStepElement(step);
    if (!el) return base;
    el.scrollIntoView({ block: 'center' });
    const c = centerOf(el);
    return { ...base, found: true, x: c.x, y: c.y };
  }

  // ----------------------------------------------------------------- monitor

  function scanPosts() {
    const out = [];
    const seen = new Set();
    const nodes = document.querySelectorAll('div[role="article"], div[data-pagelet*="FeedUnit"], div.userContentWrapper');
    for (const node of nodes) {
      const text = (node.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 500);
      if (!text || text.length < 12) continue;
      let h = 2166136261;
      for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
      const id = String(h >>> 0);
      if (seen.has(id)) continue;
      seen.add(id);
      const lines = text.split(' · ').slice(0, 3);
      out.push({ id, snippet: text.slice(0, 220), author: (lines[0] || '').slice(0, 80), at: new Date().toISOString() });
      if (out.length >= 40) break;
    }
    return { url: location.href, title: document.title, posts: out, scannedAt: new Date().toISOString() };
  }

  // ------------------------------------------------------------------ router

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'mt-rec-start':
        startRecording(msg.mode);
        sendResponse({ ok: true });
        return false;
      case 'mt-rec-stop':
        stopRecording(false);
        sendResponse({ ok: true });
        return false;
      case 'mt-rec-status':
        sendResponse({ recording: rec.active, steps: rec.steps.length, mode: rec.mode });
        return false;
      case 'mt-play':
        runFlow(msg.flow, msg.options).then((r) => sendResponse(r));
        return true;
      case 'mt-play-stop':
        play.cancel = true;
        sendResponse({ ok: true });
        return false;
      case 'mt-step-pos':
        sendResponse(stepPosition(msg.step || {}));
        return false;
      // visual-cursor commands from the background (cursor/coordinate mode)
      case 'mt-cursor':
        (async () => {
          if (msg.op === 'show') cursor.show();
          else if (msg.op === 'hide') cursor.hide();
          else if (msg.op === 'move') await cursor.moveTo(msg.x, msg.y, msg.ms || 420);
          else if (msg.op === 'press') cursor.press();
          else if (msg.op === 'label') cursor.label(msg.text || '', msg.ms || 900);
          sendResponse({ ok: true });
        })();
        return true;
      case 'mt-paste-desc': {
        const box = findComposeBox();
        if (!box) { sendResponse({ ok: false, error: 'no open compose box found' }); return false; }
        setText(box, msg.text || '');
        sendResponse({ ok: true });
        return false;
      }
      case 'mt-monitor-scan':
        sendResponse(scanPosts());
        return false;
      default:
        return false;
    }
  });
})();
