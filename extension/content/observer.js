/**
 * Twin-Brain observer — dwell time, scroll depth, and the capture trigger.
 *
 * Injected ONLY after the background worker has verified that this URL is
 * allowed (exclusions are checked before injection, never after). Runs in the
 * isolated world, touches nothing on the page, and sends exactly one payload
 * per visit.
 *
 * Timing rules (deliberately boring, and deliberately honest):
 *   - only time while the document is visible counts as dwell
 *   - nothing is sent before minDwellSeconds, so accidental clicks are never
 *     recorded
 *   - if you leave the page after the threshold, the payload is still sent
 */
(function () {
  'use strict';

  if (window.__twinbrainObserver) return;
  window.__twinbrainObserver = true;

  var state = {
    startUrl: location.href,
    startedAt: Date.now(),
    activeMs: 0,
    lastTick: Date.now(),
    maxScroll: 0,
    captured: false,
    config: null,
    hidden: document.visibilityState === 'hidden'
  };

  function send(message) {
    try {
      return chrome.runtime.sendMessage(message);
    } catch (error) {
      // extension was reloaded/disabled mid-page: nothing we can do
      return Promise.resolve(null);
    }
  }

  function scrollDepth() {
    var doc = document.documentElement;
    var body = document.body;
    var total = Math.max(
      doc ? doc.scrollHeight : 0, body ? body.scrollHeight : 0,
      doc ? doc.offsetHeight : 0, body ? body.offsetHeight : 0, 0);
    if (!total) return 0;
    var seen = (window.scrollY || (doc ? doc.scrollTop : 0) || 0) + window.innerHeight;
    return Math.max(0, Math.min(1, seen / total));
  }

  function tick() {
    var now = Date.now();
    var delta = now - state.lastTick;
    state.lastTick = now;
    // Only count time the page was actually on screen. A background tab is
    // hidden, so reading time never accumulates while you are elsewhere.
    if (!state.hidden && delta > 0 && delta < 5000) state.activeMs += delta;
    var depth = scrollDepth();
    if (depth > state.maxScroll) state.maxScroll = depth;
    maybeCapture();
  }

  function seconds() {
    return Math.round(state.activeMs / 1000);
  }

  function maybeCapture() {
    if (state.captured || !state.config) return;
    var min = Number(state.config.minDwellSeconds || 5);
    if (seconds() < min) return;
    state.captured = true;
    var article = null;
    if (state.config.captureContent && typeof window.__twinbrainExtract === 'function') {
      try {
        article = window.__twinbrainExtract({
          maxChars: Number(state.config.maxTextChars || 120000)
        });
      } catch (error) {
        article = { ok: false, reason: String(error && error.message || error) };
      }
    }
    var payload = {
      url: location.href,
      title: (article && article.title) || document.title || location.href,
      text: (article && article.ok && article.text) ? article.text : '',
      description: (article && article.description) || '',
      byline: (article && article.byline) || '',
      published: (article && article.published) || '',
      canonical_url: (article && article.canonical) || '',
      lang: (article && article.lang) || document.documentElement.lang || '',
      visited_at: new Date().toISOString().slice(0, 19),
      dwell_seconds: seconds(),
      scroll_depth: Math.round(state.maxScroll * 1000) / 1000,
      referrer: document.referrer || '',
      source: 'extension',
      capture_content: Boolean(state.config.captureContent),
      mode: state.config.mode || 'full',
      extractor: article ? {
        ok: Boolean(article.ok), source: article.source, words: article.wordCount,
        chars: article.chars, took_ms: article.tookMs, candidates: article.candidates,
        nodes_removed: article.nodesRemoved
      } : { ok: false, source: 'disabled' }
    };
    if (!payload.text) payload.link_only = true;
    send({ type: 'tb-capture', payload: payload });
    send({ type: 'tb-progress', url: location.href, dwell: seconds(),
           scroll: state.maxScroll, captured: true });
  }

  function reportProgress() {
    send({ type: 'tb-progress', url: location.href, dwell: seconds(),
           scroll: state.maxScroll, captured: state.captured });
  }

  // --- lifecycle ----------------------------------------------------------
  document.addEventListener('visibilitychange', function () {
    var wasHidden = state.hidden;
    state.hidden = document.visibilityState === 'hidden';
    tick();
    if (state.hidden && !wasHidden) {
      // leaving: flush whatever we have if the threshold was reached
      if (!state.captured) maybeCapture();
      reportProgress();
    }
  });

  window.addEventListener('pagehide', function () {
    tick();
    if (!state.captured) maybeCapture();
    reportProgress();
  });

  window.addEventListener('scroll', function () {
    var depth = scrollDepth();
    if (depth > state.maxScroll) state.maxScroll = depth;
  }, { passive: true });

  // --- single-page-app navigation ----------------------------------------
  function spaNavigated() {
    if (location.href === state.startUrl) return;
    tick();
    if (!state.captured) maybeCapture();          // finish the page we were on
    send({ type: 'tb-navigated', from: state.startUrl, to: location.href });
    // the background decides whether the new URL is allowed and re-injects
    state.startUrl = location.href;
    state.startedAt = Date.now();
    state.activeMs = 0;
    state.maxScroll = scrollDepth();
    state.captured = false;
  }

  ['pushState', 'replaceState'].forEach(function (name) {
    var original = history[name];
    if (typeof original !== 'function') return;
    history[name] = function () {
      var result = original.apply(this, arguments);
      setTimeout(spaNavigated, 0);
      return result;
    };
  });
  window.addEventListener('popstate', function () { setTimeout(spaNavigated, 0); });
  window.addEventListener('hashchange', function () { setTimeout(spaNavigated, 0); });

  // --- ask the background for our configuration ---------------------------
  Promise.resolve(send({ type: 'tb-init', url: location.href, title: document.title }))
    .then(function (response) {
      state.config = (response && response.config) || {
        minDwellSeconds: 5, captureContent: true, maxTextChars: 120000, mode: 'full'
      };
      state.lastTick = Date.now();
      maybeCapture();
    })
    .catch(function () {
      state.config = { minDwellSeconds: 5, captureContent: true,
                       maxTextChars: 120000, mode: 'full' };
    });

  setInterval(tick, 1000);
  setInterval(reportProgress, 15000);
})();
