/**
 * Twin-Brain page extractor — a Readability-style main-content algorithm.
 *
 * Runs in the content script's ISOLATED world on a *clone* of the document, so
 * the page you are looking at is never modified. Injected only after the
 * background worker has confirmed the URL is allowed, so excluded sites never
 * run this code at all.
 *
 * Why not ship Mozilla's Readability.js? It cannot be vendored offline here, and
 * the algorithm that matters is small: score text-bearing blocks by prose
 * length, comma density and link density, then keep the winner. That is what
 * this does, in ~250 dependency-free lines you can read and audit.
 *
 * Exposes: window.__twinbrainExtract(opts) -> article object
 */
(function () {
  'use strict';

  var STRIP_TAGS = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'OBJECT',
                    'EMBED', 'CANVAS', 'VIDEO', 'AUDIO', 'MAP', 'FORM', 'BUTTON', 'SELECT',
                    'OPTION', 'TEXTAREA', 'INPUT', 'LABEL', 'DIALOG'];

  var STRIP_SEMANTIC = ['NAV', 'FOOTER', 'HEADER', 'ASIDE'];

  // class/id fragments that almost always mean "not the article"
  var NEGATIVE_RE = /(^|[\s-_])(comment|combx|disqus|footer|footnote|header|nav|navbar|menu|sidebar|side|ad|ads|advert|banner|social|share|sharing|related|recommend|promo|sponsor|popup|modal|cookie|consent|newsletter|subscribe|signup|sign-in|login|breadcrumb|pagination|pager|toolbar|widget|marketing|promo|recirculation|outbrain|taboola|carousel|gallery-thumbs|jump|skip)([\s-_]|$)/i;
  // class/id fragments that almost always mean "this is the article"
  var POSITIVE_RE = /(^|[\s-_])(article|body|content|entry|main|page|post|story|text|prose|markdown|blog|document|hentry|reader)([\s-_]|$)/i;

  var BLOCK_TAGS = { P: 1, DIV: 1, SECTION: 1, ARTICLE: 1, LI: 1, TD: 1, TH: 1, PRE: 1,
                     BLOCKQUOTE: 1, FIGCAPTION: 1, DD: 1, DT: 1 };

  function textOf(node) {
    return (node.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function linkDensity(node) {
    var total = (node.textContent || '').length;
    if (!total) return 1;
    var links = node.querySelectorAll('a');
    var linkChars = 0;
    for (var i = 0; i < links.length; i += 1) {
      linkChars += (links[i].textContent || '').length;
    }
    return Math.min(1, linkChars / total);
  }

  function classWeight(node) {
    var score = 0;
    var bits = [node.className, node.id];
    for (var i = 0; i < bits.length; i += 1) {
      var value = bits[i];
      if (!value || typeof value !== 'string') continue;
      if (NEGATIVE_RE.test(value)) score -= 25;
      if (POSITIVE_RE.test(value)) score += 25;
    }
    return score;
  }

  function stripNode(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  /** Serialise a subtree into readable plain text, preserving structure. */
  function renderText(root, maxChars) {
    var out = [];
    var used = 0;

    function walk(node, depth) {
      if (used >= maxChars) return;
      if (node.nodeType === 3) {                       // text node
        var text = node.nodeValue.replace(/\s+/g, ' ');
        if (text.trim()) { out.push(text); used += text.length; }
        return;
      }
      if (node.nodeType !== 1) return;
      var tag = node.tagName;
      if (STRIP_TAGS.indexOf(tag) !== -1) return;
      if (tag === 'BR') { out.push('\n'); return; }

      var isBlock = Boolean(BLOCK_TAGS[tag]) || /^H[1-6]$/.test(tag) ||
                    tag === 'FIGURE' || tag === 'ARTICLE' || tag === 'SECTION' ||
                    tag === 'BLOCKQUOTE' || tag === 'TABLE' || tag === 'TR';

      if (isBlock) out.push('\n\n');
      if (/^H[1-6]$/.test(tag)) {
        out.push('\n' + '#'.repeat(Number(tag[1]) + 1) + ' ');
      }
      if (tag === 'LI') out.push('\n- ');

      for (var child = node.firstChild; child; child = child.nextSibling) {
        walk(child, depth + 1);
        if (used >= maxChars) break;
      }
      if (isBlock) out.push('\n');
    }

    walk(root, 0);
    var text = out.join('');
    // collapse the whitespace runs our block markers produced
    text = text.replace(/[ \t\r\f\v]+/g, ' ')
               .replace(/ ?\n ?/g, '\n')
               .replace(/\n{3,}/g, '\n\n')
               .replace(/^\s+|\s+$/g, '');
    if (text.length > maxChars) text = text.slice(0, maxChars);
    return text;
  }

  function metaContent(doc, names) {
    for (var i = 0; i < names.length; i += 1) {
      var selector = names[i];
      var node = doc.querySelector(selector);
      if (node) {
        var value = node.getAttribute('content') || node.textContent || '';
        value = value.trim();
        if (value) return value;
      }
    }
    return '';
  }

  function pickTitle(clone, doc) {
    var og = metaContent(clone, ['meta[property="og:title"]', 'meta[name="twitter:title"]']);
    if (og) return og;
    var h1s = clone.querySelectorAll('h1');
    var best = null;
    for (var i = 0; i < h1s.length; i += 1) {
      var text = textOf(h1s[i]);
      if (text.length >= 8 && text.length <= 220) {
        if (!best || text.length > best.length) best = text;
      }
    }
    if (best) return best;
    var title = doc.title || '';
    // strip the common " - Site Name" / " | Site" tail
    return title.split(/\s+[|\u2013\u2014]\s+[A-Za-z0-9 .&'()-]{2,45}$/)[0].trim() || title;
  }

  function extractArticle(opts) {
    opts = opts || {};
    var maxChars = opts.maxChars || 120000;
    var doc = document;
    var started = Date.now();

    var clone;
    try {
      clone = doc.documentElement.cloneNode(true);
    } catch (error) {
      clone = null;
    }
    if (!clone) {
      return { ok: false, reason: 'clone failed', title: doc.title, text: '', url: location.href };
    }

    // 1) hard removals
    var all = clone.querySelectorAll('*');
    var removed = 0;
    for (var i = 0; i < all.length; i += 1) {
      var node = all[i];
      if (!node || !node.tagName) continue;
      if (STRIP_TAGS.indexOf(node.tagName) !== -1) { stripNode(node); removed += 1; continue; }
      if (STRIP_SEMANTIC.indexOf(node.tagName) !== -1) { stripNode(node); removed += 1; continue; }
      var role = (node.getAttribute && node.getAttribute('role')) || '';
      if (/^(navigation|banner|contentinfo|complementary|search|form)$/i.test(role)) {
        stripNode(node); removed += 1; continue;
      }
      if (node.hasAttribute && (node.hasAttribute('aria-hidden') &&
          node.getAttribute('aria-hidden') === 'true')) {
        stripNode(node); removed += 1;
      }
    }

    // 2) score candidate containers with the classic Readability signal:
    //    prose length + comma density, propagated to parent/grandparent,
    //    penalised by link density and boilerplate class names.
    var candidates = new Map();
    var paragraphs = clone.querySelectorAll('p, pre, article, section > div, blockquote, li');
    for (var p = 0; p < paragraphs.length; p += 1) {
      var para = paragraphs[p];
      if (!para.parentNode) continue;
      var text = textOf(para);
      if (text.length < 25) continue;
      var commas = (text.match(/,/g) || []).length;
      var score = 1 + Math.min(commas, 6) + Math.min(text.length / 100, 4);
      if (linkDensity(para) > 0.5) score *= 0.25;

      var parent = para.parentNode;
      var grandparent = parent && parent.parentNode;
      if (parent && parent.tagName) {
        var current = candidates.get(parent) || 0;
        candidates.set(parent, current + score + classWeight(parent) * 0.1);
      }
      if (grandparent && grandparent.tagName) {
        var gcurrent = candidates.get(grandparent) || 0;
        candidates.set(grandparent, gcurrent + score / 2 + classWeight(grandparent) * 0.05);
      }
    }

    // <article> and og:description anchors get a head start when they carry text
    var semantic = clone.querySelectorAll('article, [itemprop="articleBody"], main');
    for (var s = 0; s < semantic.length; s += 1) {
      var node2 = semantic[s];
      var len = textOf(node2).length;
      if (len > 200) {
        candidates.set(node2, (candidates.get(node2) || 0) + len / 25 + 30);
      }
    }

    var best = null;
    var bestScore = 0;
    candidates.forEach(function (score, node3) {
      if (!node3 || !node3.tagName) return;
      if (node3.tagName === 'BODY' || node3.tagName === 'HTML') return;
      var density = linkDensity(node3);
      var adjusted = score * (1 - density * 0.75);
      if (adjusted > bestScore) { bestScore = adjusted; best = node3; }
    });

    // 3) widen slightly: if a sibling holds more prose than the winner's parent,
    //    take the parent (keeps multi-part articles together)
    if (best && best.parentNode && best.parentNode.tagName !== 'BODY') {
      var parentText = textOf(best.parentNode).length;
      var bestText = textOf(best).length;
      if (parentText > bestText * 1.6 && linkDensity(best.parentNode) < 0.35) {
        best = best.parentNode;
      }
    }

    var articleText = best ? renderText(best, maxChars) : '';
    var source = best ? 'scored' : 'fallback';

    // 4) fallbacks, in order of trustworthiness
    if (!articleText || articleText.length < 220) {
      var main = clone.querySelector('main') || clone.querySelector('article') ||
                 clone.querySelector('[role="main"]');
      if (main) {
        var mainText = renderText(main, maxChars);
        if (mainText.length > articleText.length) { articleText = mainText; source = 'main'; }
      }
    }
    if (!articleText || articleText.length < 220) {
      var bodyText = renderText(clone.querySelector('body') || clone, maxChars);
      if (bodyText.length > articleText.length) { articleText = bodyText; source = 'body'; }
    }
    if (!articleText && doc.body) {
      articleText = (doc.body.innerText || '').replace(/\s+/g, ' ').slice(0, maxChars);
      source = 'innerText';
    }

    var title = pickTitle(clone, doc);
    var description = metaContent(clone, [
      'meta[property="og:description"]', 'meta[name="description"]',
      'meta[name="twitter:description"]', 'meta[itemprop="description"]'
    ]);
    var byline = metaContent(clone, ['meta[name="author"]', 'meta[property="article:author"]',
                                     '[rel="author"]', '.byline', '.author']);
    var published = metaContent(clone, [
      'meta[property="article:published_time"]', 'meta[name="date"]',
      'meta[name="publish-date"]', 'time[datetime]'
    ]);
    var canonical = (clone.querySelector('link[rel="canonical"]') || {}).href || '';
    var siteName = metaContent(clone, ['meta[property="og:site_name"]']);
    var lang = (doc.documentElement && doc.documentElement.getAttribute('lang')) || '';

    var words = articleText ? articleText.split(/\s+/).filter(Boolean).length : 0;
    return {
      ok: Boolean(articleText && articleText.length >= 40),
      source: source,
      title: title,
      byline: byline,
      description: description,
      published: published,
      siteName: siteName,
      lang: lang,
      canonical: canonical,
      url: location.href,
      text: articleText,
      wordCount: words,
      chars: articleText ? articleText.length : 0,
      nodesRemoved: removed,
      candidates: candidates.size,
      tookMs: Date.now() - started,
      documentHeight: doc.documentElement ? doc.documentElement.scrollHeight : 0
    };
  }

  // Exposed for observer.js (same isolated world) and for manual debugging.
  window.__twinbrainExtract = extractArticle;
})();
