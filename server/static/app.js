/* Twin-Brain dashboard — plain JS, no build step.
 *
 * Everything here talks to the local backend on the same origin. The ask box
 * streams (SSE) so retrieval results appear before the answer finishes, which is
 * the "real time" part of the product: you watch your memory being searched.
 */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const TOKEN_KEY = 'twinbrain.token';

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    health: null,
    memOffset: 0,
    memQuery: '',
    memMode: '',
    currentView: 'ask'
  };

  // ---------------------------------------------------------------- helpers
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function esc(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtDuration(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
  }
  let toastTimer = null;
  function toast(text, bad) {
    const node = $('#toast');
    node.textContent = text;
    node.classList.toggle('bad', Boolean(bad));
    node.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.add('hidden'), 3800);
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json',
                                    'X-Requested-With': 'TwinBrain' }, opts.headers || {});
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error('not authorised'), { auth: true });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data });
    return data;
  }

  // ---------------------------------------------------------------- connect
  async function bootstrap() {
    $('#connect').classList.add('hidden');
    try {
      state.health = await api('/api/health');
      enter();
    } catch (error) {
      if (error.auth && state.token) {
        localStorage.removeItem(TOKEN_KEY);
        state.token = '';
      }
      // same-origin browsers may be allowed to self-pair without pasting
      try {
        const res = await fetch('/api/token');
        if (res.ok) {
          const data = await res.json();
          if (data && data.token) {
            state.token = data.token;
            localStorage.setItem(TOKEN_KEY, data.token);
            state.health = await api('/api/health');
            enter();
            return;
          }
        }
      } catch { /* fall through to manual paste */ }
      $('#app').classList.add('hidden');
      $('#connect').classList.remove('hidden');
      $('#connect-error').textContent = error.auth ? '' : String(error.message || error);
    }
  }

  function enter() {
    $('#connect').classList.add('hidden');
    $('#app').classList.remove('hidden');
    paintHealth();
    loadSuggestions();
    switchView('ask');
  }

  function paintHealth() {
    const h = state.health;
    if (!h) return;
    $('#version-tag').textContent = `v${h.version || '?'} · local-first`;
    $('#head-status').textContent = 'online';
    $('#head-status').className = 'pill pill-ok';
    const c = h.counts || {};
    $('#head-memory').textContent =
      `${(c.pages || 0).toLocaleString()} pages · ${(c.visits || 0).toLocaleString()} visits`;
    const engine = h.engine || {};
    $('#side-engine').textContent =
      `${(engine.llm || {}).name || '?'} · ${(engine.embedder || {}).name || '?'}`;
    const b = h.budgets || {};
    $('#side-budgets').textContent =
      `today: ${b.notifications ? `${b.notifications.used}/${b.notifications.budget} notes` : '–'} · ` +
      `${b.enrichment ? `${b.enrichment.used}/${b.enrichment.budget} enrich` : '–'} · ` +
      `${b.web_search ? `${b.web_search.used}/${b.web_search.budget} web` : '–'}`;
    $('#side-scheduler').textContent =
      h.scheduler && h.scheduler.running ? 'scheduler: running' : 'scheduler: stopped';
    const exportLink = $('#export-link');
    exportLink.href = `/api/export?download=1&token=${encodeURIComponent(state.token)}`;
  }

  $('#connect-btn').addEventListener('click', async () => {
    const value = $('#connect-token').value.trim();
    if (!value) return;
    state.token = value;
    localStorage.setItem(TOKEN_KEY, value);
    $('#connect-error').textContent = '';
    try {
      state.health = await api('/api/health');
      enter();
    } catch (error) {
      $('#connect-error').textContent = String(error.message || error);
    }
  });
  $('#connect-token').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('#connect-btn').click();
  });

  // ------------------------------------------------------------------- nav
  const VIEW_META = {
    ask: ['Ask your memory', 'Answers come only from pages you actually read — streaming, with sources first.'],
    memory: ['Memory', 'Every page the extension saved, newest first. Open the text, or forget it forever.'],
    sites: ['Sites & privacy', 'Decide per site what the AI may read, and what is never recorded at all.'],
    interests: ['Interests', 'Derived from your reading: topics, habits, sites — each with its evidence.'],
    digest: ['Digest & insights', 'Your daily recap and everything the background sweep surfaced.'],
    growth: ['Growth & audit', 'Optional web enrichment, its budget, and every outbound query ever sent.'],
    settings: ['Settings', 'The shared configuration the extension and the backend both obey.']
  };

  function switchView(name) {
    state.currentView = name;
    $$('.nav-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === name));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    const meta = VIEW_META[name] || ['', ''];
    $('#view-title').textContent = meta[0];
    $('#view-sub').textContent = meta[1];
    if (name === 'memory') loadMemory(true);
    if (name === 'sites') loadSites();
    if (name === 'interests') loadInterests();
    if (name === 'digest') loadDigest();
    if (name === 'growth') loadGrowth();
    if (name === 'settings') loadSettings();
  }
  $$('.nav-btn').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));
  $('#head-refresh').addEventListener('click', async () => {
    state.health = await api('/api/health');
    paintHealth();
    switchView(state.currentView);
    toast('refreshed');
  });

  // ------------------------------------------------------------------- ask
  function loadSuggestions() {
    api('/api/suggestions').then((data) => {
      const box = $('#ask-chips');
      box.textContent = '';
      (data.suggestions || []).slice(0, 6).forEach((text) => {
        const chip = el('button', 'chip', text);
        chip.addEventListener('click', () => ask(text));
        box.appendChild(chip);
      });
    }).catch(() => {});
  }

  function addBubble(cls, text) {
    const bubble = el('div', `bubble ${cls}`);
    if (text) bubble.appendChild(el('div', 'text', text));
    $('#chat').appendChild(bubble);
    $('#chat').scrollTop = $('#chat').scrollHeight;
    return bubble;
  }

  function renderSources(bubble, sources, kind) {
    let box = bubble.querySelector('.sources');
    if (!box) {
      box = el('div', 'sources');
      bubble.appendChild(box);
    }
    box.textContent = '';
    sources.forEach((item, index) => {
      const row = el('div', `src ${kind === 'web' ? 'web' : ''}`);
      row.appendChild(el('span', 'n', kind === 'web' ? 'web' : String(index + 1)));
      const main = el('div');
      const link = el('a', null, item.title || item.url);
      link.href = item.url; link.target = '_blank'; link.rel = 'noreferrer';
      main.appendChild(link);
      const who = el('div', 'who',
        `${(item.domain_label || item.domain || '').replace(/^www\./, '')}` +
        (item.visited_ago ? ` · visited ${item.visited_ago}` : '') +
        (item.assistant_fetched ? ' · assistant-fetched (not something you read)' : ''));
      main.appendChild(who);
      if (item.sentences && item.sentences.length) {
        main.appendChild(el('div', 'quote', `“${item.sentences[0]}”`));
      } else if (item.snippet) {
        main.appendChild(el('div', 'quote', `“${item.snippet}”`));
      }
      row.appendChild(main);
      if (item.scores) {
        row.appendChild(el('span', 'rel', `${Math.round((item.scores.relevance || 0) * 100)}%`));
      }
      box.appendChild(row);
    });
  }

  function streamAsk(query) {
    const bubble = addBubble('bot', '');
    const line = $('#stream-line');
    line.textContent = 'searching…';
    const url = `/api/query/stream?q=${encodeURIComponent(query)}&token=${encodeURIComponent(state.token)}`;
    const source = new EventSource(url);
    let answered = false;

    const fail = (message) => {
      bubble.className = 'bubble bot error';
      bubble.textContent = '';
      bubble.appendChild(el('div', 'text', message));
      line.textContent = '';
      source.close();
    };

    source.addEventListener('intent', (event) => {
      const intent = JSON.parse(event.data);
      line.innerHTML = `intent: <b>${esc(intent.name || 'memory')}</b>${intent.topics && intent.topics.length ? ` · topics: ${esc(intent.topics.join(', '))}` : ''}`;
    });
    source.addEventListener('sources', (event) => {
      const sources = JSON.parse(event.data);
      if (sources.length) {
        line.innerHTML = `<b>${sources.length}</b> candidate memories found — composing answer…`;
        renderSources(bubble, sources.slice(0, 5), 'memory');
      } else {
        line.textContent = 'no memories matched — being honest about it…';
      }
    });
    source.addEventListener('grounding', (event) => {
      const grounding = JSON.parse(event.data);
      bubble.classList.toggle('ungrounded', !grounding.grounded);
      line.innerHTML = `grounded: <b>${grounding.grounded ? 'yes' : 'no'}</b> · ` +
        `best relevance ${(grounding.best_relevance * 100).toFixed(0)}% · ` +
        `${grounding.took_ms}ms · ${grounding.engine ? grounding.engine.embedder : ''}`;
    });
    source.addEventListener('web', (event) => {
      const web = JSON.parse(event.data);
      line.innerHTML = `web search: <b>${esc(web.query || '')}</b>`;
      if (web.results && web.results.length) renderSources(bubble, web.results.slice(0, 4), 'web');
    });
    source.addEventListener('answer', (event) => {
      answered = true;
      const payload = JSON.parse(event.data);
      bubble.classList.toggle('ungrounded', !payload.grounded);
      let text = bubble.querySelector('.text');
      if (!text) { text = el('div', 'text'); bubble.prepend(text); }
      text.textContent = payload.text || '';
      const foot = el('div', 'foot');
      foot.appendChild(el('span', `pill ${payload.grounded ? 'pill-ok' : 'pill-warn'}`,
        payload.grounded ? 'grounded' : 'not grounded'));
      foot.appendChild(el('span', 'pill', payload.provider || ''));
      if (payload.confidence) foot.appendChild(el('span', 'pill', `confidence: ${payload.confidence}`));
      bubble.appendChild(foot);
      line.textContent = '';
    });
    source.addEventListener('citations', (event) => {
      const cites = JSON.parse(event.data);
      if (cites && cites.length) renderSources(bubble, cites, 'memory');
    });
    source.addEventListener('done', () => {
      line.textContent = '';
      source.close();
      state.health = null;
      api('/api/health').then((h) => { state.health = h; paintHealth(); }).catch(() => {});
    });
    source.addEventListener('error', (event) => {
      let message = 'stream ended unexpectedly';
      try { message = JSON.parse(event.data || '{}').message || message; } catch { /* keep default */ }
      if (!answered) fail(message); else { line.textContent = ''; source.close(); }
    });
  }

  function ask(query) {
    const text = (query || $('#ask-input').value || '').trim();
    if (!text) return;
    $('#ask-input').value = '';
    autoGrow($('#ask-input'));
    addBubble('user', text);
    streamAsk(text);
  }
  $('#ask-btn').addEventListener('click', () => ask());
  $('#ask-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); ask(); }
  });

  function autoGrow(node) {
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
  }
  $('#ask-input').addEventListener('input', (event) => autoGrow(event.target));

  // ---------------------------------------------------------------- memory
  async function loadMemory(reset) {
    if (reset) state.memOffset = 0;
    const tbody = $('#mem-table tbody');
    if (reset) tbody.textContent = '';
    const params = new URLSearchParams({ limit: '50', offset: String(state.memOffset) });
    if (state.memQuery) params.set('q', state.memQuery);
    const data = await api(`/api/pages?${params}`);
    let pages = data.pages || [];
    if (state.memMode) {
      pages = pages.filter((p) => (p.mode || 'full') === state.memMode);
    }
    pages.forEach((page) => {
      const tr = el('tr');
      const titleCell = el('td', 'title-cell');
      const link = el('a', null, page.title || page.url);
      link.href = page.url; link.target = '_blank'; link.rel = 'noreferrer';
      titleCell.appendChild(link);
      titleCell.appendChild(el('div', 'sub',
        (page.assistant_fetched ? 'assistant-fetched · ' : '') +
        `${(page.word_count || 0).toLocaleString()} words` +
        (page.summary ? ` · ${page.summary.slice(0, 70)}…` : '')));
      tr.appendChild(titleCell);
      tr.appendChild(el('td', null, page.domain_label || page.domain));
      tr.appendChild(el('td', null, page.visited_ago || ''));
      const dwell = el('td', 'num', fmtDuration(page.total_dwell_seconds || page.dwell_seconds));
      tr.appendChild(dwell);
      tr.appendChild(el('td', 'num', String(page.visit_count || 1)));
      const actions = el('td', 'num');
      const open = el('button', 'linklike', 'read');
      open.title = 'Show the stored text exactly as captured';
      open.addEventListener('click', () => openPage(page));
      const forget = el('button', 'linklike', 'forget');
      forget.title = 'Delete and never capture again';
      forget.addEventListener('click', async () => {
        if (!confirm(`Forget “${page.title || page.url}” forever?`)) return;
        try {
          await api('/api/forget', { method: 'POST', body: JSON.stringify({ page_id: page.page_id || page.id }) });
          tr.remove();
          toast('forgotten');
        } catch (error) { toast(String(error.message), true); }
      });
      actions.appendChild(open);
      actions.appendChild(document.createTextNode(' '));
      actions.appendChild(forget);
      tr.appendChild(actions);
      tbody.appendChild(tr);
    });
    state.memOffset += (data.pages || []).length;
    $('#mem-empty').classList.toggle('hidden', tbody.children.length > 0);
  }
  let memTimer = null;
  $('#mem-search').addEventListener('input', (event) => {
    clearTimeout(memTimer);
    memTimer = setTimeout(() => { state.memQuery = event.target.value.trim(); loadMemory(true); }, 300);
  });
  $('#mem-mode').addEventListener('change', (event) => { state.memMode = event.target.value; loadMemory(true); });
  $('#mem-more').addEventListener('click', () => loadMemory(false));

  async function openPage(page) {
    const id = page.page_id || page.id;
    $('#modal-title').textContent = page.title || page.url;
    $('#modal-body').textContent = 'loading…';
    $('#modal-bg').classList.remove('hidden');
    try {
      const data = await api(`/api/pages/${encodeURIComponent(id)}/text`);
      const detail = (await api(`/api/pages/${encodeURIComponent(id)}`)).page || {};
      $('#modal-body').textContent =
        `${page.url}\n${page.domain_label || page.domain} · visited ${page.visited_ago || ''} · ` +
        `${fmtDuration(detail.total_dwell_seconds || page.dwell_seconds)} read · ` +
        `${(detail.word_count || page.word_count || 0).toLocaleString()} words\n\n` +
        (data.text || '(no stored text — link only)');
    } catch (error) {
      $('#modal-body').textContent = `Could not load: ${error.message}`;
    }
  }
  $('#modal-close').addEventListener('click', () => $('#modal-bg').classList.add('hidden'));
  $('#modal-bg').addEventListener('click', (event) => {
    if (event.target === $('#modal-bg')) $('#modal-bg').classList.add('hidden');
  });

  // ----------------------------------------------------------------- sites
  const MODE_LABEL = { full: 'Remember', no_ai: 'Hide from AI', off: 'Block' };
  async function loadSites() {
    const query = $('#site-search').value.trim();
    const data = await api(`/api/domains?q=${encodeURIComponent(query)}`);
    const tbody = $('#site-table tbody');
    tbody.textContent = '';
    (data.domains || []).forEach((row) => {
      const domain = row.registrable || row.domain;
      const tr = el('tr');
      const nameCell = el('td');
      nameCell.appendChild(el('div', null, row.label || domain));
      if (row.category) nameCell.appendChild(el('div', 'sub muted', `default blocklist: ${row.category}`));
      tr.appendChild(nameCell);
      tr.appendChild(el('td', 'num', String(row.page_count || 0)));
      tr.appendChild(el('td', 'num', String(row.visit_count || 0)));
      tr.appendChild(el('td', 'num', fmtDuration(row.total_dwell || 0)));
      const modeCell = el('td');
      const select = el('select');
      Object.entries(MODE_LABEL).forEach(([value, label]) => {
        const opt = el('option', null, label);
        opt.value = value;
        if ((row.mode || 'full') === value) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener('change', async () => {
        select.disabled = true;
        try {
          await api('/api/domains/mode', { method: 'POST',
                                           body: JSON.stringify({ domain, mode: select.value }) });
          toast(`${domain} → ${MODE_LABEL[select.value]}`);
          if (select.value === 'off') loadSites();
        } catch (error) {
          toast(String(error.message), true);
          select.disabled = false;
        }
      });
      modeCell.appendChild(select);
      tr.appendChild(modeCell);
      tbody.appendChild(tr);
    });
    if (!(data.domains || []).length) {
      tbody.appendChild(el('tr', null)).appendChild(el('td', 'muted', 'No sites yet.')).colSpan = 5;
    }
  }
  let siteTimer = null;
  $('#site-search').addEventListener('input', () => {
    clearTimeout(siteTimer);
    siteTimer = setTimeout(loadSites, 250);
  });
  $('#site-add-btn').addEventListener('click', async () => {
    const domain = $('#site-add').value.trim().toLowerCase()
      .replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    if (!domain) return;
    try {
      await api('/api/domains/mode', { method: 'POST',
                                       body: JSON.stringify({ domain, mode: $('#site-add-mode').value }) });
      $('#site-add').value = '';
      toast(`${domain} → ${MODE_LABEL[$('#site-add-mode').value]}`);
      loadSites();
    } catch (error) { toast(String(error.message), true); }
  });

  // ------------------------------------------------------------- interests
  async function loadInterests() {
    const data = await api('/api/interests');
    const grid = $('#interest-grid');
    grid.textContent = '';
    const topics = data.topics || [];
    if (!topics.length) {
      grid.appendChild(el('div', 'empty', 'No interests yet — the profile builds itself as you read.'));
    }
    const max = Math.max(0.0001, ...topics.map((t) => t.weight || 0));
    topics.slice(0, 12).forEach((topic) => {
      const card = el('div', 'interest');
      card.appendChild(el('h3', null, `${topic.label}${topic.is_concept ? ' (concept)' : ''}`));
      const bar = el('div', 'bar');
      const fill = el('i');
      fill.style.width = `${Math.round(((topic.weight || 0) / max) * 100)}%`;
      bar.appendChild(fill);
      card.appendChild(bar);
      card.appendChild(el('div', 'ev',
        `${topic.pages || 0} page(s) · weight ${(topic.weight || 0).toFixed(2)} · ` +
        `last ${(topic.last_seen || '').slice(0, 10)}`));
      // the evidence: the actual pages behind the topic, click-through verifiable
      (topic.evidence || []).slice(0, 3).forEach((item) => {
        const link = el('a', null, `↳ ${item.title}`);
        link.href = item.url || '#';
        if (item.url) { link.target = '_blank'; link.rel = 'noreferrer'; }
        else { link.removeAttribute('href'); link.style.cursor = 'default'; }
        link.title = `${item.domain} · ${item.visited_at || ''}`;
        card.appendChild(el('div', 'ev')).appendChild(link);
      });
      grid.appendChild(card);
    });

    const habits = data.habits || {};
    if (habits && habits.visits_analysed) {
      const card = el('div', 'interest');
      card.appendChild(el('h3', null, 'Reading habits'));
      [
        `Peak reading hour: ${habits.peak_hour_label || '–'}`,
        `Busiest weekday: ${habits.peak_weekday || '–'}`,
        `Average time per page: ${fmtDuration(habits.avg_dwell_seconds)}`,
        `Long-read ratio: ${Math.round((habits.long_read_ratio || 0) * 100)}% of ${habits.visits_analysed} visits`,
        `Median ${habits.median_pages_per_day || 0} page(s)/day over ${habits.active_days || 0} active day(s)`,
        `${habits.sessions_detected || 0} reading sessions detected`
      ].forEach((line) => card.appendChild(el('div', 'ev', `• ${line}`)));
      grid.appendChild(card);
    }

    const sites = data.sites || [];
    if (sites.length) {
      const card = el('div', 'interest');
      card.appendChild(el('h3', null, 'Where you read'));
      sites.slice(0, 8).forEach((site) => {
        card.appendChild(el('div', 'ev',
          `• ${site.label} — ${site.pages} page(s), ${site.visits} visit(s), ` +
          `${site.dwell_label}, last ${site.last_seen_ago}`));
      });
      grid.appendChild(card);
    }

    const persona = data.persona || {};
    const statements = Array.isArray(persona) ? persona : (persona.statements || []);
    $('#persona').textContent = statements.length
      ? statements.join('\n')
      : 'Not enough reading yet to describe you honestly.';
  }
  $('#interests-recompute').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      await api('/api/interests/recompute', { method: 'POST', body: '{}' });
      await loadInterests();
      toast('interest profile recomputed');
    } catch (error) { toast(String(error.message), true); }
    event.target.disabled = false;
  });

  // ---------------------------------------------------------------- digest
  async function loadDigest() {
    const day = $('#digest-day').value || undefined;
    const params = day ? `?day=${encodeURIComponent(day)}` : '';
    const data = await api(`/api/digest${params}`);
    $('#digest-body').textContent = data.digest || '(nothing captured that day)';
    const insights = await api('/api/insights?limit=20');
    const box = $('#insight-list');
    box.textContent = '';
    (insights.insights || []).forEach((insight) => {
      const row = el('div', 'insight');
      row.appendChild(el('div', 'ico', insight.kind === 'digest' ? '📬' : '🌱'));
      const body = el('div', 'body');
      body.appendChild(el('b', null, insight.title || insight.body));
      if (insight.body && insight.body !== insight.title) body.appendChild(el('div', null, insight.body));
      body.appendChild(el('div', 'why',
        `${insight.kind} · ${insight.created_ago || insight.created_at || ''}` +
        (insight.url ? ` · ${insight.url}` : '')));
      row.appendChild(body);
      if (!insight.seen) {
        const seen = el('button', 'ghost', 'mark seen');
        seen.addEventListener('click', async () => {
          await api(`/api/insights/${encodeURIComponent(insight.id)}/seen`,
            { method: 'POST', body: JSON.stringify({ dismissed: false }) });
          row.remove();
        });
        row.appendChild(seen);
      }
      box.appendChild(row);
    });
    if (!(insights.insights || []).length) box.appendChild(el('div', 'empty', 'No insights yet.'));
  }
  $('#digest-day').valueAsDate = new Date();
  $('#digest-day').addEventListener('change', loadDigest);
  $('#digest-build').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      await api('/api/digest/build', { method: 'POST',
                                       body: JSON.stringify({ day: $('#digest-day').value || null, notify: false }) });
      await loadDigest();
      toast('digest rebuilt');
    } catch (error) { toast(String(error.message), true); }
    event.target.disabled = false;
  });

  // ---------------------------------------------------------------- growth
  async function loadGrowth() {
    const data = await api('/api/enrichment');
    const budgets = data.budget || {};
    const stats = $('#growth-stats');
    stats.textContent = '';
    const mk = (label, value, sub) => {
      const box = el('div', 'stat');
      box.appendChild(el('div', 'k', label));
      const v = el('div', 'v', String(value));
      if (sub) v.appendChild(el('small', null, ` ${sub}`));
      box.appendChild(v);
      return box;
    };
    stats.appendChild(mk('Insights today', budgets.used !== undefined ? budgets.used : '–',
      `of ${budgets.budget !== undefined ? budgets.budget : '–'} allowed`));
    stats.appendChild(mk('Enrichment runs', (data.runs || []).length, 'recent'));
    stats.appendChild(mk('Outbound queries', (data.audit || []).length, 'logged all-time'));
    stats.appendChild(mk('Candidates', (data.candidates || []).length, 'ready to refresh'));

    const candidates = $('#candidate-table tbody');
    candidates.textContent = '';
    (data.candidates || []).forEach((candidate) => {
      const tr = el('tr');
      tr.appendChild(el('td', null, candidate.topic || candidate.title));
      tr.appendChild(el('td', 'muted', candidate.reason || ''));
      tr.appendChild(el('td', 'num', String(Math.round((candidate.score || 0) * 100) / 100)));
      const actions = el('td', 'num');
      const run = el('button', 'linklike', 'search now');
      run.addEventListener('click', async () => {
        run.disabled = true;
        try {
          const out = await api('/api/enrichment/run', { method: 'POST',
            body: JSON.stringify({ topic: candidate.topic, page_id: candidate.page_id, url: candidate.url }) });
          toast(out.status === 'budget' ? 'Daily budget used up.' :
            out.status === 'no_new_info' ? 'Nothing genuinely new found.' :
              `Stored ${out.stored || out.novel || 0} new item(s).`);
          loadGrowth();
        } catch (error) { toast(String(error.message), true); run.disabled = false; }
      });
      actions.appendChild(run);
      tr.appendChild(actions);
      candidates.appendChild(tr);
    });
    if (!(data.candidates || []).length) {
      candidates.appendChild(el('tr')).appendChild(el('td', 'muted', 'No candidates yet.')).colSpan = 4;
    }

    const audit = $('#audit-table tbody');
    audit.textContent = '';
    (data.audit || []).forEach((row) => {
      const tr = el('tr');
      tr.appendChild(el('td', null, row.created_at || ''));
      tr.appendChild(el('td', null, row.kind || ''));
      tr.appendChild(el('td', null, row.query || ''));
      tr.appendChild(el('td', null, row.provider || ''));
      tr.appendChild(el('td', null, row.status || ''));
      audit.appendChild(tr);
    });
    if (!(data.audit || []).length) {
      audit.appendChild(el('tr')).appendChild(el('td', 'muted',
        'Nothing has left your machine yet.')).colSpan = 5;
    }

    const jobs = await api('/api/jobs');
    const jobTable = $('#job-table tbody');
    jobTable.textContent = '';
    const lastRun = {};
    (jobs.runs || []).forEach((run) => {
      if (!lastRun[run.name]) lastRun[run.name] = run;
    });
    (jobs.available || []).forEach((name) => {
      const run = lastRun[name] || {};
      const tr = el('tr');
      tr.appendChild(el('td', null, name));
      tr.appendChild(el('td', null, run.finished_at || run.started_at || 'never'));
      tr.appendChild(el('td', null, run.status || (jobs.status || {})[name] && (jobs.status[name].last_status) || '–'));
      const actions = el('td', 'num');
      const button = el('button', 'linklike', 'run');
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const out = await api(`/api/jobs/run/${encodeURIComponent(name)}`, { method: 'POST', body: '{}' });
          toast(`${name}: ${out.status || 'done'}`);
          loadGrowth();
        } catch (error) { toast(String(error.message), true); button.disabled = false; }
      });
      actions.appendChild(button);
      tr.appendChild(actions);
      jobTable.appendChild(tr);
    });
  }
  $('#enrich-run').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      const out = await api('/api/enrichment/run', { method: 'POST', body: JSON.stringify({}) });
      toast(out.status === 'budget' ? 'Daily enrichment budget used up.' :
        out.status === 'no_new_info' ? 'Searched — nothing genuinely new.' :
          `Enriched “${(out.candidate || {}).topic}”: ${out.stored || out.novel || 0} new item(s).`);
      loadGrowth();
    } catch (error) { toast(String(error.message), true); }
    event.target.disabled = false;
  });
  $('#enrich-daily').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      const out = await api('/api/enrichment/run', { method: 'POST', body: JSON.stringify({ daily: true }) });
      toast(`daily sweep: ${out.status || JSON.stringify(out).slice(0, 80)}`);
      loadGrowth();
    } catch (error) { toast(String(error.message), true); }
    event.target.disabled = false;
  });

  // -------------------------------------------------------------- settings
  const SETTING_GROUPS = {
    'set-capture': [
      ['capture_enabled', 'Remember what I read', 'Master switch.'],
      ['capture_content', 'Read page content', 'Off keeps links only.'],
      ['global_pause', 'Pause everything', 'Nothing is captured while on.'],
      ['skip_sensitive_urls', 'Skip sensitive URLs', 'logins, checkouts, tokens…'],
      ['respect_default_blocklist', 'Respect the default blocklist', 'banking, health, government, webmail.'],
      ['min_dwell_seconds', 'Minimum seconds on page', 'Skips accidental clicks.'],
      ['retention_days', 'Retention (days, 0 = forever)', 'The “never forget” default.']
    ],
    'set-growth': [
      ['web_search_enabled', 'Allow backend web searches', 'Optional growth about your own topics.'],
      ['web_search_for_answers', 'Use web when memory is thin', 'Always labelled, never as your memory.'],
      ['web_search_daily_budget', 'Web searches per day', 'Hard cap.'],
      ['enrichment_enabled', 'Daily enrichment sweep', 'Checks your topics for updates.'],
      ['enrichment_daily_budget', 'Enrichment runs per day', 'Default 5.'],
      ['notifications_enabled', 'Notifications', 'Browser notifications via the extension.'],
      ['notification_daily_budget', 'Notifications per day', 'Hard cap, default 5.'],
      ['digest_enabled', 'Daily recap', 'A summary of your reading day.'],
      ['digest_hour', 'Recap hour (0-23)', 'Your local time.']
    ],
    'set-answers': [
      ['answer_style', 'Answer style', 'concise | detailed | bullet'],
      ['top_k', 'Memories per answer', '5-8 works well.'],
      ['always_offer_links', 'Always offer saved links', "Even when the answer is “I don’t know”."],
      ['min_grounding_score', 'Minimum grounding score', "Below this the engine says it doesn’t know."]
    ]
  };

  async function loadSettings() {
    const data = await api('/api/settings');
    const settings = data.settings || {};
    Object.entries(SETTING_GROUPS).forEach(([containerId, rows]) => {
      const container = document.getElementById(containerId);
      container.textContent = '';
      rows.forEach(([key, label, hint]) => {
        const value = settings[key];
        const row = el('div', 'switch');
        const txt = el('div', 'txt');
        txt.appendChild(el('b', null, label));
        txt.appendChild(el('small', null, hint));
        row.appendChild(txt);
        let input;
        if (typeof value === 'boolean') {
          input = el('input', 'toggle');
          input.type = 'checkbox';
          input.checked = value;
          input.addEventListener('change', () => saveSetting(key, input.checked));
        } else if (key === 'answer_style') {
          input = el('select');
          ['concise', 'detailed', 'bullet'].forEach((option) => {
            const opt = el('option', null, option);
            opt.value = option;
            if (option === value) opt.selected = true;
            input.appendChild(opt);
          });
          input.addEventListener('change', () => saveSetting(key, input.value));
        } else {
          input = el('input');
          input.type = 'number';
          input.step = Number.isInteger(value) ? '1' : '0.05';
          input.value = value;
          input.style.width = '110px';
          input.addEventListener('change', () => {
            saveSetting(key, Number.isInteger(value) ? parseInt(input.value, 10) : parseFloat(input.value));
          });
        }
        row.appendChild(input);
        container.appendChild(row);
      });
    });

    const engine = data.engine || {};
    const box = $('#engine-info');
    box.textContent = '';
    const kv = (k, v) => {
      const row = el('div', 'switch');
      const txt = el('div', 'txt');
      txt.appendChild(el('b', null, k));
      txt.appendChild(el('small', null, String(v)));
      row.appendChild(txt);
      box.appendChild(row);
    };
    kv('Answer engine', `${(engine.llm || {}).name} (${(engine.llm || {}).model})`);
    kv('Embeddings', `${(engine.embedder || {}).name}, dim ${(engine.embedder || {}).dim}` +
      ((engine.embedder || {}).local === false ? ' — hosted' : ' — local'));
    kv('Vector index', `${(engine.vector || {}).backend}, ${(engine.vector || {}).knn_indexed || 0} vectors`);
    kv('Lexical index', `${(engine.lexical || {}).backend}, FTS5 ${(engine.fts5 ? 'yes' : 'no')}`);
    kv('Web provider', `${(engine.web_search || {}).provider} (${(engine.web_search || {}).configured ? 'configured' : 'not configured'})`);
    kv('Database', (engine.vector || {}).db_path || '');
  }

  async function saveSetting(key, value) {
    try {
      const out = await api('/api/settings', { method: 'POST', body: JSON.stringify({ [key]: value }) });
      if (out.rejected && out.rejected.length) toast(`rejected: ${out.rejected.join(', ')}`, true);
      else toast(`${key} saved`);
      state.health = await api('/api/health');
      paintHealth();
    } catch (error) { toast(String(error.message), true); }
  }

  $('#reindex-btn').addEventListener('click', async (event) => {
    event.target.disabled = true;
    event.target.textContent = 'rebuilding…';
    try {
      const out = await api('/api/jobs/run/reindex_all', { method: 'POST', body: '{}' });
      toast(`reindexed ${out.pages || 0} pages / ${out.chunks || 0} chunks`);
    } catch (error) { toast(String(error.message), true); }
    event.target.disabled = false;
    event.target.textContent = 'rebuild search index';
  });

  $('#wipe-btn').addEventListener('click', () => $('#wipe-box').classList.remove('hidden'));
  $('#wipe-cancel').addEventListener('click', () => $('#wipe-box').classList.add('hidden'));
  $('#wipe-go').addEventListener('click', async () => {
    const confirmText = $('#wipe-confirm').value.trim();
    if (confirmText.toUpperCase() !== 'DELETE ALL') { toast('Type DELETE ALL to confirm.', true); return; }
    try {
      await api('/api/wipe', { method: 'POST', body: JSON.stringify({ confirm: confirmText }) });
      $('#wipe-box').classList.add('hidden');
      toast('everything deleted');
      bootstrap();
    } catch (error) { toast(String(error.message), true); }
  });

  // ------------------------------------------------------------------ boot
  bootstrap();
})();
