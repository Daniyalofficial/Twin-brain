/**
 * MarketerTwin Studio — the full-tab app.
 * Talks to the background worker only (chrome.runtime messages); every byte
 * lives in the extension's own IndexedDB. No server, no localhost.
 */

const send = (msg) => chrome.runtime.sendMessage(msg);
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function toast(text, ms = 2600) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --------------------------------------------------------------------- nav

$$('.nav').forEach((btn) => {
  btn.onclick = () => {
    $$('.nav').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    $$('.view').forEach((v) => v.classList.remove('active'));
    $(`#view-${btn.dataset.view}`).classList.add('active');
    if (btn.dataset.view === 'automate') loadFlows();
    if (btn.dataset.view === 'descriptions') loadDescriptions();
    if (btn.dataset.view === 'monitors') loadMonitors();
    if (btn.dataset.view === 'memory') loadMemory();
    if (btn.dataset.view === 'settings') loadSettings();
  };
});

// -------------------------------------------------------------------- chat

let currentChatId = null;
let chats = [];

async function loadChats() {
  const res = await send({ type: 'mt-chats' });
  chats = (res && res.chats) || [];
  const box = $('#threads');
  box.innerHTML = '';
  for (const c of chats) {
    const row = document.createElement('div');
    row.className = 'thread' + (c.id === currentChatId ? ' active' : '');
    row.innerHTML = `<span>${esc(c.title || 'New chat')}</span>`;
    const x = document.createElement('button');
    x.className = 'x'; x.textContent = '✕'; x.title = 'Delete chat';
    x.onclick = async (ev) => {
      ev.stopPropagation();
      await send({ type: 'mt-chat-delete', chatId: c.id });
      if (currentChatId === c.id) { currentChatId = null; $('#messages').innerHTML = ''; }
      loadChats();
    };
    row.appendChild(x);
    row.onclick = () => openChat(c.id);
    box.appendChild(row);
  }
}

async function openChat(id) {
  currentChatId = id;
  loadChats();
  const res = await send({ type: 'mt-chat-get', chatId: id });
  const box = $('#messages');
  box.innerHTML = '';
  if (!res || !res.chat) return;
  for (const m of res.chat.messages) renderMessage(m);
  box.scrollTop = box.scrollHeight;
}

$('#btn-new-chat').onclick = async () => {
  const res = await send({ type: 'mt-chat-new' });
  currentChatId = res.chat.id;
  $('#messages').innerHTML = '';
  $('#chips').innerHTML = '';
  loadChats();
  $('#chat-input').focus();
};

function modeLabel(m) {
  if (m.role === 'user') return 'You';
  const labels = {
    sales: 'Sales playbook · tactic', book: 'Bookshelf', bookshelf: 'Bookshelf',
    core: 'Knowledge core', explain: 'From your memory', neural: m.providerLabel || 'AI provider',
    fluent: 'Twin experience', chat: 'MarketerTwin', clarify: 'MarketerTwin',
    meta: 'Brain stats', advice: 'Advice', needs_permission: 'Web permission',
  };
  return labels[m.mode] || 'MarketerTwin';
}

function renderMessage(m) {
  const box = $('#messages');
  const el = document.createElement('div');
  el.className = `msg ${m.role}`;
  let html = `<span class="meta">${esc(modeLabel(m))}${m.tactics && m.tactics.length ? ' · ' + esc(m.tactics.join(', ')) : ''}</span>`;
  html += esc(m.text || '…');
  if (m.citations && m.citations.length) {
    html += '<div class="cites">' + m.citations.map((c) => {
      const title = esc(c.title || c.domain || 'source');
      const when = c.when ? ` · ${esc(c.when)}` : '';
      return c.url ? `<a href="${esc(c.url)}" target="_blank">[${c.n}] ${title}</a>${when}` : `[${c.n}] ${title}${when}`;
    }).join('<br>') + '</div>';
  }
  el.innerHTML = html;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  return el;
}

function renderChips(list) {
  const box = $('#chips');
  box.innerHTML = '';
  for (const c of (list || []).slice(0, 4)) {
    const b = document.createElement('button');
    b.textContent = c;
    b.onclick = () => { $('#chat-input').value = c; sendChat(); };
    box.appendChild(b);
  }
}

async function sendChat(override) {
  const input = $('#chat-input');
  const text = (override && override.text) || input.value.trim();
  if (!text) return;
  if (!override) input.value = '';
  $('#chips').innerHTML = '';
  renderMessage({ role: 'user', text });
  const typing = document.createElement('div');
  typing.className = 'typing';
  typing.textContent = 'thinking…';
  $('#messages').appendChild(typing);

  const res = await send({
    type: 'mt-ask', chatId: currentChatId, text,
    useWeb: $('#use-web').checked || (override && override.useWeb) || false,
    denied: (override && override.denied) || false,
  });
  typing.remove();
  if (!res || !res.ok) {
    renderMessage({ role: 'twin', mode: 'chat', text: `Something went wrong: ${esc(res && res.error || 'unknown')}` });
    return;
  }
  currentChatId = res.chat.id;
  const reply = res.reply;
  renderMessage(reply);
  loadChats();
  if (reply.needsPermission) {
    const chips = $('#chips');
    chips.innerHTML = '';
    const mk = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; chips.appendChild(b); };
    mk('✅ Allow this once', () => sendChat({ text: reply.question || text, useWeb: true }));
    mk('🌐 Always allow web', async () => {
      await send({ type: 'tb-web-permission', allow: 'always' });
      sendChat({ text: reply.question || text, useWeb: true });
    });
    mk('🚫 Not now', () => sendChat({ text: reply.question || text, denied: true }));
  } else {
    renderChips(reply.followups);
  }
}

$('#btn-send').onclick = () => sendChat();
$('#chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});

// ---------------------------------------------------------------- automate

let flows = [];
let selectedFlow = null;

async function loadFlows() {
  const res = await send({ type: 'mt-flows' });
  flows = (res && res.flows) || [];
  for (const mode of ['branding', 'meta']) {
    const box = $(`#flows-${mode}`);
    box.innerHTML = '';
    const mine = flows.filter((f) => (f.mode || 'branding') === mode);
    if (!mine.length) box.innerHTML = '<div class="dim" style="font-size:12px">No recorded flow yet — hit ● Record, then click through Facebook.</div>';
    for (const f of mine) {
      const row = document.createElement('div');
      row.className = 'flow-item' + (selectedFlow && selectedFlow.id === f.id ? ' selected' : '');
      row.innerHTML = `<span><b>${esc(f.name)}</b><br><span class="dim">${(f.steps || []).length} steps · ${esc((f.updatedAt || '').slice(0, 16).replace('T', ' '))}</span></span>`;
      const acts = document.createElement('span');
      acts.className = 'acts';
      const play = document.createElement('button'); play.textContent = '▶'; play.title = 'Select for play';
      play.onclick = (ev) => { ev.stopPropagation(); selectFlow(f); };
      const del = document.createElement('button'); del.textContent = '🗑'; del.className = 'danger';
      del.onclick = async (ev) => {
        ev.stopPropagation();
        await send({ type: 'mt-flow-delete', flowId: f.id });
        if (selectedFlow && selectedFlow.id === f.id) selectedFlow = null;
        loadFlows();
      };
      acts.append(play, del);
      row.appendChild(acts);
      row.onclick = () => selectFlow(f);
      box.appendChild(row);
    }
  }
}

function selectFlow(f) {
  selectedFlow = f;
  $('#play-flow-name').textContent = `— ${f.name} (${f.mode}, ${(f.steps || []).length} steps)`;
  const box = $('#flow-steps');
  box.innerHTML = '';
  (f.steps || []).forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'step-row';
    const label = s.type === 'click' ? (s.hint && (s.hint.text || s.hint.aria) || s.sel || '').slice(0, 60)
      : s.type === 'write' ? (s.text || '').slice(0, 60)
      : s.type === 'wait' ? (s.imageWait ? 'image-pick wait (options)' : `${(s.ms || 0) / 1000}s`)
      : s.type === 'scroll' ? `${s.pct}%`
      : s.type;
    row.innerHTML = `<b>${i + 1}. ${esc(s.type)}</b><span>${esc(label)}</span><span class="dim" style="margin-left:auto">${s.delayMs ? '+' + s.delayMs + 'ms' : ''}</span>`;
    box.appendChild(row);
  });
  loadFlows();
}

$$('.rec-start').forEach((b) => {
  b.onclick = async () => {
    const res = await send({ type: 'mt-rec-start', mode: b.dataset.mode });
    if (res && res.ok) toast(`Recording ${b.dataset.mode.toUpperCase()} flow — click through Facebook. The recorder panel is on the page.`);
    else toast(`Could not start: ${res && res.error || 'open Facebook first'}`);
  };
});
$$('.rec-stop').forEach((b) => {
  b.onclick = async () => { await send({ type: 'mt-rec-stop' }); toast('Recorder stopped (nothing saved).'); };
});

// the recorder posts saved flows through the background — refresh when asked
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'mt-progress') {
    const log = $('#play-log');
    if (log) {
      log.textContent += `[${new Date().toLocaleTimeString()}] ${msg.msg}\n`;
      log.scrollTop = log.scrollHeight;
    }
    if (msg.done) toast('Flow complete ✔');
    if (msg.error) toast(`Flow failed: ${msg.error}`, 5000);
  }
  if (msg && msg.type === 'mt-flow-saved') loadFlows();
});

function collectOptions() {
  return {
    speed: Number($('#opt-speed').value) || 1,
    imageWaitSec: Number($('#opt-imgwait').value) || 40,
    elementTimeoutSec: Number($('#opt-eltimeout').value) || 20,
    scrollPct: $('#opt-scrollpct').value === '' ? null : Number($('#opt-scrollpct').value),
    groups: $('#opt-groups').value.split('\n').map((s) => s.trim()).filter(Boolean),
  };
}

async function currentDescription() {
  const source = $('#opt-desc-source').value;
  if (source === 'none') return '';
  if (source === 'custom') return $('#opt-desc-custom').value;
  if (source === 'saved') {
    const sel = $('#opt-desc-saved');
    const opt = sel.options[sel.selectedIndex];
    return opt ? (opt.dataset.text || '') + (opt.dataset.hash ? '\n\n' + opt.dataset.hash : '') : '';
  }
  // ai: generate on the spot from the quick form
  const brief = {
    business: $('#gen-business').value, niche: $('#gen-niche').value,
    city: $('#gen-city').value, offer: $('#gen-offer').value,
    kind: $('#gen-kind').value, language: $('#gen-lang').value,
  };
  const res = await send({ type: 'mt-desc-generate', brief });
  if (!res || !res.ok || !res.variants.length) { toast('Could not generate a description'); return ''; }
  renderGenResults('#gen-results', res);
  return res.variants[0] + '\n\n' + res.hashtags;
}

$('#opt-desc-source').onchange = () => {
  $('#desc-ai-box').classList.toggle('hidden', $('#opt-desc-source').value !== 'ai');
  $('#opt-desc-saved').classList.toggle('hidden', $('#opt-desc-source').value !== 'saved');
  $('#opt-desc-custom').classList.toggle('hidden', $('#opt-desc-source').value !== 'custom');
  if ($('#opt-desc-source').value === 'saved') refreshSavedDescSelect();
};

async function refreshSavedDescSelect() {
  const res = await send({ type: 'mt-desc-list' });
  const sel = $('#opt-desc-saved');
  sel.innerHTML = '<option value="">— pick a saved description —</option>';
  for (const d of (res && res.descriptions) || []) {
    const opt = document.createElement('option');
    opt.value = d.id; opt.textContent = d.name;
    opt.dataset.text = d.text || ''; opt.dataset.hash = d.hashtags || '';
    sel.appendChild(opt);
  }
}
// "saved" select stores chosen text on the option; adjust currentDescription:
$('#opt-desc-saved') && ($('#opt-desc-saved').onchange = () => {});

$('#btn-play').onclick = async () => {
  if (!selectedFlow) { toast('Select a recorded flow first (▶ next to it)'); return; }
  $('#play-log').textContent = '';
  const description = await currentDescription();
  const options = { ...collectOptions(), description };
  const res = await send({ type: 'mt-play', flowId: selectedFlow.id, options });
  if (res && res.ok) toast('Flow started — watch the Facebook tab. Progress appears below.');
  else toast(`Play failed: ${res && res.error || 'unknown'}`);
};
$('#btn-play-stop').onclick = async () => { await send({ type: 'mt-play-stop' }); toast('Stop signal sent.'); };

// ------------------------------------------------------------- descriptions

function renderGenResults(sel, res) {
  const box = $(sel);
  box.innerHTML = '';
  res.variants.forEach((v, i) => {
    const el = document.createElement('div');
    el.className = 'variant';
    el.innerHTML = `<b class="dim">Variant ${i + 1} · ${esc(res.language === 'ur' ? 'Roman Urdu' : 'English')}</b>\n\n${esc(v)}\n\n<span class="dim">${esc(res.hashtags)}</span>` +
      `<div class="principles">Psychology: ${res.principles.map(esc).join(' · ')}</div>`;
    const row = document.createElement('div');
    row.className = 'row';
    const copy = document.createElement('button'); copy.textContent = '⧉ Copy';
    copy.onclick = () => { navigator.clipboard.writeText(v + '\n\n' + res.hashtags); toast('Copied'); };
    const paste = document.createElement('button'); paste.textContent = '📋 Paste into open FB compose';
    paste.onclick = async () => {
      const r = await send({ type: 'mt-paste-desc', text: v + '\n\n' + res.hashtags });
      toast(r && r.ok ? 'Pasted into the compose box' : `Paste failed: ${r && r.error || 'open a compose box first'}`);
    };
    const save = document.createElement('button'); save.textContent = '💾 Save to library'; save.className = 'primary';
    save.onclick = async () => {
      await send({ type: 'mt-desc-save', desc: { name: `${res.language === 'ur' ? 'Urdu' : 'EN'} variant ${i + 1} — ${new Date().toLocaleString()}`, text: v, hashtags: res.hashtags, kind: 'ai' } });
      toast('Saved to library');
      loadDescriptions();
    };
    row.append(copy, paste, save);
    el.appendChild(row);
    box.appendChild(el);
  });
}

async function generateFrom(selPrefix, outSel) {
  const brief = {
    business: $(`${selPrefix}-business`).value, niche: $(`${selPrefix}-nickname`) ? $(`${selPrefix}-nickname`).value : $(`${selPrefix}-niche`).value,
    city: $(`${selPrefix}-city`).value, offer: $(`${selPrefix}-offer`).value,
    price: ($(`${selPrefix}-price`) || {}).value || '', audience: ($(`${selPrefix}-audience`) || {}).value || '',
    kind: $(`${selPrefix}-kind`).value, language: $(`${selPrefix}-lang`).value,
  };
  const res = await send({ type: 'mt-desc-generate', brief });
  if (res && res.ok) renderGenResults(outSel, res);
  else toast('Generation failed');
}

$('#btn-gen-desc').onclick = () => generateFrom('#gen', '#gen-results');
$('#btn-write').onclick = () => generateFrom('#w', '#w-results');

async function loadDescriptions() {
  const res = await send({ type: 'mt-desc-list' });
  const box = $('#desc-list');
  box.innerHTML = '';
  const rows = (res && res.descriptions) || [];
  if (!rows.length) box.innerHTML = '<div class="dim">Nothing saved yet — generate or write one and hit Save.</div>';
  for (const d of rows) {
    const el = document.createElement('div');
    el.className = 'desc-item';
    el.innerHTML = `<b>${esc(d.name)}</b> <span class="dim">${esc((d.updatedAt || '').slice(0, 10))}</span><pre>${esc((d.text || '').slice(0, 300))}${(d.text || '').length > 300 ? '…' : ''}${d.hashtags ? '\n' + esc(d.hashtags) : ''}</pre>`;
    const row = document.createElement('div');
    row.className = 'row';
    const copy = document.createElement('button'); copy.textContent = '⧉ Copy';
    copy.onclick = () => { navigator.clipboard.writeText((d.text || '') + (d.hashtags ? '\n\n' + d.hashtags : '')); toast('Copied'); };
    const paste = document.createElement('button'); paste.textContent = '📋 Paste into FB';
    paste.onclick = async () => {
      const r = await send({ type: 'mt-paste-desc', text: (d.text || '') + (d.hashtags ? '\n\n' + d.hashtags : '') });
      toast(r && r.ok ? 'Pasted' : `Paste failed: ${r && r.error || ''}`);
    };
    const edit = document.createElement('button'); edit.textContent = '✎ Load into editor';
    edit.onclick = () => { $('#dl-name').value = d.name; $('#dl-text').value = d.text || ''; $('#dl-hashtags').value = d.hashtags || ''; $('#dl-name').dataset.id = d.id; };
    const del = document.createElement('button'); del.textContent = '🗑'; del.className = 'danger';
    del.onclick = async () => { await send({ type: 'mt-desc-delete', id: d.id }); loadDescriptions(); };
    row.append(copy, paste, edit, del);
    el.appendChild(row);
    box.appendChild(el);
  }
  refreshSavedDescSelect();
}

$('#btn-desc-save').onclick = async () => {
  const text = $('#dl-text').value.trim();
  if (!text) { toast('Write some text first'); return; }
  await send({
    type: 'mt-desc-save',
    desc: { id: $('#dl-name').dataset.id || undefined, name: $('#dl-name').value.trim() || 'Untitled', text, hashtags: $('#dl-hashtags').value.trim() },
  });
  $('#dl-name').value = ''; $('#dl-text').value = ''; $('#dl-hashtags').value = ''; delete $('#dl-name').dataset.id;
  toast('Saved to library');
  loadDescriptions();
};

// --------------------------------------------------------------- monitors

async function loadMonitors() {
  const res = await send({ type: 'mt-monitors' });
  const box = $('#mon-list');
  box.innerHTML = '';
  const rows = (res && res.monitors) || [];
  if (!rows.length) box.innerHTML = '<div class="card dim">No monitors yet — add your first Facebook group above.</div>';
  for (const m of rows) {
    const el = document.createElement('div');
    el.className = 'mon-item';
    const lastScan = m.lastScanAt ? new Date(m.lastScanAt).toLocaleString() : 'never';
    const logLine = (m.log || []).slice(0, 3).map((l) => `${new Date(l.at).toLocaleTimeString()}: +${l.fresh} new / ${l.total} seen`).join(' · ');
    el.innerHTML = `
      <div class="row">
        <span><b>${esc(m.name)}</b> <span class="pill ${m.enabled !== false ? 'on' : 'off'}">${m.enabled !== false ? 'watching' : 'paused'}</span></span>
        <span class="stats">every ${esc(m.intervalMin)} min · last scan ${esc(lastScan)} · ${m.lastCount != null ? m.lastCount + ' posts seen' : ''}</span>
      </div>
      <div class="dim" style="font-size:12px;word-break:break-all">${esc(m.url)}</div>
      ${m.lastError ? `<div style="color:var(--danger);font-size:12px">last error: ${esc(m.lastError)}</div>` : ''}
      ${logLine ? `<div class="dim" style="font-size:11.5px;margin-top:4px">${esc(logLine)}</div>` : ''}`;
    const row = document.createElement('div');
    row.className = 'row';
    const scan = document.createElement('button'); scan.textContent = '🔍 Scan now';
    scan.onclick = async () => { toast('Scanning in a background tab…'); const r = await send({ type: 'mt-monitor-scan-now', id: m.id }); toast(r && r.ok ? `Scan done — ${r.fresh} new post(s)` : `Scan failed: ${r && r.error || ''}`, 4000); loadMonitors(); };
    const toggle = document.createElement('button'); toggle.textContent = m.enabled !== false ? '⏸ Pause' : '▶ Resume';
    toggle.onclick = async () => { await send({ type: 'mt-monitor-save', monitor: { ...m, enabled: m.enabled === false } }); loadMonitors(); };
    const del = document.createElement('button'); del.textContent = '🗑 Delete'; del.className = 'danger';
    del.onclick = async () => { await send({ type: 'mt-monitor-delete', id: m.id }); loadMonitors(); };
    row.append(scan, toggle, del);
    el.appendChild(row);
    box.appendChild(el);
  }
}

$('#btn-mon-add').onclick = async () => {
  const res = await send({
    type: 'mt-monitor-save',
    monitor: { name: $('#mon-name').value.trim(), url: $('#mon-url').value.trim(), intervalMin: Number($('#mon-interval').value) || 5 },
  });
  if (res && res.ok) {
    toast('Monitor added — first scan happens within a minute (it builds the baseline silently).');
    $('#mon-name').value = ''; $('#mon-url').value = '';
    loadMonitors();
  } else toast(`Could not add: ${res && res.error || ''}`, 4000);
};

// ----------------------------------------------------------------- memory

async function loadMemory() {
  const res = await send({ type: 'mt-stats' });
  if (!res || !res.ok) return;
  const s = res;
  const grid = [
    ['Pages remembered', s.memory.pages], ['Memory chunks', s.memory.chunks],
    ['Chat experience turns', s.chatExperience.turns], ['Knowledge topics', s.knowledgeCore.topics],
    ['Sales tactics', s.salesPlaybook.tactics], ['Books (full lessons)', `${s.bookshelf.books} (${s.bookshelf.lessons})`],
    ['Urdu phrase banks', `${s.urdu.banks} banks / ${s.urdu.phrases} phrases`], ['English tool entries', s.englishTool.words],
  ];
  $('#mem-stats').innerHTML = `<div class="stat-grid">${grid.map(([k, v]) =>
    `<div class="stat"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('')}</div>` +
    `<p class="dim" style="margin-top:8px">Interests: ${esc((s.memory.interests || []).toString() || '— none yet —')}</p>`;
  $('#mem-style').textContent = s.style && s.style.learned
    ? s.style.summaryText
    : 'Chat a little and I will learn how you write (message length, language mix, greeting habits, favourite words).';

  const pagesRes = await send({ type: 'tb-pages', params: { limit: 40 } });
  const pbox = $('#mem-pages');
  pbox.innerHTML = '';
  for (const p of (pagesRes && pagesRes.pages) || []) {
    const row = document.createElement('div');
    row.className = 'page-row';
    row.innerHTML = `<span><a href="${esc(p.url)}" target="_blank" style="color:var(--acc)">${esc(p.title || p.url)}</a><br><span class="dim">${esc(p.domain_label)} · visited ${esc(p.visited_ago)} · ${p.word_count} words${p.assistant_fetched ? ' · fetched by twin' : ''}</span></span>`;
    const acts = document.createElement('span');
    acts.className = 'acts';
    const forget = document.createElement('button'); forget.textContent = 'Forget'; forget.className = 'danger';
    forget.onclick = async () => { await send({ type: 'tb-forget', url: p.url, reason: 'app memory page' }); toast('Forgotten'); loadMemory(); };
    acts.appendChild(forget);
    row.appendChild(acts);
    pbox.appendChild(row);
  }
  if (!pbox.children.length) pbox.innerHTML = '<div class="dim">No pages remembered yet — browse with capture on, or hit “Analyze this page” from the popup.</div>';

  const auditRes = await send({ type: 'tb-audit' });
  const abox = $('#mem-audit');
  abox.innerHTML = ((auditRes && auditRes.audit) || []).slice(0, 30)
    .map((a) => `<div class="page-row"><span>${esc(a.kind)}${a.query ? ` · “${esc(String(a.query).slice(0, 60))}”` : ''}${a.url ? ` · ${esc(String(a.url).slice(0, 60))}` : ''}${a.status ? ` · ${esc(a.status)}` : ''}</span><span class="dim">${esc(new Date(a.at).toLocaleString())}</span></div>`)
    .join('') || '<div class="dim">No activity yet.</div>';
}

$('#btn-pages-refresh').onclick = loadMemory;

$('#btn-export').onclick = async () => {
  const res = await send({ type: 'mt-export' });
  if (!res || !res.ok) { toast('Export failed'); return; }
  const blob = new Blob([JSON.stringify(res.dump, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `marketer-twin-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  toast('Backup downloaded');
};

$('#btn-wipe').onclick = async () => {
  const word = prompt('This deletes ALL memory (pages, chats, flows, descriptions, monitors). Type WIPE to confirm:');
  if (word !== 'WIPE') return;
  const res = await send({ type: 'mt-wipe', confirm: 'WIPE' });
  toast(res && res.ok ? 'Memory wiped. Settings kept.' : 'Wipe failed');
  loadMemory();
};

// --------------------------------------------------------------- settings

let currentSettings = {};

async function loadSettings() {
  const res = await send({ type: 'tb-settings-get' });
  currentSettings = (res && res.settings) || {};
  const s = currentSettings;
  $('#set-backend').value = s.neuralBackend === 'off' ? 'builtin' : (s.neuralBackend === 'openai' ? 'openai' : 'auto');
  $('#set-baseurl').value = s.openaiUrl || '';
  $('#set-apikey').value = s.openaiKey || '';
  $('#set-model').value = s.openaiModel || '';
  $('#set-prompt').value = s.customSystemPrompt || '';
  $('#set-webperm').value = s.webPermission || 'ask';
  $('#set-webbudget').value = s.webSearchDailyBudget != null ? s.webSearchDailyBudget : 40;
  $('#set-notebudget').value = s.notificationDailyBudget != null ? s.notificationDailyBudget : 5;
  $('#set-talk').value = s.talkativeness || 'friendly';
  $('#set-capture').checked = s.captureEnabled !== false;
  $('#set-daily').checked = s.autoEnrich !== false;
  refreshProviderChip();
}

async function refreshProviderChip() {
  try {
    const res = await send({ type: 'tb-neural-status' });
    const n = res && res.neural;
    const chip = $('#provider-chip');
    if (n && n.connected) { chip.textContent = n.label || 'LLM connected'; chip.style.color = 'var(--acc2)'; }
    else { chip.textContent = 'built-in engine'; chip.style.color = 'var(--acc)'; }
  } catch { /* ignore */ }
}

function settingsPatchFromForm() {
  const backend = $('#set-backend').value;
  return {
    neuralEnabled: backend !== 'builtin',
    neuralBackend: backend === 'builtin' ? 'off' : backend,
    openaiUrl: $('#set-baseurl').value.trim(),
    openaiKey: $('#set-apikey').value.trim(),
    openaiModel: $('#set-model').value.trim(),
    webPermission: $('#set-webperm').value,
    webSearchDailyBudget: Number($('#set-webbudget').value) || 0,
    notificationDailyBudget: Number($('#set-notebudget').value) || 0,
    talkativeness: $('#set-talk').value,
    captureEnabled: $('#set-capture').checked,
    autoEnrich: $('#set-daily').checked,
  };
}

$('#btn-save-api').onclick = async () => {
  const res = await send({ type: 'tb-settings-set', patch: settingsPatchFromForm() });
  if (res && res.ok) { toast('Provider saved'); refreshProviderChip(); }
};
$('#btn-test-api').onclick = async () => {
  await send({ type: 'tb-settings-set', patch: settingsPatchFromForm() });
  $('#api-status').textContent = 'testing…';
  const res = await send({ type: 'tb-neural-status' });
  const n = res && res.neural;
  $('#api-status').textContent = n && n.connected ? `✔ connected: ${n.label}` : '✖ not reachable — built-in engine will answer';
  $('#api-status').style.color = n && n.connected ? 'var(--acc2)' : 'var(--warn)';
  refreshProviderChip();
};
$('#btn-save-prompt').onclick = async () => {
  await send({ type: 'tb-settings-set', patch: { customSystemPrompt: $('#set-prompt').value } });
  toast('System prompt saved — every connected LLM will act with it');
};
$('#btn-reset-prompt').onclick = async () => {
  await send({ type: 'tb-settings-set', patch: { customSystemPrompt: '' } });
  $('#set-prompt').value = '';
  toast('Factory sales-master prompt restored');
};
$('#btn-save-settings').onclick = async () => {
  await send({ type: 'tb-settings-set', patch: settingsPatchFromForm() });
  toast('Settings saved');
};

// ------------------------------------------------------------------- boot

(async function boot() {
  await loadChats();
  const res = await send({ type: 'mt-stats' });
  if (res && res.ok) {
    $('#side-stats').innerHTML =
      `${esc(res.chatExperience.turns)} chat turns · ${esc(res.knowledgeCore.topics)} topics<br>` +
      `${esc(res.salesPlaybook.tactics)} sales tactics · ${esc(res.bookshelf.books)} books<br>` +
      `${esc(res.memory.pages)} pages remembered`;
  }
  refreshProviderChip();
  if (!chats.length) $('#btn-new-chat').click();
  else openChat(chats[0].id);
  const params = new URLSearchParams(location.search);
  if (params.get('welcome')) {
    toast('Welcome! Ask me anything — or record your first Facebook flow in Automate.', 6000);
  }
  const autoAsk = params.get('ask');
  if (autoAsk) {
    $('#chat-input').value = autoAsk;
    setTimeout(() => sendChat(), 300);
  }
})();
