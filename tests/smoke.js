const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

const manifest = JSON.parse(read('manifest.json'));
const content = read('content.js');
const background = read('background.js');
const settings = read('settings.js');
const settingsHtml = read('settings.html');
const search = read('search.js');
const sidepanelHtml = read('sidepanel.html');
const sidepanelJs = read('sidepanel.js');

assert.equal(manifest.version, '1.4.6');
assert(manifest.host_permissions.includes('https://api.openai.com/*'));
assert(manifest.host_permissions.includes('https://api.anthropic.com/*'));

assert(settingsHtml.includes('id="ai-provider-select"'));
assert(settingsHtml.includes('id="ai-fast-mode-toggle"'));
assert(settings.includes("openai:    'gpt-5.6-terra'"));
assert(settings.includes('ch_api_keys'));
assert(background.includes("const provider = syn.ch_prefs?.aiProvider === 'openai' ? 'openai' : 'anthropic'"));

assert(content.includes("https://api.openai.com/v1/chat/completions"));
assert(content.includes("'Authorization': `Bearer ${apiKey}`"));
assert(content.includes("response_format: { type: 'json_object' }"));
assert(content.includes("service_tier: 'fast'"));
assert(content.includes('readProviderStream'));
assert(content.includes("type: 'PREFETCH_ANALYSIS_LOOKUPS'"));
assert(content.includes("id=\"ch-rate-lab\""));
assert(content.includes('calcPITIBreakdown(barPrice, Number(rate))'));

assert(background.includes('insurancePct:         profile.insurancePct || 0'));
assert(background.includes('result.taxEstimate.estimatedAfterReset = taxAtOffer;'),
  'tax badges/numbers must be recomputed on the Clear Home offer basis');
assert(background.includes("msg.type === 'PREFETCH_ANALYSIS_LOOKUPS'"));
assert(background.includes('getAnalysisLookupPromises(listingData)'));
assert(background.includes('JS-OWNED OUTPUT FIELDS'));
assert(search.includes('if (!filterActive) restoreMapPins();'));
assert(search.includes("if (c.img) img.src = c.img;"));

assert(!content.includes('ch-floorplan-btn'), 'floor plan button must stay removed');
assert(!content.includes('showFloorPlanResult'), 'floor plan renderer must stay removed');
assert(!content.includes('scrapeAllListingPhotos'), 'floor plan photo scraper must stay removed');
assert(!background.includes('ESTIMATE_FLOORPLAN'), 'floor plan message handler must stay removed');
assert(!content.includes('data-referral'), 'referral buttons must stay removed');
assert(!content.includes('showReferralModal'), 'referral modal must stay removed');
assert(!settingsHtml.includes('stat-referrals'), 'referral stat card must stay removed');

assert(!content.includes('AI is writing'), 'no AI narration in the activity feed');
assert(!/Analysis draft: \$\{/.test(content), 'no generated-character counter in the activity feed');
assert(!/token limit/i.test(content), 'no token jargon in user-facing copy');
assert(!content.includes('Uses your selected AI provider'), 'no provider name on the trigger card');
assert(content.includes('generated with the assistance of AI'), 'AI disclosure must remain');

assert(manifest.permissions.includes('sidePanel'));
assert.equal(manifest.side_panel?.default_path, 'sidepanel.html');
assert(background.includes('chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })'),
  'Chrome must not auto-open on icon click; the worker owns the toggle');
assert(background.includes('if (sidePanelIsOpen()) await closeSidePanel(tab?.id);'),
  'a second icon click must close the panel');
assert(background.includes("port.name !== 'ch_sidepanel'"),
  'panel liveness port must be tracked — it is the only open/closed signal');
assert(background.includes("msg.type === 'OPEN_SIDE_PANEL'"));
assert(!background.includes("chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') })"),
  'settings must never open in a new tab');
assert(sidepanelJs.includes("chrome.runtime.connect({ name: 'ch_sidepanel' })"),
  'panel must announce itself or the icon toggle breaks');
assert(sidepanelHtml.includes('src="settings.html"'), 'settings must render inside the side panel');
assert(!content.includes("type: 'OPEN_SIDE_PANEL'"),
  'nothing in the page opens the panel now — the icon does');

assert(!content.includes('function showManualTrigger'), 'the floating trigger card must stay removed');
assert(!content.includes('function getManualTriggerHTML'), 'trigger card markup must stay removed');
assert(!content.includes('attachShadow'), 'no shadow-root panel may be mounted in the page');
assert(!content.includes('function wirePanelEvents'), 'in-page panel wiring must stay removed');
assert(!content.includes("panelHost"), 'the popup host element must stay removed');
assert(content.includes('chPanelRoot = document.createElement'),
  'the panel must render into a detached root instead');
assert(content.includes('function pushPanel()'), 'the rendered panel must be shipped to the side panel');
assert(content.includes("type:   'CH_PANEL_HTML',"), 'panel HTML + styles ride one message');
assert(content.includes('function runManualAnalysis'), 'the side panel must be able to start a run');
assert(content.includes('function announceListing'), 'the side panel must learn which listing is open');

assert(sidepanelJs.includes("case 'CH_PANEL_HTML'"), 'panel must render the shipped analysis');
assert(sidepanelJs.includes("case 'CH_PROGRESS'"), 'panel must show live progress');
assert(sidepanelJs.includes("{ type: 'CH_RUN_ANALYSIS' }"), 'Analyze button must drive the content script');
assert(sidepanelJs.includes("{ type: 'CH_PRINT' }"), 'print must round-trip to the page');
assert(sidepanelJs.includes("type: 'CH_RATE_CHANGE'"), 'Rate Lab slider must recompute through the page');
assert(sidepanelJs.includes('function wireResult'), 'shipped markup needs its handlers re-bound here');
assert(sidepanelHtml.includes('id="sp-run-btn"'), 'the Analyze button lives in the panel now');
assert(sidepanelHtml.includes('id="sp-progress"'), 'the panel owns the progress view');

assert(!settingsHtml.includes('id="ai-model-select"'), 'model dropdown must stay removed');
assert(!settings.includes('PROVIDER_MODELS'), 'per-provider model list must stay removed');
assert(settings.includes("anthropic: 'claude-sonnet-5'"), 'Anthropic must resolve to Sonnet 5');
assert(settings.includes('aiModel:         PROVIDER_MODEL[activeProvider]'),
  'the saved model must follow the provider');

assert(!search.includes("'background:#1a1a2e'"), 'the price-cut bar must not stay dark');
assert(!search.includes('background:#1a1a2e;color:#e8eaf2'), 'the All Cuts panel must not stay dark');
assert(!search.includes('#8888aa'), 'old slate-on-dark text must stay replaced');
assert(!search.includes('#a5b4fc'), 'old indigo accent must stay replaced');
assert(search.includes("btn.style.color = '#3d465c';"), 'idle toggle text must read on white');

{
  const line = search.split('\n').find(l => l.includes('[A-Z]{2}') && l.includes('.test(path)'));
  assert(line, 'search.js must still match City-State search paths');
  const cityState = new RegExp(line.match(/\/(.+)\/\.test\(path\)/)[1]);
  for (const p of ['/Orlando-FL/', '/Winter-Garden-FL/', '/Haines-City-FL/', '/Palm-Beach-Gardens-FL/', '/Winter-Garden-FL/houses/']) {
    assert(cityState.test(p), `City-State pattern must match ${p}`);
  }
  for (const p of ['/homedetails/1234-Main-St-Winter-Garden-FL-34787/12345678_zpid/', '/', '/homes/', '/mortgage-rates/']) {
    assert(!cityState.test(p), `City-State pattern must not match ${p}`);
  }
}

assert(sidepanelJs.includes("panel.className = 'visible';"),
  'the rendered panel must carry .visible or nothing in it is clickable');
assert(sidepanelHtml.includes('pointer-events: auto !important;'),
  'the panel override must guarantee interactivity even without the class');

assert(sidepanelHtml.includes('@media (prefers-color-scheme: dark)'),
  'the side panel shell needs the dark palette too');
assert(sidepanelHtml.includes(':root[data-theme="dark"]'),
  'an explicit Dark choice must override the system preference');
assert(content.includes('theme:  currentTheme'),
  'the theme class rides with the HTML — innerHTML does not carry it');
assert(sidepanelJs.includes('function applyTheme'), 'the panel applies the shipped theme');

assert(content.includes('function chLooksLikeAddress'), 'the title needs vetting before use');
assert(content.includes("'Detecting address…'"), 'unknown address must say so, not guess');
assert(!content.includes('"streetAddress"\\s*:\\s*"'),
  'never grab the first streetAddress in NEXT_DATA — it can be a nearby home');
assert(content.includes('function chAddressFromUrl'), 'the /homedetails/ slug is the anchor');
assert(content.includes('function chAddrMatchesUrl'), 'candidates must be checked against the URL');
{
  const code = content.slice(content.indexOf('function chLooksLikeAddress'),
                             content.indexOf('function chQuickListing'));
  const make = new Function(
    'return (pathname, title) => { const location = { pathname }, document = { title };'
    + code + '; return chQuickAddress(); };')();
  const BOLERO = '/homedetails/9560-Bolero-Rd-Winter-Garden-FL-34787/338514469_zpid/';
  assert.equal(make(BOLERO, '9560 Bolero Rd, Winter Garden, FL 34787 | Zillow'), '9560 Bolero Rd');
  assert.equal(make(BOLERO, 'Winter Garden FL Real Estate - Homes For Sale | Zillow'), '9560 Bolero Rd');
  assert.equal(make(BOLERO, '16968 Hamlin Oasis Loop, Winter Garden, FL 34787 | Zillow'), '9560 Bolero Rd');
  assert.equal(make('/homedetails/87-W-Plant-St-APT-2-Winter-Garden-FL-34787/555_zpid/',
                    '87 W Plant St APT 2, Winter Garden, FL 34787 | Zillow'), '87 W Plant St APT 2');
  assert.equal(make('/Winter-Garden-FL/', 'Winter Garden FL Real Estate | Zillow'), '');
}

assert(sidepanelJs.includes('port.onDisconnect.addListener(() => { setTimeout(connectPort, 250); });'),
  'panel must re-announce itself after a service worker restart');

assert(!content.includes('onclick='),
  'inline handlers are dead on an extension page - wire them in sidepanel.js');
assert(content.includes('data-comp-expand'), 'the comps expander needs a hook the panel can bind');
assert(sidepanelJs.includes("querySelectorAll('[data-comp-expand]')"),
  'the comps expander must be wired in the panel');

assert(sidepanelJs.includes("const STORE_KEY = 'ch_analyses';"), 'analyses must be persisted');
assert(sidepanelJs.includes('function saveAnalysis'), 'a finished analysis must be saved');
assert(sidepanelJs.includes('function restoreAnalysis'), 'a saved analysis must be restorable');
assert(content.includes('function chZpid'), 'saved analyses are keyed by zpid');
assert(content.includes('zpid:   chZpid(),'), 'the panel payload must carry its zpid');
{
  const body = sidepanelJs.slice(sidepanelJs.indexOf('function setEmpty'));
  const end  = body.indexOf('\n}');
  assert(!body.slice(0, end).includes("el.result.innerHTML       = ''"),
    'leaving a listing tab must never wipe the analysis the user paid for');
}

assert(search.includes("btn.style.background = '#4F6BFF';"));
assert(!search.includes("btn.style.background = 'rgba(99,102,241,.85)';"),
  'old indigo active state must stay replaced');

const searchHead = search.slice(0, search.indexOf('function isSearchPage'));
assert((searchHead.match(/return;/g) || []).length === 1,
  'only the hostname bail may remain at module level in search.js');
assert(search.includes("if (location.pathname.indexOf('/homedetails/') !== -1 || !isSearchPage()) return;"),
  'inject() must gate per-URL now that it is reachable everywhere');
assert(search.includes('function armDomWatch()') && search.includes('function disarmDomWatch()'),
  'observer must arm on results pages and disarm off them');

console.log('Clear Home 1.4.6 smoke checks passed.');
