/**
 * Twin-Brain popup — quick answers straight from the toolbar.
 *
 * Talks to the background worker only (never to the backend directly), so the
 * exclusion engine and the offline outbox stay in one place.
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

function escapeHtml(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Render answer text, turning bare URLs and [n] markers into links. */
function renderAnswerText(container, text, citations) {
  container.textContent = '';
  const lines = String(text || '').split('\n');
  lines.forEach((line) => {
    const p = el('div');
    let remaining = line;
    // [1] style citation markers -> superscript links to the source chip
    const parts = remaining.split(/(\[\d+\])/g);
    parts.forEach((part) => {
      const marker = part.match(/^\[(\d+)\]$/);
      if (marker) {
        const idx = Number(marker[1]);
        const cite = (citations || []).find((c) => c.index === idx);
        const link = el('a', 'cite-ref', `[${idx}]`);
        link.href = cite ? cite.url : '#';
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.title = cite ? `${cite.title} — ${cite.domain}` : '';
        p.appendChild(link);
        return;
      }
      // bare URLs -> clickable
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

  const dot = $('#status-dot');
  dot.className = `dot ${response.backend && response.backend.ok ? 'dot-ok' : 'dot-bad'}`;
  dot.title = response.backend && response.backend.ok
    ? `backend online — ${response.backend.stats ? response.backend.stats.pages.toLocaleString() : 0} pages in memory`
    : `backend offline (${response.backend ? response.backend.error : 'unknown'})`;

  const pauseBtn = $('#btn-pause');
  const paused = Boolean(response.settings.globalPause || !response.settings.captureEnabled);
  pauseBtn.classList.toggle('paused', paused);
  $('#pause-label').textContent = paused ? '▶' : '⏸';
  pauseBtn.title = paused ? 'Capture is PAUSED — click to resume' : 'Pause capture';

  const counts = response.counts || {};
  $('#counts').textContent = counts.captured
    ? `${counts.captured} remembered today` : 'nothing captured yet today';
  $('#queue').textContent = counts.queued ? `${counts.queued} queued (backend down)` : '';

  const base = (response.settings.backendUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '');
  $('#dashboard-link').href = `${base}/`;
  $('#web-toggle').checked = Boolean(response.settings.webSearchEnabled &&
                                     response.settings.useWebForAnswers);
  $('#style').value = response.settings.answerStyle || 'concise';
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

function renderAnswer(node, data, query) {
  node.className = `msg bot ${data.grounded ? 'grounded' : 'ungrounded'}${data.error ? ' error' : ''}`;
  node.textContent = '';

  const text = el('div', 'text');
  renderAnswerText(text, data.answer || data.error || 'No answer.', data.citations || []);
  node.appendChild(text);

  const citations = data.citations || [];
  if (citations.length) {
    const box = el('div', 'cites');
    citations.slice(0, 6).forEach((cite) => {
      const row = el('div', 'cite');
      row.appendChild(el('span', 'idx', String(cite.index)));
      const main = el('div', 'row');
      const a = el('a', null, cite.title || cite.url);
      a.href = cite.url; a.target = '_blank'; a.rel = 'noreferrer';
      main.appendChild(a);
      const site = el('span', 'site',
        `${(cite.domain || '').replace(/^www\./, '')} · visited ${cite.visited_ago || '—'}` +
        (cite.dwell_seconds ? ` · ${Math.round(cite.dwell_seconds / 60)}m on page` : ''));
      main.appendChild(site);
      row.appendChild(main);
      box.appendChild(row);
    });
    node.appendChild(box);
  }

  const meta = el('div', 'meta');
  const groundedBadge = el('span', `badge ${data.grounded ? 'ok' : 'warn'}`,
    data.grounded ? 'grounded' : 'no match in memory');
  meta.appendChild(groundedBadge);
  if (data.confidence) meta.appendChild(el('span', 'badge', `confidence: ${data.confidence}`));
  const retrieval = data.retrieval || {};
  if (retrieval.engine) {
    meta.appendChild(el('span', 'badge',
      `${retrieval.count || 0} sources · ${retrieval.engine.took_ms}ms · ${retrieval.engine.embedder || ''}`));
  }
  if (retrieval.time_label) meta.appendChild(el('span', 'badge', `window: ${retrieval.time_label}`));
  if (data.used_web) meta.appendChild(el('span', 'badge warn', 'used web search'));
  meta.appendChild(el('span', 'badge', `${data.latency_ms || 0}ms total`));
  if (data.provider) meta.appendChild(el('span', 'badge', data.provider));
  node.appendChild(meta);

  // offline / thin-memory helper
  if (!data.grounded && !citations.length) {
    const hint = el('div', 'meta');
    const btn = el('button', 'chip', 'widen the search');
    btn.addEventListener('click', () => ask(`${query} (search all time)`, { widen: true }));
    hint.appendChild(btn);
    node.appendChild(hint);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showSources(data) {
  const retrieval = data.retrieval || {};
  const results = retrieval.results || [];
  if (!results.length) { sourcesBar.classList.add('hidden'); return; }
  sourcesBar.textContent = '';
  sourcesBar.appendChild(el('span', null, `${results.length} retrieved:`));
  results.slice(0, 3).forEach((item) => {
    const chip = el('span', 'badge', `${item.title.slice(0, 28)}${item.title.length > 28 ? '…' : ''}`);
    chip.title = `${item.title}\n${item.domain}\nrelevance ${(item.scores.relevance * 100).toFixed(0)}%`;
    sourcesBar.appendChild(chip);
  });
  sourcesBar.classList.remove('hidden');
}

async function ask(query, options = {}) {
  const text = (query || inputEl.value || '').trim();
  if (!text || state.busy) return;
  state.busy = true;
  sendEl.disabled = true;
  inputEl.value = '';
  autoGrow();
  addUserMessage(text);
  const thinking = addThinking();

  const useWeb = options.useWeb !== undefined ? options.useWeb : $('#web-toggle').checked;
  const response = await send('tb-query', {
    query: text,
    options: {
      style: $('#style').value,
      use_web: useWeb,
      top_k: options.widen ? 12 : undefined
    }
  });

  thinking.remove();
  const node = el('div', 'msg bot');
  messagesEl.appendChild(node);

  if (!response.ok) {
    node.className = 'msg bot error';
    node.appendChild(el('div', 'text',
      response.offline
        ? 'The Twin-Brain backend is not reachable. Your captures are queued locally and will be stored as soon as it is running again.\n\nStart it with:  ./run.sh'
        : `Error: ${response.error}`));
    sourcesBar.classList.add('hidden');
  } else {
    renderAnswer(node, response, text);
    showSources(response);
  }
  state.busy = false;
  sendEl.disabled = false;
  inputEl.focus();
  refreshStatus();
}

async function loadSuggestions() {
  const response = await send('tb-suggestions');
  const items = (response.ok && response.suggestions) ? response.suggestions : [
    'What did I read today?', 'What are my top interests?', 'Summarise my day'
  ];
  suggestionsEl.textContent = '';
  items.slice(0, 5).forEach((text) => {
    const chip = el('button', 'chip', text);
    chip.type = 'button';
    chip.addEventListener('click', () => ask(text));
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
  const response = await send('tb-pages', { params: { limit: 40, since: since.getTime() / 1000 } });
  listEl.textContent = '';
  const pages = (response.ok && response.pages) ? response.pages : [];
  $('#today-count').textContent = pages.length
    ? `${pages.length} page(s) today` : 'nothing captured today';
  if (!pages.length) {
    listEl.appendChild(el('div', 'muted',
      response.offline ? 'Backend offline — showing nothing.' : 'No pages yet today.'));
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
      (page.assistant_fetched ? ' · assistant-fetched' : '')));
    row.appendChild(main);
    const actions = el('div', 'actions');
    const askBtn = el('button', 'mini ask', 'ask');
    askBtn.title = 'Ask about this page';
    askBtn.addEventListener('click', () => {
      switchTab('ask');
      ask(`What did I read on "${(page.title || '').slice(0, 60)}"?`);
    });
    const forgetBtn = el('button', 'mini', 'forget');
    forgetBtn.title = 'Delete this page from memory and never capture it again';
    forgetBtn.addEventListener('click', async () => {
      const result = await send('tb-forget', { url: page.url, reason: 'popup' });
      row.remove();
      toast(result.ok ? 'Forgotten — deleted and blocked from re-capture.' : 'Forget failed', !result.ok);
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

  // merge the server's view (what is stored) with the extension's local view
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
