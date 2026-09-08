/**
 * MarketerTwin — Facebook automation content script.
 *
 * A pyautogui-style clicker, built the only way a Chrome extension can:
 * DOM-level. Instead of screen pixels it records CSS selector paths + human
 * hints (text, aria-labels), which survive page reloads far better than raw
 * coordinates — and it can WRITE text (descriptions) directly into Facebook's
 * React editors, scroll to a percentage, and wait out the 40-second image
 * picker while you choose the photo yourself.
 *
 * Two flow modes — BRANDING and META — each with its own saved positions,
 * sharing the same timing / write / post options. Flows support loop segments
 * for the share-to-groups cycle: share → search group → open → paste → post,
 * repeated for every group on your list.
 *
 * Also hosts the group monitor scraper: on request it snapshots the visible
 * posts of the current page so the background can diff and notify.
 */

(() => {
  if (window.__marketerTwinFb) return;
  window.__marketerTwinFb = true;

  // ------------------------------------------------------------------ utils

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function selectorFor(el) {
    if (!el || el === document.body || el === document.documentElement) return 'body';
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    let guard = 0;
    while (node && node !== document.body && guard < 8) {
      guard += 1;
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
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
    return parts.join(' > ');
  }

  function hintFor(el) {
    const aria = el.getAttribute && (el.getAttribute('aria-label') || '');
    const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    const role = el.getAttribute && el.getAttribute('role') || '';
    return { aria, text, role, tag: el.tagName.toLowerCase() };
  }

  /** Find an element by selector; fall back to its recorded human hint. */
  function findStepElement(step) {
    let el = null;
    try { el = step.sel ? document.querySelector(step.sel) : null; } catch { el = null; }
    if (el) return el;
    const hint = step.hint || {};
    if (hint.aria) {
      el = document.querySelector(`[aria-label="${CSS.escape(hint.aria)}"]`);
      if (el) return el;
    }
    if (hint.text) {
      const wanted = hint.text.toLowerCase();
      const candidates = document.querySelectorAll(hint.tag || '*');
      for (const c of candidates) {
        if (c.children.length > 4) continue;
        const t = (c.innerText || c.textContent || '').trim().toLowerCase();
        if (t && (t === wanted || (t.length < 80 && t.includes(wanted)))) return c;
      }
    }
    return null;
  }

  /** React-safe text injection: works on inputs, textareas and contenteditable
   *  editors (Facebook's compose boxes are contenteditable/lexical). */
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
    const boxes = [...document.querySelectorAll(sel)]
      .filter((b) => b.offsetParent !== null);
    return boxes[0] || null;
  }

  function scrollToPercent(pct, el) {
    const target = el || document.scrollingElement || document.documentElement;
    const max = target.scrollHeight - target.clientHeight;
    target.scrollTo({ top: Math.max(0, Math.round(max * (pct / 100))), behavior: 'smooth' });
  }

  // ---------------------------------------------------------------- recorder

  const rec = { active: false, paused: false, steps: [], mode: 'branding', lastAt: 0, overlay: null };

  function pushStep(step) {
    const now = Date.now();
    step.delayMs = rec.lastAt ? Math.min(30000, now - rec.lastAt) : 0;
    rec.lastAt = now;
    rec.steps.push(step);
    renderOverlay();
  }

  function onClickCapture(ev) {
    if (!rec.active || rec.paused) return;
    const el = ev.target;
    if (rec.overlay && rec.overlay.contains(el)) return;
    const step = {
      type: 'click', sel: selectorFor(el), hint: hintFor(el),
      x: ev.clientX, y: ev.clientY,
      at: new Date().toISOString(),
    };
    pushStep(step);
    flash(el);
  }

  function flash(el) {
    try {
      const old = el.style ? el.style.outline : '';
      if (el.style) el.style.outline = '3px solid #1877f2';
      setTimeout(() => { if (el.style) el.style.outline = old; }, 600);
    } catch { /* transient styling can fail on SVG etc. */ }
  }

  // ---------------------------------------------------------------- overlay

  function ensureOverlay() {
    if (rec.overlay && document.body.contains(rec.overlay)) return rec.overlay;
    const panel = document.createElement('div');
    panel.id = 'mt-recorder-panel';
    panel.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;background:#111827;color:#e5e7eb;font:13px/1.5 system-ui,sans-serif;border:1px solid #374151;border-radius:12px;padding:12px 14px;width:330px;box-shadow:0 12px 40px rgba(0,0,0,.5)';
    document.body.appendChild(panel);
    rec.overlay = panel;
    return panel;
  }

  function renderOverlay() {
    const panel = ensureOverlay();
    const loopIn = rec.steps.filter((s) => s.type === 'loopStart').length >
                   rec.steps.filter((s) => s.type === 'loopEnd').length;
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <b style="color:#60a5fa">● REC — ${rec.mode.toUpperCase()} flow</b>
        <span id="mt-stepcount">${rec.steps.length} steps</span>
      </div>
      <div style="font-size:11px;color:#9ca3af;margin-bottom:8px">
        Click anywhere on Facebook to record a position. Use the buttons to add waits, text-writing, scrolls and the group loop.
        ${loopIn ? '<span style="color:#fbbf24">Inside group loop 🔁</span>' : ''}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        <button id="mt-rec-pause" style="flex:1">${rec.paused ? '▶ Resume' : '⏸ Pause'}</button>
        <button id="mt-rec-wait" style="flex:1">⏱ Wait…</button>
        <button id="mt-rec-imgwait" style="flex:1">🖼 Image wait</button>
        <button id="mt-rec-write" style="flex:1">✍️ Write…</button>
        <button id="mt-rec-scroll" style="flex:1">🖱 Scroll…</button>
        <button id="mt-rec-loop" style="flex:1">${loopIn ? '🔁 Loop END' : '🔁 Loop START'}</button>
        <button id="mt-rec-undo" style="flex:1">↩ Undo</button>
        <button id="mt-rec-stop" style="flex:2;background:#dc2626;color:#fff;border-radius:6px">⏹ Stop & Save</button>
      </div>
      <div id="mt-rec-form" style="margin-top:8px"></div>
    `;
    panel.querySelectorAll('button').forEach((b) => {
      b.style.cssText += b.id === 'mt-rec-stop' ? ';padding:6px 8px;border:none;border-radius:6px;cursor:pointer;font-weight:600' :
        ';padding:6px 8px;background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:6px;cursor:pointer';
    });
    panel.querySelector('#mt-rec-pause').onclick = () => { rec.paused = !rec.paused; renderOverlay(); };
    panel.querySelector('#mt-rec-wait').onclick = () => askWait();
    panel.querySelector('#mt-rec-imgwait').onclick = () => pushStep({ type: 'wait', ms: 0, imageWait: true, label: 'image picker wait (set in options)' });
    panel.querySelector('#mt-rec-write').onclick = () => askWrite();
    panel.querySelector('#mt-rec-scroll').onclick = () => askScroll();
    panel.querySelector('#mt-rec-loop').onclick = () => {
      pushStep({ type: loopIn ? 'loopEnd' : 'loopStart' });
    };
    panel.querySelector('#mt-rec-undo').onclick = () => { rec.steps.pop(); renderOverlay(); };
    panel.querySelector('#mt-rec-stop').onclick = () => stopRecording(true);
  }

  function form(html, onOk) {
    const box = rec.overlay.querySelector('#mt-rec-form');
    box.innerHTML = html + `<div style="display:flex;gap:6px;margin-top:6px"><button id="mt-f-ok" style="flex:1;padding:5px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer">Add</button><button id="mt-f-no" style="flex:1;padding:5px;background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:6px;cursor:pointer">Cancel</button></div>`;
    box.querySelector('#mt-f-no').onclick = () => { box.innerHTML = ''; };
    box.querySelector('#mt-f-ok').onclick = () => { if (onOk(box) !== false) box.innerHTML = ''; renderOverlay(); };
    const input = box.querySelector('input, textarea');
    if (input) input.focus();
  }

  function askWait() {
    form('<label style="font-size:11px;color:#9ca3af">Wait seconds</label><input id="mt-f-sec" type="number" min="1" max="300" value="3" style="width:100%;padding:5px;background:#0b1220;color:#e5e7eb;border:1px solid #374151;border-radius:6px;margin-top:2px">',
      (box) => {
        const sec = Math.max(1, Number(box.querySelector('#mt-f-sec').value) || 3);
        pushStep({ type: 'wait', ms: sec * 1000, label: `wait ${sec}s` });
      });
  }

  function askWrite() {
    form('<label style="font-size:11px;color:#9ca3af">Text to write (use {description} / {group} placeholders — filled at play time)</label><textarea id="mt-f-text" rows="3" style="width:100%;padding:5px;background:#0b1220;color:#e5e7eb;border:1px solid #374151;border-radius:6px;margin-top:2px"></textarea><label style="font-size:11px;color:#9ca3af;margin-top:4px;display:block"><input id="mt-f-here" type="checkbox" checked> write into the box currently focused on the page (otherwise: last clicked element)</label>',
      (box) => {
        const text = box.querySelector('#mt-f-text').value;
        if (!text.trim()) return false;
        pushStep({ type: 'write', text, targetFocused: box.querySelector('#mt-f-here').checked });
      });
  }

  function askScroll() {
    form('<label style="font-size:11px;color:#9ca3af">Scroll to percent of page</label><input id="mt-f-pct" type="number" min="0" max="100" value="50" style="width:100%;padding:5px;background:#0b1220;color:#e5e7eb;border:1px solid #374151;border-radius:6px;margin-top:2px">',
      (box) => {
        const pct = Math.min(100, Math.max(0, Number(box.querySelector('#mt-f-pct').value) || 0));
        pushStep({ type: 'scroll', pct, label: `scroll ${pct}%` });
      });
  }

  function startRecording(mode) {
    rec.active = true; rec.paused = false; rec.steps = []; rec.mode = mode || 'branding'; rec.lastAt = 0;
    document.addEventListener('click', onClickCapture, true);
    renderOverlay();
  }

  function stopRecording(save) {
    rec.active = false;
    document.removeEventListener('click', onClickCapture, true);
    const steps = rec.steps.slice();
    if (rec.overlay) { rec.overlay.remove(); rec.overlay = null; }
    if (save && steps.length) {
      try {
        chrome.runtime.sendMessage({ type: 'mt-flow-recorded', mode: rec.mode, steps });
      } catch { /* context invalidated — steps are lost with the page anyway */ }
    }
  }

  // ------------------------------------------------------------------ player

  const play = { running: false, cancel: false };

  function progress(msg, extra) {
    try { chrome.runtime.sendMessage({ type: 'mt-progress', msg, ...extra }); } catch {}
  }

  async function waitForElement(step, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const el = findStepElement(step);
      if (el) return el;
      await sleep(400);
    }
    return null;
  }

  async function runFlow(flow, options) {
    if (play.running) { progress('already playing — stop it first'); return { ok: false }; }
    play.running = true; play.cancel = false;
    const opts = {
      speed: 1, imageWaitSec: 40, elementTimeoutSec: 20, description: '',
      groups: [], scrollPct: null, ...options,
    };
    const steps = flow.steps || [];

    // expand loop segments across the group list
    const expanded = [];
    let loopBuf = null;
    for (const step of steps) {
      if (step.type === 'loopStart') { loopBuf = []; continue; }
      if (step.type === 'loopEnd') {
        const groups = opts.groups.length ? opts.groups : [''];
        for (const group of groups) {
          for (const inner of loopBuf) expanded.push({ ...inner, group });
        }
        loopBuf = null;
        continue;
      }
      if (loopBuf) loopBuf.push(step); else expanded.push({ ...step, group: '' });
    }

    let lastWriteTarget = null;
    for (let i = 0; i < expanded.length; i += 1) {
      if (play.cancel) { play.running = false; return { ok: false, cancelled: true, step: i }; }
      const step = expanded[i];
      const delay = Math.round((step.delayMs || 0) / Math.max(0.25, opts.speed));
      if (delay > 0) await sleep(Math.min(delay, 20000));
      progress(`step ${i + 1}/${expanded.length}: ${step.type}${step.group ? ` (${step.group})` : ''}`, { stepIndex: i });

      try {
        if (step.type === 'click') {
          const el = await waitForElement(step, opts.elementTimeoutSec * 1000);
          if (!el) throw new Error(`element not found: ${step.hint && (step.hint.text || step.hint.aria) || step.sel}`);
          el.scrollIntoView({ block: 'center' });
          await sleep(150);
          el.click();
          lastWriteTarget = el;
        } else if (step.type === 'write') {
          let text = String(step.text || '');
          text = text.replace(/\{description\}/g, opts.description || '')
                     .replace(/\{group\}/g, step.group || '');
          const el = step.targetFocused
            ? (findComposeBox() || lastWriteTarget)
            : (await waitForElement(step, opts.elementTimeoutSec * 1000)) || findComposeBox();
          if (!el) throw new Error('no text box found to write into');
          setText(el, text);
        } else if (step.type === 'wait') {
          const ms = step.imageWait ? opts.imageWaitSec * 1000 : (step.ms || 1000);
          progress(step.imageWait
            ? `waiting ${opts.imageWaitSec}s for you to pick the image…`
            : `waiting ${(ms / 1000).toFixed(1)}s…`, { stepIndex: i });
          // wait in slices so cancel stays responsive
          const until = Date.now() + ms;
          while (Date.now() < until) {
            if (play.cancel) break;
            await sleep(Math.min(500, until - Date.now()));
          }
        } else if (step.type === 'scroll') {
          const pct = opts.scrollPct != null ? opts.scrollPct : step.pct;
          scrollToPercent(pct);
          await sleep(600);
        } else {
          progress(`skipping unknown step type: ${step.type}`, { stepIndex: i });
        }
      } catch (err) {
        play.running = false;
        progress(`FAILED at step ${i + 1}: ${err.message}`, { stepIndex: i, error: err.message });
        return { ok: false, step: i, error: err.message };
      }
    }
    play.running = false;
    progress('flow complete ✔', { done: true });
    return { ok: true };
  }

  // ----------------------------------------------------------------- monitor

  function scanPosts() {
    const out = [];
    const seen = new Set();
    // Facebook post containers — several layouts exist; probe the common ones.
    const nodes = document.querySelectorAll('div[role="article"], div[data-pagelet*="FeedUnit"], div.userContentWrapper');
    for (const node of nodes) {
      const text = (node.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 500);
      if (!text || text.length < 12) continue;
      let h = 2166136261;
      for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
      const id = String(h >>> 0);
      if (seen.has(id)) continue;
      seen.add(id);
      // author = first strong link-ish line; time = a line with time words
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
        return true; // async response
      case 'mt-play-stop':
        play.cancel = true;
        sendResponse({ ok: true });
        return false;
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
