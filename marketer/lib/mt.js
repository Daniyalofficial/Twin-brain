/**
 * MarketerTwin service layer — the message desk between the UI, the brain and
 * the Facebook content script. Everything here runs inside the extension:
 * IndexedDB only, no server, no localhost.
 *
 *  • mt-ask        multi-chat conversation (threads persisted in `chats`)
 *  • mt-flow-*     recorded click/write/scroll flows (Branding & Meta modes)
 *  • mt-rec-*      start/stop the recorder on the live Facebook tab
 *  • mt-play*      replay a flow with options (image wait, speed, groups…)
 *  • mt-desc-*     saved manual descriptions + the psychology-based generator
 *  • mt-monitor-*  Facebook group watchers (interval scans + diff + notify)
 *  • mt-style*     the learned writing-style profile
 *  • mt-export / mt-wipe / mt-open-app / mt-stats
 */

import * as store from './store.js';
import * as brain from './brain/brain.js';
import { getSettings, saveSettings } from './settings.js';
import { generateDescription, copygenStats } from './brain/copygen.js';
import { styleProfile, learnFromText } from './brain/style.js';
import { salesStats } from './brain/sales.js';
import { corpusStats } from './brain/fluent.js';
import { coreStats, bookStats, englishStats } from './brain/core.js';
import { urduDataSize } from './brain/data/urdu.js';
import { wheelDeltas, expandLoopSteps, resolveStepTarget } from './cursor.js';

const MONITOR_ALARM = 'mt-monitor-tick';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------- alarms

export async function ensureMtAlarms() {
  try {
    const existing = await chrome.alarms.get(MONITOR_ALARM);
    if (!existing) chrome.alarms.create(MONITOR_ALARM, { periodInMinutes: 1 });
  } catch { /* alarms unavailable (tests) */ }
}

export async function onMtAlarm(name) {
  if (name === MONITOR_ALARM) await monitorTick();
}

// ------------------------------------------------------------------ mt-ask

function newChatId() {
  return `c${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

async function mtAsk(message) {
  const text = String(message.text || '').trim();
  if (!text) return { ok: false, error: 'empty message' };

  let chat = message.chatId ? await store.getChat(message.chatId) : null;
  if (!chat) {
    chat = { id: message.chatId || newChatId(), title: '',
             createdAt: new Date().toISOString(), messages: [] };
  }

  // the thread becomes the retrieval history (anaphora + memory-RAG)
  const history = chat.messages
    .filter((m) => m.role === 'user')
    .slice(-10)
    .map((m) => ({ query: m.text, topic: m.topic || '', type: m.type || 'knowledge' }));

  const settings = await getSettings(true);
  const out = await brain.answer(text, {
    history,
    useWeb: message.useWeb === true,
    denied: message.denied === true,
  }, settings, {});

  const at = new Date().toISOString();
  chat.messages.push({ role: 'user', text, at });

  const reply = {
    role: 'twin', at,
    mode: out.mode || 'chat',
    text: out.text || out.adviceText || (out.explanation && out.explanation.simple) || '',
    grounded: Boolean(out.grounded),
    citations: (out.citations || []).slice(0, 6),
    followups: out.followups || [],
    intent: out.intent || '',
    tactics: out.sales ? out.sales.tactics : undefined,
    providerLabel: out.providerLabel || '',
    chips: out.chips || undefined,
    needsPermission: out.mode === 'needs_permission' ? true : undefined,
    question: out.mode === 'needs_permission' ? out.question : undefined,
  };
  chat.messages.push(reply);
  if (!chat.title) chat.title = text.slice(0, 60);
  await store.putChat(chat);

  // every conversation becomes a long-term memory
  await store.addMemory({
    kind: 'chat', topic: chat.title,
    text: `Q: ${text}\nA: ${String(reply.text).slice(0, 400)}`,
  });

  return { ok: true, chat, reply };
}

// ----------------------------------------------------------------- monitors

async function waitForTabComplete(tabId, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return true;
    } catch { return false; }
    await sleep(500);
  }
  return false;
}

async function scanMonitor(mon) {
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: mon.url, active: false });
    await waitForTabComplete(tab.id);
    await sleep(5000); // let Facebook render the feed
    const snap = await chrome.tabs.sendMessage(tab.id, { type: 'mt-monitor-scan' });
    const prevPosts = (mon.snapshot && mon.snapshot.posts) || [];
    const prevIds = new Set(prevPosts.map((p) => p.id));
    const fresh = ((snap && snap.posts) || []).filter((p) => !prevIds.has(p.id));

    mon.snapshot = {
      posts: ((snap && snap.posts) || []).slice(0, 40),
      title: (snap && snap.title) || mon.name || '',
      scannedAt: (snap && snap.scannedAt) || new Date().toISOString(),
    };
    mon.lastScanAt = Date.now();
    mon.lastCount = mon.snapshot.posts.length;
    mon.log = [{ at: Date.now(), fresh: fresh.length, total: mon.snapshot.posts.length }]
      .concat(mon.log || []).slice(0, 60);

    if (fresh.length && prevPosts.length) {
      const settings = await getSettings(true);
      await brain.maybeNotify(settings, {
        title: `MarketerTwin monitor — ${mon.name || mon.url}`,
        message: `${fresh.length} new post(s). Latest: “${fresh[0].snippet.slice(0, 120)}”`,
      });
      await store.addMemory({
        kind: 'monitor', topic: mon.name || mon.url,
        text: `${fresh.length} new post(s) in ${mon.snapshot.title || mon.url}: ${fresh[0].snippet}`,
      });
      await store.addAudit({ kind: 'monitor_scan', url: mon.url, fresh: fresh.length });
    }
    delete mon.lastError;
    await store.putMonitor(mon);
    return { ok: true, fresh: fresh.length };
  } catch (error) {
    mon.lastError = String((error && error.message) || error);
    mon.lastScanAt = Date.now();
    await store.putMonitor(mon);
    return { ok: false, error: mon.lastError };
  } finally {
    if (tab && tab.id != null) { try { await chrome.tabs.remove(tab.id); } catch { /* gone */ } }
  }
}

async function monitorTick() {
  let mons = [];
  try { mons = await store.listMonitors(); } catch { return; }
  const due = mons.filter((m) => m.enabled !== false && (
    !m.lastScanAt || Date.now() - m.lastScanAt >= (Number(m.intervalMin) || 5) * 60000));
  for (const mon of due.slice(0, 3)) {   // never more than 3 per tick
    await scanMonitor(mon);
  }
}

// ------------------------------------------------------------------- helpers

async function activeFacebookTab(openIfMissing) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && /facebook\.com/i.test(tab.url || '')) return tab;
  if (!openIfMissing) return null;
  const created = await chrome.tabs.create({ url: 'https://www.facebook.com/' });
  await waitForTabComplete(created.id);
  await sleep(3000);
  return created;
}

// ------------------------------------------- pyautogui-style cursor replay

/**
 * Coordinate replay: TRUE input events at the recorded viewport positions,
 * dispatched through Chrome's debugger input channel. The OS pointer cannot
 * be moved by an extension (that is an OS-level privilege), but the page
 * receives genuine mouseMoved / mousePressed / mouseWheel / insertText
 * events — hover, focus and React handlers react exactly like a human hand,
 * gliding step by step to every saved position.
 */
function cursorMsg(tabId, payload) {
  return chrome.tabs.sendMessage(tabId, { type: 'mt-cursor', ...payload }).catch(() => {});
}

async function runCoordinateFlow(flow, options, tabId) {
  const settings = await getSettings(true).catch(() => ({}));
  const autoSet = (settings && settings.automation) || {};
  const visual = autoSet.visualCursor !== false;
  const speed = Math.max(0.25, Number(options && options.speed) || 1);
  const moveMs = Math.round(({ slow: 700, normal: 420, fast: 200 }[autoSet.cursorSpeed || 'normal'] || 420) / speed);
  const opts = { speed: 1, imageWaitSec: autoSet.imageWaitSec || 40, description: '', groups: [], ...options };
  const dbg = { tabId };
  // ask the page for the FRESH position of each step's element (re-found by
  // selector / testid / aria / name / placeholder / index-path / text)
  const stepPos = (step) => chrome.tabs.sendMessage(tabId, { type: 'mt-step-pos', step }).catch(() => null);
  const targetOf = async (step) => resolveStepTarget(step, await stepPos(step), { w: 1280, h: 800 });
  const send = (method, params) => chrome.debugger.sendCommand(dbg, method, params);
  const progress = (msg, extra) => {
    try { chrome.runtime.sendMessage({ type: 'mt-progress', msg, ...extra }); } catch { /* no listeners */ }
  };
  let attached = false;
  try {
    await chrome.debugger.attach(dbg, '1.3');
    attached = true;
    progress('cursor mode attached — moving to your saved positions');
    if (visual) await cursorMsg(tabId, { op: 'show' });
    const steps = expandLoopSteps(flow.steps || [], opts.groups);
    let cur = { x: 500, y: 400 };
    let lastPct = 0;

    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      const afterSec = step.delayAfter != null ? step.delayAfter : ((step.delayMs || 0) / 1000);
      const delay = Math.round((afterSec * 1000) / speed);
      progress(`step ${i + 1}/${steps.length}: ${step.type}${step.group ? ` (${step.group})` : ''}`, { stepIndex: i });

      if (step.type === 'click') {
        cur = await targetOf(step);
        if (visual) {
          await cursorMsg(tabId, { op: 'move', x: cur.x, y: cur.y, ms: moveMs });
          await cursorMsg(tabId, { op: 'press' });
        } else {
          await sleep(120);
        }
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cur.x, y: cur.y, buttons: 0 });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cur.x, y: cur.y, button: 'left', clickCount: 1 });
        await sleep(60);
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cur.x, y: cur.y, button: 'left', clickCount: 1 });
      } else if (step.type === 'write') {
        const text = String(step.text || '')
          .replace(/\{description\}/g, opts.description || '')
          .replace(/\{group\}/g, step.group || '');
        // glide to the box (fresh position if the page can re-find it) and
        // click it so it takes focus, then type
        cur = await targetOf(step);
        if (visual) {
          await cursorMsg(tabId, { op: 'move', x: cur.x, y: cur.y, ms: moveMs });
          await cursorMsg(tabId, { op: 'press' });
        }
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cur.x, y: cur.y, buttons: 0 });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cur.x, y: cur.y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cur.x, y: cur.y, button: 'left', clickCount: 1 });
        await sleep(300);
        if (visual) await cursorMsg(tabId, { op: 'label', text: `typing ${text.length} chars…`, ms: 1200 });
        await send('Input.insertText', { text });
      } else if (step.type === 'wait') {
        const ms = step.imageWait ? Number(opts.imageWaitSec) * 1000 : (step.ms || 1000);
        progress(step.imageWait
          ? `waiting ${opts.imageWaitSec}s for you to pick the image…`
          : `waiting ${(ms / 1000).toFixed(1)}s…`, { stepIndex: i });
        if (visual) await cursorMsg(tabId, { op: 'label', text: step.imageWait ? `pick your image — ${opts.imageWaitSec}s` : `waiting ${(ms / 1000).toFixed(1)}s`, ms: Math.min(ms, 4000) });
        await sleep(ms);
      } else if (step.type === 'scroll') {
        const pct = opts.scrollPct != null ? Number(opts.scrollPct) : step.pct;
        const evalRes = await send('Runtime.evaluate', {
          expression: 'JSON.stringify({sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight})',
          returnByValue: true,
        });
        const dims = JSON.parse((evalRes && evalRes.result && evalRes.result.value) || '{"sh":0,"ch":0}');
        if (visual) await cursorMsg(tabId, { op: 'label', text: `scrolling to ${pct}%`, ms: 900 });
        for (const delta of wheelDeltas(lastPct, pct, dims.sh, dims.ch)) {
          await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cur.x, y: cur.y, deltaX: 0, deltaY: delta });
          await sleep(90);
        }
        lastPct = pct;
      } else {
        progress(`skipping ${step.type}`, { stepIndex: i });
      }
      if (delay > 0) await sleep(Math.min(delay, 300000));   // YOUR after-delay, per step
    }
    progress('flow complete ✔', { done: true });
    return { ok: true };
  } catch (error) {
    const msg = String((error && error.message) || error);
    progress(`cursor mode failed: ${msg}`, { error: msg });
    return { ok: false, error: msg };
  } finally {
    if (visual) await cursorMsg(tabId, { op: 'hide' });
    if (attached) { try { await chrome.debugger.detach(dbg); } catch { /* already gone */ } }
  }
}

// -------------------------------------------------------------------- router

export async function handleMt(message) {
  switch (message.type) {

    // ---- app & stats -------------------------------------------------------
    case 'mt-open-app': {
      await chrome.tabs.create({ url: chrome.runtime.getURL('app/app.html') });
      return { ok: true };
    }
    case 'mt-stats': {
      const [bStats, style] = await Promise.all([brain.brainStats(), styleProfile()]);
      return {
        ok: true,
        memory: bStats,
        chatExperience: corpusStats(),
        knowledgeCore: coreStats(),
        englishTool: englishStats(),
        bookshelf: bookStats(),
        salesPlaybook: salesStats(),
        copygen: copygenStats(),
        urdu: urduDataSize(),
        style,
      };
    }

    // ---- chat ---------------------------------------------------------------
    case 'mt-ask':
      return await mtAsk(message);
    case 'mt-chats': {
      const chats = await store.listChats();
      return { ok: true, chats: chats.map((c) => ({
        id: c.id, title: c.title || 'New chat', updatedAt: c.updatedAt,
        createdAt: c.createdAt, messages: (c.messages || []).length,
      })) };
    }
    case 'mt-chat-get': {
      const chat = await store.getChat(message.chatId);
      return chat ? { ok: true, chat } : { ok: false, error: 'chat not found' };
    }
    case 'mt-chat-new': {
      const chat = { id: newChatId(), title: '', createdAt: new Date().toISOString(), messages: [] };
      await store.putChat(chat);
      return { ok: true, chat };
    }
    case 'mt-chat-delete':
      await store.deleteChat(message.chatId);
      return { ok: true };
    case 'mt-chat-rename': {
      const chat = await store.getChat(message.chatId);
      if (!chat) return { ok: false, error: 'chat not found' };
      chat.title = String(message.title || '').slice(0, 80);
      await store.putChat(chat);
      return { ok: true, chat };
    }

    // ---- flows (Branding & Meta position sets) -------------------------------
    case 'mt-flows': {
      const flows = await store.listFlows();
      return { ok: true, flows: flows.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')) };
    }
    case 'mt-flow-get': {
      const flow = await store.getFlow(message.flowId);
      return flow ? { ok: true, flow } : { ok: false, error: 'flow not found' };
    }
    case 'mt-flow-save': {
      const flow = {
        id: message.flow.id || `f${Date.now().toString(36)}`,
        name: message.flow.name || `${message.flow.mode || 'branding'} flow`,
        mode: message.flow.mode || 'branding',
        steps: message.flow.steps || [],
        updatedAt: new Date().toISOString(),
        createdAt: message.flow.createdAt || new Date().toISOString(),
      };
      await store.putFlow(flow);
      await store.addAudit({ kind: 'flow_save', flow: flow.id, steps: flow.steps.length });
      return { ok: true, flow };
    }
    case 'mt-flow-delete':
      await store.deleteFlow(message.flowId);
      return { ok: true };
    case 'mt-flow-recorded': {
      // fired by the content-script recorder when the user hits Stop & Save
      const flow = {
        id: message.flowId || `f${Date.now().toString(36)}`,
        name: message.name || `${message.mode} flow ${new Date().toLocaleString()}`,
        mode: message.mode || 'branding',
        steps: message.steps || [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await store.putFlow(flow);
      await store.addAudit({ kind: 'flow_recorded', flow: flow.id, steps: flow.steps.length });
      try { chrome.runtime.sendMessage({ type: 'mt-flow-saved', flowId: flow.id }); } catch { /* no listeners */ }
      return { ok: true, flow };
    }

    // ---- recorder / player ---------------------------------------------------
    case 'mt-rec-start': {
      const tab = await activeFacebookTab(true);
      if (!tab) return { ok: false, error: 'open Facebook first' };
      await chrome.tabs.sendMessage(tab.id, { type: 'mt-rec-start', mode: message.mode || 'branding' });
      return { ok: true, tabId: tab.id };
    }
    case 'mt-rec-stop': {
      const tab = await activeFacebookTab(false);
      if (!tab) return { ok: false, error: 'no Facebook tab' };
      await chrome.tabs.sendMessage(tab.id, { type: 'mt-rec-stop' });
      return { ok: true };
    }
    case 'mt-play': {
      const tab = await activeFacebookTab(true);
      if (!tab) return { ok: false, error: 'open Facebook first' };
      let flow = message.flow;
      if (!flow && message.flowId) flow = await store.getFlow(message.flowId);
      if (!flow) return { ok: false, error: 'flow not found' };
      await store.addAudit({ kind: 'flow_play', flow: flow.id, mode: flow.mode,
                             cursor: Boolean(message.options && message.options.coordinateMode) });
      if (message.options && message.options.coordinateMode) {
        // pyautogui-style: true input events at saved coordinates
        runCoordinateFlow(flow, message.options, tab.id).catch(() => {});
        return { ok: true, started: true, mode: 'coordinate', tabId: tab.id };
      }
      // fire-and-forget: the content script broadcasts mt-progress itself, so
      // the app UI sees live step updates even if this worker naps
      chrome.tabs.sendMessage(tab.id, { type: 'mt-play', flow, options: message.options || {} })
        .catch(() => {});
      return { ok: true, started: true, tabId: tab.id };
    }
    case 'mt-play-stop': {
      const tab = await activeFacebookTab(false);
      if (tab) await chrome.tabs.sendMessage(tab.id, { type: 'mt-play-stop' }).catch(() => {});
      return { ok: true };
    }
    case 'mt-paste-desc': {
      const tab = await activeFacebookTab(false);
      if (!tab) return { ok: false, error: 'open a Facebook compose box first' };
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'mt-paste-desc', text: message.text || '' });
      return { ok: Boolean(res && res.ok), error: res && res.error };
    }

    // ---- descriptions ----------------------------------------------------------
    case 'mt-desc-generate': {
      const brief = message.brief || {};
      const out = generateDescription(brief);
      void learnFromText(`${brief.business || ''} ${brief.offer || ''} ${brief.tone || ''}`, 'brief');
      await store.addAudit({ kind: 'desc_generated', language: out.language });
      return { ok: true, ...out };
    }
    case 'mt-desc-list': {
      const rows = await store.listDescriptions();
      return { ok: true, descriptions: rows.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')) };
    }
    case 'mt-desc-save': {
      const desc = {
        id: message.desc.id || `d${Date.now().toString(36)}`,
        name: message.desc.name || 'Untitled description',
        text: String(message.desc.text || ''),
        hashtags: message.desc.hashtags || '',
        kind: message.desc.kind || 'general',
        createdAt: message.desc.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await store.putDescription(desc);
      return { ok: true, desc };
    }
    case 'mt-desc-delete':
      await store.deleteDescription(message.id);
      return { ok: true };

    // ---- monitors ----------------------------------------------------------------
    case 'mt-monitors': {
      const rows = await store.listMonitors();
      return { ok: true, monitors: rows };
    }
    case 'mt-monitor-save': {
      const mon = {
        id: message.monitor.id || `m${Date.now().toString(36)}`,
        name: message.monitor.name || message.monitor.url,
        url: String(message.monitor.url || '').trim(),
        intervalMin: Math.max(1, Number(message.monitor.intervalMin) || 5),
        enabled: message.monitor.enabled !== false,
        createdAt: message.monitor.createdAt || new Date().toISOString(),
        snapshot: message.monitor.snapshot || null,
        log: message.monitor.log || [],
      };
      if (!/^https?:\/\/(www\.|web\.|m\.)?facebook\.com\//i.test(mon.url)) {
        return { ok: false, error: 'monitor URLs must be facebook.com group/page links' };
      }
      await store.putMonitor(mon);
      await store.addAudit({ kind: 'monitor_saved', url: mon.url, intervalMin: mon.intervalMin });
      return { ok: true, monitor: mon };
    }
    case 'mt-monitor-delete':
      await store.deleteMonitor(message.id);
      return { ok: true };
    case 'mt-monitor-scan-now': {
      const mon = await store.getMonitor(message.id);
      if (!mon) return { ok: false, error: 'monitor not found' };
      return await scanMonitor(mon);
    }

    // ---- style ----------------------------------------------------------------------
    case 'mt-style':
      return { ok: true, ...(await styleProfile()) };
    case 'mt-style-reset': {
      await store.putStyle('profile', null);
      return { ok: true };
    }

    // ---- data -------------------------------------------------------------------------
    case 'mt-export': {
      const dump = await store.exportAll();
      await store.addAudit({ kind: 'export' });
      return { ok: true, dump };
    }
    case 'mt-wipe': {
      if (message.confirm !== 'WIPE') return { ok: false, error: 'confirmation required' };
      await brain.wipeBrain();
      return { ok: true };
    }

    default:
      return { ok: false, error: `unknown mt message ${message.type}` };
  }
}
