/**
 * Twin-Brain popup — your AI friend lives right here in the toolbar.
 *
 * Talks to the background worker only. The answers come from the ON-DEVICE
 * brain (IndexedDB + local retrieval), so this works with no backend and no
 * internet. The web is consulted only with your permission — the ask flow has
 * its own card below the answer.
 */

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const messagesEl = $('#messages');
const inputEl = $('#ask-input');
const sendEl = $('#ask-send');
const emptyEl = $('#empty-state');
const suggestionsEl = $('#suggestions');
const sourcesBar = $('#sources-bar');
const toastEl = $('#toast');

let state = { settings: null, counts: null, backend: null, busy: false };

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

function send(type, payload = {}) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(Object.assign({ type }, payload), (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: 'no response' });
      });
    } catch (error) {
      resolve({ ok: false, error: String(error.message || error) });
    }
  });
}

let toastTimer = null;
function toast(text, bad = false) {
  toastEl.textContent = text;
  toastEl.classList.toggle('bad', bad);
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3200);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/** Render plain answer text, turning bare URLs and [n] markers into links. */
function renderAnswerText(container, text, citations) {
  container.textContent = '';
  const lines = String(text || '').split('\n');
  lines.forEach((line) => {
    const p = el('div');
    line.split(/(\[\d+\])/g).forEach((part) => {
      const marker = part.match(/^\[(\d+)\]$/);
      if (marker) {
        const idx = Number(marker[1]);
        const cite = (citations || []).find((c) => (c.n || c.index) === idx);
        const link = el('a', 'cite-ref', `[${idx}]`);
        link.href = cite ? cite.url : '#';
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.title = cite ? `${cite.title} — ${cite.domain}` : '';
        p.appendChild(link);
        return;
      }
      part.split(/(https?:\/\/[^\s)\]]+)/g).forEach((chunk) => {
        if (/^https?:\/\//.test(chunk)) {
          const a = el('a', null, chunk.length > 58 ? `${chunk.slice(0, 55)}…` : chunk);
          a.href = chunk; a.target = '_blank'; a.rel = 'noreferrer';
          p.appendChild(a);
        } else if (chunk) {
          p.appendChild(document.createTextNode(chunk));
        }
      });
    });
    container.appendChild(p);
  });
}

// ---------------------------------------------------------------------------
// header / status
// ---------------------------------------------------------------------------

async function refreshStatus() {
  const response = await send('tb-status');
  if (!response.ok) return;
  state.settings = response.settings;
  state.counts = response.counts;
  state.backend = response.backend;

  const brainPages = (response.brain && response.brain.pages) || 0;
  const backendOk = Boolean(response.backend && response.backend.ok);
  const dot = $('#status-dot');
  dot.className = `dot ${brainPages || backendOk ? 'dot-ok' : 'dot-bad'}`;
  dot.title = brainPages
    ? `on-device memory: ${brainPages} page(s) — works offline` +
      (backendOk ? ' · backend mirror online' : '')
    : 'memory is empty — browse a page for a few seconds and I will learn it';

  const pauseBtn = $('#btn-pause');
  const paused = Boolean(response.settings.globalPause || !response.settings.captureEnabled);
  pauseBtn.classList.toggle('paused', paused);
  $('#pause-label').textContent = paused ? '▶' : '⏸';
  pauseBtn.title = paused ? 'Capture is PAUSED — click to resume' : 'Pause capture';

  const counts = response.counts || {};
  $('#counts').textContent = brainPages
    ? `${brainPages} page(s) in your on-device brain` +
      (counts.captured ? ` · ${counts.captured} captured today` : '')
    : 'nothing remembered yet';
  $('#queue').textContent = counts.queued ? `${counts.queued} queued for backend mirror` : '';

  const base = (response.settings.backendUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '');
  $('#dashboard-link').href = `${base}/`;
  $('#web-toggle').checked = String(response.settings.webPermission) === 'always';
  $('#web-toggle').title = response.settings.webPermission === 'always'
    ? 'Web lookups are always allowed'
    : 'Check this (or pick "Always allow" below an answer) to let me search the web';
}

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

function addUserMessage(text) {
  emptyEl.classList.add('hidden');
  const node = el('div', 'msg user');
  node.appendChild(el('div', 'text', text));
  messagesEl.appendChild(node);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return node;
}

function addThinking() {
  const node = el('div', 'msg bot');
  const inner = el('div', 'thinking');
  inner.appendChild(el('span', 'pulse'));
  inner.appendChild(el('span', null, 'searching your memory…'));
  node.appendChild(inner);
  messagesEl.appendChild(node);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return node;
}

function addMeta(node, data) {
  const meta = el('div', 'meta');
  meta.appendChild(el('span', `badge ${data.grounded ? 'ok' : 'warn'}`,
    data.grounded ? 'from your memory' : 'not in memory'));
  const retrieval = data.retrieval || {};
  if (retrieval.engine) {
    meta.appendChild(el('span', 'badge',
      `${retrieval.count || 0} source(s) · ${retrieval.tookMs || 0}ms · on-device`));
  }
  if (data.usedWeb) meta.appendChild(el('span', 'badge warn', 'web used (with permission)'));
  meta.appendChild(el('span', 'badge', 'offline-ready'));
  node.appendChild(meta);
}

/** Sectioned "super explainer" rendering. */
function renderExplanation(node, data, query) {
  const ex = data.explanation || {};
  node.className = `msg bot ${data.grounded ? 'grounded' : 'ungrounded'}`;
  node.textContent = '';

  if (ex.opener) node.appendChild(el('div', 'opener', ex.opener));

  if (ex.simple) {
    const block = el('div', 'simple');
    block.appendChild(el('div', 'label', 'In simple words'));
    const p = el('div', 'text');
    renderAnswerText(p, ex.simple, ex.citations);
    block.appendChild(p);
    node.appendChild(block);
  }

  if (data.adviceText) {
    const block = el('div', 'advice');
    renderAnswerText(block, data.adviceText, ex.citations);
    node.appendChild(block);
  }

  if (ex.points && ex.points.length) {
    const block = el('div', 'points');
    block.appendChild(el('div', 'label', 'The details'));
    const ul = el('ul');
    ex.points.forEach((point) => ul.appendChild(el('li', null, point)));
    block.appendChild(ul);
    node.appendChild(block);
  }

  if (ex.words && ex.words.length) {
    const block = el('div', 'words');
    block.appendChild(el('div', 'label', 'Tricky words, translated'));
    ex.words.forEach((word) => {
      const chip = el('div', 'word-chip');
      chip.appendChild(el('b', null, word.term));
      chip.appendChild(el('span', null, ` = ${word.plain}`));
      block.appendChild(chip);
    });
    node.appendChild(block);
  }

  if (ex.webNotes && ex.webNotes.length) {
    const block = el('div', 'webnotes');
    block.appendChild(el('div', 'label', 'From the web (you allowed this)'));
    const ul = el('ul');
    ex.webNotes.forEach((note) => {
      const li = el('li', null, note.text);
      li.appendChild(el('sup', 'cite-ref', `[${note.n}]`));
      ul.appendChild(li);
    });
    block.appendChild(ul);
    node.appendChild(block);
  }

  if (ex.connect) node.appendChild(el('div', 'connect', ex.connect));
  if (ex.webDeniedLine) node.appendChild(el('div', 'connect', ex.webDeniedLine));

  const citations = ex.citations || data.citations || [];
  if (citations.length) {
    const box = el('div', 'cites');
    box.appendChild(el('div', 'label', 'Where this comes from'));
    citations.slice(0, 8).forEach((cite) => {
      const row = el('div', 'cite');
      row.appendChild(el('span', 'idx', String(cite.n || cite.index)));
      const main = el('div', 'row');
      const a = el('a', null, cite.title || cite.url);
      a.href = cite.url; a.target = '_blank'; a.rel = 'noreferrer';
      main.appendChild(a);
      const kind = cite.kind === 'web' ? 'web' : 'memory';
      main.appendChild(el('span', `badge ${kind === 'web' ? 'warn' : 'ok'}`, kind));
      main.appendChild(el('span', 'site',
        `${(cite.domain || '').replace(/^www\./, '')} · ${cite.when || 'visited —'}` +
        (cite.dwell ? ` · ${Math.round(cite.dwell / 60)}m on page` : '')));
      row.appendChild(main);
      box.appendChild(row);
    });
    node.appendChild(box);
  }

  if (ex.further && ex.further.length) {
    const box = el('div', 'further');
    box.appendChild(el('div', 'label', 'Related reading (links at the end, as you like it)'));
    ex.further.forEach((item) => {
      const row = el('div', 'further-row');
      const a = el('a', null, item.title);
      a.href = item.url; a.target = '_blank'; a.rel = 'noreferrer';
      row.appendChild(a);
      row.appendChild(el('span', 'site', item.why || ''));
      box.appendChild(row);
    });
    node.appendChild(box);
  }

  if (ex.honesty) node.appendChild(el('div', 'honesty', ex.honesty));
  if (ex.closing) node.appendChild(el('div', 'closing', ex.closing));

  if (ex.followups && ex.followups.length) {
    const chips = el('div', 'followups');
    ex.followups.forEach((text) => {
      const chip = el('button', 'chip', text);
      chip.type = 'button';
      chip.addEventListener('click', () => ask(text, { silent: true }));
      chips.appendChild(chip);
    });
    node.appendChild(chips);
  }

  addMeta(node, data);

  // --- permission card: the AI asks before touching the internet ------------
  if (data.mode === 'needs_permission') {
    const card = el('div', 'perm-card');
    card.appendChild(el('div', 'perm-title', 'May I check the web for this?'));
    card.appendChild(el('div', 'perm-sub',
      'Nothing is in your memory about it. I will search, read the top result and explain it — only with your okay.'));
    const actions = el('div', 'perm-actions');
    const once = el('button', 'chip primary', 'Allow once');
    once.addEventListener('click', () => ask(query, { useWeb: true, silent: true }));
    const always = el('button', 'chip', 'Always allow web');
    always.addEventListener('click', async () => {
      await send('tb-web-permission', { allow: 'always' });
      $('#web-toggle').checked = true;
      toast('Web lookups are now always allowed. You can change this in Options.');
      ask(query, { useWeb: true, silent: true });
    });
    const no = el('button', 'chip', 'Not now');
    no.addEventListener('click', () => ask(query, { denied: true, silent: true }));
    actions.appendChild(once);
    actions.appendChild(always);
    actions.appendChild(no);
    card.appendChild(actions);
    node.appendChild(card);
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showSources(data) {
  const ex = data.explanation || {};
  const citations = ex.citations || data.citations || [];
  if (!citations.length) { sourcesBar.classList.add('hidden'); return; }
  sourcesBar.textContent = '';
  sourcesBar.appendChild(el('span', null, `${citations.length} source(s):`));
  citations.slice(0, 3).forEach((cite) => {
    const title = cite.title || cite.url;
    const chip = el('span', 'badge', `${title.slice(0, 28)}${title.length > 28 ? '…' : ''}`);
    chip.title = `${title}\n${cite.domain || ''}\n${cite.kind === 'web' ? 'web (permitted)' : 'your memory'}`;
    sourcesBar.appendChild(chip);
  });
  sourcesBar.classList.remove('hidden');
}

async function ask(query, options = {}) {
  const text = (query || inputEl.value || '').trim();
  if (!text || state.busy) return;
  state.busy = true;
  sendEl.disabled = true;
  if (!options.silent) { inputEl.value = ''; autoGrow(); addUserMessage(text); }
  const thinking = addThinking();

  const response = await send('tb-query', {
    query: text,
    options: {
      useWeb: options.useWeb === true || $('#web-toggle').checked,
      denied: options.denied === true,
      topK: options.widen ? 12 : 8
    }
  });

  thinking.remove();
  const node = el('div', 'msg bot');
  messagesEl.appendChild(node);

  if (!response.ok) {
    node.className = 'msg bot error';
    node.appendChild(el('div', 'text',
      `The on-device brain hit a problem: ${response.error}\n\n` +
      'Your memory itself is safe — reload the extension from chrome://extensions if this repeats.'));
    sourcesBar.classList.add('hidden');
  } else {
    renderExplanation(node, response, text);
    showSources(response);
  }
  state.busy = false;
  sendEl.disabled = false;
  inputEl.focus();
  refreshStatus();
}

async function loadSuggestions() {
  const response = await send('tb-suggestions');
  suggestionsEl.textContent = '';
  const items = (response.ok && response.suggestions) ? response.suggestions : [];
  const chips = items.length
    ? items.map((item) => (typeof item === 'string' ? { title: item } : item))
    : [
      { title: 'What did I read today?' },
      { title: 'What are my top interests?' },
      { title: 'Summarise my day' }
    ];
  chips.slice(0, 6).forEach((item) => {
    const chip = el('button', 'chip', item.title);
    chip.type = 'button';
    if (item.reason) chip.title = item.reason;
    chip.addEventListener('click', () => ask(item.title));
    suggestionsEl.appendChild(chip);
  });
}

// ---------------------------------------------------------------------------
// Today tab
// ---------------------------------------------------------------------------

async function loadToday() {
  const listEl = $('#today-list');
  listEl.textContent = '';
  listEl.appendChild(el('div', 'muted', 'loading…'));
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const response = await send('tb-pages', { params: { limit: 40, since: since.toISOString() } });
  listEl.textContent = '';
  const pages = (response.ok && response.pages) ? response.pages : [];
  $('#today-count').textContent = pages.length
    ? `${pages.length} page(s) today — stored on-device` : 'nothing captured today';
  if (!pages.length) {
    listEl.appendChild(el('div', 'muted',
      'No pages yet today. Browse something for a few seconds and it will appear here.'));
    return;
  }
  pages.forEach((page) => {
    const row = el('div', 'row-item');
    const main = el('div', 'main');
    const a = el('a', 'title', page.title || page.url);
    a.href = page.url; a.target = '_blank'; a.rel = 'noreferrer';
    main.appendChild(a);
    const minutes = Math.round((page.total_dwell_seconds || page.dwell_seconds || 0) / 60);
    main.appendChild(el('div', 'sub',
      `${page.domain_label || page.domain} · ${page.visited_ago || ''}` +
      (minutes ? ` · ${minutes}m` : '') +
      (page.visit_count > 1 ? ` · ${page.visit_count} visits` : '') +
      (page.mode === 'assistant_fetched' ? ' · assistant-fetched' : '')));
    row.appendChild(main);
    const actions = el('div', 'actions');
    const askBtn = el('button', 'mini ask', 'ask');
    askBtn.title = 'Ask about this page';
    askBtn.addEventListener('click', () => {
      switchTab('ask');
      ask(`What did I read on "${(page.title || '').slice(0, 60)}"?`);
    });
    const forgetBtn = el('button', 'mini', 'forget');
    forgetBtn.title = 'Delete this page from on-device memory and never capture it again';
    forgetBtn.addEventListener('click', async () => {
      const result = await send('tb-forget', { url: page.url, reason: 'popup' });
      row.remove();
      toast(result.ok ? 'Forgotten — deleted from this browser.' : 'Forget failed', !result.ok);
      refreshStatus();
    });
    actions.appendChild(askBtn);
    actions.appendChild(forgetBtn);
    row.appendChild(actions);
    listEl.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Sites tab
// ---------------------------------------------------------------------------

const MODE_OPTIONS = [
  { value: 'full', label: 'Remember' },
  { value: 'no_ai', label: 'Hide from AI' },
  { value: 'off', label: 'Block' }
];

async function loadSites(filter = '') {
  const listEl = $('#site-list');
  listEl.textContent = '';
  listEl.appendChild(el('div', 'muted', 'loading…'));
  const response = await send('tb-domains', { query: filter });
  listEl.textContent = '';

  const byDomain = new Map();
  (response.domains || []).forEach((row) => {
    const key = row.registrable || row.domain;
    byDomain.set(key, Object.assign({}, row));
  });
  (response.local || []).forEach((row) => {
    const key = row.registrable || row.domain;
    if (!byDomain.has(key)) byDomain.set(key, Object.assign({}, row));
  });

  const rows = Array.from(byDomain.values()).sort((a, b) =>
    (b.visit_count || b.visits || 0) - (a.visit_count || a.visits || 0));

  if (!rows.length) {
    listEl.appendChild(el('div', 'muted', 'No sites yet.'));
    return;
  }

  rows.slice(0, 400).forEach((row) => {
    const domain = row.registrable || row.domain;
    const mode = row.mode || 'full';
    const item = el('div', `row-item site-row ${mode}`);
    const main = el('div', 'main');
    main.appendChild(el('a', 'title', domain));
    const visits = row.visit_count || row.visits || 0;
    const pages = row.page_count || 0;
    main.appendChild(el('div', 'sub',
      `${visits} visit${visits === 1 ? '' : 's'}` +
      (pages ? ` · ${pages} page${pages === 1 ? '' : 's'} stored` : ' · nothing stored') +
      (row.category ? ` · default-blocked (${row.category})` : '')));
    item.appendChild(main);

    const select = el('select');
    select.title = row.mode === 'off'
      ? 'Blocked: nothing from this site is ever recorded'
      : row.mode === 'no_ai'
        ? 'Hidden from AI: the link is kept, the content is never shown to the assistant'
        : 'Remembered: captured and available to the assistant';
    MODE_OPTIONS.forEach((option) => {
      const opt = el('option', null, option.label);
      opt.value = option.value;
      if (option.value === mode) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', async () => {
      select.disabled = true;
      const result = await send('tb-domain-mode', { domain, mode: select.value });
      select.disabled = false;
      item.className = `row-item site-row ${select.value}`;
      if (result.ok) {
        toast(`${domain} → ${select.selectedOptions[0].textContent}` +
              (select.value === 'off' ? ' (stored pages deleted)' : ''));
        if (select.value === 'off') loadSites($('#site-filter').value);
      } else {
        toast(`Could not change ${domain}: ${result.error}`, true);
      }
      refreshStatus();
    });
    item.appendChild(select);
    listEl.appendChild(item);
  });
}

// ---------------------------------------------------------------------------
// tabs + wiring
// ---------------------------------------------------------------------------

function switchTab(name) {
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
  $$('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === `panel-${name}`));
  if (name === 'today') loadToday();
  if (name === 'sites') loadSites($('#site-filter').value);
  if (name === 'ask') inputEl.focus();
}

function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 110)}px`;
}

function init() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

  $('#ask-form').addEventListener('submit', (event) => {
    event.preventDefault();
    ask();
  });
  inputEl.addEventListener('input', autoGrow);
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); ask(); }
  });

  $('#web-toggle').addEventListener('change', async (event) => {
    const allow = event.target.checked ? 'always' : 'ask';
    await send('tb-web-permission', { allow });
    toast(event.target.checked
      ? 'Web lookups always allowed — I still audit every search.'
      : 'Back to asking you first before any web lookup.');
    refreshStatus();
  });

  $('#btn-pause').addEventListener('click', async () => {
    const next = !(state.settings && (state.settings.globalPause || !state.settings.captureEnabled));
    await send('tb-settings-set', { patch: { globalPause: next, captureEnabled: !next } });
    await refreshStatus();
    toast(next ? 'Capture paused — nothing is being recorded.' : 'Capture resumed.');
  });

  $('#btn-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  $('#btn-refresh').addEventListener('click', () => loadToday());
  $('#site-filter').addEventListener('input', (event) => {
    clearTimeout(window.__siteTimer);
    const value = event.target.value;
    window.__siteTimer = setTimeout(() => loadSites(value), 220);
  });
  $('#btn-all-sites').addEventListener('click', () => {
    $('#site-filter').value = '';
    loadSites('');
  });

  refreshStatus();
  loadSuggestions();
  setTimeout(() => inputEl.focus(), 60);
}

document.addEventListener('DOMContentLoaded', init);
