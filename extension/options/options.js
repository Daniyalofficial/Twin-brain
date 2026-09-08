/**
 * Twin-Brain options page — the privacy console.
 *
 * This is where "which sites may the AI read" is answered. Every site you have
 * visited is listed with a three-state control, and the list works even when the
 * backend is offline (the extension keeps its own record of domain names).
 */

import { DEFAULT_BLOCKLIST, DEFAULT_BLOCKLIST_CATEGORIES, DOMAIN_MODES } from '../lib/defaults.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

let settings = {};
let siteRows = [];
let siteLimit = 150;

function send(type, payload = {}) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(Object.assign({ type }, payload), (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message, offline: true });
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
  const node = $('#toast');
  node.textContent = text;
  node.classList.toggle('bad', bad);
  node.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), 3600);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function stat(key, value, sub) {
  const box = el('div', 'stat');
  box.appendChild(el('div', 'k', key));
  const v = el('div', 'v', String(value));
  if (sub) v.appendChild(el('small', null, ` ${sub}`));
  box.appendChild(v);
  return box;
}

// ---------------------------------------------------------------------------
// settings binding
// ---------------------------------------------------------------------------

const SWITCHES = ['captureEnabled', 'captureContent', 'globalPause', 'skipSensitiveUrls',
                  'webSearchEnabled', 'useWebForAnswers', 'enrichmentEnabled',
                  'notificationsEnabled', 'webDeepRead', 'autoEnrich',
                  'neuralEnabled', 'sendMemoryToCloud'];
const NUMBERS = ['minDwellSeconds', 'retentionDays', 'notificationDailyBudget',
                 'enrichmentDailyBudget', 'webSearchDailyBudget', 'digestHour', 'topK',
                 'researchHops'];
const TEXTS = ['backendUrl', 'token', 'userName', 'ollamaUrl', 'ollamaModel',
               'openaiUrl', 'openaiKey', 'openaiModel'];
const SELECTS = ['answerStyle', 'webPermission', 'talkativeness', 'neuralBackend'];

let saveTimer = null;
function scheduleSave(patch, label) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const response = await send('tb-settings-set', { patch });
    if (response.ok) {
      settings = response.settings;
      if (label) toast(label);
      refreshStatus();
    } else {
      toast(`Could not save: ${response.error}`, true);
    }
  }, 260);
}

function bindSettings() {
  SWITCHES.forEach((key) => {
    const node = $(`#set-${key}`);
    if (!node) return;
    node.checked = Boolean(settings[key]);
    node.onchange = () => scheduleSave({ [key]: node.checked },
      key === 'globalPause'
        ? (node.checked ? 'Capture paused — nothing is being recorded.' : 'Capture resumed.')
        : null);
  });
  NUMBERS.forEach((key) => {
    const node = $(`#set-${key}`);
    if (!node) return;
    node.value = settings[key] !== undefined ? settings[key] : '';
    node.onchange = () => scheduleSave({ [key]: Number(node.value) });
  });
  TEXTS.forEach((key) => {
    const node = $(`#set-${key}`);
    if (!node) return;
    if (key === 'token') node.value = settings.tokenRaw || '';
    else node.value = settings[key] || '';
    node.onchange = () => scheduleSave({ [key]: node.value.trim() });
  });
  SELECTS.forEach((key) => {
    const node = $(`#set-${key}`);
    if (!node) return;
    node.value = settings[key] || 'concise';
    node.onchange = () => scheduleSave({ [key]: node.value });
  });
  $('#welcome-dwell').textContent = settings.minDwellSeconds || 5;
}

async function loadSettings() {
  const response = await send('tb-settings-get');
  if (response.ok) {
    settings = response.settings;
    // keep the raw token locally so the field is editable
    const raw = await chrome.storage.local.get('settings');
    settings.tokenRaw = (raw.settings && raw.settings.token) || '';
  }
  bindSettings();
}

// ---------------------------------------------------------------------------
// status / stats / engine
// ---------------------------------------------------------------------------

async function refreshStatus() {
  const response = await send('tb-status');
  const pill = $('#backend-pill');
  const memory = $('#memory-pill');
  if (response.ok && response.backend && response.backend.ok) {
    pill.className = 'pill pill-ok';
    pill.textContent = 'backend online';
    const stats = response.backend.stats || {};
    memory.textContent = `${(stats.pages || 0).toLocaleString()} pages · ` +
      `${(stats.chunks || 0).toLocaleString()} chunks · ${fmtBytes(stats.db_bytes)}`;
    renderBudgets(response.backend.budgets || {});
    renderCaptureStats(stats, response.counts || {});
    renderDataStats(stats);
  } else {
    pill.className = 'pill pill-bad';
    pill.textContent = 'backend offline';
    memory.textContent = response.ok && response.counts
      ? `${response.counts.queued || 0} capture(s) queued locally`
      : '–';
    renderCaptureStats({}, response.ok ? response.counts || {} : {});
  }
  $('#btn-dashboard').onclick = () => {
    const base = String(settings.backendUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '');
    window.open(`${base}/`, '_blank', 'noreferrer');
  };
  loadEngine();
}

function renderBudgets(budgets) {
  const box = $('#budgets');
  box.textContent = '';
  const items = [
    ['Notifications today', budgets.notifications, 'used / budget'],
    ['Enrichment runs today', budgets.enrichment, 'used / budget'],
    ['Web searches today', budgets.web_search, 'used / budget']
  ];
  items.forEach(([label, data]) => {
    if (!data) return;
    box.appendChild(stat(label, `${data.used}`, `of ${data.budget} allowed today`));
  });
}

function renderCaptureStats(stats, counts) {
  const box = $('#capture-stats');
  box.textContent = '';
  box.appendChild(stat('Remembered today', counts.captured || 0));
  box.appendChild(stat('Skipped by rules', counts.skipped || 0));
  box.appendChild(stat('Waiting for backend', counts.queued || 0));
  if (stats.total_dwell_seconds) {
    box.appendChild(stat('Reading time stored', fmtDuration(stats.total_dwell_seconds)));
  }
}

function renderDataStats(stats) {
  const box = $('#data-stats');
  box.textContent = '';
  box.appendChild(stat('Pages', (stats.pages || 0).toLocaleString()));
  box.appendChild(stat('Visits logged', (stats.visits || 0).toLocaleString()));
  box.appendChild(stat('Words of your reading', (stats.total_words || 0).toLocaleString()));
  box.appendChild(stat('Sites', (stats.domains || 0).toLocaleString()));
  box.appendChild(stat('Blocked domains', (stats.excluded_domains || 0).toLocaleString()));
  box.appendChild(stat('Hidden from AI', (stats.hidden_from_ai || 0).toLocaleString()));
  box.appendChild(stat('Questions answered', (stats.conversations || 0).toLocaleString()));
  box.appendChild(stat('Things forgotten', (stats.forgotten || 0).toLocaleString()));
  box.appendChild(stat('Database size', fmtBytes(stats.db_bytes)));
}

/** Explain which optional upgrades are missing, in plain words. */
function upgradeNotes(response) {
  const notes = [];
  const embedder = response.embedder || {};
  const selection = embedder.selection || {};
  if (selection.st_error) notes.push(`sentence-transformers: ${selection.st_error}`);
  if (selection.api_error) notes.push(`hosted embeddings: ${selection.api_error}`);
  const llmSelection = (response.llm || {}).selection || {};
  if (llmSelection.anthropic_error) notes.push(`Claude: ${llmSelection.anthropic_error}`);
  if (llmSelection.openai_error) notes.push(`OpenAI-compatible: ${llmSelection.openai_error}`);
  if ((response.web_search || {}).provider === 'none') notes.push('web search: no provider configured');
  return notes.join(' · ') || 'none — running fully offline';
}

async function loadEngine() {
  const response = await send('tb-engine');
  const box = $('#engine');
  box.textContent = '';
  if (!response.ok) {
    box.appendChild(el('div', 'muted', 'Backend offline — engine details unavailable.'));
    return;
  }
  const rows = [
    ['Answer engine', `${response.llm ? response.llm.name : '?'} · ${response.llm ? response.llm.model : ''}`],
    ['Embeddings', `${response.embedder ? response.embedder.name : '?'} · dim ${response.embedder ? response.embedder.dim : '?'}` +
      (response.embedder && response.embedder.local === false ? ' (hosted — text leaves your machine)' : ' (local, private)')],
    ['Vector index', `${response.vector ? response.vector.backend : '?'} · ` +
      `${response.vector ? (response.vector.knn_indexed || 0).toLocaleString() : 0} vectors indexed`],
    ['Lexical index', `${response.lexical ? response.lexical.backend : '?'} (BM25, porter stemming)`],
    ['Web search provider', `${response.web_search ? response.web_search.provider : '?'} · ` +
      `${response.web_search && response.web_search.enabled ? 'enabled' : 'disabled'}`],
    ['Scheduler', response.scheduler && response.scheduler.running ? 'running' : 'stopped'],
    ['Database', response.vector ? response.vector.db_path : ''],
    ['Upgrades not installed', upgradeNotes(response)]
  ];
  rows.forEach(([key, value]) => {
    if (!value) return;
    const row = el('div', 'kv');
    row.appendChild(el('b', null, key));
    row.appendChild(el('span', null, String(value)));
    box.appendChild(row);
  });
  if (response.llm) {
    $('#provider-note').textContent = response.llm.name === 'extractive'
      ? 'Currently: the offline grounded engine. It quotes only what you read, so it cannot invent a memory.'
      : `Currently: ${response.llm.name} (${response.llm.model}). Every provider gets the same retrieval-limited prompt.`;
  }
}

// ---------------------------------------------------------------------------
// sites table
// ---------------------------------------------------------------------------

async function loadSites() {
  const response = await send('tb-domains', { query: $('#site-search').value.trim() });
  const merged = new Map();
  (response.domains || []).forEach((row) => {
    const key = row.registrable || row.domain;
    if (key) merged.set(key, Object.assign({}, row));
  });
  (response.local || []).forEach((row) => {
    const key = row.registrable || row.domain;
    if (!key) return;
    if (merged.has(key)) {
      const existing = merged.get(key);
      existing.localVisits = row.visits;
    } else {
      merged.set(key, Object.assign({}, row));
    }
  });
  siteRows = Array.from(merged.values()).sort((a, b) => {
    const av = a.visit_count || a.visits || 0;
    const bv = b.visit_count || b.visits || 0;
    if (bv !== av) return bv - av;
    return String(a.domain).localeCompare(String(b.domain));
  });
  siteLimit = 150;
  renderSites();
}

function renderSites() {
  const modeFilter = $('#site-mode-filter').value;
  const box = $('#site-table');
  box.textContent = '';
  const filtered = siteRows.filter((row) => !modeFilter || (row.mode || 'full') === modeFilter);

  const counts = { full: 0, no_ai: 0, off: 0 };
  siteRows.forEach((row) => { counts[row.mode || 'full'] = (counts[row.mode || 'full'] || 0) + 1; });
  const summary = $('#site-summary');
  summary.textContent = '';
  summary.appendChild(el('span', 'pill', `${siteRows.length} sites known`));
  summary.appendChild(el('span', 'pill pill-ok', `${counts.full || 0} remembered`));
  summary.appendChild(el('span', 'pill', `${counts.no_ai || 0} hidden from AI`));
  summary.appendChild(el('span', 'pill pill-bad', `${counts.off || 0} blocked`));

  if (!filtered.length) {
    box.appendChild(el('div', 'muted', 'No sites match that filter.'));
    $('#site-more').classList.add('hidden');
    return;
  }

  filtered.slice(0, siteLimit).forEach((row) => {
    const domain = row.registrable || row.domain;
    const mode = row.mode || 'full';
    const item = el('div', `site-row ${mode}`);

    const left = el('div');
    left.appendChild(el('div', 'name', domain));
    const visits = row.visit_count || row.visits || 0;
    const pages = row.page_count || 0;
    const bits = [`${visits} visit${visits === 1 ? '' : 's'}`];
    if (pages) bits.push(`${pages} page${pages === 1 ? '' : 's'} stored`);
    else bits.push('nothing stored');
    if (row.category) bits.push(`default list: ${DEFAULT_BLOCKLIST_CATEGORIES[row.category] || row.category}`);
    if (row.last_seen_ago) bits.push(`last ${row.last_seen_ago}`);
    left.appendChild(el('div', 'meta', bits.join(' · ')));
    item.appendChild(left);

    const select = el('select');
    select.title = DOMAIN_MODES[mode] ? DOMAIN_MODES[mode].description : '';
    Object.values(DOMAIN_MODES).forEach((option) => {
      const opt = el('option', null, option.short);
      opt.value = option.id;
      opt.title = option.description;
      if (option.id === mode) opt.selected = true;
      select.appendChild(opt);
    });
    select.onchange = async () => {
      select.disabled = true;
      const next = select.value;
      const result = await send('tb-domain-mode', { domain, mode: next });
      select.disabled = false;
      row.mode = next;
      item.className = `site-row ${next}`;
      if (result.ok) {
        toast(next === 'off'
          ? `${domain} blocked — nothing recorded, stored pages deleted.`
          : next === 'no_ai'
            ? `${domain} hidden from the AI — links kept, content never shown.`
            : `${domain} is remembered again.`);
        if (next === 'off') { loadSites(); refreshStatus(); }
      } else {
        toast(`Failed: ${result.error}`, true);
      }
      renderSites();
    };
    item.appendChild(select);

    const badge = el('span', 'badge-src',
      row.source === 'default' ? 'default' : row.in_memory ? 'stored' : 'seen');
    badge.title = row.source === 'default'
      ? 'Blocked by the shipped default list — you can change it'
      : row.in_memory ? 'This site has pages in your memory' : 'Seen by the extension only';
    item.appendChild(badge);

    box.appendChild(item);
  });

  const more = $('#site-more');
  if (filtered.length > siteLimit) {
    more.classList.remove('hidden');
    $('#btn-site-more').textContent = `show ${Math.min(150, filtered.length - siteLimit)} more`;
  } else {
    more.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// knowledge growth
// ---------------------------------------------------------------------------

async function loadAudit() {
  const box = $('#audit');
  box.classList.remove('hidden');
  box.textContent = 'loading…';
  const response = await send('tb-audit');
  box.textContent = '';
  if (!response.ok) {
    box.appendChild(el('div', 'muted', `Backend offline (${response.error}).`));
    return;
  }
  const runs = response.audit || response.runs || [];
  if (!runs.length) {
    box.appendChild(el('div', 'muted', 'No outbound searches yet.'));
    return;
  }
  const table = el('table');
  const head = el('tr');
  ['When', 'Kind', 'Query sent', 'Provider', 'Status'].forEach((label) => head.appendChild(el('th', null, label)));
  table.appendChild(head);
  runs.slice(0, 100).forEach((run) => {
    const row = el('tr');
    row.appendChild(el('td', null, run.created_at || ''));
    row.appendChild(el('td', null, run.kind || ''));
    row.appendChild(el('td', null, run.query || ''));
    row.appendChild(el('td', null, run.provider || ''));
    row.appendChild(el('td', null, run.status || ''));
    table.appendChild(row);
  });
  box.appendChild(table);
}

// ---------------------------------------------------------------------------
// data actions
// ---------------------------------------------------------------------------

function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function doExport() {
  const button = $('#btn-export');
  button.disabled = true;
  button.textContent = 'exporting…';
  const response = await send('tb-export', { includeText: true });
  button.disabled = false;
  button.textContent = 'Export all memory as JSON';
  if (!response.ok) { toast(`Export failed: ${response.error}`, true); return; }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  download(`twinbrain-export-${stamp}.json`, JSON.stringify(response, null, 1));
  toast(`Exported ${(response.pages || []).length} pages.`);
}

async function doImport(file) {
  const text = await file.text();
  let dump;
  try { dump = JSON.parse(text); } catch { toast('That file is not valid JSON.', true); return; }
  toast('Importing… this can take a minute.');
  const response = await send('tb-import', { dump });
  if (response.ok) {
    toast(`Imported ${response.pages || 0} page(s).`);
    refreshStatus();
    loadSites();
  } else {
    toast(`Import failed: ${response.error}`, true);
  }
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

function init() {
  if (new URLSearchParams(location.search).get('welcome')) $('#welcome').classList.remove('hidden');
  $('#version').textContent = `Twin-Brain extension ${chrome.runtime.getManifest().version}`;

  $('#site-search').addEventListener('input', () => {
    clearTimeout(window.__t);
    window.__t = setTimeout(() => { loadSites(); }, 250);
  });
  $('#site-mode-filter').addEventListener('change', renderSites);
  $('#btn-site-more').addEventListener('click', () => { siteLimit += 150; renderSites(); });

  $('#btn-add-domain').addEventListener('click', () => {
    $('#add-domain').classList.remove('hidden');
    $('#new-domain').focus();
  });
  $('#btn-add-cancel').addEventListener('click', () => $('#add-domain').classList.add('hidden'));
  $('#btn-add-confirm').addEventListener('click', async () => {
    const value = $('#new-domain').value.trim().toLowerCase()
      .replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    if (!value) { toast('Enter a domain like example.com', true); return; }
    const mode = $('#new-mode').value;
    const result = await send('tb-domain-mode', { domain: value, mode });
    if (result.ok) {
      toast(`${value} → ${DOMAIN_MODES[mode].label}`);
      $('#new-domain').value = '';
      $('#add-domain').classList.add('hidden');
      loadSites();
      refreshStatus();
    } else {
      toast(`Failed: ${result.error}`, true);
    }
  });

  $('#btn-restore-defaults').addEventListener('click', async () => {
    const domains = Object.keys(DEFAULT_BLOCKLIST);
    let changed = 0;
    for (const domain of domains) {           // sequential: keeps the backend calm
      const current = siteRows.find((row) => (row.registrable || row.domain) === domain);
      if (!current || current.mode !== 'off') {
        const result = await send('tb-domain-mode', { domain, mode: 'off' });
        if (result.ok) changed += 1;
      }
    }
    toast(`Default blocklist restored (${changed} site(s) changed).`);
    loadSites();
    refreshStatus();
  });

  $('#btn-run-enrichment').addEventListener('click', async (event) => {
    event.target.disabled = true;
    const response = await send('tb-enrich', { daily: false });
    event.target.disabled = false;
    if (!response.ok) { toast(`Enrichment failed: ${response.error}`, true); return; }
    if (response.status === 'budget') {
      toast('Daily enrichment budget is used up. It resets at midnight.', true);
    } else if (response.status === 'no_new_info') {
      toast('Searched, but nothing genuinely new for you.');
    } else {
      toast(`Found ${response.novel || 0} new item(s) about “${(response.candidate || {}).topic}”.`);
    }
    refreshStatus();
    loadAudit();
  });

  $('#btn-run-digest').addEventListener('click', async (event) => {
    event.target.disabled = true;
    const response = await send('tb-run-job', { job: 'digest' });
    event.target.disabled = false;
    toast(response.ok ? "Today's recap built — check your notifications or the dashboard."
      : `Failed: ${response.error}`, !response.ok);
  });

  $('#btn-audit').addEventListener('click', () => {
    const box = $('#audit');
    if (box.classList.contains('hidden')) loadAudit();
    else box.classList.add('hidden');
  });

  $('#btn-export').addEventListener('click', doExport);
  $('#import-file').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) doImport(file);
    event.target.value = '';
  });

  $('#btn-reindex').addEventListener('click', async (event) => {
    event.target.disabled = true;
    event.target.textContent = 'rebuilding…';
    const response = await send('tb-run-job', { job: 'reindex_all' });
    event.target.disabled = false;
    event.target.textContent = 'Rebuild search index';
    toast(response.ok
      ? `Index rebuilt: ${response.pages || 0} pages, ${response.chunks || 0} chunks.`
      : `Failed: ${response.error}`, !response.ok);
    refreshStatus();
  });

  $('#btn-wipe').addEventListener('click', () => $('#wipe-box').classList.remove('hidden'));
  $('#btn-wipe-cancel').addEventListener('click', () => {
    $('#wipe-box').classList.add('hidden');
    $('#wipe-confirm').value = '';
  });
  $('#btn-wipe-confirm').addEventListener('click', async () => {
    const confirmText = $('#wipe-confirm').value.trim();
    if (confirmText.toUpperCase() !== 'DELETE ALL') {
      toast('Type DELETE ALL to confirm.', true);
      return;
    }
    const response = await send('tb-wipe', { confirm: confirmText,
                                             keepSettings: $('#wipe-keep-settings').checked });
    if (response.ok) {
      toast('Everything deleted.');
      $('#wipe-box').classList.add('hidden');
      $('#wipe-confirm').value = '';
      refreshStatus();
      loadSites();
    } else {
      toast(`Wipe failed: ${response.error}`, true);
    }
  });

  $('#btn-pair').addEventListener('click', async () => {
    const response = await send('tb-pair');
    if (response.ok && response.token) {
      $('#set-token').value = response.token;
      settings.tokenRaw = response.token;
      scheduleSave({ token: response.token }, 'Connected to the local backend.');
      refreshStatus();
    } else {
      toast('Auto-fill failed. Is the backend running? Copy the token from data/token.txt.', true);
    }
  });

  $('#btn-test').addEventListener('click', async () => {
    const result = $('#connection-result');
    result.className = 'result';
    result.textContent = 'testing…';
    const response = await send('tb-stats');
    if (response.ok) {
      result.className = 'result ok';
      const stats = response.stats || {};
      result.textContent = `Connected. ${(stats.pages || 0).toLocaleString()} pages, ` +
        `${(stats.chunks || 0).toLocaleString()} chunks, ${fmtBytes(stats.db_bytes)} on disk.`;
    } else {
      result.className = 'result bad';
      result.textContent = `Not reachable: ${response.error}` +
        (response.offline ? ' — start the backend with ./run.sh' : '');
    }
  });

  $('#set-provider').addEventListener('change', async (event) => {
    const response = await send('tb-provider', { provider: event.target.value });
    if (response.ok) {
      toast(`Answer engine: ${response.name || response.requested}`);
      loadEngine();
    } else {
      toast(`Could not switch: ${response.error}`, true);
      loadEngine();
    }
  });

  (async () => {
    await loadSettings();
    await refreshStatus();
    await loadSites();
    await loadBrainStats();
    wireNeuralButtons();
  })();
}

function wireNeuralButtons() {
  const testBtn = $('#btn-neural-test');
  if (testBtn) testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    $('#neural-status').textContent = 'Probing local model servers…';
    const response = await send('tb-neural-status');
    testBtn.disabled = false;
    if (response.ok && response.neural) {
      const n = response.neural;
      $('#neural-status').textContent = n.connected
        ? `✅ Connected: ${n.label} — every answer now streams from this real model, grounded in your memory.`
        : `ℹ️ ${n.label}. Start Ollama (ollama serve) or set an OpenAI-compatible URL, then test again. Everything still works on-device meanwhile.`;
    } else {
      $('#neural-status').textContent = `Could not test: ${response.error || 'unknown error'}`;
    }
  });
  const mfBtn = $('#btn-modelfile');
  if (mfBtn) mfBtn.addEventListener('click', async () => {
    mfBtn.disabled = true;
    const response = await send('tb-modelfile');
    mfBtn.disabled = false;
    if (!response.ok) { toast(`Export failed: ${response.error}`, true); return; }
    const blob = new Blob([response.modelfile], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'twinbrain.Modelfile';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('twinbrain.Modelfile downloaded — run: ollama create twinbrain -f twinbrain.Modelfile');
  });
}

async function loadBrainStats() {
  const node = $('#brain-stats');
  if (!node) return;
  const response = await send('tb-stats');
  if (response.ok && response.stats) {
    const s = response.stats;
    const budget = s.web_budget || {};
    node.textContent = `On-device memory: ${s.pages} page(s), ${s.chunks} slice(s), ` +
      `${fmtDuration(s.dwellSeconds)} of reading, ${s.interests} tracked interest(s). ` +
      `Web budget today: ${budget.used || 0}/${budget.budget || 0}. ` +
      `Everything above runs in this browser alone.`;
  } else {
    node.textContent = 'Could not read on-device stats (reload the extension and try again).';
  }
}

document.addEventListener('DOMContentLoaded', init);
