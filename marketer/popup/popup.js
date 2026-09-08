/**
 * MarketerTwin popup — slim remote control:
 * quick chat (same threads as the Studio), analyze-this-page, Facebook
 * record/play shortcuts, and jumps into the full studio.
 */

const send = (msg) => chrome.runtime.sendMessage(msg);
const $ = (s) => document.querySelector(s);

let chatId = null;

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function add(role, text, meta) {
  const el = document.createElement('div');
  el.className = `m ${role}`;
  el.innerHTML = (meta ? `<span class="meta">${esc(meta)}</span>` : '') + esc(text);
  $('#log').appendChild(el);
  $('#log').scrollTop = $('#log').scrollHeight;
}

async function ask() {
  const q = $('#q').value.trim();
  if (!q) return;
  $('#q').value = '';
  add('u', q);
  const typing = document.createElement('div');
  typing.className = 'm t dim'; typing.textContent = 'thinking…';
  $('#log').appendChild(typing);
  const res = await send({ type: 'mt-ask', chatId, text: q });
  typing.remove();
  if (!res || !res.ok) { add('t', `Error: ${(res && res.error) || 'unknown'}`); return; }
  chatId = res.chat.id;
  await chrome.storage.local.set({ popupChatId: chatId });
  const r = res.reply;
  const label = r.mode === 'sales' ? 'sales playbook' : r.mode === 'core' ? 'knowledge core'
    : r.mode === 'book' || r.mode === 'bookshelf' ? 'bookshelf' : r.providerLabel || 'MarketerTwin';
  add('t', r.text || '…', label);
}

$('#ask').onclick = ask;
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); }
});

$('#btn-studio').onclick = () => send({ type: 'mt-open-app' });
$('#btn-memory').onclick = () => send({ type: 'mt-open-app' });
$('#btn-desc').onclick = () => send({ type: 'mt-open-app' }).then(() => window.close());
$('#btn-newchat').onclick = async () => {
  const res = await send({ type: 'mt-chat-new' });
  chatId = res.chat.id;
  await chrome.storage.local.set({ popupChatId: chatId });
  $('#log').innerHTML = '';
  add('t', 'Fresh chat started — I remember everything from the old one in long-term memory.', 'MarketerTwin');
};
$('#btn-analyze').onclick = async () => {
  const res = await send({ type: 'tb-capture-now' });
  add('t', res && res.ok ? (res.linkOnly ? 'Saved (link only — page text needs a moment of reading time).' : 'Analyzing this page into memory ✔ — ask me about it in a few seconds.') : `Could not analyze: ${(res && res.error) || 'not allowed on this page'}`);
};
$('#btn-pause').onclick = async () => {
  await send({ type: 'tb-pause' });
  const res = await send({ type: 'tb-settings-get' });
  updatePause(res.settings);
};

$('#fb-rec').onclick = async () => {
  const res = await send({ type: 'mt-rec-start', mode: 'branding' });
  add('t', res && res.ok ? 'Recording — click through Facebook; the panel sits bottom-left. Stop & Save there.' : `Cannot record: ${(res && res.error) || 'open Facebook first'}`);
};
$('#fb-stop').onclick = () => send({ type: 'mt-rec-stop' });
$('#fb-play').onclick = async () => {
  const res = await send({ type: 'mt-flows' });
  const flows = (res && res.flows) || [];
  if (!flows.length) { add('t', 'No recorded flow yet — hit ● Record first, or manage flows in the Studio.'); return; }
  const flow = flows[0];
  const play = await send({ type: 'mt-play', flowId: flow.id, options: {} });
  add('t', play && play.ok ? `Playing “${flow.name}” — watch this tab. Full options (image wait, groups, descriptions) live in the Studio.` : `Play failed: ${(play && play.error) || ''}`);
};

function updatePause(settings) {
  $('#btn-pause').textContent = settings && settings.globalPause ? '▶' : '⏸';
  $('#btn-pause').title = settings && settings.globalPause ? 'Capture paused — click to resume' : 'Pause memory capture';
}

(async function boot() {
  const stored = await chrome.storage.local.get('popupChatId');
  chatId = stored.popupChatId || null;
  if (chatId) {
    const res = await send({ type: 'mt-chat-get', chatId });
    if (res && res.chat) {
      for (const m of res.chat.messages.slice(-6)) add(m.role === 'user' ? 'u' : 't', m.text, m.role === 'twin' ? 'MarketerTwin' : '');
    } else chatId = null;
  }
  if (!chatId) add('t', 'Salam! I am your marketing twin — Meta Ads, sales scripts, branding, copy. English or Roman Urdu, jo dil kare. Ask me anything, or open the Studio for flows & monitors.', 'MarketerTwin');
  const sres = await send({ type: 'tb-settings-get' });
  updatePause(sres && sres.settings);
  try {
    const nres = await send({ type: 'tb-neural-status' });
    if (nres && nres.neural && nres.neural.connected) { $('#chip').textContent = nres.neural.label; }
  } catch { /* built-in */ }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && /facebook\.com/i.test(tab.url || '')) $('#fb-actions').classList.remove('hidden');
})();
