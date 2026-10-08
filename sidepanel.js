let port = null;

function connectPort() {
  port = chrome.runtime.connect({ name: 'ch_sidepanel' });
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'SHOW_VIEW') showView(msg.view);
  });
  port.onDisconnect.addListener(() => { setTimeout(connectPort, 250); });
}
connectPort();

const views = {
  analysis: document.getElementById('sp-view-analysis'),
  settings: document.getElementById('sp-view-settings'),
};
const settingsBtn = document.getElementById('sp-settings-btn');
const backBtn     = document.getElementById('sp-back-btn');

const el = {
  empty:     document.getElementById('sp-empty'),
  listing:   document.getElementById('sp-listing'),
  addr:      document.getElementById('sp-listing-addr'),
  note:      document.getElementById('sp-listing-note'),
  runBtn:    document.getElementById('sp-run-btn'),
  runLabel:  document.getElementById('sp-run-label'),
  progress:  document.getElementById('sp-progress'),
  status:    document.getElementById('sp-progress-status'),
  activity:  document.getElementById('sp-activity'),
  error:     document.getElementById('sp-error'),
  errorMsg:  document.getElementById('sp-error-msg'),
  retryBtn:  document.getElementById('sp-retry-btn'),
  errSetBtn: document.getElementById('sp-error-settings-btn'),
  result:    document.getElementById('sp-result'),
  scroller:  document.getElementById('ch-analysis-root'),
  toast:     document.getElementById('sp-toast'),
};

let hasListing = false;
let running    = false;
let currentTheme = 'system';
let currentZpid  = null;
let shownZpid    = null;

let lastListing = null;
const STORE_KEY = 'ch_analyses';
const CSS_KEY   = 'ch_panel_css';
const KEEP      = 8;

function storeGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, (r) => resolve(r || {})));
}
function storeSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, () => resolve()));
}

async function saveAnalysis(zpid, html, styles, listing) {
  if (!zpid) return;
  const got = await storeGet([STORE_KEY]);
  const map = got[STORE_KEY] || {};
  map[zpid] = { html, listing: listing || null, savedAt: Date.now() };
  const keys = Object.keys(map).sort((a, b) => map[b].savedAt - map[a].savedAt);
  for (const k of keys.slice(KEEP)) delete map[k];
  const write = { [STORE_KEY]: map };
  if (styles) write[CSS_KEY] = styles;
  try { await storeSet(write); } catch (e) {}
}

async function restoreAnalysis(zpid) {
  if (!zpid) return false;
  const got = await storeGet([STORE_KEY, CSS_KEY]);
  const rec = (got[STORE_KEY] || {})[zpid];
  if (!rec || !rec.html) return false;
  renderResult(rec.html, got[CSS_KEY], currentTheme, zpid, true);
  return true;
}

function applyTheme(theme, panel) {
  if (theme) currentTheme = theme;
  document.documentElement.dataset.theme = currentTheme;
  const target = panel || document.querySelector('#ch-panel');
  if (!target) return;
  target.classList.remove('ch-light', 'ch-dark');
  if (currentTheme === 'light') target.classList.add('ch-light');
  if (currentTheme === 'dark')  target.classList.add('ch-dark');
}

chrome.storage.sync.get(['ch_theme'], (res) => applyTheme(res?.ch_theme || 'system'));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.ch_theme) applyTheme(changes.ch_theme.newValue || 'system');
});

function showView(name) {
  const target = views[name] ? name : 'analysis';
  for (const [key, view] of Object.entries(views)) {
    view.classList.toggle('active', key === target);
  }
  settingsBtn.style.display = target === 'settings' ? 'none' : '';
  backBtn.style.display     = target === 'settings' ? '' : 'none';
}

settingsBtn.addEventListener('click', () => showView('settings'));
backBtn.addEventListener('click', () => showView('analysis'));

async function sendToTab(msg) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    return null;   
  }
}

function toast(text) {
  el.toast.textContent = text;
  el.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.remove('show'), 3200);
}

function setEmpty() {
  hasListing = false;
  running    = false;
  el.listing.style.display  = 'none';
  el.progress.style.display = 'none';
  el.error.style.display    = 'none';
  el.empty.style.display    = el.result.innerHTML ? 'none' : '';
}

function clearResult() {
  el.result.innerHTML = '';
  shownZpid = null;
}

async function setListing(listing) {
  hasListing = true;
  currentZpid = listing.zpid || null;
  if (shownZpid && currentZpid && shownZpid !== currentZpid) clearResult();
  if (!shownZpid && currentZpid && !running) await restoreAnalysis(currentZpid);
  el.empty.style.display   = 'none';
  el.listing.style.display = '';
  lastListing = listing;
  el.addr.innerHTML = escapeHtml(listing.address)
    + (listing.priceText ? ' · ' + escapeHtml(listing.priceText) : '')
    + (listing.isOffMarket ? ' <span class="sp-offmarket">(off market)</span>' : '');
  el.note.textContent = listing.note || '';
  if (!running) {
    el.runBtn.disabled     = false;
    el.runLabel.textContent = el.result.innerHTML ? 'Run again' : 'Analyze Listing';
  }
}

function setRunning(statusText) {
  running = true;
  el.runBtn.disabled       = true;
  el.runLabel.textContent  = 'Analyzing…';
  el.error.style.display    = 'none';
  el.progress.style.display = '';
  el.status.textContent     = statusText || 'Working…';
}

function setDone() {
  running = false;
  el.runBtn.disabled      = false;
  el.runLabel.textContent = 'Run again';
  el.progress.style.display = 'none';
}

function setFailed(text) {
  setDone();
  el.error.style.display = '';
  el.errorMsg.textContent = text;
}

function pushActivity(text) {
  const item = document.createElement('div');
  item.className = 'sp-activity-item';
  item.textContent = text;
  el.activity.appendChild(item);
  el.activity.scrollTop = el.activity.scrollHeight;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let stylesInstalled = false;

function installStyles(css) {
  if (stylesInstalled || !css) return;
  const style = document.createElement('style');
  style.id = 'ch-panel-styles';
  style.textContent = css;
  document.head.appendChild(style);
  stylesInstalled = true;
}

function renderResult(html, styles, theme, zpid, restored) {
  installStyles(styles);
  const panel = document.createElement('div');
  panel.id = 'ch-panel';
  panel.className = 'visible';
  applyTheme(theme, panel);
  panel.innerHTML = html;
  el.result.innerHTML = '';
  el.result.appendChild(panel);
  wireResult(panel);
  el.scroller.scrollTop = 0;
  shownZpid = zpid || shownZpid;
  el.empty.style.display = 'none';
  if (!restored) el.listing.style.display = '';
}

function wireResult(panel) {
  panel.querySelectorAll('[data-comp-expand]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const more = btn.previousElementSibling;
      if (!more) return;
      const open = more.style.display !== 'none';
      more.style.display = open ? 'none' : 'flex';
      btn.textContent = open ? `Show ${btn.dataset.more} more ▾` : 'Show less ▴';
    });
  });

  panel.querySelectorAll('[data-section-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = panel.querySelector(btn.dataset.sectionToggle);
      const collapsed = target?.classList.toggle('collapsed');
      btn.textContent = collapsed ? '▸' : '▾';
      chrome.runtime.sendMessage({
        type: 'LOG_EVENT',
        event: 'section_expanded',
        payload: { section: btn.dataset.sectionToggle.replace('#ch-', '').replace('-body', '') },
      }).catch(() => {});
    });
  });

  const fsboToggle = panel.querySelector('#ch-fsbo-toggle');
  fsboToggle?.addEventListener('click', () => {
    const sec = panel.querySelector('#ch-fsbo-section');
    sec?.classList.toggle('collapsed');
    fsboToggle.textContent = sec?.classList.contains('collapsed') ? '▸' : '▾';
  });

  panel.querySelector('#ch-print-btn')?.addEventListener('click', () => {
    sendToTab({ type: 'CH_PRINT' });
  });

  panel.querySelectorAll(
    '#ch-downloadlogs-btn, #ch-sold-downloadlogs-btn, #ch-rent-downloadlogs-btn'
  ).forEach((btn) => {
    btn.addEventListener('click', () => sendToTab({ type: 'CH_DOWNLOAD_LOGS' }));
  });

  const slider = panel.querySelector('#ch-rate-lab');
  slider?.addEventListener('input', async () => {
    const out = await sendToTab({ type: 'CH_RATE_CHANGE', rate: Number(slider.value) });
    if (!out) return;
    const label = panel.querySelector('#ch-rate-lab-label');
    const piti  = panel.querySelector('#ch-rate-lab-piti');
    const left  = panel.querySelector('#ch-rate-lab-left');
    if (label) label.textContent = `${out.rate.toFixed(3)}%`;
    if (piti)  piti.textContent  = `$${out.piti.toLocaleString()}/mo`;
    if (left) {
      left.textContent = `${out.left < 0 ? '-' : '+'}$${Math.abs(out.left).toLocaleString()} left`;
      left.className = out.left < 0 ? 'ch-afford-neg' : 'ch-afford-pos';
    }
  });
}

el.runBtn.addEventListener('click', () => {
  el.activity.innerHTML = '';
  el.result.innerHTML   = '';
  setRunning('Starting…');
  sendToTab({ type: 'CH_RUN_ANALYSIS' });
});

el.retryBtn.addEventListener('click', () => {
  el.activity.innerHTML = '';
  setRunning('Starting…');
  sendToTab({ type: 'CH_RUN_ANALYSIS' });
});

el.errSetBtn.addEventListener('click', () => showView('settings'));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'CH_TO_PANEL') return;
  const m = msg.payload || {};

  switch (m.type) {
    case 'CH_LISTING':      setListing(m.listing); break;
    case 'CH_NO_LISTING':   setEmpty(); break;
    case 'CH_RESET':        if (!running) setEmpty(); break;
    case 'CH_ANALYSIS_SAVED': break;
    case 'CH_STATUS':       setRunning(m.text); break;
    case 'CH_ANALYZING':    setRunning('Analyzing the listing…'); break;
    case 'CH_PROGRESS':     if (running) pushActivity(m.text); break;
    case 'CH_PANEL_HTML':
      setDone();
      renderResult(m.html, m.styles, m.theme, m.zpid);
      saveAnalysis(m.zpid, m.html, m.styles, lastListing);
      break;
    case 'CH_FAILED':       setFailed(m.text); break;
    case 'CH_TOAST':        toast(m.text); break;
    case 'CH_NEEDS_KEY':
      setFailed('Add your API key in Settings to run an analysis.');
      break;
  }
});

function refreshListing() {
  sendToTab({ type: 'CH_REQUEST_LISTING' }).then((res) => {
    if (!res && !running) setEmpty();
  });
}

chrome.tabs.onActivated.addListener(() => { running = false; refreshListing(); });
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && tab.active) refreshListing();
});

(async () => {
  const got = await storeGet([STORE_KEY, CSS_KEY]);
  const map = got[STORE_KEY] || {};
  const newest = Object.keys(map).sort((a, b) => map[b].savedAt - map[a].savedAt)[0];
  if (newest && map[newest].html) {
    renderResult(map[newest].html, got[CSS_KEY], currentTheme, newest, true);
    const li = map[newest].listing;
    if (li) {
      lastListing = li;
      el.addr.innerHTML = escapeHtml(li.address || '')
        + (li.priceText ? ' · ' + escapeHtml(li.priceText) : '');
      el.note.textContent = li.note || '';
      el.listing.style.display = '';
      el.runLabel.textContent = 'Run again';
    }
  }
  refreshListing();
})();
