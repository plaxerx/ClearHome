

let homePanel        = null;
let chPanelRoot      = null;
let chRateLabCtx     = null;   
let clearHomeEnabled = true;
let currentTheme     = 'system';
let lastAnalyzedUrl  = '';
let analysisInProgress = false;
let scrollingInProgress = false; 
let analysisAbortKey = 0; 

const CH_LOG_MAX = 300;
let chDiagLog = [];
let chLastResult = null;     
let chLastScraped = null;    
let chLastRawResponse = null; 
let chAnalysisEffort = 'low'; 
function chLog(tag, detail) {
  try {
    const entry = { t: new Date().toISOString(), tag, detail: detail ?? null };
    chDiagLog.push(entry);
    if (chDiagLog.length > CH_LOG_MAX) chDiagLog.shift();
  } catch (e) {}
}
try {
  self.addEventListener?.('error', (e) => chLog('window.error', { message: e.message, src: e.filename, line: e.lineno, col: e.colno }));
  self.addEventListener?.('unhandledrejection', (e) => chLog('unhandledrejection', { reason: String(e.reason).slice(0, 500) }));
} catch (e) {}


function sendToPanel(msg) {
  try { chrome.runtime.sendMessage({ type: 'CH_TO_PANEL', payload: msg })?.catch?.(() => {}); } catch (e) {}
}

function chZpid() {
  const m = location.pathname.match(/\/(\d+)_zpid/);
  return m ? m[1] : '';
}

function pushPanel() {
  if (!chPanelRoot) return;
  sendToPanel({
    type:   'CH_PANEL_HTML',
    html:   chPanelRoot.innerHTML,
    styles: getPanelStyles(),
    theme:  currentTheme,
    zpid:   chZpid(),
    url:    location.href,
  });
}

function rateLabRecompute(rate) {
  if (!chRateLabCtx) return null;
  const { barPrice, takehome, utilEst, debts, discretionary } = chRateLabCtx;
  const piti = calcPITIBreakdown(barPrice, Number(rate)).total;
  return { rate: Number(rate), piti, left: takehome - piti - utilEst - debts - discretionary };
}

function resetState() {
  if (scrollingInProgress) return; 
  analysisAbortKey++;
  analysisInProgress = false;
  lastAnalyzedUrl    = '';
  stopCanvasSpinner();
  _activityTimers.forEach(clearTimeout);
  _activityTimers = [];
  chPanelRoot  = null;
  homePanel    = null;
  chRateLabCtx = null;
  document.querySelectorAll('#clear-home-host').forEach(el => el.remove());
  sendToPanel({ type: 'CH_RESET' });
}

chrome.runtime.sendMessage({ type: 'GET_ENABLED' }).then(r => {
  clearHomeEnabled = r?.enabled !== false;
  if (clearHomeEnabled) maybeAnalyze();
}).catch(() => { maybeAnalyze(); });

chrome.runtime.sendMessage({ type: 'GET_THEME' }).then(r => {
  currentTheme = r?.theme || 'system';
  applyTheme(currentTheme);
}).catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CH_REQUEST_LISTING') {
    announceListing();
    sendResponse && sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'CH_RUN_ANALYSIS') {
    runManualAnalysis();
    sendResponse && sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'CH_PRINT') {
    if (chPanelRoot) printAnalysis(chPanelRoot, chLastScraped || {});
    sendResponse && sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'CH_DOWNLOAD_LOGS') {
    try { downloadDiagnosticLogs(chLastScraped || {}); }
    catch (err) { chToast('Log export failed — ' + (err?.message || err)); }
    sendResponse && sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'CH_RATE_CHANGE') {
    sendResponse && sendResponse(rateLabRecompute(msg.rate));
    return true;
  }
  if (msg.type === 'SETTINGS_CHANGED') {
    clearHomeEnabled = msg.enabled !== undefined ? msg.enabled : clearHomeEnabled;
    currentTheme     = msg.theme     !== undefined ? msg.theme  : currentTheme;
    if (homePanel) applyTheme(currentTheme);
    if (clearHomeEnabled && !analysisInProgress) maybeAnalyze();
    if (!clearHomeEnabled) { chPanelRoot = null; sendToPanel({ type: 'CH_RESET' }); }
  }
  if (msg.type === 'PRIORITIES_CHANGED') {
  }
  if (msg.type === 'PROFILE_CHANGED') {
  }
});

let lastUrl = location.href;

function handleUrlChange() {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    resetState();
    setTimeout(() => { if (clearHomeEnabled) maybeAnalyze(); }, 2500);
  }
}

const urlObserver = new MutationObserver(handleUrlChange);
urlObserver.observe(document.body, { childList: true, subtree: true });

const _pushState    = history.pushState.bind(history);
const _replaceState = history.replaceState.bind(history);
history.pushState    = function(...a) { _pushState(...a);    setTimeout(handleUrlChange, 50); };
history.replaceState = function(...a) { _replaceState(...a); setTimeout(handleUrlChange, 50); };
window.addEventListener('popstate', () => setTimeout(handleUrlChange, 50));

function isListingPage() {
  const url      = location.href;
  const hostname = location.hostname;
  if (hostname.includes('zillow.com'))   return /\/homedetails\//.test(url);
  return false;
}

function detectSite() {
  return 'Zillow';
}

async function scrapeListing() {
  const site = detectSite();
  let data = {
    listingSite: site,
    isFSBO: false,
    address: '',
    price: 0,
    rentPrice: 0,   
    sqft: 0,
    beds: 0,
    baths: 0,
    description: '',
    agentName: '',
    agentPhone: '',
    brokerageName: '',
    propertyModel: '',
    builderName:   '',
    yearBuilt: '',
    lotSize: '',
    propertyType: '',
    hoaFee: '',
    taxHistory: [],       
    priceHistory: [],     
    propertyDetails: {},  
    listingMode: 'buy',    
    homeStatus: '',
    rentZestimate: 0,
    rentZestimateRange: null,
    leaseTerms: '',
    petPolicy: '',
    laundry: '',
    parkingType: '',
    applicationFee: 0,
    depositMin: 0,
    availableDate: '',
    utilitiesIncluded: '',
    landlordName: '',
    landlordPhone: '',
    landlordEmail: '',
    landlordCompany: '',
    isPrivateLandlord: false,
    landlordOtherListings: 0,
    landlordProfileUrl: '',
    dateSold: '',
    soldPrice: 0,
    daysToSell: 0,
    zestimate: 0,
    daysOnMarket: 0,
    mlsId: '',
    garage: '',
    stories: '',
    cooling: '',
    heating: '',
    parking: '',
  };

  if (site === 'Zillow') {
    data = await scrapeZillow(data);
  } else if (site === 'Redfin') {
    data = scrapeRedfin(data);
  } else if (site === 'Realtor.com') {
    data = scrapeRealtor(data);
  }

  if (site === 'Zillow' && !data.isFSBO) {
    try {
      const bank = chReadAgent();
      let nm = bank.name || '', ph = bank.phone || '';
      if (!nm || !ph) {
        for (const src of [_chRenderedText, _chDeepText, _chListedByBlock]) {
          if (nm && ph) break;
          const r = chParseAgentDirect(src || '');
          if (r.name && !nm) nm = r.name;
          if (r.phone && !ph) ph = r.phone;
        }
      }
      if (nm && !data.agentName)  data.agentName  = nm;
      if (ph && !data.agentPhone) data.agentPhone = ph;
      _chAgentDebug.finalStamp = { bank: { name: bank.name || '', phone: bank.phone || '' },
                                   result: { name: data.agentName || '', phone: data.agentPhone || '' } };
    } catch (e) {}
  }

  lastScrapedData = data; 
  return data;
}

function parseNum(str) {
  if (!str) return 0;
  return parseFloat(str.replace(/[^0-9.]/g, '')) || 0;
}

function extractZillowNextData() {
  try {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return null;
    const json  = JSON.parse(el.textContent);
    const props = json?.props?.pageProps;

    const zpidM  = location.pathname.match(/\/(\d+)_zpid/);
    const urlZpid = zpidM ? zpidM[1] : null;

    const gdp = props?.gdpClientCache;
    if (gdp) {
      const keys = Object.keys(gdp);
      const matchingKey = urlZpid ? keys.find(k => k.includes(urlZpid)) : null;
      const tryKey = (key) => {
        try {
          const inner = JSON.parse(gdp[key]);
          const data  = inner?.property || inner?.gdp || inner;
          if (data && (!urlZpid || !data.zpid || String(data.zpid) === urlZpid)) {
            if (data?.price || data?.listPrice || data?.zpid || data?.address) return data;
          }
        } catch(e) {}
        return null;
      };
      const result = (matchingKey ? tryKey(matchingKey) : null) || tryKey(keys[0]);
      if (result) return result;
    }

    const atf = props?.aboveTheFold?.homeData || props?.aboveTheFold;
    if (atf && (!urlZpid || !atf.zpid || String(atf.zpid) === urlZpid)) {
      if (atf?.price || atf?.listPrice || atf?.address) return atf;
    }

    const direct = props?.listing || props?.property || props?.homeDetails;
    if (direct) return direct;

    return null;
  } catch(e) {
    return null;
  }
}

function extractFullPageText() {
  try {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, nav, header').forEach(el => el.remove());
    const txt = clone.textContent || clone.innerText || '';
    return txt;
  } catch(e) {
    return document.body?.innerText || document.body?.textContent || '';
  }
}

function parseSchoolsFromText(text) {
  const out = [];
  if (!text || typeof text !== 'string') return out;
  const secM = text.match(/Nearby schools[\s\S]{0,1500}?(?:More about schools|More school details|Skip carousel|Nearby homes|Local experts|$)/i);
  const region = secM ? secM[0] : text;
  const re = /([A-Za-z][^\n]{1,70}?)\s*Grades?\s+([A-Za-z0-9\-]{1,8})\s*[•·∙]\s*([\d.]+)\s*mi(?:les)?\s*(\d{1,2})\s*\/\s*10\s*(?:GreatSchools®?\s*Rating)?\s*(?:Test Score Rating\s*\d{1,2}\s*\/\s*10)?\s*(?:Student Progress Rating\s*\d{1,2}\s*\/\s*10)?/gi;
  let m;
  while ((m = re.exec(region)) !== null) {
    let name = (m[1] || '').trim();
    name = name.replace(/.*GreatSchools®?\s*Rating?/is, '')
               .replace(/.*GreatSchools®?/is, '')
               .replace(/^\s*Source:?\s*/i, '')
               .replace(/^Nearby schools\s*/i, '')
               .replace(/^[\s•·∙\-]+/, '')
               .trim();
    if (!name || name.length < 3 || /^\d/.test(name)) continue;
    out.push({ name, grades: m[2].trim(), distance: m[3] + ' mi', rating: m[4] + '/10' });
    if (out.length >= 6) break;
  }
  return out;
}

let lastScrapedData = null;

function extractPhotos() {
  const photos = [];
  const seen = new Set();

  const heroSelectors = [
    '[data-testid="media-stream"] img',
    '[class*="media-stream"] img',
    '[data-testid="hollywood-image"] img',      
    '[class*="Showcase"] img',                   
    '[class*="carousel"] img',                   
    '[class*="gallery"] img',                    
    'picture[class*="photo"] img',
    '[class*="hdp__sc-"] > picture img',
    '[aria-label*="view larger"] img',
    '[class*="ZilPxlView"] img',                 
  ];
  for (const sel of heroSelectors) {
    const imgs = document.querySelectorAll(sel);
    for (const img of imgs) {
      const src = img.src || img.dataset?.src || img.currentSrc || '';
      if (!src || seen.has(src)) continue;
      if (img.naturalWidth > 0 && img.naturalWidth < 100) continue;
      if (src.includes('logo') || src.includes('icon') || src.includes('avatar') || src.includes('agent') || src.includes('profile')) continue;
      if (src.includes('p_a/') || src.includes('p_e/')) continue;
      if (src.includes('zillowstatic') || src.includes('photos.zillow')) {
        photos.push(src);
        seen.add(src);
        break; 
      }
    }
    if (photos.length > 0) break;
  }

  try {
    const ndEl = document.getElementById('__NEXT_DATA__');
    if (ndEl) {
      const snippet = ndEl.textContent;
      const patterns = [
        /"url"\s*:\s*"(https:\/\/[^"]*photos\.zillowstatic[^"]+)"/g,
        /"mixedSources"[\s\S]*?"url"\s*:\s*"(https:\/\/[^"]+zillowstatic[^"]+)"/g,
      ];
      for (const pattern of patterns) {
        for (const m of snippet.matchAll(pattern)) {
          if (!seen.has(m[1]) && photos.length < 5) { photos.push(m[1]); seen.add(m[1]); }
        }
      }
    }
  } catch(e) {}

  if (photos.length === 0) {
    document.querySelectorAll('img[src*="zillowstatic"], img[src*="photos.zillow"]').forEach(img => {
      const src = img.src || img.dataset?.src || '';
      if (!src || seen.has(src)) return;
      if (src.includes('logo') || src.includes('icon') || src.includes('avatar') || src.includes('agent') || src.includes('profile')) return;
      if (src.includes('p_a/') || src.includes('p_e/')) return;
      if (src.includes('photos') || src.includes('p_f/') || src.includes('p_d/') || src.includes('zillowstatic')) {
        photos.push(src);
        seen.add(src);
      }
    });
  }

  return photos.slice(0, 5);
}

function countListingPhotos(fullText) {
  let m = (fullText || '').match(/See all\s+(\d{1,4})\s+photos/i);
  if (m) { const n = parseInt(m[1], 10); if (n > 0 && n <= 5000) return n; }
  try {
    const ndEl = document.getElementById('__NEXT_DATA__');
    if (ndEl && ndEl.textContent) {
      const txt = ndEl.textContent;
      const ms = (txt.match(/"mixedSources"/g) || []).length;
      if (ms > 0) return ms;
      const hashes = new Set();
      for (const mm of txt.matchAll(/photos\.zillowstatic\.com\/fp\/([a-f0-9]{8,})-/gi)) hashes.add(mm[1]);
      if (hashes.size > 0) return hashes.size;
    }
  } catch (e) {}
  m = (fullText || '').match(/\b(\d{1,4})\s+photos?\b/i);
  if (m) { const n = parseInt(m[1], 10); if (n > 1 && n <= 5000) return n; }
  return 0;
}


function sanitizeFactValue(raw) {
  if (!raw) return '';
  let v = String(raw).trim();
  const b = v.search(/\s[A-Z][A-Za-z]*(?:\s[A-Za-z()&/]+){0,3}:/);
  if (b > 0) v = v.slice(0, b);
  if (v.length > 140) v = v.slice(0, 140);
  return v.replace(/[\s,;|•·]+$/, '').trim();
}

function scrapeFactsFromDOM(data, fullText) {

  const patterns = [
    { re: /Heating(?:\s*features?)?[:\s]+([^\n]{2,60})/i, field: 'heating',
      transform: v => /central|electric|gas|forced|heat\s*pump|baseboard|radiant|propane|solar|ductless|wall|window|geothermal|evaporative|hot\s*water|natural|zoned|none/i.test(v) ? v.trim() : '' },
    { re: /Cooling(?:\s*features?)?[:\s]+([^\n]{2,60})/i, field: 'cooling',
      transform: v => /central|electric|gas|wall|window|ductless|heat\s*pump|geothermal|evaporative|zoned|none|a\/?c|air/i.test(v) ? v.trim() : '' },
    { re: /(?:Stories|Levels|Number of stories)[:\s]+([^\n]{1,24})/i, field: 'stories',
      transform: v => /one|two|three|four|split|tri|multi|bi|\b[1-4]\b/i.test(v) ? v.trim() : '' },
    { re: /(?:Has\s+(?:private\s+)?pool|Private pool)[:\s]+(Yes|No)/i, field: 'poolText' },
    { re: /Pool features?[:\s]+([^\n]{2,60})/i,                          field: 'poolFeatures' },
    { re: /Has\s+spa[:\s]+(Yes|No)/i,                                     field: 'spaText' },
    { re: /Spa features?[:\s]+([^\n]{2,50})/i,                            field: 'spaFeatures' },
    { re: /Has\s+view[:\s]+(Yes|No)/i,                                    field: 'viewHas' },
    { re: /\bView[:\s]+([^\n]{2,50})/i, field: 'viewText',
      transform: v => /water|lake|pond|golf|city|mountain|park|garden|trees?|pool|canal|preserve|conservation|river|ocean|beach|skyline/i.test(v) ? v.trim() : '' },
    { re: /Waterfront features?[:\s]+([^\n]{2,60})/i,                     field: 'waterfront' },
    { re: /\bAppliances\b[\s\n]+((?:[\*•\-][^\n]+\n?)+)/i,               field: 'appliances', multiline: true },
    { re: /(?:Appliances included|Included appliances)[:\s]+([^\n]{2,120})/i, field: 'appliances' },
    { re: /\bAppliances\b[\s\S]{0,15}?Included[:\s]+([^\n]{3,150})/i,     field: 'appliances' },
    { re: /Flooring[:\s]+([^\n\*•]+)/i,                                   field: 'flooring' },
    { re: /Has fireplace[:\s]+(Yes|No)/i,                                 field: 'fireplaceText' },
    { re: /Common walls[^:]*:[:\s]+([^\n]+)/i,                            field: 'commonWalls' },
    { re: /Total interior livable area[:\s]+([0-9,]+)\s*sq/i,             field: 'sqftLivable' },
    { re: /Total structure area[:\s]+([0-9,]+)/i,                         field: 'sqftTotal' },
    { re: /\bBedrooms[:\s]+(\d+)/i,                                       field: 'bedsVerify' },
    { re: /Full bathrooms[:\s]+(\d+)/i,                                   field: 'fullBaths' },
    { re: /(\d+)\s+full\s+bathroom/i,                                     field: 'fullBaths' },
    { re: /1\/2 bathrooms?[:\s]+(\d+)/i,                                  field: 'halfBaths' },
    { re: /(\d+)\s+half\s+bathroom/i,                                     field: 'halfBaths' },
    { re: /(\d+)\s+(?:one.half|1\/2)\s+bathroom/i,                       field: 'halfBaths' },
    { re: /(?:^|\n)\s*Size[:\s]+([0-9,]+)\s*Square\s*Feet/im,            field: 'lotSize', transform: v => { const n = parseInt(v.replace(/,/g,''),10); return n > 0 && n <= 500000 ? n.toLocaleString() + ' sqft' : ''; } },
    { re: /\bLot\b[^0-9]{0,20}([0-9,]+)\s*(?:sq|Square\s*Feet)/i,       field: 'lotSize', transform: v => { const n = parseInt(v.replace(/,/g,''),10); return n > 0 && n <= 500000 ? n.toLocaleString() + ' sqft' : ''; } },
    { re: /Total spaces[:\s]+(\d+)/i,                                     field: 'parkingSpaces' },
    { re: /Parking features[:\s]+([^\n]+)/i,                              field: 'parking' },
    { re: /Attached garage spaces[:\s]+(\d+)/i,                           field: 'garageSpaces' },
    { re: /Home type[:\s]+([^\n]+)/i,                                     field: 'propertyType' },
    { re: /Property subtype[:\s]+([^\n]+)/i,                              field: 'propertySubtype' },
    { re: /Year built[:\s]+(\d{4})/i,                                     field: 'yearBuilt' },
    { re: /Builder\s*name[:\s]*([A-Za-z][A-Za-z0-9\s&'.,-]{1,40}?)(?=\s*(?:Builder\s*model|Utilities|Sewer|Water|Year|Lot|Type|Garage|HOA|New\s*con|Condi|\*|$))/i, field: 'builderNameText' },
    { re: /Builder\s*model[:\s]*([A-Za-z0-9][A-Za-z0-9\s\-]{1,20}?)(?=\s*(?:Utilities|Sewer|Water|Year|Lot|Type|Garage|HOA|New\s*con|Condi|Builder\s*name|\*|$))/i,  field: 'builderModelText' },
    { re: /Roof[:\s]+([^\n]+)/i,                                          field: 'roofType' },
    { re: /Foundation[:\s]+([^\n]+)/i,                                    field: 'foundation' },
    { re: /(?:^|\n)\s*\*?\s*((?:Block|Brick|Stucco|Wood\s*Frame|Concrete|CBS|Stone|Vinyl\s*Siding|Fiber\s*Cement|HardiPlank|Cement\s*Siding|Metal\s*Siding)(?:\s*,\s*[A-Za-z][A-Za-z\s\/]+?)*)\s*(?:\n|$)/im, field: 'constructionMaterials' },
    { re: /(?:^|\n)\s*Materials\s*\n\s*([A-Z][A-Za-z,\s\/&-]{2,80})/i, field: 'constructionMaterials',
      transform: v => /block|brick|stucco|wood\s*frame|concrete|cbs|stone|vinyl|cement|hardiplank|fiber|metal\s*siding/i.test(v) ? v.trim() : '' },
    { re: /Construction materials?[:\s]+([^\n]+)/i,                       field: 'constructionMaterials' },
    { re: /New construction[:\s]+(Yes|No)/i,                              field: 'newConstructionText' },
    { re: /Condition[:\s]+([^\n]+)/i,                                     field: 'condition' },
    { re: /Subdivision[:\s]+([^\n]+)/i,                                   field: 'subdivision' },
    { re: /HOA fee[:\s]+\$?([0-9,]+)\s*(?:monthly|\/mo)?/i,              field: 'hoaFeeText' },
    { re: /HOA name[:\s]+([^\n]+)/i,                                      field: 'hoaNameText' },
    { re: /Parcel number[:\s]+([0-9\-A-Z]+)/i,                           field: 'parcelNumber' },
    { re: /Tax assessed value[:\s]+\$?([0-9,]+)/i,                       field: 'taxAssessedText' },
    { re: /Annual tax amount[:\s]+\$?([0-9,]+)/i,                        field: 'taxAnnualText' },
    { re: /Date on market[:\s]+([0-9\/]+)/i,                              field: 'listDate' },
    { re: /Cumulative days[^:]*[:\s]+(\d+)/i,                            field: 'daysOnMarketText' },
    { re: /MLS#?:?\s*([A-Z0-9]{5,15})(?=\s|$|\b)/i,                    field: 'mlsIdText' },
    { re: /Listing\s+courtesy\s+of[:\s]+([^,\n\d]{3,60}?)(?=\s*\d{3}[-.]\d{3}|\s*,|\n|$)/i, field: 'agentNameText' },
    { re: /Source:\s*([A-Z][A-Za-z0-9]{1,20})(?=\s|,|as\s|$)/,          field: 'mlsSourceText' },
    { re: /Zoning[:\s]+([^\n]+)/i,                                       field: 'zoning' },
    { re: /Sewer[:\s]+([^\n]+)/i,                                         field: 'sewer' },
    { re: /(?:^|\n)\s*\*?\s*Water\s*:\s*([^\n]{2,40})/im,                 field: 'waterSource',
      transform: v => /public|private|well|city|municipal|cistern|spring|community|county|shared/i.test(v) ? v.trim() : '' },
    { re: /Exterior features?[:\s]+([^\n]+)/i,                            field: 'exteriorFeaturesText' },
    { re: /Interior features?[:\s]+([^\n]+)/i,                            field: 'interiorFeaturesText' },
    { re: /Listing Provided by[:\s]*\n?\s*([^\n\d,]{4,60})(?:\s+\d{3})/i, field: 'agentNameText' },
    { re: /Source[:\s]+([^\n,]+),\s*MLS/i,                               field: 'mlsSourceText' },
    { re: /(?:Lease|Lease type|Lease term)[:\s]+([^\n]+)/i,               field: 'leaseTermsText' },
    { re: /Pets[:\s]+([^\n]+)/i,                                           field: 'petPolicyText' },
    { re: /Pet policy[:\s]+([^\n]+)/i,                                     field: 'petPolicyText' },
    { re: /Laundry[:\s]+([^\n]+)/i,                                        field: 'laundryText' },
    { re: /Available[:\s]+([^\n]+)/i,                                      field: 'availableDateText' },
    { re: /Deposit[:\s]+\$?([0-9,]+)/i,                                    field: 'depositText' },
    { re: /Application fee[:\s]+\$?([0-9,]+)/i,                           field: 'applicationFeeText' },
    { re: /Utilities included[:\s]+([^\n]+)/i,                             field: 'utilitiesIncludedText' },
  ];

  const factText = _chRenderedText
    || (typeof document !== 'undefined' && document.body && document.body.innerText)
    || (fullText || '');

  for (const { re, field, multiline, transform } of patterns) {
    if (data[field]) continue; 
    const m = factText.match(re);
    if (!m) continue;

    let val = m[1]?.trim() || '';
    if (!val) continue;
    if (multiline) {
      val = val.replace(/[\*•\-]\s*/g, '').replace(/\n+/g, '; ').trim();
    } else if (!transform) {
      val = sanitizeFactValue(val);
    }
    if (transform) val = transform(val);
    if (val) data[field] = val;
  }

  if (!data.sqft && data.sqftLivable)    data.sqft   = parseNum(data.sqftLivable);
  if (!data.yearBuilt && data.yearBuilt) data.yearBuilt = data.yearBuilt;
  if (!data.builderName && data.builderNameText) data.builderName = data.builderNameText.trim();
  if (!data.propertyModel && data.builderModelText) {
    const _sb2 = (s) => (s||'').replace(/\s*Builder\b|Builder$/gi, '').trim();
    data.propertyModel = _sb2(data.builderModelText);
  }
  if (!data.hoaFee && data.hoaFeeText)   data.hoaFee = parseNum(data.hoaFeeText);
  if (!data.hoaName && data.hoaNameText) data.hoaName = data.hoaNameText;
  if (data.agentNameText) data.agentName = data.agentNameText.trim();
  if (data.mlsIdText)     data.mlsId     = data.mlsIdText.trim();
  if (data.mlsSourceText) data.mlsSource = data.mlsSourceText.trim();
  if (!data.listDate && data.listDateText) data.listDate = data.listDateText;
  if (data.newConstructionText)          data.newConstruction = /yes/i.test(data.newConstructionText);
  if (data.fireplaceText)               data.fireplace = /yes/i.test(data.fireplaceText);

  if (!data.hasPool && (data.poolText === 'Yes' || data.poolFeatures)) data.hasPool = true;
  if (data.poolFeatures && !data.poolDetail) data.poolDetail = data.poolFeatures;
  if (!data.spa && (data.spaText === 'Yes' || data.spaFeatures)) data.spa = data.spaFeatures || true;
  if (!data.view && (data.viewText || data.viewHas === 'Yes')) data.view = data.viewText || 'Yes';

  if (!data.garage && data.garageSpaces) data.garage = `${data.garageSpaces} space(s)`;

  if (data.bedsVerify && parseNum(data.bedsVerify) > 0) data.beds = parseNum(data.bedsVerify);
  if (data.fullBaths !== undefined || data.halfBaths !== undefined) {
    const full = parseNum(String(data.fullBaths || 0));
    const half = parseNum(String(data.halfBaths || 0));
    if (full <= 10 && half <= 4) {
      data.baths = full + (half * 0.5);
      if (full > 0 || half > 0) data.bathsDetail = `${full} full, ${half} half`;
    }
  }
  if (data.baths > 10) {
    const headerBathM = fullText.slice(0, 2000).match(/(\d+(?:\.\d)?)\s*ba\b/i);
    if (headerBathM) data.baths = parseFloat(headerBathM[1]);
    else data.baths = 0; 
  }

  ['sqftLivable','sqftTotal','bedsVerify','fullBaths','halfBaths','garageSpaces',
   'parkingSpaces','fireplaceText','newConstructionText','hoaFeeText','hoaNameText',
   'agentNameText','mlsIdText','mlsSourceText','taxAssessedText','taxAnnualText',
   'daysOnMarketText','exteriorFeaturesText','interiorFeaturesText','commonWalls'
  ].forEach(k => {
    if (data[k] !== undefined) {
      if (k === 'exteriorFeaturesText' && !data.exteriorFeatures) data.exteriorFeatures = data[k];
      if (k === 'interiorFeaturesText' && !data.interiorFeatures) data.interiorFeatures = data[k];
      delete data[k];
    }
  });

  if (!data.lotSize) {
    const lotM = fullText.match(/\bLot\b[^0-9]{0,20}([0-9,]+)\s*(?:sq|Square)/i)
              || fullText.match(/(?:^|\n)\s*Size[:\s]+([0-9,]+)\s*Square/im);
    if (lotM) {
      const lotVal = parseInt(lotM[1].replace(/,/g,''), 10);
      if (lotVal > 0 && lotVal <= 500000) data.lotSize = lotVal.toLocaleString() + ' sqft';
    }
  }
}

function matchAndSet(data, factMap, label, value) {
  for (const { patterns, field } of factMap) {
    if (patterns.some(re => re.test(label.trim()))) {
      if (!data[field]) data[field] = value;
      return;
    }
  }
}

function extractComps() {
  const comps = [];
  const seen  = new Set();

  try {
    const el = document.getElementById('__NEXT_DATA__');
    if (el) {
      const json  = JSON.parse(el.textContent);
      const props = json?.props?.pageProps;
      const gdp   = props?.gdpClientCache;
      let nd = null;
      if (gdp) {
        const key   = Object.keys(gdp)[0];
        const inner = JSON.parse(gdp[key]);
        nd = inner?.property || inner?.gdp || inner;
      }
      const nearby = nd?.nearbyHomes || nd?.comps || nd?.similarHomes || [];
      for (const h of nearby.slice(0, 20)) {
        const addr  = h.address?.streetAddress || h.streetAddress || '';
        const price = h.price || h.listPrice || h.recentSalePrice || 0;
        if (!price || !addr || seen.has(addr)) continue;
        seen.add(addr);
        comps.push({
          address:      [addr, h.address?.city || ''].filter(Boolean).join(', '),
          price,
          beds:         h.bedrooms || h.beds || 0,
          baths:        h.bathrooms || h.baths || 0,
          sqft:         h.livingArea || h.area || 0,
          status:       h.homeStatus || h.statusType || '',
          daysOnMarket: h.daysOnZillow || 0,
          pricePerSqft: (price && (h.livingArea||h.area)) ? Math.round(price/(h.livingArea||h.area)) : 0,
          zpid:         h.zpid || '',
          url:          h.hdpUrl ? `https://www.zillow.com${h.hdpUrl}` : (h.detailUrl || ''),
          source:       'Zillow nearby homes'
        });
      }
    }
  } catch(e) {}

  if (comps.length < 4) {
    const cardSelectors = [
      'article[data-test="property-card"]',
      '[class*="StyledPropertyCard"]',
      '[class*="property-card-link"]',
      '[class*="HomeCard"]',
      'li[class*="result"]',
    ];

    for (const sel of cardSelectors) {
      document.querySelectorAll(sel).forEach(card => {
        const addrEl  = card.querySelector('[data-test="property-card-addr"], address, [class*="address"]');
        const priceEl = card.querySelector('[data-test="property-card-price"], [class*="price"]');
        const addr    = addrEl?.innerText?.trim() || '';
        const price   = parseNum(priceEl?.innerText || '');
        if (!price || !addr || seen.has(addr)) return;
        const minPrice = (document.querySelector('[class*="for-rent"], [data-testid*="rent"]') || document.body.innerText.match(/for rent/i)) ? 200 : 50000;
        if (price < minPrice) return;
        seen.add(addr);
        const text    = card.innerText || '';
        const bedsM   = text.match(/(\d+)\s*(?:bd|bed)/i);
        const bathsM  = text.match(/(\d+(?:\.\d)?)\s*(?:ba|bath)/i);
        const sqftM   = text.match(/([0-9,]+)\s*(?:sqft|sq\s*ft)/i);
        const sqft    = sqftM ? parseNum(sqftM[1]) : 0;
        const linkEl  = card.querySelector('a[href*="/homedetails/"]') || card.closest('a[href*="/homedetails/"]');
        const compUrl = linkEl?.href || '';
        comps.push({
          address: addr, price,
          beds:  bedsM  ? parseNum(bedsM[1])  : 0,
          baths: bathsM ? parseNum(bathsM[1]) : 0,
          sqft,
          pricePerSqft: (price && sqft) ? Math.round(price/sqft) : 0,
          status: card.querySelector('[class*="status"]')?.innerText?.trim() || '',
          url:    compUrl,
          source: 'DOM carousel'
        });
      });
      if (comps.length >= 8) break;
    }
  }

  if (comps.length < 3) {
    const text   = document.body.innerText;
    const regex  = /\$([0-9,]+)\s*\n([^\n]{10,80}(?:Dr|Ln|Ave|Blvd|Way|St|Ct|Rd|Aly|Loop|Ter|Pl|Cir)[^\n]{0,40})\n([\d]+ bd[^\n]*)/gi;
    let m;
    while ((m = regex.exec(text)) !== null && comps.length < 10) {
      const price = parseNum(m[1]);
      const addr  = m[2].trim();
      if (price < 50000 || seen.has(addr)) continue;
      seen.add(addr);
      const stats  = m[3].trim();
      const bedsM  = stats.match(/(\d+)\s*bd/i);
      const bathsM = stats.match(/(\d+(?:\.\d)?)\s*ba/i);
      const sqftM  = stats.match(/([0-9,]+)\s*(?:sqft|sq)/i);
      const sqft   = sqftM ? parseNum(sqftM[1]) : 0;
      comps.push({
        address: addr, price,
        beds:  bedsM  ? parseNum(bedsM[1]) : 0,
        baths: bathsM ? parseNum(bathsM[1]) : 0,
        sqft,
        pricePerSqft: (price && sqft) ? Math.round(price/sqft) : 0,
        source: 'page text'
      });
    }
  }

  return comps.slice(0, 10);
}

let _chListedByName  = '';
let _chListedByPhone = '';
let _chAgentAttr    = { name: '', phone: '' };
let _chAgentAttrUrl = '';

function chAgentKey() {
  const m = location.href.match(/(\d+)_zpid/);
  return 'chAgent_' + (m ? m[1] : location.pathname);
}
function chReadAgent() {
  try { return JSON.parse(sessionStorage.getItem(chAgentKey()) || '{}'); } catch (e) { return {}; }
}
function chSaveAgent(name, phone) {
  try {
    if (!name && !phone) return;
    const cur = chReadAgent();
    const next = {
      name:  cur.name  || (name  || ''),
      phone: cur.phone || (phone || '')
    };
    if (next.name || next.phone) sessionStorage.setItem(chAgentKey(), JSON.stringify(next));
  } catch (e) {}
}

function chParseAgentDirect(text) {
  if (!text) return { name: '', phone: '' };
  const norm = text.replace(/\u00A0/g, ' ');
  const i = norm.search(/Listed by/i);
  if (i < 0) return { name: '', phone: '' };
  const win = norm.slice(i, i + 240);
  const m = win.match(/Listed by[:\s]*([A-Z][A-Za-z.'’\-]+(?:\s+[A-Z][A-Za-z.'’\-]+){1,3})/);
  if (!m || COMPANY_RE.test(m[1])) return { name: '', phone: '' };
  const tail = win.slice(win.indexOf(m[1]) + m[1].length);
  const pm = tail.match(/\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/);
  return { name: m[1].trim(), phone: pm ? `${pm[1]}-${pm[2]}-${pm[3]}` : '' };
}

function chProbeAgentNow() {
  try {
    const el = document.querySelector('[data-testid="attribution-LISTING_AGENT"]');
    if (el) {
      const t = (el.textContent || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
      const pm = t.match(/\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/);
      const name = (pm ? t.slice(0, t.indexOf(pm[0])) : t).replace(/[,\s]+$/, '').trim();
      if (name && name.length >= 2 && name.length < 60 && !COMPANY_RE.test(name)) {
        chSaveAgent(name, pm ? `${pm[1]}-${pm[2]}-${pm[3]}` : '');
        return;
      }
    }
    const cands = document.querySelectorAll('[data-testid*="attribution"], p');
    for (const c of cands) {
      const t = (c.textContent || '');
      if (t.length > 0 && t.length < 300 && /listed by/i.test(t)) {
        const r = chParseAgentDirect(t);
        if (r.name) { chSaveAgent(r.name, r.phone); return; }
      }
    }
  } catch (e) {}
}

setInterval(() => {
  try {
    const cur = chReadAgent();
    if (cur.name && cur.phone) return;   
    chProbeAgentNow();
  } catch (e) {}
}, 600);
let _chRenderedText = '';
let _chDescription = '';
let _chNearbyHomes = [];

const COMPANY_RE = /\b(LLC|INC|REALTY|REAL ESTATE|GROUP|TEAM|BROKERAGE|PROPERTIES|HOMES|ASSOCIATES|COMPANY|CORP|LLP|\bPA\b|REALTORS?)\b/i;

let _chAgentDebug = {};

function harvestDeepText() {
  let main = '', shadow = '', frames = '';
  try { main = (document.body && document.body.textContent) || ''; } catch (e) {}
  try {
    const seen = new Set();
    const collect = (nodes) => {
      for (const el of nodes) {
        if (el && el.shadowRoot && !seen.has(el)) {
          seen.add(el);
          try { shadow += ' ' + (el.shadowRoot.textContent || ''); } catch (e) {}
          try { collect(el.shadowRoot.querySelectorAll('*')); } catch (e) {}
        }
      }
    };
    collect(document.querySelectorAll('*'));
  } catch (e) {}
  try {
    document.querySelectorAll('iframe').forEach(f => {
      try { const d = f.contentDocument; if (d && d.body) frames += ' ' + (d.body.textContent || ''); } catch (e) {}
    });
  } catch (e) {}
  _chAgentDebug.shadowLen = shadow.length;
  _chAgentDebug.frameLen = frames.length;
  const combined = main + ' ' + shadow + ' ' + frames;
  _chAgentDebug.listedByIn = {
    mainText: /Listed by/i.test(main),
    shadow:   /Listed by/i.test(shadow),
    iframe:   /Listed by/i.test(frames),
  };
  try {
    let snip = '';
    const li = combined.search(/Listed by/i);
    if (li >= 0) {
      snip = 'DEEPTEXT: ' + combined.slice(li, li + 180).replace(/\s+/g, ' ');
    } else {
      const html = document.documentElement ? (document.documentElement.outerHTML || '') : '';
      _chAgentDebug.outerHTMLHasListedBy = /Listed by/i.test(html);
      const hi = html.search(/Listed by/i);
      if (hi >= 0) snip = 'OUTERHTML: ' + html.slice(hi, hi + 260).replace(/<[^>]+>/g, '·').replace(/\s+/g, ' ');
    }
    _chAgentDebug.snippet = snip.slice(0, 220);
  } catch (e) {}
  return combined;
}

let _chDeepText = '';
let _chListedByBlock = '';

function parseAgentByBrokerageAnchor(text, brokerage) {
  if (!text || !brokerage) return { name: '', phone: '' };
  const norm = text.replace(/\u00A0/g, ' ');
  const lc = norm.toLowerCase();
  let idx = lc.indexOf(brokerage.toLowerCase());
  if (idx < 0) {
    const tok = brokerage.split(/\s+/)[0];           
    if (tok && tok.length > 2) idx = lc.indexOf(tok.toLowerCase());
  }
  if (idx < 0) return { name: '', phone: '' };
  const before = norm.slice(Math.max(0, idx - 140), idx);
  const m = before.match(/([A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+){1,3})\s*(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})?\s*,?\s*$/);
  if (m && !COMPANY_RE.test(m[1])) {
    const ph = m[2] ? m[2].replace(/\D/g, '').replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3') : '';
    return { name: m[1].trim(), phone: ph };
  }
  return { name: '', phone: '' };
}

function findListedByBlock(brokerage) {
  const norm = s => (s || '').replace(/\u00A0/g, ' ').replace(/[ \t\f\v]+/g, ' ').trim();
  const want = norm(brokerage).toLowerCase();
  const PHONE = /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/;
  let best = '';
  const consider = (txt) => {
    const n = norm(txt);
    if (!n || n.length > 400) return;            
    const nl = n.toLowerCase();
    if ((/listed by/i.test(n) || (want && nl.includes(want))) && PHONE.test(n)) {
      if (!best || n.length < best.length) best = n;
    }
  };
  const walk = (root, depth) => {
    if (!root || depth > 10) return;
    let els;
    try { els = root.querySelectorAll('*'); } catch (e) { return; }
    for (const el of els) {
      try {
        if (el.children && el.children.length <= 8) consider(el.textContent);
        if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
      } catch (e) {}
    }
  };
  try { walk(document, 0); } catch (e) {}
  try { document.querySelectorAll('iframe').forEach(f => { try { if (f.contentDocument) walk(f.contentDocument, 0); } catch (e) {} }); } catch (e) {}
  return best;
}

function parseListedByFromText(text) {
  if (text) text = text.replace(/\u00A0/g, ' ');
  if (!text) return { name: '', phone: '' };
  const sIdx = text.search(/Listing updated:|Zillow last checked:/i);
  let region;
  if (sIdx >= 0) {
    const after = text.slice(sIdx);
    const eIdx = after.search(/IDX information|Listing Information presented by|MLS Grid|Listings courtesy/i);
    region = eIdx > 0 ? after.slice(0, eIdx) : after.slice(0, 800);
  }
  if (!region || !/Listed by/i.test(region)) {
    const lb = text.search(/Listed by/i);
    if (lb < 0) return { name: '', phone: '' };
    region = text.slice(lb, lb + 240);
  }
  const m = region.match(/Listed by[:\s]*([A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+){1,3})/i);
  if (!m || COMPANY_RE.test(m[1])) return { name: '', phone: '' };
  const name = m[1].trim();
  const tail = region.slice(region.indexOf(m[0]) + m[0].length);
  const pm = tail.match(/\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/);
  return { name, phone: pm ? `${pm[1]}-${pm[2]}-${pm[3]}` : '' };
}

function captureListedByFromDOM() {
  try {
    _chAgentDebug = {};
    const deep = harvestDeepText();
    if (deep && deep.length > _chDeepText.length) _chDeepText = deep;   
    try { const blk = findListedByBlock(''); if (blk && blk.length > _chListedByBlock.length) _chListedByBlock = blk; } catch (e) {}
    const srcs = [deep];
    try { if (document.body) srcs.push(document.body.textContent || ''); } catch (e) {}
    try { if (document.body) srcs.push(document.body.innerText  || ''); } catch (e) {}
    for (const src of srcs) {
      if (_chListedByName) break;
      const r = parseListedByFromText(src);
      if (r.name) { _chListedByName = r.name; if (r.phone) _chListedByPhone = r.phone; }
    }
    try {
      const ndRaw = document.getElementById('__NEXT_DATA__')?.textContent || '';
      _chAgentDebug.nextDataHasAgentName = /"agentName"\s*:\s*"[^"]+"/.test(ndRaw);
      _chAgentDebug.nextDataLen = ndRaw.length;
    } catch (e) {}
    _chAgentDebug.captured = { name: _chListedByName || '', phone: _chListedByPhone || '' };
    chSaveAgent(_chListedByName, _chListedByPhone);   

    if (!_chListedByName) {
      const els = document.querySelectorAll('p, div, span, li, h3, h4');
      for (const el of els) {
        const txt = (el.textContent || '').trim();
        if (txt.length < 60 && /^Listed by\b/i.test(txt)) {
          const block = (el.parentElement?.innerText || el.parentElement?.textContent || txt);
          const nm = block.match(/Listed by[:\s]*\n?\s*([A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+){1,3})/);
          if (nm && !COMPANY_RE.test(nm[1])) {
            _chListedByName = nm[1].trim();
            if (!_chListedByPhone) {
              const ph = block.match(/\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/);
              if (ph) _chListedByPhone = `${ph[1]}-${ph[2]}-${ph[3]}`;
            }
            break;
          }
        }
      }
    }
    chSaveAgent(_chListedByName, _chListedByPhone);   
  } catch (e) {}
}

function captureAgentAttribution() {
  try {
    if (_chAgentAttrUrl !== location.href) { _chAgentAttr = { name: '', phone: '' }; _chAgentAttrUrl = location.href; }
    if (_chAgentAttr.name && _chAgentAttr.phone) return;   
    const el = document.querySelector('[data-testid="attribution-LISTING_AGENT"]');
    if (!el) return;
    const t = (el.textContent || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();  
    if (!t) return;
    const pm = t.match(/\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/);
    const phone = pm ? `${pm[1]}-${pm[2]}-${pm[3]}` : '';
    let name = (pm ? t.slice(0, t.indexOf(pm[0])) : t).replace(/[,\s]+$/, '').trim();
    if (name && name.length >= 2 && name.length < 60 && !COMPANY_RE.test(name)) {
      if (!_chAgentAttr.name)  _chAgentAttr.name  = name;
      if (phone && !_chAgentAttr.phone) _chAgentAttr.phone = phone;
      chSaveAgent(_chAgentAttr.name, _chAgentAttr.phone);   
    }
  } catch (e) {}
}

function expandPriceHistory() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const findShowMoreButtons = () =>
    Array.from(document.querySelectorAll('button, [role="button"], a'))
      .filter(el => {
        const txt = (el.innerText || el.textContent || '').trim();
        if (/\bless\b/i.test(txt)) return false;
        return /^(show more|show all|see all|read more|see more)$/i.test(txt)
            || /(more facts and features|see more facts|show more facts)/i.test(txt)
            || /^show more\b/i.test(txt);
      });

  const waitForDOMSettled = () => new Promise(r => {
    let t = setTimeout(() => { mo.disconnect(); r(); }, 400);
    const mo = new MutationObserver(() => {
      clearTimeout(t); t = setTimeout(() => { mo.disconnect(); r(); }, 200);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  });

  const scrollSmart = () => new Promise(resolve => {
    const onDone = (e) => {
      document.removeEventListener('_ch_scroll_smart_done', onDone);
      resolve(e.detail?.finalY || 0);
    };
    document.addEventListener('_ch_scroll_smart_done', onDone);
    document.dispatchEvent(new CustomEvent('_ch_scroll_smart'));
    setTimeout(() => { document.removeEventListener('_ch_scroll_smart_done', onDone); resolve(0); }, 25000);
  });

  return new Promise(async resolve => {
    scrollingInProgress = true;
    urlObserver.disconnect();
    pushActivity('Scrolling page…');
    _chListedByName = ''; _chListedByPhone = ''; _chRenderedText = ''; _chDescription = ''; _chNearbyHomes = []; _chDeepText = ''; _chListedByBlock = '';   

    const finalY = await scrollSmart();
    pushActivity('Scrolled — expanding sections…');
    await sleep(150);

    pushActivity('Expanding sections…');
    let clicks = 0;
    while (clicks < 50) {
      const btns = findShowMoreButtons();
      if (btns.length === 0) break;
      try { btns[0].click(); } catch(e) {}
      await waitForDOMSettled();
      clicks++;
    }

    try {
      const sc = document.querySelector('.layout-container-desktop');
      for (let i = 0; i < 3; i++) {
        if (sc) sc.scrollTop = sc.scrollHeight;
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(250);
      }
      const lb = Array.from(document.querySelectorAll('p, div, span, li'))
        .find(el => /^Listed by\b/i.test((el.textContent || '').trim().slice(0, 12)));
      if (lb && lb.scrollIntoView) { lb.scrollIntoView({ block: 'center' }); await sleep(300); }
    } catch (e) {}

    captureAgentAttribution();     
    captureListedByFromDOM();      
    let _agentTries = 0;
    while (!_chAgentAttr.name && !_chListedByName && _agentTries < 6) {
      await sleep(400);
      try { const sc2 = document.querySelector('.layout-container-desktop'); if (sc2) sc2.scrollTop = sc2.scrollHeight; } catch (e) {}
      captureAgentAttribution();
      captureListedByFromDOM();
      _agentTries++;
    }
    _chAgentDebug.retries = _agentTries;
    try { _chRenderedText = document.body.innerText || ''; } catch (e) { _chRenderedText = ''; }
    try {
      const dsels = ['[data-testid="description"]', '[data-testid="description-text"]',
                     '[data-testid="listing-description"]', '[class*="description-text"]',
                     '[class*="description"] p', '[class*="remarks"]'];
      for (const sel of dsels) {
        const el = document.querySelector(sel);
        const txt = (el?.innerText || el?.textContent || '').trim();
        if (txt.length > 40 && txt.length > _chDescription.length) _chDescription = txt;
      }
    } catch (e) {}
    try { const nh = scrapeNearbyHomes(); if (Array.isArray(nh) && nh.length) _chNearbyHomes = nh; } catch (e) {}

    pushActivity('Returning to top…');
    const scroller = document.querySelector('.layout-container-desktop');
    if (scroller) scroller.scrollTop = 0;
    await sleep(200);

    pushActivity('All sections expanded — analyzing…');
    scrollingInProgress = false;
    urlObserver.observe(document.body, { childList: true, subtree: true });
    resolve();
  });
}
































function scrapeNearbyHomes() {
  const homes = [];
  try {
    const allHeadings = Array.from(document.querySelectorAll('h2, h3, h4'));

    let h2 = allHeadings.find(el => /comparable homes/i.test(el.textContent));

    if (!h2) {
      h2 = allHeadings.find(el => /^similar homes/i.test(el.textContent.trim()));
    }
    if (!h2) {
      h2 = allHeadings.find(el => /nearby homes|more homes|homes for rent|homes for you/i.test(el.textContent));
    }
    if (!h2) return homes;

    let carousel = null;
    let el = h2.parentElement;
    for (let i = 0; i < 10 && el; i++) {
      const ul = el.querySelector(':scope > ul[role="list"], ul[role="list"]');
      if (ul) { carousel = ul; break; }
      const cards = el.querySelectorAll('[data-testid="property-card"], article[data-test="property-card"]');
      if (cards.length >= 2) { carousel = el; break; }
      el = el.parentElement;
    }
    if (!carousel) return homes;

    const cardSet = new Set();
    for (const sel of ['[data-testid="property-card"]', 'article[data-test="property-card"]', '[class*="StyledPropertyCard"]']) {
      carousel.querySelectorAll(sel).forEach(c => cardSet.add(c));
    }
    const cards = Array.from(cardSet).filter(c => {
      let parent = c.parentElement;
      while (parent && parent !== carousel) {
        if (cardSet.has(parent)) return false; 
        parent = parent.parentElement;
      }
      return true;
    });

    const STREET_ABBR = ['St','Ave','Blvd','Dr','Rd','Ln','Ct','Pl','Way','Trl','Ter','Aly','Loop','Pkwy','Cir','Hwy'];
    function parseAddrFromUrl(href) {
      try {
        const m = href.match(/\/homedetails\/([^/]+)\//);
        if (!m) return '';
        const parts = m[1].split('-');
        const abbrLower = STREET_ABBR.map(s => s.toLowerCase());
        let splitIdx = -1;
        for (let i = parts.length - 1; i >= 0; i--) {
          if (abbrLower.includes(parts[i].toLowerCase())) { splitIdx = i; break; }
        }
        if (splitIdx === -1) return parts.join(' '); 
        const streetParts = parts.slice(0, splitIdx + 1);
        const rest = parts.slice(splitIdx + 1);
        const zip   = rest[rest.length - 1];
        const state = rest[rest.length - 2];
        const cityParts = rest.slice(0, rest.length - 2);
        const street = streetParts.join(' ');
        const city   = cityParts.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        return `${street}, ${city}, ${state} ${zip}`;
      } catch(e) { return ''; }
    }

    const seenAddrs = new Set();
    for (const card of cards) {
      try {
        let price = card.querySelector('[data-testid="data-price-row"]')?.textContent?.trim() || '';
        if (!price) {
          const priceEl = card.querySelector('[class*="price"], [class*="Price"]');
          if (priceEl) price = priceEl.textContent.trim();
        }
        if (!price) {
          const priceM = (card.textContent || '').match(/\$[\d,]+/);
          if (priceM) price = priceM[0];
        }
        if (!price) continue;

        const linkEl = card.closest('a[href]') || card.querySelector('a[href]');
        const href   = linkEl?.getAttribute('href') || '';
        const addrFromUrl = href ? parseAddrFromUrl(href) : '';

        const ariaDiv = card.querySelector('[aria-label]');
        const addrAria = (ariaDiv?.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        const addrEl = card.querySelector('address, [data-test="property-card-addr"], [class*="address"]');
        const addrDom = addrEl?.textContent?.trim() || '';
        const addr = addrFromUrl || addrDom || addrAria;
        if (!addr) continue;

        const addrKey = addr.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (seenAddrs.has(addrKey)) continue;
        seenAddrs.add(addrKey);

        const cardText = card.textContent || '';
        const ariaAll = Array.from(card.querySelectorAll('[aria-label]'))
          .map(e => e.getAttribute('aria-label') || '').join(' ');
        const statSrc = (ariaAll + ' ' + cardText).replace(/\$\d{1,3}(?:,\d{3})*(?:\.\d+)?/g, ' ');
        const bedsM  = statSrc.match(/(\d{1,2})\s*(?:beds?|bd)(?![a-z])/i);
        const bathsM = statSrc.match(/(\d{1,2}(?:\.\d)?)\s*(?:baths?|ba)(?![a-z])/i);
        const sqftM  = statSrc.match(/([\d,.]+)\s*(k?)\s*(?:sqft|sq\s*ft|square\s*fe)/i);
        const bedsNum  = bedsM  ? parseInt(bedsM[1], 10)   : 0;
        const bathsNum = bathsM ? parseFloat(bathsM[1])    : 0;
        let   sqftNum  = 0;
        if (sqftM) {
          const rawN = parseFloat(sqftM[1].replace(/,/g, ''));
          if (!isNaN(rawN)) sqftNum = /k/i.test(sqftM[2]) ? Math.round(rawN * 1000) : Math.round(rawN);
        }
        const statusEl = card.querySelector('[class*="StatusLabel"], [class*="status"]');
        homes.push({
          addr,
          price,
          priceNum:  parseInt(price.replace(/[^0-9]/g, ''), 10) || 0,
          beds:      bedsNum  ? bedsNum  + ' bd' : '',
          baths:     bathsNum ? bathsNum + ' ba' : '',
          sqft:      sqftNum  ? sqftNum.toLocaleString() + ' sqft' : '',
          bedsNum, bathsNum, sqftNum,
          status:    statusEl?.textContent?.trim() || '',
          url:       href ? (href.startsWith('http') ? href : `https://www.zillow.com${href}`) : '',
          zpid:      (href.match(/(\d+)_zpid/) || [])[1] || '',
        });
      } catch(e) {}
    }
  } catch(e) {}
  return homes;
}

function scrapeNearbySchools() {
  const schools = [];
  try {
    const allEls = document.querySelectorAll('h4, h5, h6, [class*="heading"], [class*="Heading"], [data-testid*="school"]');
    let schoolSection = null;
    for (const el of allEls) {
      if (/nearby\s*schools/i.test(el.textContent || '')) {
        schoolSection = el.closest('section') || el.closest('[class*="school"]') || el.parentElement?.parentElement;
        break;
      }
    }

    if (schoolSection) {
      const links = schoolSection.querySelectorAll('a[href*="school"], a[href*="greatschools"]');
      for (const link of Array.from(links).slice(0, 6)) {
        const name = (link.textContent || '').trim();
        if (!name || name.length < 4 || /GreatSchools|rating|nearby/i.test(name)) continue;
        const card = link.closest('li') || link.closest('[class*="card"]') || link.closest('div')?.parentElement;
        const cardText = card?.textContent || '';
        const ratingM = cardText.match(/(\d+)\s*\/\s*10/);
        const ratingM2 = cardText.match(/^(\d)$/m);
        const gradesM = cardText.match(/Grades?\s*:?\s*([K0-9\-]+)/i) || cardText.match(/([KPk]\s*-\s*\d+)/);
        const distM = cardText.match(/([\d.]+)\s*mi/i);
        const typeM = cardText.match(/\b(Public|Private|Charter)\b/i);
        schools.push({
          name,
          rating: ratingM ? ratingM[1] + '/10' : (ratingM2 ? ratingM2[1] + '/10' : ''),
          grades: gradesM ? gradesM[1].trim() : '',
          dist: distM ? distM[1] + ' mi' : '',
          type: typeM ? typeM[1] : ''
        });
        if (schools.length >= 4) break;
      }
    }

    if (!schools.length) {
      const ratingEls = Array.from(document.querySelectorAll('[class*="rating"],[class*="Score"],[class*="score"]'))
        .filter(el => /^\d\/10$|^\d$/.test((el.innerText||'').trim()));
      for (const ratingEl of ratingEls.slice(0, 6)) {
        const rating = (ratingEl.innerText||'').trim();
        let card = ratingEl.parentElement;
        for (let i = 0; i < 6 && card; i++) {
          const nameEl = card.querySelector('a,[class*="name"],[class*="Name"]');
          const name   = nameEl?.innerText?.trim() || '';
          const cardText = (card.innerText || '').trim();
          const gradesM = cardText.match(/Grades?\s*([K0-9\-]+)/i);
          const distM   = cardText.match(/([\d.]+)\s*mi/i);
          if (name && name.length > 3) {
            schools.push({
              name,
              rating: /^\d$/.test(rating) ? rating + '/10' : rating,
              grades: gradesM ? gradesM[1] : '',
              dist:   distM   ? distM[1] + ' mi' : ''
            });
            break;
          }
          card = card.parentElement;
        }
      }
    }
  } catch(e) {}
  return schools;
}




function sortHistory(rows) {
  const toYMD = (d) => {
    const m = (d||'').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return [0, 0, 0];
    return [+m[3], +m[1], +m[2]]; 
  };
  return rows.slice().sort((a, b) => {
    const [ay, am, ad] = toYMD(a.date);
    const [by, bm, bd] = toYMD(b.date);
    if (by !== ay) return by - ay;
    if (bm !== am) return bm - am;
    return bd - ad;
  });
}

async function parsePriceHistoryFromPage() {
  const EVENT_KEYWORDS = [
    'Listed for sale','Listed for rent','Pending sale','Back on market',
    'Listing removed','Pre-foreclosure','Price change','Pending','Sold'
  ];
  const parseRow = (rawDate, rawEvent, rawPrice) => {
    const dm = (rawDate||'').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!dm) return null;
    const date = Number(dm[1])+'/'+Number(dm[2])+'/'+dm[3];
    const event = EVENT_KEYWORDS.find(e =>
      (rawEvent||'').trim().toLowerCase().startsWith(e.toLowerCase())
    ) || (rawEvent||'').trim();
    if (!event) return null;
    const priceM = (rawPrice||'').match(/\$([1-9][\d,]+)/);
    const price = priceM ? parseInt(priceM[1].replace(/,/g,''),10) : 0;
    return { date, event, price };
  };

  const results = [];
  try {
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      let isPriceTable = false;
      const hdr = table.querySelector('tr');
      if (hdr) {
        const htxt = (hdr.innerText || hdr.textContent || '').toLowerCase();
        if (htxt.includes('date') && (htxt.includes('event') || htxt.includes('price'))) {
          isPriceTable = true;
        }
      }
      if (!isPriceTable) {
        let el = table.previousElementSibling;
        for (let i=0; i<5 && el; i++) {
          if (/price.{0,5}history/i.test(el.innerText || el.textContent || '')) {
            isPriceTable = true; break;
          }
          el = el.previousElementSibling;
        }
      }
      if (!isPriceTable) continue;

      const rows = table.querySelectorAll('tr');
      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) continue;
        const r = parseRow(
          cells[0].innerText || cells[0].textContent || '',
          cells[1].innerText || cells[1].textContent || '',
          cells[2] ? (cells[2].innerText || cells[2].textContent || '') : ''
        );
        if (r) results.push(r);
      }
      if (results.length > 0) break;
    }
  } catch(e) {}

  if (results.length > 0) return sortHistory(results);

  try {
    const html = await fetch(window.location.href, {
      credentials: 'include',
      headers: { 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' }
    }).then(r => r.ok ? r.text() : Promise.reject(r.status));

    const tdRe = /<tr[^>]*>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([^<]*)<\/td>(?:\s*<td[^>]*>([^<]*)<\/td>)?/gi;
    for (const m of html.matchAll(tdRe)) {
      const r = parseRow(m[1], m[2], m[3]||'');
      if (r) results.push(r);
    }

    if (!results.length) {
      const rowRe = /^\|\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|/gm;
      for (const m of html.matchAll(rowRe)) {
        const r = parseRow(m[1], m[2], m[3]);
        if (r) results.push(r);
      }
    }
  } catch(e) {}

  return sortHistory(results);
}













async function scrapeZillow(data) {
  const fullText = extractFullPageText();
  const bodyInnerText = document.body.innerText || '';


  try {
    const phText = bodyInnerText.match(/Price history[\s\S]{0,300}/i)?.[0] || '';
    const phEvents = phText.match(/\d{1,2}\/\d{1,2}\/\d{4}\s*\n?\s*(Sold|Listed for sale|Listed for rent|Price change|Listing removed|Pending|Back on market|Pre-foreclosure)/gi);
    if (phEvents && phEvents.length > 0) {
      const firstEvent = phEvents[0].replace(/^\d{1,2}\/\d{1,2}\/\d{4}\s*\n?\s*/i, '').trim().toLowerCase();
      if (/^sold/i.test(firstEvent)) {
        data.listingMode = 'sold';
        data.homeStatus  = 'RECENTLY_SOLD';
        const spM = phText.match(/Sold[^$]*\$([\d,]+)/i);
        if (spM) data.soldPrice = parseInt(spM[1].replace(/,/g,''), 10);
      } else if (/^listing removed/i.test(firstEvent)) {
        data.listingMode = 'sold';
        data.homeStatus  = 'OFF_MARKET';
        data.isOffMarket = true;
      } else if (/^listed for rent/i.test(firstEvent)) {
        data.listingMode = 'rent';
        data.homeStatus  = 'FOR_RENT';
      }
    }
  } catch(e) {}

  if (!data.listingMode) {
    try {
      const topText = bodyInnerText.slice(0, 1500);
      if (/\$[\d,]+\s*\/\s*mo/i.test(topText.slice(150, 800))) {
        data.listingMode = 'rent';
        data.homeStatus  = 'FOR_RENT';
      }
      if (/(?:house|home|apartment|condo|townhouse|single.?family|multi.?family|duplex)\s+for\s+rent/im.test(topText.slice(150, 800))) {
        data.listingMode = 'rent';
        data.homeStatus  = 'FOR_RENT';
      }
    } catch(e) {}
  }

  if (!data.listingMode) {
    try {
      const ndEl = document.getElementById('__NEXT_DATA__');
      if (ndEl) {
        const ndSnippet = ndEl.textContent.slice(0, 30000);
        const hsM = ndSnippet.match(/"homeStatus"\s*:\s*"([^"]+)"/);
        if (hsM) {
          const hs = hsM[1];
          if (/^RECENTLY_SOLD$/i.test(hs)) {
            data.listingMode = 'sold';
            data.homeStatus  = 'RECENTLY_SOLD';
            const spM = ndSnippet.match(/"lastSoldPrice"\s*:\s*(\d+)/);
            if (spM) data.soldPrice = parseInt(spM[1], 10);
          } else if (/^OFF_MARKET$|^OTHER$/i.test(hs)) {
            data.listingMode = 'sold';
            data.homeStatus  = 'OFF_MARKET';
            data.isOffMarket = true;
            const spM = ndSnippet.match(/"lastSoldPrice"\s*:\s*(\d+)/);
            if (spM) data.soldPrice = parseInt(spM[1], 10);
          } else if (/^FOR_RENT$/i.test(hs)) {
            data.listingMode = 'rent';
            data.homeStatus  = 'FOR_RENT';
          } else if (/^FOR_SALE$/i.test(hs)) {
            data.listingMode = 'buy';
            data.homeStatus  = 'FOR_SALE';
          }
        }
      }
    } catch(e) {}
  }

  if (!data.listingMode) {
    try {
      const hdrText = bodyInnerText.slice(0, 1000);
      const afterNav = hdrText.slice(200); 

      if (/off\s*market/im.test(afterNav)) {
        data.listingMode = 'sold'; data.homeStatus = 'OFF_MARKET'; data.isOffMarket = true;
      } else if (/Sold (?:for |on )?\$([\d,]+)/im.test(afterNav)) {
        data.listingMode = 'sold'; data.homeStatus = 'RECENTLY_SOLD';
        const m = afterNav.match(/Sold (?:for |on )?\$([\d,]+)/i);
        if (m) data.soldPrice = parseInt(m[1].replace(/,/g,''), 10);
      } else if (/Zestimate®/i.test(hdrText.slice(0, 500)) && !/^For sale$/m.test(afterNav)) {
        data.listingMode = 'sold'; data.homeStatus = 'OFF_MARKET'; data.isOffMarket = true;
      } else if (/(?:house|home|apartment|condo|townhouse|single.?family)\s+for\s+rent/im.test(afterNav)) {
        data.listingMode = 'rent'; data.homeStatus = 'FOR_RENT';
      } else if (/^For sale$/m.test(afterNav)) {
        data.listingMode = 'buy'; data.homeStatus = 'FOR_SALE';
      }
    } catch(e) {}
  }

  if (!data.listingMode) {
    try {
      const allEls = document.querySelectorAll('span, div, h1, h2, h3, p');
      const limit = Math.min(allEls.length, 200);
      for (let i = 0; i < limit; i++) {
        const el = allEls[i];
        if (el.children.length > 1) continue;
        const txt = (el.textContent || '').trim();
        if (txt.length > 40 || txt.length < 4) continue;
        if (/^off\s*market$/i.test(txt))           { data.listingMode = 'sold'; data.homeStatus = 'OFF_MARKET'; data.isOffMarket = true; break; }
        if (/^sold/i.test(txt) && /\$/.test(txt))  { data.listingMode = 'sold'; data.homeStatus = 'RECENTLY_SOLD'; const m = txt.match(/\$([\d,]+)/); if (m) data.soldPrice = parseInt(m[1].replace(/,/g,''),10); break; }
        if (/^recently sold/i.test(txt))           { data.listingMode = 'sold'; data.homeStatus = 'RECENTLY_SOLD'; break; }
      }
    } catch(e) {}
  }

  if (!data.listingMode) { data.listingMode = 'buy'; data.homeStatus = 'FOR_SALE'; }

  const domPrice = scrapeListingPrice(data.listingMode);
  if (domPrice > 0) data.price = domPrice;


  const nd = extractZillowNextData();
  if (nd) {
    if (nd.address) {
      const a = nd.address;
      data.address = [a.streetAddress, a.city, a.state, a.zipcode].filter(Boolean).join(', ');
    }
    if (!data.price) {
      data.price = nd.price || nd.listPrice || nd.listedPrice
                 || nd.unformattedPrice || nd.hdpData?.homeInfo?.price
                 || nd.homeInfo?.price || 0;
    }

    const isProbablyRent = data.listingMode === 'rent';
    if (!isProbablyRent) {
      const ph = nd.priceHistory || [];
      if (Array.isArray(ph) && ph.length > 0) {
        const listedEvent = ph.find(h => /listed\s+for\s+sale|listed/i.test(h.event || h.priceChangeType || ''));
        if (listedEvent?.price > 0 && listedEvent.price !== data.price) {
          const ratio = Math.abs(listedEvent.price - data.price) / Math.max(listedEvent.price, data.price);
          if (ratio > 0.05 || data.price === 0) {
            data.price = listedEvent.price;
          }
        }
      }
    }
    data.beds        = nd.bedrooms || nd.beds || data.beds;
    const ndFullBaths = nd.resoFacts?.bathroomsFull || nd.resoFacts?.bathsFull || 0;
    const ndHalfBaths = nd.resoFacts?.bathroomsHalf || nd.resoFacts?.bathsHalf || 0;
    if (ndFullBaths > 0 && ndFullBaths <= 10) {
      data.baths = ndFullBaths + (ndHalfBaths > 0 && ndHalfBaths <= 4 ? ndHalfBaths * 0.5 : 0);
      data.bathsDetail = ndHalfBaths > 0 ? `${ndFullBaths} full, ${ndHalfBaths} half` : '';
    } else {
      const ndBaths = nd.bathrooms || nd.baths || 0;
      if (ndBaths > 0 && ndBaths <= 20) data.baths = ndBaths;
    }
    data.sqft        = nd.livingArea || nd.livingAreaValue || data.sqft;

    data.yearBuilt = nd.yearBuilt || nd.builtYear
                  || nd.resoFacts?.yearBuilt || nd.resoFacts?.yearBuiltEffective
                  || nd.resoFacts?.originalConstructionYear || '';

    const lotSqftRaw = nd.resoFacts?.lotSizeSquareFeet || nd.lotAreaValue || nd.lotSize || 0;
    const lotSqft  = (Number(lotSqftRaw) > 0 && Number(lotSqftRaw) <= 500000) ? Number(lotSqftRaw) : 0;
    const lotAcresRaw = nd.resoFacts?.lotSizeAcres || 0;
    const lotAcres = (Number(lotAcresRaw) > 0 && Number(lotAcresRaw) <= 50) ? Number(lotAcresRaw) : 0;
    if (lotSqft)       data.lotSize = `${lotSqft.toLocaleString()} sqft`;
    else if (lotAcres) data.lotSize = `${lotAcres} acres`;

    data.propertyType = nd.homeType || nd.resoFacts?.propertySubType || nd.resoFacts?.propertyType || '';
    data.daysOnMarket = nd.daysOnZillow || nd.daysOnMarket || 0;
    data.zestimate    = (nd.zestimate && nd.zestimate >= 10000) ? nd.zestimate : 0;
    data.rentZestimate = nd.rentZestimate || 0;
    data.rentZestimateRange = nd.rentZestimateRange || null;

    if (!data.lastSoldPrice || data.lastSoldPrice === 0) {
      const ph2 = Array.isArray(nd.priceHistory) ? nd.priceHistory : [];
      const soldEv = ph2.find(h => /^sold$/i.test((h.event || h.priceChangeType || '').trim()));
      if (soldEv?.price > 50000) data.lastSoldPrice = Number(soldEv.price);
    }


    const homeStatus = nd.homeStatus
      || nd.hdpData?.homeInfo?.homeStatus
      || nd.resoFacts?.homeStatus
      || nd.homeInfo?.homeStatus
      || '';
    data.homeStatus = homeStatus;

    if (data.listingMode === 'sold') {
      if (!data.soldPrice) {
        data.soldPrice = nd.lastSoldPrice || (
          Array.isArray(nd.priceHistory)
            ? (nd.priceHistory.find(h => /^sold$/i.test((h.event || h.priceChangeType || '').trim()))?.price || 0)
            : 0
        );
      }
      if (!data.dateSold) data.dateSold = nd.dateSoldString || nd.dateSold || '';
      if (!data.daysToSell) data.daysToSell = nd.daysOnZillow || 0;
    } else if (data.listingMode === 'buy') {
      const ph0 = nd.priceHistory;
      if (Array.isArray(ph0) && ph0.length > 0) {
        const latest = ph0[0];
        const latestEv = (latest.event || latest.priceChangeType || '').toLowerCase();
        const latestDt = latest.date
          ? (Number(latest.date) > 1e9 ? new Date(Number(latest.date)) : new Date(latest.date))
          : null;
        const daysSince = latestDt && !isNaN(latestDt)
          ? Math.round((Date.now() - latestDt) / 86400000) : 999;
        if (daysSince < 60 && /listed\s+for\s+rent|^rent/i.test(latestEv)) {
          data.listingMode = 'rent';
          data.homeStatus  = 'FOR_RENT';
        }
      }
    }

    if (data.listingMode === 'rent') {
      const rf = nd.rentalListingDetails || nd.resoFacts || {};
      data.leaseTerms       = rf.leaseType || rf.leaseTerm || nd.leaseType || '';
      data.petPolicy        = rf.petsPolicy || nd.petsAllowed ? 'Pets allowed' : (nd.petsAllowed === false ? 'No pets' : '');
      data.laundry          = rf.laundryType || nd.laundryType || '';
      data.parkingType      = rf.parkingType || nd.parkingType || '';
      data.applicationFee   = rf.applicationFee || nd.applicationFee || 0;
      data.depositMin       = rf.depositMin || nd.depositMin || nd.deposit || 0;
      data.availableDate    = rf.availableFrom || nd.availableFrom || '';
      data.utilitiesIncluded = rf.utilitiesIncluded || nd.utilitiesIncluded || '';
      const landlord = nd.rentalListingDetails?.contact || nd.attributionInfo || nd.listingAgent || {};
      data.landlordName     = landlord.displayName || landlord.agentName || landlord.memberFullName || '';
      data.landlordPhone    = landlord.phoneNumber || landlord.agentPhoneNumber || '';
      data.landlordEmail    = landlord.email       || landlord.agentEmail       || '';
      data.landlordCompany  = landlord.businessName || landlord.officeName || landlord.brokerName || '';
      data.isPrivateLandlord = nd.isListedByOwner || !data.landlordCompany;
      data.landlordProfileUrl = landlord.profileUrl || '';
    }

    if (!data.listingMode) data.listingMode = 'buy';

    if (data.homeStatus !== 'FOR_SALE') {
      try {
        const ph = nd.priceHistory;
        if (Array.isArray(ph) && ph.length > 0) {
          const top = ph[0];
          const topEv = (top.event || top.priceChangeType || '').toLowerCase().trim();
          const topDt = top.date ? (Number(top.date) > 1e9 ? new Date(Number(top.date)) : new Date(top.date)) : null;
          const topDays = topDt && !isNaN(topDt) ? Math.round((Date.now() - topDt) / 86400000) : 999;

          if (data.listingMode === 'buy' && /^sold$/.test(topEv) && topDays < 14) {
            data.listingMode = 'sold';
            data.homeStatus  = 'RECENTLY_SOLD';
          } else if (data.listingMode === 'buy' && /listed\s+for\s+rent/.test(topEv) && topDays < 60) {
            data.listingMode = 'rent';
            data.homeStatus  = 'FOR_RENT';
          } else if (data.listingMode === 'sold' && /listed\s+for\s+sale|^listed$/.test(topEv) && topDays < 60) {
            data.listingMode = 'buy';
            data.homeStatus  = 'FOR_SALE';
          }
        }
      } catch(e) {}
    }

    if (!data.homeStatus) {
      try {
        const hdr = bodyInnerText.slice(0, 600);
        if (/\bSold\s+for\s+\$[\d,]+/i.test(hdr)) {
          data.listingMode = 'sold';
          data.homeStatus  = 'RECENTLY_SOLD';
        } else if (/^(?:house|home|apartment|condo|townhouse)\s+for\s+rent$/im.test(hdr)) {
          data.listingMode = 'rent';
          data.homeStatus  = 'FOR_RENT';
        }
      } catch(e) {}
    }

    data.mlsId        = nd.mlsid || nd.resoFacts?.mlsListingId || nd.resoFacts?.mlsNumber || '';
    data.parcelNumber = nd.resoFacts?.parcelNumber || nd.parcelId || nd.resoFacts?.apn || '';
    data.latitude     = nd.latitude  || nd.address?.latitude  || null;
    data.longitude    = nd.longitude || nd.address?.longitude || null;

    const garageSpaces = nd.resoFacts?.garageSpaces || nd.resoFacts?.numberOfGarageSpaces || 0;
    data.garage = garageSpaces ? `${garageSpaces} space(s)`
                : nd.resoFacts?.hasGarage ? 'Yes'
                : nd.resoFacts?.hasAttachedGarage ? 'Attached'
                : nd.resoFacts?.parkingFeatures?.join?.(', ') || '';

    data.stories = nd.resoFacts?.stories || nd.resoFacts?.levels || nd.resoFacts?.numberOfStories || '';
    data.hoaFee  = nd.monthlyHoaFee || nd.resoFacts?.associationFee || nd.resoFacts?.hoaFee || '';
    data.hoaName = nd.resoFacts?.associationName || nd.resoFacts?.associationManagement || '';

    const ndDesc = (nd.description || nd.homeDescription || nd.adTargets?.description || nd.resoFacts?.description || '').trim();
    if (ndDesc.length > (data.description || '').trim().length) data.description = ndDesc;
    if (_chDescription && _chDescription.length > (data.description || '').trim().length) {
      data.description = _chDescription;
    }

    data.builderName = nd.resoFacts?.builderName || nd.resoFacts?.builder || '';
    if (!data.builderName && nd.description) {
      const _bm = nd.description.match(/\b(DR\s+Horton|Lennar|Pulte|KB\s+Home|Taylor\s+Morrison|Meritage|Ryan\s+Homes|Toll\s+Brothers|Century\s+Communities|Smith\s+Douglas|Dream\s+Finders|Highland\s+Homes|Maronda|Beazer|David\s+Weekley)\b/i);
      if (_bm) data.builderName = _bm[1].replace(/\s+/g,' ').trim();
    }

    const _sb = (s) => (s||'').replace(/\s*Builder\b|Builder$/gi, '').trim();
    const _domModelM = (fullText||'').match(/Builder\s+model[:\s]*([A-Za-z0-9][A-Za-z0-9\-]{1,20})/i);
    const _domModel  = _domModelM ? _sb(_domModelM[1]) : '';
    const _ndModel   = _sb(nd.resoFacts?.builderModel || nd.resoFacts?.model || nd.resoFacts?.floorPlanName || '');
    data.propertyModel = _domModel || _ndModel;
    if (data.propertyModel && data.builderName) {
      try {
        const _esc = data.builderName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        data.propertyModel = data.propertyModel.replace(new RegExp('^' + _esc + '\\s*', 'i'), '').trim();
      } catch(e) {}
    }
    data.zoning      = nd.resoFacts?.zoning || '';

    const rf = nd.resoFacts || {};
    const arr = (v) => Array.isArray(v) ? v.join(', ') : (v || '');

    data.roofType              = arr(rf.roofType) || arr(rf.roof) || '';
    data.foundation            = arr(rf.foundationDetails) || arr(rf.foundation) || '';
    data.constructionMaterials = arr(rf.constructionMaterials) || arr(rf.construction) || arr(rf.structureType) || '';
    data.appliances            = arr(rf.appliances) || '';
    data.flooring              = arr(rf.flooringTypes) || arr(rf.flooring) || arr(rf.floorCovering) || '';
    data.interiorFeatures      = arr(rf.interiorFeatures) || '';
    data.exteriorFeatures      = arr(rf.exteriorFeatures) || arr(rf.patioAndPorchFeatures) || '';
    data.cooling               = arr(rf.cooling) || arr(rf.coolingFeatures) || arr(rf.airConditioning) || '';
    data.heating               = arr(rf.heating) || arr(rf.heatingFeatures) || arr(rf.heatSource) || '';
    data.sewer                 = arr(rf.sewer) || arr(rf.sewerInformation) || '';
    data.waterSource           = arr(rf.waterSource) || arr(rf.water) || '';
    data.listingTerms          = arr(rf.listingTerms) || '';
    data.specialConditions     = rf.specialListingConditions || '';
    data.ownership             = rf.ownership || rf.ownershipType || '';
    data.walkScore             = nd.walkScore || '';
    data.bikeScore             = nd.bikeScore || '';
    data.hasPool               = rf.hasPool || false;
    data.fireplace             = rf.hasFireplace || rf.fireplaceFeatures?.length > 0 || false;
    data.newConstruction       = nd.newConstruction || rf.newConstructionType === 'NEW_CONSTRUCTION' || false;

    const seniorFlagFromMLS = !!(rf.seniorCommunity || rf.seniorLivingCommunity
      || rf.ageRestricted || rf.communityFeatures?.some?.(f => /senior|55\+|age.restrict/i.test(f)));
    const seniorInDescription = /\b55\+|senior\s+community|age.restricted|active\s+adult/i.test(
      (nd.description || '') + ' ' + (data.hoaName || '') + ' ' + (data.subdivision || '')
    );
    data.seniorCommunityMLS         = seniorFlagFromMLS;  
    data.seniorCommunityConfirmed   = seniorInDescription; 
    data.seniorCommunityUnverified  = seniorFlagFromMLS && !seniorInDescription; 

    data.taxAssessedValueListing = nd.resoFacts?.taxAssessedValue || 0;
    data.taxAnnualAmountListing  = nd.resoFacts?.taxAnnualAmount  || 0;
    data.taxYearListing          = nd.resoFacts?.taxYear          || '';

    const taxHist = nd.taxHistory || [];
    if (Array.isArray(taxHist)) {
      data.taxHistory = taxHist.slice(0, 7).map(t => ({
        year: t.time ? new Date(t.time * 1000).getFullYear() : t.taxYear || t.year,
        taxPaid: t.taxPaid || 0,
        assessed: t.value || 0,
        valueChange: t.valueChange || null
      })).filter(t => t.taxPaid > 0 || t.assessed > 0);
    }

    const latestPublicTax = data.taxHistory?.[0]?.taxPaid || 0;
    const listingTax      = parseNum(String(data.taxAnnualAmountListing));
    if (latestPublicTax > 0 && listingTax > 0 && Math.abs(latestPublicTax - listingTax) > 200) {
      data.taxDataConflict = {
        listingSheetValue: listingTax,
        publicRecordValue: latestPublicTax,
        difference: listingTax - latestPublicTax
      };
    }


    const isFsboListing = nd.isForSaleByOwner || /for sale by owner|fsbo/i.test(nd.homeStatus || '');
    const agent = Object.assign({}, nd.attributionInfo || {}, nd.listingAgent || {});
    if (!isFsboListing) {
      data.agentName     = agent.agentName || agent.listingAgentName || agent.memberFullName
                        || agent.listAgentFullName || agent.buyerAgentName || agent.trueName
                        || agent.agentFullName || '';
      data.agentPhone    = agent.agentPhoneNumber || agent.listingAgentPhoneNumber || agent.phoneNumber || '';
      data.brokerageName = agent.brokerName || agent.officeName || agent.listingOfficeName
                        || agent.brokerageName || '';
    } else {
      data.agentName     = '';
      data.brokerageName = '';
      data.isFSBO        = true;
    }

    if (!data.isFSBO) {
      if (_chAgentAttr.name)  data.agentName  = _chAgentAttr.name;
      if (_chAgentAttr.phone && !data.agentPhone) data.agentPhone = _chAgentAttr.phone;

      if (!_chListedByName || !_chListedByPhone) {
        let deepNow = '';
        try { deepNow = harvestDeepText(); } catch (e) {}
        let htmlText = '';
        try { htmlText = (document.documentElement.outerHTML || '').replace(/<[^>]+>/g, ' '); } catch (e) {}
        for (const src of [_chRenderedText, _chDeepText, deepNow, (document.body && document.body.textContent) || '', (document.body && document.body.innerText) || '', (typeof fullText !== 'undefined' ? fullText : ''), htmlText]) {
          const r = parseListedByFromText(src);
          if (r.name && !_chListedByName) _chListedByName = r.name;
          if (r.phone && !_chListedByPhone) _chListedByPhone = r.phone;
          if (_chListedByName && _chListedByPhone) break;
        }
      }
      if (_chListedByName && !data.agentName) data.agentName = _chListedByName;
      if (_chListedByPhone && !data.agentPhone) data.agentPhone = _chListedByPhone;

      if (!data.agentName || !data.agentPhone) {
        try {
          const ndRaw = document.getElementById('__NEXT_DATA__')?.textContent || '';
          const ai = ndRaw.indexOf('"attributionInfo"');
          const scope = ai >= 0 ? ndRaw.slice(ai, ai + 2500) : ndRaw;
          if (!data.agentName) {
            const am = scope.match(/"(?:agentName|listingAgentFullName|listAgentFullName)"\s*:\s*"([^"]{3,50})"/);
            if (am && !/\b(LLC|INC|REALTY|REAL ESTATE|GROUP|TEAM|PROPERTIES|HOMES|ASSOCIATES|CORP|REALTORS?)\b/i.test(am[1])) {
              data.agentName = am[1].trim();
            }
          }
          if (!data.agentPhone) {
            const pm = scope.match(/"(?:agentPhoneNumber|listingAgentPhoneNumber)"\s*:\s*"([^"]{7,20})"/);
            if (pm) data.agentPhone = pm[1].trim();
          }
        } catch (e) {}
      }

      if ((!data.agentName || !data.agentPhone) && data.brokerageName) {
        try {
          const ndRaw = document.getElementById('__NEXT_DATA__')?.textContent || '';
          const bi = ndRaw.indexOf(data.brokerageName);
          if (bi >= 0) {
            const win = ndRaw.slice(Math.max(0, bi - 1600), bi + 200);
            if (!data.agentName) {
              const am = win.match(/"(?:agentName|listAgentFullName|listingAgentFullName|memberFullName)"\s*:\s*"([^"]{2,50})"/);
              if (am && !COMPANY_RE.test(am[1])) data.agentName = am[1].trim();
            }
            if (!data.agentPhone) {
              const pm = win.match(/"(?:agentPhoneNumber|listingAgentPhoneNumber)"\s*:\s*"([^"]{7,20})"/);
              if (pm) data.agentPhone = pm[1].trim();
            }
          }
        } catch (e) {}
        if (!data.agentName || !data.agentPhone) {
          let block = '';
          try { block = findListedByBlock(data.brokerageName) || _chListedByBlock; } catch (e) { block = _chListedByBlock; }
          if (block) {
            _chAgentDebug.blockFound = block.slice(0, 200);
            const rb = parseListedByFromText(block);
            if (rb.name && !data.agentName) data.agentName = rb.name;
            if (rb.phone && !data.agentPhone) data.agentPhone = rb.phone;
            const ra = parseAgentByBrokerageAnchor(block, data.brokerageName);
            if (ra.name && !data.agentName) data.agentName = ra.name;
            if (ra.phone && !data.agentPhone) data.agentPhone = ra.phone;
          }
        }
        if (!data.agentName || !data.agentPhone) {
          let deepNow = ''; try { deepNow = harvestDeepText(); } catch (e) {}
          for (const src of [_chDeepText, deepNow, _chRenderedText, (document.body && document.body.textContent) || '']) {
            const r = parseAgentByBrokerageAnchor(src, data.brokerageName);
            if (r.name && !data.agentName) data.agentName = r.name;
            if (r.phone && !data.agentPhone) data.agentPhone = r.phone;
            if (data.agentName && data.agentPhone) break;
          }
        }
      }

      if (!data.agentName || !data.agentPhone) {
        const bt = _chRenderedText || (document.body && document.body.innerText) || '';
        if (!data.agentName) {
          const lm = bt.match(/Listed by[:\s]*\n?\s*([A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+){1,3})/);
          if (lm && !/\b(LLC|INC|REALTY|REAL ESTATE|GROUP|TEAM|PROPERTIES|HOMES|ASSOCIATES|CORP|REALTORS?)\b/i.test(lm[1])) {
            data.agentName = lm[1].trim();
          }
        }
        if (!data.agentPhone) {
          const pm2 = bt.match(/Listed by[:\s]*\n?\s*[A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+){1,3}[\s,]*\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/);
          if (pm2) data.agentPhone = `${pm2[1]}-${pm2[2]}-${pm2[3]}`;
        }
      }

      try {
        const ndTxt = document.getElementById('__NEXT_DATA__')?.textContent || '';
        _chAgentDebug.brokerage = data.brokerageName || '';
        _chAgentDebug.brokerInNextData = !!(data.brokerageName && ndTxt.includes(data.brokerageName));
        _chAgentDebug.brokerInDeepText = !!(data.brokerageName && _chDeepText.includes(data.brokerageName));
        _chAgentDebug.brokerInBodyText = !!(data.brokerageName && ((document.body && document.body.textContent) || '').includes(data.brokerageName));
        _chAgentDebug.finalAgent = { name: data.agentName || '', phone: data.agentPhone || '' };
        _chAgentDebug.testidCapture = { name: _chAgentAttr.name || '', phone: _chAgentAttr.phone || '' };
        _chAgentDebug.testidElPresent = !!document.querySelector('[data-testid="attribution-LISTING_AGENT"]');
      } catch (e) {}
      try { console.log('%c[ClearHome AGENT DEBUG]', 'color:#4F6BFF;font-weight:bold', JSON.parse(JSON.stringify(_chAgentDebug))); } catch (e) {}
    }

    data.zestimateRange = {
      low:  nd.zestimate ? Math.round(nd.zestimate * 0.95) : 0,
      high: nd.zestimate ? Math.round(nd.zestimate * 1.05) : 0
    };

    if (nd.nearbySchools?.schools) {
      data.schools = nd.nearbySchools.schools.slice(0, 3).map(s => ({
        name: s.name, rating: s.rating, grades: s.grades, distance: s.distance
      }));
    }

    data.floodFactor   = nd.floodFactor || nd.floodFactorSeverity || '';
    data.fireFactor    = nd.fireFactor  || '';
    data.heatFactor    = nd.heatFactor  || '';
  }

  scrapeFactsFromDOM(data, fullText);

  if (data.roofType && !/(shingle|tile|metal|asphalt|concrete|slate|wood|shake|membrane|flat|composition|built.?up|tpo|epdm|rubber|clay|architectural|gable|hip|foam)/i.test(data.roofType)) {
    data.roofType = '';
  }
  if (data.waterSource && !/(public|private|well|city|municipal|cistern|spring|community|county|shared)/i.test(data.waterSource)) {
    data.waterSource = '';
  }

  if (_chDescription && _chDescription.length > (data.description || '').trim().length) {
    data.description = _chDescription;
  }

  if (!data.sqft) {
    const livableM = fullText.match(/total\s+interior\s+livable\s+area[:\s]+([0-9,]+)\s*sq/i);
    if (livableM) data.sqft = parseNum(livableM[1]);
  }

  (function findLotSize() {
    const parseValid = (str) => {
      if (!str) return null;
      const n = parseInt(String(str).replace(/[^\d]/g, ''), 10);
      if (n > 0 && n <= 500000) return n;
      return null;
    };
    const setLot = (sqft) => {
      if (sqft) data.lotSize = sqft.toLocaleString() + ' sqft';
    };

    if (data.lotSize) {
      const existingSqft = parseInt(String(data.lotSize).replace(/[^\d]/g, ''), 10);
      if (existingSqft > 0 && existingSqft <= 500000) return;
      data.lotSize = '';
    }

    const allSizeMatches = [...fullText.matchAll(/Size[:\s]+([0-9,]+)\s*Square\s*Feet/gi)]
      .map(m => parseInt(m[1].replace(/,/g, ''), 10))
      .filter(n => n > 0 && n <= 500000);
    if (allSizeMatches.length > 0) {
      const lot0 = Math.min(...allSizeMatches);
      setLot(lot0);
      return;
    }

    const mA = fullText.match(/\bLot\b[\s\S]{0,80}?Size[:\s]+([0-9,]+)\s*Square\s*Feet/i)
            || fullText.match(/(?:^|\n)\s*Size[:\s]+([0-9,]+)\s*Square\s*Feet/im);
    const vA = parseValid(mA?.[1]);
    if (vA) { setLot(vA); return; }

    const mB = fullText.match(/\bLot(?:\s+size)?[:\s]+([0-9,]+)\s*(?:sqft|sq\s*ft)\b/i);
    const vB = parseValid(mB?.[1]);
    if (vB) { setLot(vB); return; }

    const mC = fullText.match(/([0-9,]{3,7})\s*sqft\s*lot\b/i);
    const vC = parseValid(mC?.[1]);
    if (vC) { setLot(vC); return; }

    const ddEls = document.querySelectorAll('dt, [class*="label"]');
    for (const dt of ddEls) {
      const lbl = (dt.textContent || '').trim().toLowerCase();
      if (/^(?:lot(?:\s+size)?|size)$/.test(lbl)) {
        const dd = dt.nextElementSibling;
        if (dd) {
          const t = (dd.textContent || '').trim();
          const mSqft = t.match(/([0-9,]{3,7})\s*(?:sqft|sq\s*ft|Square\s*Feet)/i);
          const mAcres = t.match(/([\d.]+)\s*acres?/i);
          const vD = parseValid(mSqft?.[1]);
          if (vD) { setLot(vD); return; }
          if (mAcres) {
            const acres = parseFloat(mAcres[1]);
            if (acres > 0 && acres <= 50) { data.lotSize = `${acres} acres`; return; }
          }
        }
      }
    }

    const mE = fullText.match(/\bLot(?:\s+size)?[:\s]+([\d.]+)\s*acres?/i);
    if (mE) {
      const acres = parseFloat(mE[1]);
      if (acres > 0 && acres <= 50) data.lotSize = `${acres} acres`;
    }
  })();

  if (!data.address) {
    for (const sel of ['h1[data-testid="bdp-building-name"]', '[class*="homeInfo"] h1', 'h1']) {
      const el = document.querySelector(sel);
      if (el?.innerText?.trim()) { data.address = el.innerText.trim(); break; }
    }
    if (!data.address) { const m = document.title.match(/^([^|]+)/); if (m) data.address = m[1].trim(); }
  }

  if (!data.price) {
    const priceSelectors = ['.price-text','[data-testid="price"]','span[class*="PriceText"]','span[class*="price-text"]'];
    for (const sel of priceSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const m = (el.textContent||'').match(/\$\s*([1-9][\d,]*)/);
        const v = m ? parseInt(m[1].replace(/,/g,''),10) : 0;
        if (v > 100000 && v < 100000000) { data.price = v; break; }
      }
    }
  }
  if (!data.price) {
    const headerText = fullText.slice(0, 3000);
    const pricePattern = /\$([1-9]\d{0,2}(?:,\d{3})*)/g;
    const matches = [...headerText.matchAll(pricePattern)]
      .map(m => {
        const endIdx = m.index + m[0].length;
        const nextChar = headerText[endIdx];
        if (nextChar && /\d/.test(nextChar)) return 0; 
        return parseInt(m[1].replace(/,/g, ''), 10) || 0;
      })
      .filter(v => v > 100000 && v < 100000000);
    if (matches.length) data.price = Math.max(...matches);
  }

  if (data.price && data.sqft && data.sqft > 0) {
    const ppsqMatch = fullText.match(/\$(\d{2,4})\s*(?:price\/sqft|\/sqft|per\s*sq)/i);
    const ppsqOnPage = ppsqMatch ? parseInt(ppsqMatch[1], 10) : 0;
    if (ppsqOnPage >= 50 && ppsqOnPage <= 5000) {
      const impliedPrice = ppsqOnPage * data.sqft;
      if (impliedPrice > 100000 && data.price < impliedPrice * 0.40) {
        data.price = Math.round(impliedPrice / 1000) * 1000;
        data._priceCorrected = true;
      }
    }
  }
  if (!data.beds || !data.baths) {
    const bedM  = fullText.match(/Bedrooms[:\s]+(\d+)/i);
    const bathM = fullText.match(/Full bathrooms[:\s]+(\d+)/i);
    if (!data.beds  && bedM)  data.beds  = parseNum(bedM[1]);
    if (!data.baths && bathM) data.baths = parseNum(bathM[1]);
  }

  if (!data.description) {
    for (const sel of ['[data-testid="description-text"]', '[data-testid="listing-description"]', '[class*="description-text"]']) {
      const el = document.querySelector(sel);
      if (el?.innerText?.trim().length > 30) { data.description = el.innerText.trim(); break; }
    }
  }

  if (!data.builderName && data.description) {
    const _bm = data.description.match(/\b(DR\s+Horton|Lennar|Pulte|KB\s+Home|Taylor\s+Morrison|Meritage|Ryan\s+Homes|Toll\s+Brothers|Century\s+Communities|Smith\s+Douglas|Dream\s+Finders|Highland\s+Homes|Maronda|Beazer|David\s+Weekley)\b/i);
    if (_bm) data.builderName = _bm[1].replace(/\s+/g, ' ').trim();
  }
  if (!data.builderName) {
    const _bnM = (fullText||'').match(/Builder\s*name[:\s]*([A-Z][A-Za-z0-9\s&'.,-]{1,40}?)(?=\s*(?:Builder\s*model|Year|Lot|Type|Garage|\*|$))/i);
    if (_bnM) data.builderName = _bnM[1].trim().replace(/\s+/g, ' ');
  }

  if (!data.hoaFee) {
    const hoaM = fullText.match(/HOA fee[:\s]+\$?([0-9,]+)\s*monthly/i);
    if (hoaM) data.hoaFee = hoaM[1];
  }

  if (!data.taxAssessedValueListing) {
    const assessedM = fullText.match(/Tax assessed value[:\s]+\$([0-9,]+)/i);
    if (assessedM) data.taxAssessedValueListing = parseNum(assessedM[1]);
  }
  if (!data.taxAnnualAmountListing) {
    const annualM = fullText.match(/Annual tax amount[:\s]+\$([0-9,]+)/i);
    if (annualM) data.taxAnnualAmountListing = parseNum(annualM[1]);
  }

  if (!data.taxHistory?.length) {
    const taxRows = [];
    const taxTableM = fullText.matchAll(/(\d{4})\s+\$([0-9,]+)[\s+\-\.0-9%]*\s+\$([0-9,]+)/g);
    for (const row of taxTableM) {
      const year = parseInt(row[1]);
      if (year > 2000 && year <= new Date().getFullYear()) {
        taxRows.push({ year, taxPaid: parseNum(row[2]), assessed: parseNum(row[3]) });
      }
    }
    if (taxRows.length) data.taxHistory = taxRows;
  }

  if (!data.taxDataConflict && data.taxHistory?.length && data.taxAnnualAmountListing) {
    const latestPublic = data.taxHistory[0]?.taxPaid || 0;
    const listingVal   = parseNum(String(data.taxAnnualAmountListing));
    if (latestPublic > 0 && Math.abs(latestPublic - listingVal) > 200) {
      data.taxDataConflict = {
        listingSheetValue: listingVal,
        publicRecordValue: latestPublic,
        difference: listingVal - latestPublic
      };
    }
  }


  if (data.listingMode === 'rent') {
    if (!data.leaseTerms    && data.leaseTermsText)    data.leaseTerms    = data.leaseTermsText;
    if (!data.petPolicy     && data.petPolicyText)     data.petPolicy     = data.petPolicyText;
    if (!data.petPolicy) {
      if (/cats?,\s*dogs?\s*ok/i.test(fullText))       data.petPolicy = 'Cats & dogs allowed';
      else if (/dogs?\s*ok/i.test(fullText))             data.petPolicy = 'Dogs allowed';
      else if (/cats?\s*ok/i.test(fullText))             data.petPolicy = 'Cats allowed';
      else if (/no\s*pets?/i.test(fullText))             data.petPolicy = 'No pets';
    }
    if (!data.laundry) {
      if (data.laundryText) data.laundry = data.laundryText;
      else {
        if (/in[\s-]unit laundry/i.test(fullText))       data.laundry = 'In-unit washer/dryer';
        else if (/laundry room/i.test(fullText))           data.laundry = 'Laundry room';
        else if (/shared laundry/i.test(fullText))         data.laundry = 'Shared laundry';
      }
    }
    if (!data.availableDate && data.availableDateText) data.availableDate = data.availableDateText;
    else if (!data.availableDate) {
      if (/available\s*now/i.test(fullText)) data.availableDate = 'Available now';
    }
    if (!data.depositMin  && data.depositText)       data.depositMin       = parseNum(data.depositText);
    if (!data.applicationFee && data.applicationFeeText) data.applicationFee = parseNum(data.applicationFeeText);
    if (!data.utilitiesIncluded && data.utilitiesIncludedText) data.utilitiesIncluded = data.utilitiesIncludedText;
    if (!data.parkingType && data.parking)           data.parkingType = data.parking;
  }

  if (!data.agentName && !data.isFSBO) {
    const agentM  = fullText.match(/Listing Provided by:\s*\n?\s*([^\n,\d]+?)(?:\s+\d{3}[-\.\s]\d{3}[-\.\s]\d{4})?[\n,]/i);
    const brokerM = fullText.match(/([A-Z][A-Z\s&]+(?:REALTY|REALTORS|ASSOCIATES|GROUP|PROPERTIES|REAL ESTATE)[^\n,]{0,40})\s+\d{3}/);
    if (agentM) data.agentName = agentM[1].trim();
    if (brokerM && !data.isFSBO) data.brokerageName = brokerM[1].trim();
  }

  if (!data.agentPhone) {
    const phoneM = fullText.match(/(?:Listing Provided by|John Silva)[^\n]*?(\d{3}[-\.\s]\d{3}[-\.\s]\d{4})/i);
    if (phoneM) data.agentPhone = phoneM[1];
  }

  if (!data.propertyModel) {
    const excludeWords = new Set([
      'The','This','Our','Your','Its','Their','A','An','One','Two','Three',
      'New','Old','Open','Great','Large','Small','Single','Double','Master',
      'Guest','Main','First','Second','Third','Upper','Lower','Front','Back',
      'Corner','End','Middle','Top','Bottom','Inside','Outside','Home','House',
      'Floor','Plan','Model','Unit','Suite','Level','Story','Room','Space',
      'Welcome','Located','Featuring','Offering','Designed','Built','Situated'
    ]);

    let model = '';

    if (!model) {
      const factM = fullText.match(/Builder\s+model[:\s]+([A-Z][A-Za-z0-9\-]{2,20})/i);
      if (factM && !excludeWords.has(factM[1])) {
        model = factM[1].replace(/\s*Builder\b|Builder$/gi, '').trim();
      }
    }

    if (!model && data.description) {
      const patterns = [
        /\bThe\s+([A-Z][a-z]{2,})\s+(?:model|floor\s*plan)\b/,     
        /\b([A-Z][a-z]{2,})\s+model\s+(?:is|offers|features|boasts)/i, 
        /\b([A-Z][a-z]{2,})\s+(?:townhome|floor\s*plan)\b/i,        
        /\bour\s+([A-Z][a-z]{2,})\s+(?:model|plan)\b/i,             
        /\bpopular\s+([A-Z][a-z]{2,})\s+(?:model|plan)\b/i,         
        /\bsought.after\s+([A-Z][a-z]{2,})\b/i,                     
      ];
      for (const re of patterns) {
        const m = data.description.match(re);
        if (m && !excludeWords.has(m[1])) { model = m[1]; break; }
      }
    }

    if (!model && data.description) {
      const beforeM = data.description.match(/([A-Z][a-z]{3,})\s+(?:model|floor\s*plan)\b/g);
      if (beforeM) {
        for (const hit of beforeM) {
          const word = hit.split(/\s/)[0];
          if (!excludeWords.has(word)) { model = word; break; }
        }
      }
    }

    if (model) data.propertyModel = model.replace(/\s*Builder\b|Builder$/gi, '').trim();
  }

  if (!data.parcelNumber) {
    const parcelM = fullText.match(/Parcel number[:\s]+([0-9\-]+)/i);
    if (parcelM) data.parcelNumber = parcelM[1].trim();
  }

  if (!data.mlsId) {
    const mlsM = fullText.match(/MLS#?[:\s]+([A-Z0-9]+)/i);
    if (mlsM) data.mlsId = mlsM[1];
  }

  if (!data.walkScore) {
    const walkM = fullText.match(/Walk Score[®\s]*\n?\s*(\d+)/i);
    if (walkM) data.walkScore = walkM[1];
  }

  if (!data.daysOnMarket) {
    const domM = fullText.match(/(\d+)\s+days?\s+on\s+[Mm]arket|Cumulative days[:\s]+(\d+)/i);
    if (domM) data.daysOnMarket = parseInt(domM[1] || domM[2]);
  }

  const listDateM = fullText.match(/Date on market[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i);
  if (listDateM) data.listDate = listDateM[1];

  if (!data.zestimate) {
    const zestEl = document.querySelector('[data-testid="primary-zestimate"]')
                || document.querySelector('[class*="Zestimate"] [class*="Value"]')
                || document.querySelector('[data-testid="zestimate-value"]');
    if (zestEl) {
      const zv = parseNum((zestEl.textContent || '').replace(/[^0-9,]/g, ''));
      if (zv > 10000) data.zestimate = zv;
    }
  }
  if (!data.zestimate) {
    const zestM = fullText.match(/Zestimate[®\s]*\n?\s*\$([0-9,]+)/i);
    if (zestM) { const zv = parseNum(zestM[1]); if (zv >= 10000) data.zestimate = zv; }
  }

  if (!data.zestimateRange?.low) {
    const zestRangeM = fullText.match(/Estimated sales range\s*\n?\s*\$([0-9,]+)\s*[-–]\s*\$([0-9,]+)/i);
    if (zestRangeM) data.zestimateRange = { low: parseNum(zestRangeM[1]), high: parseNum(zestRangeM[2]) };
  }

  if (!data.schools?.length) {
    const parsed = parseSchoolsFromText(fullText);
    if (parsed.length) data.schools = parsed;
  }

  if (!data.floodZone) {
    const fzM = fullText.match(/Flood zone\s*In FEMA Zone\s*([A-Z]{1,3})\b[^.\n]{0,40}?(minimal|moderate|high|elevated|severe)[\s-]*risk/i)
             || fullText.match(/FEMA Zone\s*([A-Z]{1,3})\b[^.\n]{0,40}?(minimal|moderate|high|elevated|severe)[\s-]*risk/i);
    if (fzM) {
      data.floodZone = fzM[1].toUpperCase();
      data.floodRiskLevel = fzM[2].toLowerCase(); 
    }
  }

  const zpidM = location.href.match(/\/(\d+)_zpid/);
  data.zpid = zpidM ? zpidM[1] : '';

  const innerT = bodyInnerText;
  const mlsFromInnerT = innerT.match(/MLS\s*#\s*:?\s*([A-Z0-9]{5,15})\b/im)
             || innerT.match(/#\s*([A-Z][0-9]{5,12})\b/m)
             || innerT.match(/MLS\s*(?:ID|Number)[:\s]+([A-Z0-9]{5,15})\b/im);
  if (mlsFromInnerT) data.mlsId = mlsFromInnerT[1].trim();
  if (!data.mlsId || /^\d+$/.test(data.mlsId)) {
    const allTextEls = document.querySelectorAll('span, div, p, li, td');
    for (const el of allTextEls) {
      if (el.children.length > 2) continue;
      const t = (el.textContent || '').trim();
      if (t.length > 50 || t.length < 5) continue;
      const m = t.match(/(?:MLS|Listing)\s*#?\s*:?\s*([A-Z][0-9A-Z]{4,12})\b/i);
      if (m && /[A-Z]/i.test(m[1]) && /\d/.test(m[1])) {
        data.mlsId = m[1].trim();
        break;
      }
    }
  }
  if (!data.mlsId || /^\d+$/.test(data.mlsId)) {
    const ftMls = fullText.match(/MLS\s*#\s*:?\s*([A-Z][0-9A-Z]{4,12})\b/i)
               || fullText.match(/#\s*([A-Z][0-9]{5,12})\b/);
    if (ftMls) data.mlsId = ftMls[1].trim();
  }
  const mlsSrcM = innerT.match(/Source:\s*(Stellar\s*MLS|MRED|CRMLS|HAR|NWMLS|[A-Z]{3,10}\s*MLS)\b/im)
               || innerT.match(/Source:\s*([^\n,]{3,30}?)(?:\s*(?:IDX|as distributed|information|provided|\n))/im);
  if (mlsSrcM) {
    const src = mlsSrcM[1].trim().replace(/\s+/g, ' ');
    if (!/^(?:Orlando|Miami|Tampa|Jacksonville|Chicago|New York|Los Angeles|Houston|Dallas|Phoenix)\s*$/i.test(src)) {
      data.mlsSource = src;
    }
  }
  const originatingMlsM = fullText.match(/Originating MLS[:\s]+([^\n$,]+)/i);
  const rawOrigMls = originatingMlsM ? originatingMlsM[1].trim() : '';
  data.originatingMls = rawOrigMls.replace(/IDX.*$/i, '').replace(/information.*$/i, '').replace(/provided.*$/i, '').trim();
  const courtesyM = innerT.match(/Listing\s+courtesy\s+of[:\s]+[^,]+,\s*([^\n]+)/i);
  if (courtesyM) {
    const raw = courtesyM[1].trim();
    data.brokerageName = raw.replace(/\s*(?:Source:|MLS|\d{3}[-.]\d{3}).*/i, '').trim();
  }

  if (data.isFSBO) {
    data.agentName     = '';
    data.brokerageName = '';
  }

  if (!data.listDate) {
    const listDateM2 = fullText.match(/Date on market[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i);
    if (listDateM2) data.listDate = listDateM2[1];
    if (!data.listDate && data.priceHistory?.length) {
      const latestListing = data.priceHistory.find(h => /listed/i.test(h.event || h.priceChangeType || ''));
      if (latestListing) data.listDate = latestListing.date;
    }
  }
  if (data.listDate) {
    try {
      const listed = new Date(data.listDate);
      const today  = new Date();
      const diffMs = today - listed;
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      if (diffDays >= 0 && diffDays < 3650) data.daysOnMarket = diffDays;
    } catch(e) {}
  }
  if (!data.daysOnMarket) {
    const domM2 = fullText.match(/(\d+)\s+days?\s+on\s+Zillow|Cumulative days[^:]*:[^\d]*(\d+)/i);
    if (domM2) data.daysOnMarket = parseInt(domM2[1] || domM2[2]);
  }

  if (!data.taxHistory?.length) {
    try {
      const tables = document.querySelectorAll('table');
      for (const table of tables) {
        let isTaxTable = !!table.closest('[class*="tax"]');
        let el2 = table.previousElementSibling;
        for (let i = 0; i < 5 && el2; i++) {
          if (/tax history/i.test(el2.innerText || '')) { isTaxTable = true; break; }
          el2 = el2.previousElementSibling;
        }
        if (!isTaxTable) continue;
        const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
        const taxRows = [];
        rows.forEach(row => {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 2) {
            const yearM = cells[0]?.innerText?.match(/\d{4}/);
            const taxM  = cells[1]?.innerText?.match(/\$?([\d,]+)/);
            const assessM = cells[2]?.innerText?.match(/\$?([\d,]+)/);
            if (yearM) taxRows.push({
              year:     parseInt(yearM[0]),
              taxPaid:  taxM  ? parseNum(taxM[1])   : 0,
              assessed: assessM ? parseNum(assessM[1]) : 0
            });
          }
        });
        if (taxRows.length) { data.taxHistory = taxRows; break; }
      }
    } catch(e) {}
  }

  if (!data.taxDataConflict) {
    const latestPublic = data.taxHistory?.[0]?.taxPaid || 0;
    const listingVal   = parseNum(String(data.taxAnnualAmountListing || 0));
    if (latestPublic > 0 && listingVal > 0 && Math.abs(latestPublic - listingVal) > 200) {
      data.taxDataConflict = {
        listingSheetValue: listingVal,
        publicRecordValue: latestPublic,
        difference: listingVal - latestPublic
      };
    }
  }

  const photos = extractPhotos();
  data.photoCount = countListingPhotos(fullText) || photos.length || 0;
  data.photoUrls  = photos.slice(0, 5);
  if (!data.photoCount) {
    const photoM = fullText.match(/See all (\d+) photos/i);
    if (photoM) data.photoCount = parseInt(photoM[1]);
  }

  const aiPhotoSignals = [
    /AI.{0,10}enhanc/i, /virtual.{0,5}stag/i, /digitally.{0,10}stag/i,
    /AI.{0,10}generat/i, /rendered/i, /artist.{0,10}render/i,
    /photo.{0,10}enhanc/i, /image.{0,10}enhanc/i
  ];
  const photoText = Array.from(document.querySelectorAll(
    '[class*="photo"] [class*="caption"], [class*="media"] [class*="badge"], [class*="photo"] [class*="label"], [data-testid*="photo"]'
  )).map(el => el.textContent).join(' ') + ' ' + fullText.slice(0, 3000);
  data.hasAiPhotos = aiPhotoSignals.some(re => re.test(photoText));

  if (data.listingMode === 'buy') {
    if (!data.isFSBO && nd) {
      data.isFSBO = !!(nd.isForSaleByOwner);
    }
    if (!data.isFSBO) {
      const bodySnip = fullText.slice(1000, 5000);
      data.isFSBO = /^for sale by owner$/im.test(bodySnip) || /fsbo/i.test(bodySnip);
    }
  }

  if (!data.parcelNumber) {
    const parcelM2 = fullText.match(/Parcel number[:\s]+([0-9\-A-Z]+)/i);
    if (parcelM2) data.parcelNumber = parcelM2[1].trim();
  }

  if (!data.walkScore) {
    const walkM2 = fullText.match(/Walk Score[®\s]*\n?\s*(\d+)/i);
    if (walkM2) data.walkScore = walkM2[1];
  }

  if (!data.zestimate) {
    const zestEl2 = document.querySelector('[data-testid="primary-zestimate"]')
                 || document.querySelector('[data-testid="zestimate-value"]');
    if (zestEl2) {
      const zv2 = parseNum((zestEl2.textContent || '').replace(/[^0-9,]/g, ''));
      if (zv2 > 10000) data.zestimate = zv2;
    }
  }
  if (!data.zestimate) {
    const zestM2 = fullText.match(/Zestimate[®\s]*\n?\s*\$([0-9,]+)/i);
    if (zestM2) { const zv2b = parseNum(zestM2[1]); if (zv2b >= 10000) data.zestimate = zv2b; }
  }
  if (!data.zestimateRange?.low) {
    const zrM = fullText.match(/Estimated sales range\s*\n?\s*\$([0-9,]+)\s*[-–]\s*\$([0-9,]+)/i);
    if (zrM) data.zestimateRange = { low: parseNum(zrM[1]), high: parseNum(zrM[2]) };
  }

  if (!data.schools?.length) {
    const parsed = parseSchoolsFromText(fullText);
    if (parsed.length) data.schools = parsed;
  }

  const innerText2 = bodyInnerText;
  const courtesyM2 = innerText2.match(/Listing\s+courtesy\s+of[:\s]+([^,\n\d]{3,60}?)(?=\s*\d{3}[-.\s]\d{3}|\s*,|\n|$)/i);
  const courtesyBrokerM = innerText2.match(/Listing\s+courtesy\s+of[:\s]+[^,]+,\s*([^\n]+)/i);
  if (courtesyM2 && !data.agentName) data.agentName = courtesyM2[1].trim();
  if (courtesyBrokerM) {
    data.brokerageName = courtesyBrokerM[1].trim()
      .replace(/\s*(?:Source:|MLS|\d{3}[-.\s]\d{3}|\$\d).*/i, '').trim();
  }
  if (!data.agentPhone) {
    const phoneM2 = fullText.match(/(?:Listing Provided by[\s\S]{0,100}?)(\d{3}[-\.\s]\d{3}[-\.\s]\d{4})/i);
    if (phoneM2) data.agentPhone = phoneM2[1];
  }

  if (!data.propertyModel && data.description) {
    const modelM2 = data.description.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:townhome|model|floor\s*plan)/i);
    if (modelM2) data.propertyModel = modelM2[1].replace(/\s*Builder\b|Builder$/gi, '').trim();
  }

  data.comparables = extractComps();

  if (data.listingMode === 'sold' && !data.dateSold) {
    const dateEl = document.querySelector('[data-testid="date-info"]');
    if (dateEl) {
      const txt = (dateEl.textContent || '').trim();
      if (/\d{1,2}\/\d{1,2}\/\d{4}/.test(txt)) data.dateSold = txt;
    }
    if (!data.dateSold && Array.isArray(data.priceHistory)) {
      const soldEv = data.priceHistory.find(h => /^sold$/i.test((h.event || '').trim()));
      if (soldEv?.date) data.dateSold = soldEv.date;
    }
  }


  data.priceHistory = await parsePriceHistoryFromPage();

  if (nd && data.priceHistory.length > 0) {
    const hasPrevSale = data.priceHistory.filter(h => /^sold$/i.test((h.event||'').trim())).length >= 2;
    if (!hasPrevSale && nd.lastSoldPrice && nd.lastSoldDate) {
      const normDt = (raw) => {
        if (!raw) return '';
        const n = Number(raw);
        const d = n > 1000000000 ? new Date(n) : new Date(raw);
        if (isNaN(d)) return String(raw);
        return (d.getMonth()+1)+'/'+d.getDate()+'/'+d.getFullYear();
      };
      const prevDate = normDt(nd.lastSoldDate);
      const already = data.priceHistory.some(h =>
        /^sold$/i.test((h.event||'').trim()) && Math.abs(h.price - nd.lastSoldPrice) < 1000
      );
      if (!already && prevDate) {
        data.priceHistory.push({ date: prevDate, event: 'Sold', price: nd.lastSoldPrice });
      }
    }
  }

  if (data.listingMode === 'sold' && !data.dateSold && data.priceHistory.length > 0) {
    const soldEv = data.priceHistory.find(h => /^sold$/i.test((h.event||'').trim()));
    if (soldEv) data.dateSold = soldEv.date;
  }

  data.priceHistory = sortHistory(data.priceHistory); 
  data.nearbyHomes   = scrapeNearbyHomes();
  if ((!data.nearbyHomes || !data.nearbyHomes.length) && _chNearbyHomes.length) {
    data.nearbyHomes = _chNearbyHomes;
  }

  if (data.comparables?.length > 0) {
    const seenAddr = new Set(data.nearbyHomes.map(h => (h.addr || h.address || '').toLowerCase().replace(/[^a-z0-9]/g,'')));
    for (const c of data.comparables) {
      const key = (c.address || '').toLowerCase().replace(/[^a-z0-9]/g,'');
      if (key && !seenAddr.has(key)) {
        seenAddr.add(key);
        const cb = parseNum(String(c.beds || 0)), cba = parseFloat(String(c.baths || 0)) || 0, cs = parseNum(String(c.sqft || 0));
        data.nearbyHomes.push({
          addr: c.address, price: c.price ? '$' + Number(c.price).toLocaleString() : '',
          priceNum: c.price || 0, beds: c.beds ? c.beds + ' bd' : '', baths: c.baths ? c.baths + ' ba' : '',
          sqft: c.sqft ? Number(c.sqft).toLocaleString() + ' sqft' : '', status: c.status || '',
          bedsNum: cb, bathsNum: cba, sqftNum: cs,
          url: c.url || '', zpid: c.zpid || '',
        });
      }
    }
  }

  if (Array.isArray(data.nearbyHomes) && data.nearbyHomes.length) {
    const subjBeds  = parseNum(String(data.beds || 0));
    const subjBaths = parseFloat(String(data.baths || 0)) || 0;
    const subjSqft  = parseNum(String(data.sqft || 0));
    if (subjBeds > 0) {
      const sameBeds = data.nearbyHomes.filter(h => (h.bedsNum || 0) === subjBeds);
      if (sameBeds.length) data.nearbyHomes = sameBeds;
    }
    data.nearbyHomes.sort((a, b) => {
      const bd = Math.abs((a.bathsNum || 0) - subjBaths) - Math.abs((b.bathsNum || 0) - subjBaths);
      if (bd !== 0) return bd;
      return Math.abs((a.sqftNum || 0) - subjSqft) - Math.abs((b.sqftNum || 0) - subjSqft);
    });
  }
  data.nearbySchools = scrapeNearbySchools();

  if (!data.nearbySchools?.length) {
    const parsed = parseSchoolsFromText(fullText);
    data.nearbySchools = parsed.map(s => ({ rating: s.rating, name: s.name, grades: s.grades, dist: s.distance }));
  }

  if ((!Array.isArray(data.schools) || !data.schools.length) && data.nearbySchools?.length) {
    data.schools = data.nearbySchools.map(s => ({
      name: s.name, rating: s.rating, grades: s.grades || '', distance: s.distance || s.dist || ''
    }));
  }

  data.agentLicenseLookup = {
    state: 'FL', name: data.agentName, brokerage: data.brokerageName, phone: data.agentPhone
  };
  if (data.parcelNumber) {
    data.countyLookup = { county: 'Orange County, FL', parcel: data.parcelNumber };
  }

  if (!data.lastSoldPrice || data.lastSoldPrice === 0) {
    const soldEvDom = (data.priceHistory || []).find(h =>
      /^sold$/i.test((h.event || h.priceChangeType || '').trim()) && h.price > 50000
    );
    if (soldEvDom) data.lastSoldPrice = Number(soldEvDom.price);
  }
  if ((!data.lastSoldPrice || data.lastSoldPrice === 0) && nd?.lastSoldPrice > 50000) {
    data.lastSoldPrice = Number(nd.lastSoldPrice);
  }

  try {
    const rzEl = document.querySelector('[data-testid="rent-zestimate"]');
    if (rzEl) {
      const rzText = rzEl.textContent || '';
      const rzM = rzText.match(/\$([0-9,]+)/);
      if (rzM) {
        const rzVal = parseInt(rzM[1].replace(/,/g, ''), 10);
        if (rzVal >= 500 && rzVal <= 50000) data.rentZestimate = rzVal; 
      }
    }
  } catch(e) {}

  if (data.listingMode === 'rent') {
    const sealedRentPrice = scrapeListingPrice('rent');
    if (sealedRentPrice > 0 && sealedRentPrice <= 50000) {
      data.price     = sealedRentPrice;
      data.rentPrice = sealedRentPrice;
    } else if (data.rentZestimate > 0) {
      data.price     = data.rentZestimate;
      data.rentPrice = data.rentZestimate;
    } else {
      const rentEv = (data.priceHistory || []).find(h => {
        const ev = (h.event || h.priceChangeType || '').toLowerCase();
        return /listed.*rent|price.*change|reduced/i.test(ev) && h.price >= 500 && h.price <= 50000;
      });
      if (rentEv) { data.price = Number(rentEv.price); data.rentPrice = data.price; }
    }
  }

  if (data.propertyModel) {
    data.propertyModel = data.propertyModel.replace(/\s*Builder\b/gi, '').trim();
    if (data.builderName) {
      const esc = data.builderName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      data.propertyModel = data.propertyModel.replace(new RegExp('^' + esc + '\\s*', 'i'), '').trim();
    }
    data.propertyModel = data.propertyModel.replace(/^Builder\s*/i, '').trim();
  }

  return data;
}

function scrapeRedfin(data) {
  try {
    const el = document.getElementById('__NEXT_DATA__');
    if (el) {
      const json = JSON.parse(el.textContent);
      const home = json?.props?.pageProps?.aboveTheFold?.homeData;
      if (home) {
        data.address = home.formattedAddress || '';
        data.price = home.listingPrice?.amount || 0;
        data.beds = home.beds || 0;
        data.baths = home.baths || 0;
        data.sqft = home.sqFt?.value || 0;
        data.yearBuilt = home.yearBuilt?.value || '';
        data.description = home.remarks || '';
      }
    }
  } catch(e) {}

  if (!data.address) {
    const el = document.querySelector('.street-address, [class*="address"] h1, h1[class*="homeAddress"]');
    if (el) data.address = el.innerText?.trim();
  }
  if (!data.price) {
    const el = document.querySelector('[class*="price"] [class*="stat"], .price span, [data-rf-test-id="abp-price"]');
    if (el) data.price = (() => { const m=(el.textContent||'').match(/\$([1-9][\d,]*)/); return m?parseInt(m[1].replace(/,/g,''),10):0; })();
  }
  document.querySelectorAll('[class*="stat-value"], [data-rf-test-id*="stats"] .stat-value').forEach(el => {
    const label = el.closest('[class*="stat"]')?.querySelector('[class*="label"], .label')?.innerText?.toLowerCase() || '';
    const val = parseNum(el.innerText);
    if (/bed/i.test(label) && !data.beds) data.beds = val;
    if (/bath/i.test(label) && !data.baths) data.baths = val;
    if (/sq|sqft/i.test(label) && !data.sqft) data.sqft = val;
  });
  if (!data.description) {
    const el = document.querySelector('[class*="remarks"], [class*="description-text"]');
    if (el) data.description = el.innerText?.trim();
  }

  if (!data.agentName) {
    const agentEl = document.querySelector('[class*="agentName"], [class*="listing-agent"]');
    const v = (agentEl && agentEl.innerText ? agentEl.innerText.trim() : '');
    if (v && v.length >= 3 && v.length < 50 && !COMPANY_RE.test(v) && !/listed by|listing|courtesy|provided by/i.test(v)) {
      data.agentName = v;
    }
  }

  if (data.listingMode === 'buy') { data.isFSBO = data.isFSBO || /\bfor sale by owner\b/i.test(document.body.innerText.slice(1000, 4000)); }
  return data;
}

function scrapeRealtor(data) {
  try {
    const jsonLDs = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of jsonLDs) {
      const j = JSON.parse(s.textContent);
      if (j['@type'] === 'SingleFamilyResidence' || j['@type'] === 'Residence' || j.floorSize) {
        data.address = j.address ? `${j.address.streetAddress}, ${j.address.addressLocality}, ${j.address.addressRegion}` : '';
        data.price = parseNum(j.offers?.price || '');
        data.sqft = parseNum(j.floorSize?.value || '');
        data.beds = parseNum(j.numberOfRooms || '');
        data.description = j.description || '';
        break;
      }
    }
  } catch(e) {}

  if (!data.address) {
    const el = document.querySelector('h1[class*="address"], [data-testid="address"] h1, h1');
    if (el) data.address = el.innerText?.trim();
  }



  if (!data.price) {
    const el = document.querySelector('[data-testid="list-price"], [class*="price"] [class*="price"]');
    if (el) data.price = (() => { const m=(el.textContent||'').match(/\$([1-9][\d,]*)/); return m?parseInt(m[1].replace(/,/g,''),10):0; })();
  }

  const bedsEl  = document.querySelector('[data-testid="property-meta-beds"], [aria-label*="bed"]');
  const bathsEl = document.querySelector('[data-testid="property-meta-baths"], [aria-label*="bath"]');
  const sqftEl  = document.querySelector('[data-testid="property-meta-sqft"], [aria-label*="sq"]');
  if (bedsEl && !data.beds)   data.beds  = parseNum(bedsEl.innerText);
  if (bathsEl && !data.baths) {
    const bt = (bathsEl.innerText || bathsEl.textContent || '').trim();
    const bFrac = bt.match(/^(\d+)\s+1\/2$|^(\d+)½$/);  
    const bDec  = bt.match(/^(\d+\.\d)$/);                
    const bInt  = bt.match(/^(\d+)$/);                      
    let bv = 0;
    if (bFrac) bv = parseInt(bFrac[1] || bFrac[2], 10) + 0.5;
    else if (bDec) bv = parseFloat(bt);
    else if (bInt) bv = parseInt(bt, 10);
    if (bv > 0 && bv <= 20) data.baths = bv;
  }
  if (sqftEl && !data.sqft)   data.sqft  = parseNum(sqftEl.innerText);

  if (!data.description) {
    const el = document.querySelector('[class*="description"] p, [data-testid="description"]');
    if (el) data.description = el.innerText?.trim();
  }

  const bodyText = document.body.innerText;
  const agentCourtM  = bodyText.match(/Listing\s+courtesy\s+of[:\s]+([^,\n\d]{3,60}?)(?=\s*\d{3}[-.\ s]\d{3}|\s*,|\n|$)/i);
  const brokerCourtM = bodyText.match(/Listing\s+courtesy\s+of[:\s]+[^,]+,\s*([^\n]+)/i);
  if (agentCourtM && !data.agentName) data.agentName = agentCourtM[1].trim();
  if (brokerCourtM) {
    data.brokerageName = brokerCourtM[1].trim()
      .replace(/\s*(?:Source:|MLS|\d{3}[-.\ s]\d{3}|\$\d).*/i, '').trim();
  }

  const ybM  = bodyText.match(/(?:year\s*built|built\s*in)[:\s]+(\d{4})/i);
  const lotM = bodyText.match(/lot\s*size[:\s]+([\d,\.]+\s*(?:sq\s*ft|acres?))/i);
  const hoaM = bodyText.match(/hoa[:\s\$]+([\d,]+)\s*(?:\/mo|per month|monthly)?/i);
  if (ybM)  data.yearBuilt = ybM[1];
  if (lotM) data.lotSize   = lotM[1];
  if (hoaM) data.hoaFee    = hoaM[1];

  data.isFSBO = data.isFSBO || /\bfor sale by owner\b/i.test(bodyText.slice(0, 3000));
  return data;
}

function scrapeListingPrice(listingMode) {

  const excludedParents = [
    '[class*="carousel"]', '[class*="similar"]', '[class*="nearby"]',
    '[class*="recommendation"]', '[class*="Zestimate"]', '[class*="zestimate"]',
  ];

  const isRentCtx = listingMode === 'rent'
    || (!listingMode && (
         /FOR_RENT/i.test(document.getElementById('__NEXT_DATA__')?.textContent?.slice(0,2000) || '')
      || /^(?:House|Home|Apartment|Condo|Townhouse) for rent$/im.test(document.body?.innerText?.slice(0,200) || '')
    ));
  const minP = isRentCtx ? 500   : 100000;
  const maxP = isRentCtx ? 50000 : 100000000;

  if (isRentCtx) {
    try {
      const allSpans = document.querySelectorAll('span');
      for (const sp of allSpans) {
        const txt = (sp.textContent || '').trim();
        if (txt !== '/mo') continue;
        const parent = sp.parentElement;
        if (!parent) continue;
        if (excludedParents.some(ep => parent.closest(ep))) continue;
        const parentText = parent.textContent || '';
        const v = parsePriceToken(parentText);
        if (v >= 500 && v <= 50000) return v;
        const gp = parent.parentElement;
        if (gp) {
          const gpText = gp.textContent || '';
          const v2 = parsePriceToken(gpText);
          if (v2 >= 500 && v2 <= 50000) return v2;
        }
      }
    } catch(e) {}
  }

  const domSelectors = [
    '.price-text',                               
    '[data-testid="price"]',                     
    'span[class*="PriceText"]',                  
    'span[class*="price-text"]',                 
    '[class*="summary-container"] .price-text',  
  ];

  const parsePriceToken = (text) => {
    if (!text) return 0;
    const m = text.match(/\$\s*([1-9][\d,]*)/);
    if (!m) return 0;
    return parseInt(m[1].replace(/,/g, ''), 10) || 0;
  };

  for (const sel of domSelectors) {
    try {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        if (excludedParents.some(ep => el.closest(ep))) continue;
        const text = el.textContent || el.innerText || '';
        const v = parsePriceToken(text);
        if (v >= minP && v <= maxP) return v;
      }
    } catch(e) {}
  }

  if (!isRentCtx) {
    try {
      const bodyTop = document.body.innerText.slice(0, 2000);
      const soldM = bodyTop.match(/[Ss]old(?:\s+on\s+\S+)?\s+(?:for\s+)?\$([1-9][\d,]+)/);
      if (soldM) {
        const v = parseInt(soldM[1].replace(/,/g,''), 10);
        if (v > 100000 && v < 100000000) return v;
      }
    } catch(e) {}
  }

  const zpidM   = location.pathname.match(/\/(\d+)_zpid/);
  const urlZpid = zpidM ? zpidM[1] : null;

  const getPriceFromHistory = (obj) => {
    const ph = obj?.priceHistory;
    if (!Array.isArray(ph) || !ph.length) return 0;
    const top = ph[0];
    const topEv = (top?.event || top?.priceChangeType || '').toLowerCase().trim();
    if (isRentCtx) {
      if (/listed.*rent|price.*change|reduced/i.test(topEv) && top?.price >= 500 && top?.price <= 15000) {
        return Number(top.price);
      }
      for (const h of ph) {
        const ev = (h.event || h.priceChangeType || '').toLowerCase();
        if (/listed.*rent|price.*change|reduced/i.test(ev) && h.price >= 500 && h.price <= 15000) {
          return Number(h.price);
        }
      }
    }
    const listed = ph.find(h =>
      /listed\s+for\s+sale|^listed$/i.test(h.event || h.priceChangeType || '')
    );
    if (listed?.price > 100000) return Number(listed.price);
    const sold = ph.find(h =>
      /^sold$/i.test((h.event || h.priceChangeType || '').trim())
    );
    if (sold?.price > 100000) return Number(sold.price);
    return 0;
  };

  try {
    const el    = document.getElementById('__NEXT_DATA__');
    if (!el) return 0;
    const props = JSON.parse(el.textContent)?.props?.pageProps;

    const gdp = props?.gdpClientCache;
    if (gdp) {
      const keys       = Object.keys(gdp);
      const matchKey   = urlZpid ? keys.find(k => k.includes(urlZpid)) : null;
      const orderedKeys = matchKey ? [matchKey, ...keys.filter(k => k !== matchKey)] : keys;

      for (const key of orderedKeys) {
        try {
          const inner = JSON.parse(gdp[key]);
          const nd    = inner?.property || inner?.gdp || inner;
          if (!nd) continue;
          if (nd.zpid && urlZpid && String(nd.zpid) !== urlZpid) continue;
          const ph = getPriceFromHistory(nd);
          if (ph > 0) return ph;
          const p = nd.price || nd.listPrice || nd.listedPrice;
          if (p >= minP && p <= maxP) return Number(p);
        } catch(e) {}
      }
    }

    const atf = props?.aboveTheFold?.homeData || props?.aboveTheFold;
    if (atf && (!urlZpid || !atf.zpid || String(atf.zpid) === urlZpid)) {
      const ph = getPriceFromHistory(atf);
      if (ph > 0) return ph;
      const p = atf.price || atf.listPrice;
      if (p >= minP && p <= maxP) return Number(p);
    }
  } catch(e) {}

  return 0;
}
function maybeAnalyze() {
  if (!isListingPage()) return;
  if (location.href === lastAnalyzedUrl) return;
  if (analysisInProgress) return;

  const waitForReady = (attempts = 0) => {
    if (!isListingPage() || location.href !== lastUrl) return; 
    const nd = document.getElementById('__NEXT_DATA__');
    const hasData = nd && nd.textContent.includes('"zpid"');
    if (hasData || attempts >= 12) {
      setTimeout(announceListing, 400);
    } else {
      setTimeout(() => waitForReady(attempts + 1), 300);
    }
  };
  setTimeout(() => waitForReady(), 800);
}

function detectListingModeQuick() {
  try {
    const bodyText = document.body.innerText.slice(0, 3000);
    const phMatch = bodyText.match(/Price history[\s\S]{0,200}/i)?.[0] || '';
    const firstEvM = phMatch.match(/\d{1,2}\/\d{1,2}\/\d{4}\s*\n?\s*(Sold|Listing removed|Listed for rent)/i);
    if (firstEvM) {
      const ev = firstEvM[1].toLowerCase();
      if (/^sold/.test(ev))            return 'sold';
      if (/^listing removed/.test(ev)) return 'sold';
      if (/^listed for rent/.test(ev)) return 'rent';
    }
  } catch(e) {}

  try {
    const ndEl = document.getElementById('__NEXT_DATA__');
    if (ndEl) {
      const snippet = ndEl.textContent.slice(0, 30000);
      const m = snippet.match(/"homeStatus"\s*:\s*"([^"]+)"/);
      if (m) {
        const hs = m[1];
        if (/RECENTLY_SOLD/i.test(hs))            return 'sold';
        if (/OFF_MARKET|^OTHER$/i.test(hs))       return 'sold';
        if (/FOR_RENT/i.test(hs))                 return 'rent';
        if (/FOR_SALE/i.test(hs))                 return 'buy';
      }
    }
  } catch(e) {}

  try {
    const statusEls = document.querySelectorAll('span, div');
    const limit = Math.min(statusEls.length, 150);
    for (let i = 0; i < limit; i++) {
      const el = statusEls[i];
      if (el.children.length > 1) continue;
      const txt = (el.textContent || '').trim();
      if (txt.length > 30 || txt.length < 4) continue;
      if (/^off\s*market$/i.test(txt))                return 'sold';
      if (/^sold/i.test(txt) && /\$/.test(txt))       return 'sold';
      if (/^recently sold/i.test(txt))                return 'sold';
    }
  } catch(e) {}

  try {
    const hdr = document.body.innerText.slice(0, 1500);
    const afterNav = hdr.slice(200); 

    if (/\$[\d,]+\s*\/\s*mo/i.test(afterNav.slice(0, 600))) return 'rent';
    if (/(?:house|home|apartment|condo|townhouse|single.?family|duplex)\s+for\s+rent/im.test(afterNav)) return 'rent';
    if (/off\s*market/im.test(afterNav))                          return 'sold';
    if (/Sold (?:for |on )?\$[\d,]+/im.test(afterNav))           return 'sold';
    if (/Zestimate®/i.test(hdr.slice(0, 500)) && !/^For sale$/m.test(afterNav)) return 'sold';
    if (/^For sale$/m.test(afterNav))                             return 'buy';
  } catch(e) {}

  return 'buy';
}


function chLooksLikeAddress(s) {
  if (!s) return false;
  if (/real estate|homes? for sale|apartments? for rent|for rent|zillow|\brentals?\b/i.test(s)) return false;
  return /^\d+[\w-]*\s+\S/.test(s.trim());
}

const CH_ST_SUFFIX = /^(rd|road|st|street|ave|avenue|dr|drive|ln|lane|ct|court|blvd|boulevard|way|pl|place|ter|terrace|cir|circle|loop|trl|trail|pkwy|parkway|hwy|highway|run|path|pt|point|sq|square|xing|crossing|cv|cove|bnd|bend|walk|row|aly|alley)$/i;

function chUrlAddressSlug() {
  const m = location.pathname.match(/\/homedetails\/([^/]+)\/\d+_zpid/);
  return m ? m[1] : '';
}

function chAddressFromUrl() {
  const slug = chUrlAddressSlug();
  if (!slug) return '';
  const parts = slug.split('-');
  if (!/^\d/.test(parts[0])) return '';
  for (let i = 1; i < parts.length; i++) {
    if (CH_ST_SUFFIX.test(parts[i])) return parts.slice(0, i + 1).join(' ');
  }
  return '';
}

function chAddrMatchesUrl(s) {
  const slug = chUrlAddressSlug();
  if (!slug) return true;                       
  const norm = (x) => x.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
  return norm(slug.replace(/-/g, ' ')).startsWith(norm(s));
}

function chQuickAddress() {
  const t = (document.title.match(/^([^|,]+)/) || [])[1]?.trim() || '';
  if (chLooksLikeAddress(t) && chAddrMatchesUrl(t)) return t;
  return chAddressFromUrl();
}

function chQuickListing() {
  const quickMode  = detectListingModeQuick();
  const quickPrice = scrapeListingPrice(quickMode);
  const quickData = {
    address:     chQuickAddress(),
    price:       quickMode === 'rent' ? 0 : quickPrice,
    rentPrice:   quickMode === 'rent' ? quickPrice : 0,
    listingMode: quickMode,
    listingSite: detectSite(),
    soldPrice:   0,
    isFSBO:      false,
    isOffMarket: false,
  };
  const bodySlice = document.body.innerText.slice(0, 800);
  if (/off\s*market/im.test(bodySlice) || (/Zestimate®/i.test(bodySlice) && !/^For sale$/m.test(bodySlice))) {
    quickData.listingMode = 'sold';
    quickData.isOffMarket = true;
  }
  if (quickData.listingMode === 'sold') {
    const m = bodySlice.match(/Sold (?:for |on )?\$([\d,]+)/i);
    if (m) { quickData.soldPrice = parseInt(m[1].replace(/,/g,''), 10); quickData.price = quickData.soldPrice; }
  }
  return quickData;
}

function announceListing(attempt = 0) {
  if (!isListingPage() || !clearHomeEnabled) { sendToPanel({ type: 'CH_NO_LISTING' }); return; }
  if (analysisInProgress) return;

  const q    = chQuickListing();
  if (!q.address && attempt < 8) setTimeout(() => announceListing(attempt + 1), 700);
  const mode = q.listingMode;
  const raw  = mode === 'rent' ? (q.rentPrice || 0) : (q.soldPrice || q.price || 0);
  const label = mode === 'sold' ? (q.isOffMarket ? 'Last Sold ' : 'Sold ') : mode === 'rent' ? 'Rent ' : '';

  sendToPanel({
    type: 'CH_LISTING',
    listing: {
      address:     q.address?.split(',')[0] || 'Detecting address…',
      priceText:   raw > 0 ? label + '$' + Number(raw).toLocaleString() + (mode === 'rent' ? '/mo' : '') : '',
      listingMode: mode,
      isOffMarket: q.isOffMarket,
      note:        mode === 'sold' ? 'Sale history and current value'
                 : mode === 'rent' ? 'Rental and landlord intel'
                 : 'Price, offer, taxes and risks',
      zpid:        chZpid(),
    },
  });
}

async function runManualAnalysis() {
  if (!isListingPage()) { sendToPanel({ type: 'CH_NO_LISTING' }); return; }
  const setStatus = (t) => sendToPanel({ type: 'CH_STATUS', text: t });

  setStatus('Checking your settings…');

  let preCheck;
  try {
    preCheck = await Promise.race([
      chrome.runtime.sendMessage({ type: 'GET_API_KEY' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))
    ]);
  } catch (e) {
    sendToPanel({ type: 'CH_NEEDS_KEY' });
    return;
  }
  if (!preCheck?.apiKey) { sendToPanel({ type: 'CH_NEEDS_KEY' }); return; }
  const apiKey = preCheck.apiKey;

  analysisInProgress = false;
  lastAnalyzedUrl = '';
  analysisAbortKey++;

  const earlyScrapePromise = scrapeListing().catch(() => null);
  earlyScrapePromise.then((earlyData) => {
    if (!earlyData) return;
    chrome.runtime.sendMessage({ type: 'PREFETCH_ANALYSIS_LOOKUPS', data: earlyData }).catch(() => {});
  });

  setStatus('Opening up the full listing…');
  await expandPriceHistory();

  let freshData;
  try {
    setStatus('Reading the listing…');
    freshData = await scrapeListing();
  } catch (e) {
    sendToPanel({ type: 'CH_FAILED', text: 'Could not read this listing: ' + e.message });
    return;
  }

  await runAnalysis(freshData, apiKey);
}

let _spinnerRAF = null;
function startCanvasSpinner(shadow) {
  return;
}
function startCanvasSpinnerUnused(shadow) {
  if (_spinnerRAF) { cancelAnimationFrame(_spinnerRAF); _spinnerRAF = null; }
  const canvas = shadow.querySelector('#ch-spin-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const cx = 4, cy = 4, r = 2.8;
  const style = getComputedStyle(shadow.querySelector('#ch-panel') || document.body);
  const ringColor = style.getPropertyValue('--spinner-ring').trim() || '#e0ddf8';
  const tipColor  = style.getPropertyValue('--spinner-tip').trim()  || '#4F6BFF';
  const PERIOD_MS = 900;
  let startTime = null;
  function draw(timestamp) {
    if (!startTime) startTime = timestamp;
    const elapsed = timestamp - startTime;
    const angle   = ((elapsed % PERIOD_MS) / PERIOD_MS) * Math.PI * 2;
    ctx.clearRect(0, 0, 8, 8);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r, angle, angle + Math.PI * 0.6);
    ctx.strokeStyle = tipColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    _spinnerRAF = requestAnimationFrame(draw);
  }
  _spinnerRAF = requestAnimationFrame(draw);
}

function stopCanvasSpinner() {
  if (_spinnerRAF) { cancelAnimationFrame(_spinnerRAF); _spinnerRAF = null; }
}

const ACTIVITY_STEPS_BUY = [
  'Scraping listing details…',
  'Fetching tax records…',
  'Looking up comparable sales…',
  'Verifying agent license…',
  'Running appreciation analysis…',
  'Generating buyer intelligence…',
];
const ACTIVITY_STEPS_SOLD = [
  'Reading price history…',
  'Fetching tax records…',
  'Running FHFA appreciation…',
  'Compiling sale snapshot…',
];
const ACTIVITY_STEPS_RENT = [
  'Scraping rental details…',
  'Looking up Rent Zestimate…',
  'Checking landlord info…',
  'Cross-checking owner of record…',
  'Generating rental intel…',
];
function getActivitySteps(mode) {
  if (mode === 'sold') return ACTIVITY_STEPS_SOLD;
  if (mode === 'rent') return ACTIVITY_STEPS_RENT;
  return ACTIVITY_STEPS_BUY;
}
let _activityTimers = [];

function pushActivity(text) {
  sendToPanel({ type: 'CH_PROGRESS', text });
}

function startActivityFeed(shadow, mode = 'buy', targetMs = 45000) {
  _activityTimers.forEach(clearTimeout);
  _activityTimers = [];
  const steps = getActivitySteps(mode);
  const n = steps.length;
  const earlyWindow = Math.max(targetMs - 2000, (n - 1) * 1500);
  const interval = n > 1 ? earlyWindow / (n - 1) : 0;
  steps.forEach((text, i) => {
    const base = Math.round(i * interval);
    const jitter = i === 0 ? 0 : Math.round((Math.random() - 0.5) * interval * 0.4);
    const delay = Math.max(i * 800, base + jitter); 
    _activityTimers.push(setTimeout(() => pushActivity(text), delay));
  });
}

function stopActivityFeed(shadow) {
  _activityTimers.forEach(clearTimeout);
  _activityTimers = [];
}

async function runAnalysis(preScrapedData, preVerifiedKey) {
  if (!isListingPage() || !clearHomeEnabled) return;
  if (!preVerifiedKey && analysisInProgress) return;
  if (!preVerifiedKey && location.href === lastAnalyzedUrl) return;

  chLog('analysis_start', { url: location.href, mode: preScrapedData?.listingMode || 'buy' });
  analysisInProgress = true;
  lastAnalyzedUrl    = location.href;
  const myAbortKey   = analysisAbortKey;

  const mode = preScrapedData?.listingMode || 'buy';

  let apiKey = preVerifiedKey || '';
  let profileRes = {};
  let aiModel = 'claude-sonnet-5';
  let aiProvider = 'anthropic';
  let aiFastMode = true;
  if (!apiKey) {
    const [keyRes, pRes, prefsRes] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_API_KEY' }).catch(() => ({})),
      chrome.runtime.sendMessage({ type: 'GET_PROFILE' }).catch(() => ({})),
      new Promise(r => chrome.storage.sync.get(['ch_prefs'], r))
    ]);
    apiKey = keyRes?.apiKey || '';
    aiProvider = keyRes?.provider === 'openai' ? 'openai' : 'anthropic';
    profileRes = pRes;
    aiModel = prefsRes?.ch_prefs?.aiModel || (aiProvider === 'openai' ? 'gpt-5.6-terra' : 'claude-sonnet-5');
    if (aiModel === 'claude-sonnet-4-6') aiModel = 'claude-sonnet-5';   
    if (aiProvider === 'openai' && !aiModel.startsWith('gpt-')) aiModel = 'gpt-5.6-terra';
    if (aiProvider === 'anthropic' && !aiModel.startsWith('claude-')) aiModel = 'claude-sonnet-5';
    chAnalysisEffort = prefsRes?.ch_prefs?.analysisEffort || 'low';
    aiFastMode = prefsRes?.ch_prefs?.fastMode !== false;
  } else {
    const [pRes, prefsRes] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_PROFILE' }).catch(() => ({})),
      new Promise(r => chrome.storage.sync.get(['ch_prefs'], r))
    ]);
    profileRes = pRes;
    aiProvider = prefsRes?.ch_prefs?.aiProvider === 'openai' ? 'openai' : 'anthropic';
    aiModel = prefsRes?.ch_prefs?.aiModel || (aiProvider === 'openai' ? 'gpt-5.6-terra' : 'claude-sonnet-5');
    if (aiModel === 'claude-sonnet-4-6') aiModel = 'claude-sonnet-5';   
    if (aiProvider === 'openai' && !aiModel.startsWith('gpt-')) aiModel = 'gpt-5.6-terra';
    if (aiProvider === 'anthropic' && !aiModel.startsWith('claude-')) aiModel = 'claude-sonnet-5';
    chAnalysisEffort = prefsRes?.ch_prefs?.analysisEffort || 'low';
    aiFastMode = prefsRes?.ch_prefs?.fastMode !== false;
  }

  if (analysisAbortKey !== myAbortKey) { analysisInProgress = false; return; }

  const listingData = preScrapedData || await scrapeListing();
  listingData.userProfile = profileRes?.profile || {};

  createPanel(listingData, apiKey);
  const shadow = chPanelRoot;
  sendToPanel({ type: 'CH_ANALYZING', mode });

  chrome.runtime.sendMessage({ type: 'LOG_EVENT', event: 'listing_viewed', payload: { site: listingData.listingSite, price: listingData.price } });

  if (!apiKey) {
    showNoKeyState();
    analysisInProgress = false;
    stopCanvasSpinner();
    stopActivityFeed(shadow);
    return;
  }

  startActivityFeed(shadow, mode, 45000);

  let res;
  try {
    const sendWithTimeout = (message, label, ms) => new Promise((resolve, reject) => {
      let settled = false;
      const to = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`${label} timed out — the background worker may have restarted. Please try again.`));
      }, ms);
      try {
        chrome.runtime.sendMessage(message, (r) => {
          if (settled) return;
          settled = true;
          clearTimeout(to);
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!r?.ok) return reject(new Error(r?.error || `${label} failed`));
          resolve(r);
        });
      } catch (e) {
        if (settled) return;
        settled = true;
        clearTimeout(to);
        reject(e);
      }
    });

    const promptResult = await sendWithTimeout({ type: 'BUILD_PROMPT', data: listingData, apiKey }, 'Prompt build', 30000);

    const REQUEST_TIMEOUT_MS = (aiModel.includes('opus') || aiModel.includes('sol')) ? 150000 : 120000;
    const readProviderStream = async (resp, isOpenAI) => {
      if (!resp.body?.getReader) throw new Error('Streaming response body is unavailable');
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let rawText = '';
      let finishReason = '';
      let serviceTier = '';
      let firstTokenAt = 0;

      const consumeLine = (line) => {
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        let event;
        try { event = JSON.parse(payload); } catch (_) { return; }
        if (event?.type === 'error') throw new Error(event.error?.message || 'Provider stream error');

        let delta = '';
        if (isOpenAI) {
          const choice = event.choices?.[0];
          const content = choice?.delta?.content;
          delta = typeof content === 'string'
            ? content
            : (Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text || '').join('') : '');
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (event.service_tier) serviceTier = event.service_tier;
        } else {
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') delta = event.delta.text || '';
          if (event.type === 'message_delta' && event.delta?.stop_reason) finishReason = event.delta.stop_reason;
        }

        if (delta) {
          if (!firstTokenAt) {
            firstTokenAt = performance.now();
            pushActivity('Writing up the findings…');
          }
          rawText += delta;
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        lines.forEach(consumeLine);
        if (done) break;
      }
      if (pending) consumeLine(pending);
      if (!finishReason) throw new Error('Provider stream ended before completion');
      chLog('api_stream_complete', { chars: rawText.length, finishReason, serviceTier, firstTokenAt: firstTokenAt || null });
      return {
        rawText,
        truncated: finishReason === 'length' || finishReason === 'max_tokens',
        apiData: { streamed: true, finishReason, serviceTier }
      };
    };

    const callAIProvider = async () => {
      const MAX_ATTEMPTS = 3;
      let lastErr = null;
      const isOpenAI = aiProvider === 'openai';
      const reqBody = isOpenAI ? {
        model: (window.__chLastModelUsed = aiModel),
        reasoning_effort: (chAnalysisEffort || 'low'),
        max_completion_tokens: mode === 'buy' ? 14000 : 6000,
        response_format: { type: 'json_object' },
        ...(aiFastMode ? { service_tier: 'fast' } : {}),
        stream: true,
        messages: [
          { role: 'system', content: promptResult.system },
          { role: 'user', content: promptResult.user }
        ]
      } : {
        model: (window.__chLastModelUsed = aiModel),
        ...(/opus-4-6|opus-4-5|opus-4-1|opus-4-0|sonnet-4-6|sonnet-4-5|sonnet-4-0|sonnet-3|haiku-4|haiku-3|claude-3|claude-2/.test(aiModel) ? { temperature: 0 } : {}),
        ...(/sonnet-5|opus-4-7|opus-4-8|fable|mythos/.test(aiModel) ? { effort: (chAnalysisEffort || 'low') } : {}),
        max_tokens: mode === 'buy'
          ? (aiModel.includes('opus') ? 8000 : (aiModel.includes('sonnet-5') ? 14000 : 6000))
          : (aiModel.includes('sonnet-5') ? 6000 : 3000),
        system: promptResult.system,
        stream: true,
        messages: [{ role: 'user', content: promptResult.user }]
      };
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          const resp = await fetch(isOpenAI ? 'https://api.openai.com/v1/chat/completions' : 'https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: isOpenAI ? {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            } : {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              'anthropic-dangerous-direct-browser-access': 'true'
            },
            body: JSON.stringify(reqBody, (k, v) => k === '__stripped' ? undefined : v),
            signal: controller.signal
          });
          if (resp.ok) {
            const streamed = await readProviderStream(resp, isOpenAI);
            clearTimeout(timer);
            return streamed;
          }
          clearTimeout(timer);

          if (resp.status === 429 || resp.status >= 500) {
            const errBody = await resp.json().catch(() => ({}));
            lastErr = new Error(errBody?.error?.message || `API error ${resp.status}`);
            chLog('api_retry', { attempt, status: resp.status });
            if (attempt < MAX_ATTEMPTS) {
              const ra = parseFloat(resp.headers.get('retry-after'));
              const waitMs = (ra && ra > 0) ? ra * 1000 : 1500 * attempt;
              await new Promise(r => setTimeout(r, waitMs));
              continue;
            }
            throw lastErr;
          }

          const errBody = await resp.json().catch(() => ({}));
          const msg = errBody?.error?.message || `API error ${resp.status}`;
          if (resp.status === 400 && reqBody.service_tier && /service.?tier|fast|priority/i.test(msg)) {
            delete reqBody.service_tier;
            chLog('api_fast_mode_fallback', { msg: msg.slice(0, 120) });
            continue;
          }
          if (resp.status === 400 && /temperature|top_p|top_k|sampling|deprecated|effort|response_format|max_completion_tokens/i.test(msg)
              && (reqBody.temperature !== undefined || reqBody.top_p !== undefined || reqBody.top_k !== undefined || reqBody.effort !== undefined || reqBody.reasoning_effort !== undefined || reqBody.response_format !== undefined)
              && !reqBody.__stripped) {
            delete reqBody.temperature; delete reqBody.top_p; delete reqBody.top_k;
            if (/effort/i.test(msg)) delete reqBody.effort;
            if (/effort/i.test(msg)) delete reqBody.reasoning_effort;
            if (/response_format/i.test(msg)) delete reqBody.response_format;
            if (/max_completion_tokens/i.test(msg)) {
              reqBody.max_tokens = reqBody.max_completion_tokens;
              delete reqBody.max_completion_tokens;
            }
            reqBody.__stripped = true;
            chLog('api_strip_sampling_retry', { msg: msg.slice(0, 120) });
            continue;
          }
          throw new Error(msg);
        } catch (e) {
          clearTimeout(timer);
          const isAbort = e?.name === 'AbortError';
          const isNetwork = isAbort || /network|failed to fetch|load failed/i.test(e?.message || '');
          lastErr = isAbort ? new Error(`Request timed out after ${Math.round(REQUEST_TIMEOUT_MS/1000)}s`) : e;
          chLog('api_attempt_failed', { attempt, error: String(lastErr.message).slice(0, 200), network: isNetwork });
          if (isNetwork && attempt < MAX_ATTEMPTS) {
            await new Promise(r => setTimeout(r, 1500 * attempt));
            continue;
          }
          throw lastErr;
        }
      }
      throw lastErr || new Error('API call failed');
    };

    const { rawText, truncated, apiData } = await callAIProvider();
    chLastRawResponse = rawText || `(no streamed text found)\n${JSON.stringify(apiData).slice(0, 4000)}`;

    const finalResult = await sendWithTimeout({
      type: 'FINALIZE_RESULT',
      rawText,
      mode,
      truncated,
      meta: promptResult.meta || {}
    }, 'Finalize', 30000).then(r => r.data);

    res = { ok: true, data: finalResult };

  } catch(e) {
    res = { ok: false, error: e.message };
  }

  analysisInProgress = false;
  stopCanvasSpinner();
  if (analysisAbortKey !== myAbortKey) return;
  const currentShadow = chPanelRoot;
  stopActivityFeed(currentShadow);
  currentShadow?.querySelector('#ch-analyzing-badge')?.style &&
    (currentShadow.querySelector('#ch-analyzing-badge').style.display = 'none');

  if (res?.ok) {
    if (res.data?._truncated) {
      const tldrWrap = currentShadow?.querySelector('#ch-tldr');
      if (tldrWrap) {
        const notice = document.createElement('div');
        notice.style.cssText = 'font-size:9px;color:var(--amber-text);margin-top:4px;font-weight:600;';
        notice.textContent = '⚠ The analysis was cut off before it finished. Partial results recovered — some sections may be missing.';
        tldrWrap.appendChild(notice);
      }
    }
    populatePanel(res.data, listingData);
    const footerBrand = currentShadow?.querySelector('.ch-footer-brand');
    if (footerBrand) {
      const modelLabel = aiModel.includes('gpt-5.6-terra') ? 'GPT-5.6 Terra'
        : aiModel.includes('gpt-5.6-luna') ? 'GPT-5.6 Luna'
        : aiModel.includes('gpt-5.6') ? 'GPT-5.6 Sol'
        : aiModel.includes('opus-4-8') ? 'Opus 4.8'
        : aiModel.includes('opus') ? 'Opus 4.6'
        : aiModel.includes('sonnet-5') ? 'Sonnet 5'
        : 'Sonnet 4.6';
      footerBrand.textContent = `Clear Home · ${modelLabel}`;
    }
    chrome.runtime.sendMessage({ type: 'LOG_EVENT', event: 'analysis_generated',
      payload: { status: res.data.valuation?.status || res.data.listingMode } });
    pushPanel();
  } else {
    showErrorState(res?.error || 'Unknown error');
  }
}

function createPanel(listingData, apiKey) {
  chPanelRoot = document.createElement('div');
  chPanelRoot.id = 'ch-panel';
  chPanelRoot.innerHTML = getPanelHTML(listingData);
  homePanel = chPanelRoot;
  chRateLabCtx = null;
  applyTheme(currentTheme);
}

function getPanelHTML(listingData) {
  const { address, price, listingSite, isFSBO } = listingData;
  const mode      = listingData.listingMode || 'buy';
  const shortAddr = address?.split(',')[0] || 'Loading…';
  const rentAmt2     = listingData.rentPrice || 0;
  const rawPrice     = (mode === 'rent')
    ? (rentAmt2 > 0 ? rentAmt2 : (price > 0 && price <= 50000 ? price : 0))
    : (price || listingData.soldPrice || listingData.rawPrice || 0);
  const priceLabel   = mode === 'sold' ? 'Sold $' : mode === 'rent' ? '$' : '$';
  const priceSuffix  = mode === 'rent' ? '/mo' : '';
  const displayPrice = rawPrice > 0 ? priceLabel + Number(rawPrice).toLocaleString() + priceSuffix : '';

  return `
    <div class="ch-property-bar">
      <div class="ch-prop-address">${shortAddr}</div>
      <div class="ch-prop-meta">
        <span class="ch-prop-price" id="ch-prop-price-val">${displayPrice}</span>
        <span class="ch-prop-site">${listingSite || 'Zillow'}</span>
        ${isFSBO ? '<span class="ch-fsbo-badge">FSBO</span>' : ''}
        ${listingData.listingMode === 'sold' ? '<span class="ch-mode-badge ch-mode-badge--sold">🔒 SOLD</span>' : listingData.listingMode === 'rent' ? '<span class="ch-mode-badge ch-mode-badge--rent">🏠 FOR RENT</span>' : '<span class="ch-mode-badge ch-mode-badge--sale">🏷 FOR SALE</span>'}
        <span id="ch-analyzing-badge" class="ch-analyzing-badge">
          <canvas id="ch-spin-canvas" width="8" height="8" style="display:block;flex-shrink:0;"></canvas>${ listingData.listingMode === 'sold' ? 'Reading history' : listingData.listingMode === 'rent' ? 'Analyzing rental' : 'Analyzing' }
        </span>
      </div>
    </div>

    <!-- TLDR — hidden until analysis completes -->
    <div id="ch-tldr" class="ch-tldr" style="display:none;">
      <div class="ch-tldr-label">${ listingData.listingMode === 'sold' ? (listingData.isOffMarket ? 'OFF-MARKET ANALYSIS' : 'SALE SNAPSHOT') : listingData.listingMode === 'rent' ? 'RENTAL VERDICT' : 'CLEAR VERDICT' }</div>
      <div id="ch-tldr-text" class="ch-tldr-text"></div>
    </div>

    <!-- Activity feed — shown while analyzing, hidden when results arrive -->
    <div id="ch-activity" class="ch-activity">
      <div id="ch-activity-list" class="ch-activity-list"></div>
    </div>

    <div id="ch-results" class="ch-results" style="display:none;">

      <!-- Property meta strip — unheadered, always visible above Key Highlights -->
      <div id="ch-prop-meta-strip" class="ch-prop-meta-strip" style="display:none;"></div>

      <!-- Key Highlights — populated after analysis, sits above all sections -->
      <div class="ch-section ch-highlights-section" id="ch-highlights-section" style="display:none;">
        <div class="ch-section-header">
          <span class="ch-section-icon">⚡</span>
          <span class="ch-section-label">Key Highlights</span>
          <span class="ch-section-spacer"></span>
          <button class="ch-toggle" data-section-toggle="#ch-highlights-body">▾</button>
        </div>
        <div id="ch-highlights-body" class="ch-section-body">
          <div id="ch-highlights-content"><!-- key highlights bullets --></div>
        </div>
      </div>

      <!-- Property Info Bar — beds/baths/sqft/$/sqft/lot/hoa -->
      <div id="ch-propinfo-bar" class="ch-propinfo-bar" style="display:none;"></div>

      <!-- A. Price Reality Check -->
      <div class="ch-section">
        <div class="ch-section-header">
          <span class="ch-section-icon">💰</span>
          <span class="ch-section-label">Price Reality Check</span>
          <span id="ch-badge-price" class="ch-section-status" style="display:none;"></span>
          <span class="ch-section-spacer"></span>
          <button class="ch-toggle" data-section-toggle="#ch-price-body">▾</button>
        </div>
        <div id="ch-price-body" class="ch-section-body">
          <div id="ch-valuation-content"><!-- populated --></div>
        </div>
      </div>

      <!-- A2. Affordability -->
      <div class="ch-section">
        <div class="ch-section-header">
          <span class="ch-section-icon">🏦</span>
          <span class="ch-section-label">Affordability</span>
          <span id="ch-badge-afford" class="ch-section-status" style="display:none;"></span>
          <span class="ch-section-spacer"></span>
          <button class="ch-toggle" data-section-toggle="#ch-afford-body">▾</button>
        </div>
        <div id="ch-afford-body" class="ch-section-body">
          <div id="ch-afford-content"><!-- populated --></div>
        </div>
      </div>

      <!-- A3. What To Do Next -->
      <div class="ch-section" id="ch-actions-section" style="display:none;">
        <div class="ch-section-header">
          <span class="ch-section-icon">📋</span>
          <span class="ch-section-label">What To Do Next</span>
          <span class="ch-section-spacer"></span>
          <button class="ch-toggle" data-section-toggle="#ch-actions-body">▾</button>
        </div>
        <div id="ch-actions-body" class="ch-section-body">
          <div id="ch-actions-content"><!-- populated --></div>
        </div>
      </div>

      <!-- A4. Price History & Appreciation -->
      <div class="ch-section">
        <div class="ch-section-header">
          <span class="ch-section-icon">📈</span>
          <span class="ch-section-label">Price History & Appreciation</span>
          <span id="ch-badge-history" class="ch-section-status" style="display:none;"></span>
          <span class="ch-section-spacer"></span>
          <button class="ch-toggle" data-section-toggle="#ch-pricehistory-body">▾</button>
        </div>
        <div id="ch-pricehistory-body" class="ch-section-body">
          <div id="ch-pricehistory-content"><!-- populated --></div>
        </div>
      </div>

      <!-- A5. Estimated Tax Reset -->
      <div class="ch-section">
        <div class="ch-section-header">
          <span class="ch-section-icon">🧾</span>
          <span class="ch-section-label">Estimated Tax Reset</span>
          <span id="ch-badge-tax" class="ch-section-status" style="display:none;"></span>
          <span class="ch-section-spacer"></span>
          <button class="ch-toggle" data-section-toggle="#ch-tax-body">▾</button>
        </div>
        <div id="ch-tax-body" class="ch-section-body">
          <div id="ch-tax-content"><!-- populated --></div>
        </div>
      </div>

      <!-- A6. Commute — only shown when addresses are saved -->
      <div class="ch-section" id="ch-commute-section" style="display:none;">
        <div class="ch-section-header">
          <span class="ch-section-icon">🚗</span>
          <span class="ch-section-label">Commute Estimates</span>
          <span class="ch-section-spacer"></span>
          <button class="ch-toggle" data-section-toggle="#ch-commute-body">▾</button>
        </div>
        <div id="ch-commute-body" class="ch-section-body">
          <div id="ch-commute-content"><!-- populated --></div>
        </div>
      </div>

      <!-- B. Risks & Considerations -->
      <div class="ch-section">
        <div class="ch-section-header">
          <span class="ch-section-icon">⚠️</span>
          <span class="ch-section-label">Risks & Considerations</span>
          <span id="ch-badge-risks" class="ch-section-status" style="display:none;"></span>
          <span class="ch-section-spacer"></span>
          <button class="ch-toggle" data-section-toggle="#ch-risks-body">▾</button>
        </div>
        <div id="ch-risks-body" class="ch-section-body">
          <div id="ch-risks-content"><!-- populated --></div>
        </div>
      </div>

      <!-- C. Agent Validation -->
      <div class="ch-section">
        <div class="ch-section-header">
          <span class="ch-section-icon">🪪</span>
          <span class="ch-section-label">Agent Validation</span>
          <span id="ch-badge-agent" class="ch-section-status" style="display:none;"></span>
          <span class="ch-section-spacer"></span>
          <button class="ch-toggle" data-section-toggle="#ch-agent-body">▾</button>
        </div>
        <div id="ch-agent-body" class="ch-section-body">
          <div id="ch-agent-content"><!-- populated --></div>
        </div>
      </div>

      <!-- D. Similar Homes (moved after Agent Validation) -->
      <div class="ch-section">
        <div class="ch-section-header">
          <span class="ch-section-icon">🏘</span>
          <span class="ch-section-label">Similar Homes</span>
          <span id="ch-badge-comps" class="ch-section-status" style="display:none;"></span>
          <span class="ch-section-spacer"></span>
          <button class="ch-toggle" data-section-toggle="#ch-comps-body">▾</button>
        </div>
        <div id="ch-comps-body" class="ch-section-body">
          <div id="ch-comps-content"><!-- populated --></div>
        </div>
      </div>

      <!-- E. Print -->
      <div class="ch-print-bar">
        <button id="ch-print-btn" class="ch-print-btn">🖨 Print / Save PDF</button>
        <button id="ch-downloadlogs-btn" class="ch-print-btn ch-downloadlogs-btn">📥 Download Logs</button>
      </div>

      <!-- E. FSBO Section (conditional) -->
      <div id="ch-fsbo-section" class="ch-section ch-fsbo-section collapsed" style="display:none;">
        <div class="ch-section-header">
          <span class="ch-section-icon">🏡</span>
          <span class="ch-section-label">Seller Guidance</span>
          <span class="ch-section-spacer"></span>
          <button class="ch-toggle" id="ch-fsbo-toggle">▾</button>
        </div>
        <div id="ch-fsbo-body" class="ch-section-body">
          <div id="ch-fsbo-content"><!-- populated --></div>
        </div>
      </div>

    </div>

    <div id="ch-error" class="ch-error" style="display:none;">
      <span class="ch-error-icon">⚡</span>
      <span id="ch-error-msg">Analysis failed.</span>
    </div>

    <div id="ch-no-key" class="ch-no-key" style="display:none;">
      <div class="ch-no-key-icon">🔑</div>
      <div class="ch-no-key-text">Add your API key in<br>Clear Home settings to activate.</div>
      <div class="ch-no-key-hint">Click the extension icon → Settings</div>
    </div>

    <!-- Legal Disclaimers -->
    <div class="ch-legal">
      <p>This analysis is generated with the assistance of AI and is provided for informational purposes only. It does not constitute a binding contract, professional appraisal, legal advice, or financial recommendation. All estimates, valuations, and projections are approximations based on publicly available data and may contain errors or omissions.</p>
      <p>Due diligence, verification of all facts, and final purchase decisions are the sole responsibility of the buyer and their licensed real estate agent, attorney, or financial advisor.</p>
    </div>

  `;
}

function setBadge(shadow, id, text, variant) {
  const el = shadow.querySelector(id);
  if (!el || !text) return;
  el.textContent = text;
  el.className = `ch-section-status ch-section-status--${variant}`;
  el.style.display = '';
}

function populatePanel(result, listingData) {
  const shadow = chPanelRoot;
  if (!shadow) return;

  chLastResult = result;
  chLastScraped = listingData;
  try {
    if (result?._diag) {
      if (result._diag.fairValueClampFired) {
        chLog('fairvalue_clamped', result._diag.fairValueClampInputs);
      }
      if (result._diag.jsonRecovery) {
        chLog('json_recovery', { method: result._diag.jsonRecovery });
      }
      if (result._diag.tax) chLog('tax_basis', result._diag.tax);
      if (result._diag.offer) chLog('offer_breakdown', result._diag.offer);
    }
  } catch (e) {}
  try {
    chLog('analysis_rendered', {
      mode: listingData.listingMode || 'buy',
      url: location.href,
      list: listingData.price,
      offer: result?.buyerOpportunity?.suggestedOffer,
      fairValue: result?.buyerOpportunity?.fairValue,
      offerStrategy: result?.buyerOpportunity?.offerStrategy,
      valuationLow: result?.valuation?.low,
      valuationHigh: result?.valuation?.high,
      taxAfterReset: result?.taxEstimate?.estimatedAfterReset,
      taxRateUsed: result?.taxEstimate?.rateUsed,
    });
  } catch (e) {}

  const mode = listingData.listingMode || 'buy';
  shadow.querySelector('#ch-results').style.display = 'block';

  if (mode === 'sold') { populateSoldPanel(result, listingData, shadow); return; }
  if (mode === 'rent') { populateRentPanel(result, listingData, shadow); return; }

  const val = result.valuation;
  const tax = result.taxEstimate;
  const afford = result.affordability;
  const macro = result.macroAppreciation;
  const pha = result.priceHistoryAnalysis;
  const agv = result.agentValidation;
  const ca  = result.comparableAnalysis;
  const opp = result.buyerOpportunity;

  const ppsqVerdict = result.pricePerSqft?.verdict || '';
  const priceVariant = { 'Below Market': 'under', 'At Market': 'fair', 'Above Market': 'over', 'Well Overpriced': 'over' }[ppsqVerdict]
    || { 'Overpriced': 'over', 'Well Overpriced': 'over', 'Underpriced': 'under', 'Fair Value': 'fair' }[val?.status] || 'neutral';
  setBadge(shadow, '#ch-badge-price', ppsqVerdict || val?.status || '', priceVariant);

  if (tax) {
    const offerBasis = result.buyerOpportunity?.suggestedOffer || listingData.price || 0;
    const rateBasis = tax.rateUsed > 0 ? tax.rateUsed : 0.0165;
    const exemptionBasis = tax.exemptionTotal || 0;
    if (offerBasis > 0) {
      tax.estAssessed = Math.max(0, offerBasis - exemptionBasis);
      tax.estimatedAfterReset = Math.round(tax.estAssessed * rateBasis);
      tax.estimatedMonthly = Math.round(tax.estimatedAfterReset / 12);
      tax.taxWillIncrease = tax.currentAnnual > 0 && tax.estimatedAfterReset > tax.currentAnnual;
      tax.taxWillStayFlat = tax.currentAnnual > 0 && tax.estimatedAfterReset <= tax.currentAnnual;
      tax.increaseWarning = tax.taxWillIncrease;
    }
    if (tax.taxWillIncrease)   setBadge(shadow, '#ch-badge-tax', 'Tax Increase Expected', 'warn');
    else if (tax.taxWillStayFlat) setBadge(shadow, '#ch-badge-tax', 'Taxes Stay Flat', 'ok');
  }

  const hadPriorListing = pha?.flags?.some(f => /fail|did not sell|expired|withdrawn|reduced|relisted/i.test(f));
  if (hadPriorListing)       setBadge(shadow, '#ch-badge-history', 'Prior Listing ↓', 'good');
  else if (pha?.flags?.length) setBadge(shadow, '#ch-badge-history', 'Flags', 'warn');

  const compsBadgeMap = { 'Highest': 'over', 'Above Average': 'over', 'Average': 'fair', 'Below Average': 'under', 'Lowest': 'under' };
  if (ca?.pricePosition) setBadge(shadow, '#ch-badge-comps', ca.pricePosition, compsBadgeMap[ca.pricePosition] || 'neutral');

  const affordVariant = { 'Affordable': 'ok', 'Borderline': 'warn', 'Stretched': 'over', 'Unknown': 'neutral' }[afford?.verdict] || 'neutral';
  if (afford?.verdict) setBadge(shadow, '#ch-badge-afford', afford.verdict, affordVariant);

  if (macro?.excessOverMarket !== null && macro?.excessOverMarket !== undefined) {
    if (macro.excessOverMarket > 5)       setBadge(shadow, '#ch-badge-macro', `+${macro.excessOverMarket}% vs Market`, 'over');
    else if (macro.excessOverMarket < -3) setBadge(shadow, '#ch-badge-macro', 'Below Market', 'under');
    else                                   setBadge(shadow, '#ch-badge-macro', 'At Market', 'fair');
  }

  const highRisks  = (result.risks || []).filter(r => r.severity === 'high').length;
  const medRisks   = (result.risks || []).filter(r => r.severity === 'medium').length;
  if (highRisks > 0)      setBadge(shadow, '#ch-badge-risks', `${highRisks} High`, 'over');
  else if (medRisks > 0)  setBadge(shadow, '#ch-badge-risks', `${medRisks} Medium`, 'warn');
  else if ((result.risks || []).length > 0) setBadge(shadow, '#ch-badge-risks', 'Low Risk', 'ok');

  if (listingData.isFSBO) {
    setBadge(shadow, '#ch-badge-agent', 'FSBO', 'warn');
  } else if (agv?.licenseStatus) {
    if (agv.licenseStatus === 'Active' && !agv.concerns) {
      setBadge(shadow, '#ch-badge-agent', 'No Concerns', 'ok');
    } else if (agv.licenseStatus === 'Active' && agv.concerns) {
      setBadge(shadow, '#ch-badge-agent', 'Concerns Found', 'warn');
    } else if (agv.licenseStatus === 'Inactive') {
      setBadge(shadow, '#ch-badge-agent', 'Inactive License', 'over');
    } else {
      setBadge(shadow, '#ch-badge-agent', agv.licenseStatus, 'warn');
    }
  }

  const tldrEl   = shadow.querySelector('#ch-tldr-text');
  const tldrWrap = shadow.querySelector('#ch-tldr');
  const analyzingBadge = shadow.querySelector('#ch-analyzing-badge');
  if (analyzingBadge) analyzingBadge.style.display = 'none';

  const priceEl = shadow.querySelector('#ch-prop-price-val');
  if (priceEl && (!priceEl.textContent || priceEl.textContent.trim() === '')) {
    const bestPrice = listingData.price ||
      (result.valuation?.low && result.valuation?.high
        ? Math.round((result.valuation.low + result.valuation.high) / 2) : 0);
    if (bestPrice > 0) priceEl.textContent = '$' + Number(bestPrice).toLocaleString();
  }

  if (tldrEl && result.oneLineSummary) {
    tldrEl.textContent = result.oneLineSummary;
    if (tldrWrap) {
      tldrWrap.style.display = 'block';
      if (val?.status === 'Overpriced' || val?.status === 'Well Overpriced') tldrWrap.classList.add('ch-tldr--over');
      else if (val?.status === 'Underpriced')  tldrWrap.classList.add('ch-tldr--under');
      else                                     tldrWrap.classList.add('ch-tldr--fair');
    }
  }

  const highlightsSect = shadow.querySelector('#ch-highlights-section');
  const propMetaEl     = shadow.querySelector('#ch-prop-meta-strip');
  const highlightsEl   = shadow.querySelector('#ch-highlights-content');

  if (highlightsSect) highlightsSect.style.display = '';

  if (propMetaEl) {
    const sqft    = listingData.sqft    || listingData.livingArea || 0;
    const beds    = listingData.beds    || listingData.bedrooms   || 0;
    let baths     = listingData.baths   || listingData.bathrooms  || 0;
    if (baths > 10) {
      const str = String(baths);
      if (/^(\d)(\d)$/.test(str)) {
        const m = str.match(/^(\d)(\d)$/);
        const full = parseInt(m[1], 10);
        const halfMaybe = parseInt(m[2], 10);
        if (full >= 1 && full <= 9 && halfMaybe >= 1 && halfMaybe <= 4) baths = full + 0.5;
        else baths = 0;
      } else baths = 0;
    }

    const lotRaw  = listingData.lotSize || listingData.lotSqft || '';
    let lotDisplay = '';
    let lotSqftNum = 0;
    if (lotRaw) {
      const lotStr = String(lotRaw).toLowerCase();
      const acresM = lotStr.match(/([\d,.]+)\s*acres?/);
      const sqftM  = lotStr.match(/([\d,.]+)\s*(?:sq\s*ft|sqft)/);
      const numOnly = lotStr.match(/^[\d,.]+$/);
      if (acresM)      { lotSqftNum = parseFloat(acresM[1].replace(/,/g,'')) * 43560; lotDisplay = parseFloat(acresM[1].replace(/,/g,'')).toFixed(2) + ' ac'; }
      else if (sqftM)  { lotSqftNum = parseInt(sqftM[1].replace(/,/g,'')) || 0; lotDisplay = Number(lotSqftNum).toLocaleString() + ' sqft'; }
      else if (numOnly){ lotSqftNum = parseInt(lotStr.replace(/,/g,'')) || 0; lotDisplay = lotSqftNum >= 43560 ? (lotSqftNum/43560).toFixed(2)+' ac' : Number(lotSqftNum).toLocaleString()+' sqft'; }
    }
    const showLot = lotSqftNum > 0 && lotSqftNum <= 500000 && !isNaN(lotSqftNum);
    const hoa     = listingData.hoaFee  || listingData.monthlyHoa || 0;
    const price   = listingData.price   || 0;
    const ppsqft  = sqft > 0 && price > 0 ? Math.round(price / sqft) : 0;

    const coreStats = [
      beds    ? `<span class="ch-meta-chip"><strong>${beds}</strong> bd</span>` : '',
      baths   ? `<span class="ch-meta-chip"><strong>${baths}</strong> ba</span>` : '',
      sqft    ? `<span class="ch-meta-chip"><strong>${Number(sqft).toLocaleString()}</strong> sqft</span>` : '',
      ppsqft  ? `<span class="ch-meta-chip"><strong>$${ppsqft}</strong>/sqft</span>` : '',
    ].filter(Boolean);

    const lotHoaParts = [
      showLot ? `<span class="ch-meta-chip"><strong>${lotDisplay}</strong> lot</span>` : '',
      hoa     ? `<span class="ch-meta-chip"><strong>$${Number(hoa).toLocaleString()}</strong>/mo HOA</span>` : '',
    ].filter(Boolean);

    const builderParts = [
      listingData.builderName   ? `<span class="ch-meta-chip"><span class="ch-meta-lbl">Builder:</span> ${listingData.builderName}</span>`  : '',
      listingData.propertyModel ? `<span class="ch-meta-chip"><span class="ch-meta-lbl">Model:</span> ${listingData.propertyModel}</span>`   : '',
      listingData.yearBuilt     ? `<span class="ch-meta-chip"><span class="ch-meta-lbl">Built:</span> ${listingData.yearBuilt}</span>`       : '',
    ].filter(Boolean);

    let metaHtml = '';
    if (builderParts.length)  metaHtml += `<div class="ch-meta-row">${builderParts.join('<span class="ch-meta-sep">·</span>')}</div>`;
    if (coreStats.length)     metaHtml += `<div class="ch-meta-row${builderParts.length ? ' ch-meta-row--stats' : ''}">${coreStats.join('<span class="ch-meta-sep">·</span>')}</div>`;
    if (lotHoaParts.length)   metaHtml += `<div class="ch-meta-row">${lotHoaParts.join('<span class="ch-meta-sep">·</span>')}</div>`;
    propMetaEl.innerHTML = metaHtml;
    if (metaHtml) propMetaEl.style.display = '';
  }

  const highlights = result.keyHighlights || [];
  if (highlightsEl && highlights.length > 0) {
    highlightsEl.innerHTML = `<ul class="ch-highlights-list">${
      highlights.map(h => `<li class="ch-highlight-item">${h.replace(/^[\s*•\-–]+/, '')}</li>`).join('')
    }</ul>`;
  }

  const propInfoBar = shadow.querySelector('#ch-propinfo-bar');
  if (propInfoBar) propInfoBar.style.display = 'none';

  const commuteResults = result._commuteResults || listingData._commuteResults || {};
  const commuteSect    = shadow.querySelector('#ch-commute-section');
  const commuteEl      = shadow.querySelector('#ch-commute-content');
  const commuteEntries = Object.values(commuteResults);
  if (commuteSect && commuteEl && commuteEntries.length > 0) {
    commuteSect.style.display = '';
    commuteEl.innerHTML = `<div class="ch-commute-list">${
      commuteEntries.map(c => `
        <div class="ch-commute-row">
          <span class="ch-commute-label">${c.label}</span>
          <span class="ch-commute-time">${c.minutes} min</span>
          <span class="ch-commute-dist">${c.distanceMiles} mi</span>
        </div>`).join('')
    }</div>`;
  }

  const ppsq    = result.pricePerSqft;
  const premium = result.premiumAnalysis;

  const valEl = shadow.querySelector('#ch-valuation-content');
  if (valEl) valEl.innerHTML = `
    <div class="ch-valuation-row">
      <div class="ch-val-label">Fair Price Range</div>
      <div class="ch-val-range">$${(val?.low || 0).toLocaleString()} – $${(val?.high || 0).toLocaleString()}</div>
    </div>
    ${ppsq ? `<div class="ch-ppsq-row">
      <span class="ch-ppsq-label">Price/sqft</span>
      <span class="ch-ppsq-val" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">$${ppsq.listed || '—'} listed${ppsq.premiumAdjusted ? ` · <strong style="color:var(--green-text,#1a7a42);">$${ppsq.premiumAdjusted} Clear Home offer</strong>` : ''}</span>
    </div>` : ''}
    ${premium?.explanation ? `<div class="ch-rationale" style="border-left-color:var(--accent);margin-top:6px;">🏆 ${premium.explanation}</div>` : (val?.rationale ? `<div class="ch-rationale" style="margin-top:6px;">${val.rationale}</div>` : '')}
  `;

  if (tax) {
    const _offer = result.buyerOpportunity?.suggestedOffer || listingData.price || 0;
    const _rate  = (tax.rateUsed > 0) ? tax.rateUsed : 0.0165;
    const _exempt = tax.exemptionTotal || 0;
    if (_offer > 0) {
      tax.estAssessed        = Math.max(0, _offer - _exempt);
      tax.estimatedAfterReset = Math.round(tax.estAssessed * _rate);
      tax.estimatedMonthly    = Math.round(tax.estimatedAfterReset / 12);
    }
    const warningClass = tax.increaseWarning ? 'ch-tax--warning' : '';
    const taxEl = shadow.querySelector('#ch-tax-content');
    if (taxEl) taxEl.innerHTML = `
      <div class="ch-tax-row ch-tax-row--arrow">
        <div class="ch-tax-col">
          <div class="ch-tax-label">Current Annual</div>
          <div class="ch-tax-val">${tax.currentAnnual > 0 ? '$' + Number(tax.currentAnnual).toLocaleString() : '—'}${tax.currentAnnual > 0 ? ` <span class="ch-tax-permo">~$${Math.round(tax.currentAnnual/12).toLocaleString()}/mo</span>` : ''}</div>
          ${tax.assessedValue ? `<div class="ch-tax-sub">Assessed: $${Number(tax.assessedValue).toLocaleString()}</div>` : ''}
        </div>
        <div class="ch-tax-arrow">→</div>
        <div class="ch-tax-col">
          <div class="ch-tax-label">Est. After Reset</div>
          <div class="ch-tax-val ${warningClass}">${tax.estimatedAfterReset > 0 ? '$' + Number(tax.estimatedAfterReset).toLocaleString() : '—'}${tax.estimatedMonthly ? ` <span class="ch-tax-permo">~$${Number(tax.estimatedMonthly).toLocaleString()}/mo</span>` : ''}</div>
          ${tax.estAssessed ? `<div class="ch-tax-sub">Est. Assessed: $${Number(tax.estAssessed).toLocaleString()}</div>` : ''}
        </div>
      </div>
      ${tax.exemptionTotal > 0 ? `<div class="ch-confidence" style="margin-top:5px;font-style:italic;">Applied at the Clear Home offer price, minus $${Number(tax.exemptionTotal).toLocaleString()} in exemptions (homestead + transfer). Current Annual reflects the seller's existing bill; Est. After Reset projects your bill as the new owner.</div>` : `<div class="ch-confidence" style="margin-top:5px;font-style:italic;">Applied at the Clear Home offer price. Current Annual reflects the seller's existing bill; Est. After Reset projects your bill as the new owner.</div>`}
      ${tax.assessedValue && listingData.taxAssessedValueListing && Math.abs(tax.assessedValue - listingData.taxAssessedValueListing) > 5000 ? `
      <div class="ch-confidence" style="margin-top:5px;font-style:italic;">
        County just value: $${Number(tax.assessedValue).toLocaleString()} (public record) vs Zillow assessed: $${Number(listingData.taxAssessedValueListing).toLocaleString()} — difference reflects seller's Save Our Homes cap. Reset uses county figure.
      </div>` : ''}
      ${tax.taxDataConflict ? `<div class="ch-tax-warn-badge">⚠ Listing sheet tax differs from public record</div>` : ''}
      ${tax.listingSheetAnnual && tax.taxDataConflict ? `<div class="ch-rationale">Listing says $${Number(tax.listingSheetAnnual).toLocaleString()}/yr — verify with county.</div>` : ''}
      ${tax.note ? `<div class="ch-rationale">${tax.note}</div>` : ''}
    `;
  } else {
    const taxElFallback = shadow.querySelector('#ch-tax-content');
    if (taxElFallback) taxElFallback.innerHTML = '<div class="ch-empty-state">Tax data not available.</div>';
  }

  const phaEl = shadow.querySelector('#ch-pricehistory-content');
  if (phaEl && pha) {
    const domTrendHtml = pha.domTrend ? (() => {
      const cfg = { accelerating: { icon: '📈', label: 'Days on Market Accelerating', cls: 'over' }, stalling: { icon: '🕐', label: 'Stalling on Market', cls: 'over' }, normal: { icon: '✓', label: 'Normal Pace', cls: 'fair' } }[pha.domTrend] || null;
      if (!cfg) return '';
      return `<span class="ch-section-status ch-section-status--${cfg.cls}" style="display:inline-block;margin-bottom:6px;">${cfg.icon} ${cfg.label}</span>`;
    })() : '';
    const relistHtml = pha.relistDetected ? `<div class="ch-tax-warn-badge" style="margin-bottom:6px;">⚠ Relist detected — property was previously withdrawn</div>` : '';
    phaEl.innerHTML = `
      ${domTrendHtml}${relistHtml}
      ${macro ? `<div class="ch-tax-row ch-tax-row--arrow"><div class="ch-tax-col"><div class="ch-tax-label">FHFA Estimate</div><div class="ch-tax-val">${macro.orlandoMsaExpectedPct != null ? (macro.orlandoMsaExpectedPct > 0 ? '+' : '') + Number(macro.orlandoMsaExpectedPct).toFixed(1) + '%' : '?%'}</div>${macro.orlandoExpectedPrice ? `<div class="ch-tax-sub">→ $${Number(macro.orlandoExpectedPrice).toLocaleString()}</div>` : ''}</div><div class="ch-tax-arrow">vs</div><div class="ch-tax-col"><div class="ch-tax-label">Listed</div><div class="ch-tax-val ${(macro.excessOverMarket ?? 0) > 5 ? 'ch-tax--warning' : ''}">${macro.actualAppreciationPct != null ? (macro.actualAppreciationPct > 0 ? '+' : '') + Number(macro.actualAppreciationPct).toFixed(1) + '%' : '?%'}</div><div class="ch-tax-sub">List: $${Number(listingData.price||0).toLocaleString()}</div></div></div><div class="ch-rationale" style="margin-top:6px;">${(macro.excessOverMarket ?? 0) > 0 ? `<strong style="color:var(--amber);">+${Number(macro.excessOverMarket).toFixed(1)}% above FHFA estimate.</strong> ` : (macro.excessOverMarket ?? 0) < 0 ? `<strong style="color:var(--green);">${Number(macro.excessOverMarket).toFixed(1)}% below FHFA estimate.</strong> ` : ''}${macro.negotiationImplication || macro.interpretation || ''}</div>` : ''}
      ${pha.flags?.length ? `<div style="margin-top:6px;">${pha.flags.map(f => `<div class="ch-risk-explanation" style="color:var(--text-2);margin-bottom:3px;">⚑ ${f}</div>`).join('')}</div>` : ''}
    `;
    if (macro) {
      const excess = macro.excessOverMarket ?? 0;
      setBadge(shadow, '#ch-badge-history',
        excess > 5 ? `+${excess}% above FHFA` : excess < -5 ? `${excess}% below FHFA` : 'On Trend',
        excess > 5 ? 'over' : excess < -5 ? 'under' : 'fair');
    }
  }


  const inspectionBullet = (opp?.points || []).find(p => /inspect|inspection|HVAC|roof|water heater/i.test(p));

  const isInvestmentPriority = (listingData.userProfile?.priorities || []).includes('investment');
  const affordSection = shadow.querySelector('.ch-section:has(#ch-afford-body)') ||
    (() => { 
      return [...shadow.querySelectorAll('.ch-section-label')]
        .find(el => el.textContent.trim() === 'Affordability')?.closest('.ch-section');
    })();

  const affordEl = shadow.querySelector('#ch-afford-content');

  if (isInvestmentPriority && result.investorCashFlow) {
    const icf = result.investorCashFlow;
    const cfNum = icf.monthlyCashFlow !== null && icf.monthlyCashFlow !== undefined ? Number(icf.monthlyCashFlow) : null;
    const cov   = icf.coverageRatio ? Number(icf.coverageRatio) : null;
    const cfVariant = cfNum === null ? 'neutral' : cfNum < 0 ? 'over' : cov >= 1.25 ? 'ok' : 'fair';
    const cfBadge   = cfNum === null ? 'No Rent Data' : (cfNum >= 0 ? '+$' : '-$') + Math.abs(cfNum).toLocaleString() + '/mo';

    const iconEl  = affordSection?.querySelector('.ch-section-icon');
    const labelEl = affordSection?.querySelector('.ch-section-label');
    const badgeEl = affordSection?.querySelector('#ch-badge-afford');
    if (iconEl)  iconEl.textContent  = '🏦';
    if (labelEl) labelEl.textContent = 'Investor Cash Flow';
    if (badgeEl) { badgeEl.textContent = cfBadge; badgeEl.className = `ch-section-status ch-section-status--${cfVariant}`; badgeEl.style.display = ''; }

    if (affordEl) affordEl.innerHTML = `
      <div class="ch-tax-row">
        ${icf.purchasePrice ? `<div class="ch-tax-col"><div class="ch-tax-label">Purchase Price</div><div class="ch-tax-val">$${Number(icf.purchasePrice).toLocaleString()}</div></div>` : ''}
        ${icf.estimatedMortgage ? `<div class="ch-tax-col"><div class="ch-tax-label">P&I (${icf.investorRate||'—'})</div><div class="ch-tax-val">$${Number(icf.estimatedMortgage).toLocaleString()}/mo</div></div>` : ''}
        ${icf.estimatedTotalOwnerCost ? `<div class="ch-tax-col"><div class="ch-tax-label">All-In Cost</div><div class="ch-tax-val">$${Number(icf.estimatedTotalOwnerCost).toLocaleString()}/mo</div></div>` : ''}
        ${icf.rentZestimate ? `<div class="ch-tax-col"><div class="ch-tax-label">Rent Zestimate</div><div class="ch-tax-val">$${Number(icf.rentZestimate).toLocaleString()}/mo</div></div>` : ''}
      </div>
      <div class="ch-piti-total" style="margin-top:6px;${cfNum !== null && cfNum < 0 ? 'color:var(--red-text,#c0392b);' : ''}">
        <span>Net Cash Flow</span>
        <span>${cfNum !== null ? (cfNum >= 0 ? '+$' : '-$') + Math.abs(cfNum).toLocaleString() + '/mo' : '—'}${cov ? ' (' + cov.toFixed(2) + 'x)' : ''}</span>
      </div>
      <div class="ch-tax-row" style="margin-top:6px;">
        ${icf.breakEvenRent ? `<div class="ch-tax-col"><div class="ch-tax-label">Break-Even (1.0x)</div><div class="ch-tax-val">$${Number(icf.breakEvenRent).toLocaleString()}/mo</div></div>` : ''}
        ${icf.viableRent ? `<div class="ch-tax-col"><div class="ch-tax-label">Healthy Return (1.25x)</div><div class="ch-tax-val">$${Number(icf.viableRent).toLocaleString()}/mo</div></div>` : ''}
      </div>
      <div class="ch-tax-sub" style="margin-top:4px;">25% down · ${icf.investorRate||'—'} · fed funds + 2.75% spread</div>
      ${icf.investmentNote ? `<div class="ch-rationale" style="margin-top:6px;">${icf.investmentNote}</div>` : ''}
    `;
  } else if (affordEl && afford) {
    const takehome   = result._monthlyTakehome || 0;
    const debts      = afford.monthlyDebts || (listingData.userProfile?.monthlyDebts) || 0;
    const discretionary = listingData.userProfile?.monthlyDiscretionary || 0;

    const userUtil   = listingData.userProfile?.monthlyUtilities || 0;
    const sqftNum    = parseFloat((listingData.sqft||'').toString().replace(/[^0-9.]/g,'')) || 0;
    const stories    = listingData.stories || 1;
    const utilRate   = (1.50 + (stories > 1 ? 0.30 : 0)) / 12;
    const utilEst    = userUtil > 0 ? userUtil : (sqftNum > 0 ? Math.round(sqftNum * utilRate) : 0);

    const insPctAnnual = listingData.userProfile?.insurancePct || 0;

    const calcPITIBreakdown = (price, rateOverride) => {
      const dp   = afford.downPaymentPct || 20;
      const loan = price * (1 - dp/100);
      const r    = (rateOverride || afford.mortgageRatePct || 7) / 100 / 12;
      const n    = 360;
      const pi   = r > 0 ? Math.round(loan * (r * Math.pow(1+r,n)) / (Math.pow(1+r,n)-1)) : Math.round(loan/n);
      const taxRate    = (result.taxEstimate?.rateUsed > 0) ? result.taxEstimate.rateUsed : 0.0165;
      const exemption  = result.taxEstimate?.exemptionTotal || 0;
      const taxable    = Math.max(0, price - exemption);
      const tax  = Math.round(taxable * taxRate / 12);
      const ins  = insPctAnnual > 0 ? Math.round(price * (insPctAnnual / 100) / 12) : (afford.monthlyInsurance || 150);
      const hoa  = afford.monthlyHoa || 0;
      return { pi, tax, ins, hoa, total: pi + tax + ins + hoa };
    };
    const calcPITI = (price) => calcPITIBreakdown(price).total;

    const listPrice  = listingData.price || 0;
    const offerPrice = result.buyerOpportunity?.suggestedOffer || listPrice;
    const barPrice   = offerPrice > 0 ? offerPrice : listPrice;
    const barBreak   = calcPITIBreakdown(barPrice);
    const piPay      = barBreak.pi;
    const mTax       = barBreak.tax;
    const mIns       = barBreak.ins;
    const mHoa       = barBreak.hoa;
    const totalCost  = piPay + mTax + mIns + mHoa + utilEst + debts + discretionary;
    const remaining  = takehome > 0 ? takehome - totalCost : 0;
    const denominator = takehome > 0 ? takehome : totalCost;

    const seg = (v) => Math.max(Math.round(v / denominator * 100), v > 0 ? 1 : 0);
    const segments = [
      { label: 'P&I',     val: piPay,   pct: seg(piPay),   color: '#5b8def' },
      { label: 'Tax',     val: mTax,    pct: seg(mTax),    color: '#e67e22' },
      { label: 'Ins',     val: mIns,    pct: seg(mIns),    color: '#9b59b6' },
      mHoa > 0 ? { label: 'HOA', val: mHoa, pct: seg(mHoa), color: '#e74c3c' } : null,
      utilEst > 0 ? { label: 'Util', val: utilEst, pct: seg(utilEst), color: '#1abc9c' } : null,
      debts > 0 ? { label: 'Debts', val: debts, pct: seg(debts), color: '#95a5a6' } : null,
      discretionary > 0 ? { label: 'Disc.', val: discretionary, pct: seg(discretionary), color: '#7f8c8d' } : null,
    ].filter(Boolean);

    const remainPct = takehome > 0 ? Math.max(100 - segments.reduce((s,x) => s + x.pct, 0), 0) : 0;
    const isShort = remaining < 0;

    const barSegments = segments.map(s =>
      `<div style="width:${s.pct}%;background:${s.color};height:100%;display:inline-block;" title="${s.label}: $${s.val.toLocaleString()}"></div>`
    ).join('');

    const legendItems = segments.map(s =>
      `<span class="ch-afford-legend-item"><span class="ch-afford-legend-dot" style="background:${s.color};"></span>${s.label} $${s.val.toLocaleString()}</span>`
    ).join('');

    let unaffordMsg = '';
    if (takehome > 0 && isShort) {
      const availForPITI = takehome - debts - discretionary - utilEst;
      const pitiPerDollar = barPrice > 0 ? calcPITI(barPrice) / barPrice : 0;
      const maxPrice = (availForPITI > 0 && pitiPerDollar > 0)
        ? Math.round(availForPITI / pitiPerDollar / 1000) * 1000
        : 0;
      const annualSalary = listingData.userProfile?.annualIncome || 0;
      const salaryToTakehomeRatio = (annualSalary > 0 && takehome > 0) ? annualSalary / (takehome * 12) : 0;
      const monthlyShortfall = Math.abs(remaining);
      const annualSalaryIncrease = salaryToTakehomeRatio > 0 ? Math.round(monthlyShortfall * 12 * salaryToTakehomeRatio) : 0;

      unaffordMsg = `<div class="ch-afford-unaffordable">
        <strong>⚠ Offer strains budget.</strong>
        ${maxPrice > 0 && maxPrice < barPrice ? ` Look for homes under <strong>$${maxPrice.toLocaleString()}</strong>.` : ''}
        ${monthlyShortfall > 0 ? ` Increase take-home by <strong>$${monthlyShortfall.toLocaleString()}/mo</strong>${annualSalaryIncrease > 0 ? ` (approx. <strong>$${annualSalaryIncrease.toLocaleString()}</strong> annual salary increase)` : ''}.` : ''}
      </div>`;
    }

    const fairHigh = result.valuation?.high || 0;
    const fairLow  = result.valuation?.low  || 0;
    const marketBottom = result.buyerOpportunity?.fairValue || result.buyerOpportunity?.marketBottom || 0;
    const aggressivenessPct = result.buyerOpportunity?.aggressivenessPct || 0;
    const startingRate = Number(afford.mortgageRatePct || 7);
    const rateMin = Math.max(2, Math.floor((startingRate - 1.5) * 8) / 8);
    const rateMax = Math.min(15, Math.ceil((startingRate + 1.5) * 8) / 8);
    const rateLabHtml = `<div class="ch-sens-wrap" style="margin-top:8px;">
      <div class="ch-sens-title" style="display:flex;justify-content:space-between;gap:8px;">
        <span>Mortgage Rate Lab</span><strong id="ch-rate-lab-label">${startingRate.toFixed(3)}%</strong>
      </div>
      <input id="ch-rate-lab" type="range" min="${rateMin}" max="${rateMax}" step="0.125" value="${startingRate}" style="width:100%;accent-color:var(--accent,#4F6BFF);">
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-3);margin-top:3px;">
        <span>PITI <strong id="ch-rate-lab-piti">$${barBreak.total.toLocaleString()}/mo</strong></span>
        <span id="ch-rate-lab-left" class="${remaining < 0 ? 'ch-afford-neg' : 'ch-afford-pos'}">${remaining < 0 ? '-' : '+'}$${Math.abs(remaining).toLocaleString()} left</span>
      </div>
    </div>`;

    const rawScenarios = [
      offerPrice > 0 ? { label: 'Clear Home offer', price: offerPrice, color: 'var(--green-text, #1a7a42)' } : null,
      marketBottom > 0 && Math.abs(marketBottom - offerPrice) > 1000 ? { label: 'Est. market bottom', price: marketBottom, color: 'var(--accent, #4F6BFF)' } : null,
      fairLow > 0 && fairLow !== offerPrice && fairLow !== marketBottom ? { label: 'Fair value range (low)',  price: fairLow,  color: 'var(--accent, #4F6BFF)' } : null,
      fairHigh > 0 && fairHigh !== listPrice && fairHigh !== offerPrice && fairHigh !== marketBottom ? { label: 'Fair value range (high)', price: fairHigh, color: 'var(--accent, #4F6BFF)' } : null,
      listPrice > 0 ? { label: 'List price', price: listPrice, color: 'var(--amber-text, #b35e0a)' } : null,
    ].filter(Boolean);
    const scenarios = rawScenarios.sort((a, b) => a.price - b.price);

    let sensitivityHtml = '';
    if (scenarios.length > 1 && takehome > 0) {
      const rows = scenarios.map(s => {
        const scenPITI = calcPITI(s.price);
        const scenTotal = scenPITI + utilEst + debts + discretionary;
        const scenLeft = takehome - scenTotal;
        const neg = scenLeft < 0;
        return `<tr>
          <td style="color:${s.color};font-weight:600;">${s.label}</td>
          <td class="ch-sens-num">$${Number(s.price).toLocaleString()}</td>
          <td class="ch-sens-num">$${Number(scenPITI).toLocaleString()}</td>
          <td class="ch-sens-num ${neg ? 'ch-afford-neg' : 'ch-afford-pos'}">${neg ? '-' : '+'}$${Math.abs(scenLeft).toLocaleString()}</td>
        </tr>`;
      }).join('');
      sensitivityHtml = `
        <div class="ch-sens-wrap">
          <div class="ch-sens-title">Sensitivity Analysis</div>
          <table class="ch-sens-table">
            <thead>
              <tr>
                <th>Scenario</th>
                <th class="ch-sens-num">Price</th>
                <th class="ch-sens-num">PITI/mo</th>
                <th class="ch-sens-num">Left/mo</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }

    affordEl.innerHTML = `
      ${takehome > 0 ? `
        <div class="ch-afford-header-row">
          <div class="ch-afford-takehome-wrap">
            <span class="ch-tax-label">Monthly take-home</span>
            <span class="ch-afford-takehome-val">$${Number(takehome).toLocaleString()}</span>
          </div>
          <div class="ch-afford-result-wrap ${isShort ? 'ch-afford-neg' : 'ch-afford-pos'}">
            ${isShort ? `$${Math.abs(remaining).toLocaleString()} short/mo` : `$${remaining.toLocaleString()} left/mo`}
          </div>
        </div>` : ''}
      <div class="ch-afford-single-bar">
        <div class="ch-afford-bar-track">
          ${barSegments}
          ${remainPct > 0 ? `<div style="width:${remainPct}%;background:${isShort ? 'var(--red-bg,#fde8e8)' : '#e8f5e9'};height:100%;display:inline-block;" title="Remaining: $${Math.abs(remaining).toLocaleString()}"></div>` : ''}
        </div>
      </div>
      <div class="ch-afford-legend">${legendItems}</div>
      ${rateLabHtml}
      ${sensitivityHtml}
      ${unaffordMsg}
      ${afford.dtiHousingWarning ? `<div class="ch-tax-warn-badge" style="margin-top:5px;">⚠ Housing DTI ${afford.dtiHousingPct}% exceeds 28% guideline</div>` : ''}
      ${afford.dtiTotalDanger ? `<div class="ch-risk ch-risk--high" style="margin-top:5px;"><div class="ch-risk-explanation">⚠ Total DTI ${afford.dtiTotalPct}% hits lending limits (43% max).</div></div>` : ''}
      ${afford.note ? `<div class="ch-rationale" style="margin-top:5px;"><strong>At the Clear Home offer PITI:</strong> ${afford.note}</div>` : ''}
    `;
    chRateLabCtx = { barPrice, takehome, utilEst, debts, discretionary };
  } else if (affordEl) {
    affordEl.innerHTML = '<div class="ch-empty-state">Add your income in settings for DTI analysis.</div>';
  }

  const agvEl = shadow.querySelector('#ch-agent-content');
  const agentPhone = listingData.agentPhone || agv?.phone || '';
  const agentMlsLine = (listingData.mlsId || agentPhone)
    ? `<span class="ch-meta-lbl">MLS#</span> <strong>${listingData.mlsId || 'N/A'}</strong>${agentPhone ? `<span class="ch-meta-lbl" style="margin-left:12px;">☎</span> <strong>${agentPhone}</strong>` : ''}`
    : '';
  if (listingData.isFSBO) {
    setBadge(shadow, '#ch-badge-agent', 'FSBO', 'warn');
    if (agvEl) agvEl.innerHTML = `
      ${agentMlsLine ? `<div class="ch-agent-line">${agentMlsLine}</div>` : ''}
      <div class="ch-one-liner" style="border-left-color:var(--amber);margin-bottom:6px;">For Sale By Owner. Engage a buyer's agent or real estate attorney.</div>
    `;
  } else if (agvEl && agv) {
    const renewBadge = agv.renewalStatus && agv.renewalStatus !== 'Current'
      ? `<span class="ch-risk-badge ch-risk-badge--high" style="margin-left:6px;">${agv.renewalStatus}</span>` : '';
    const employer = agv.employerOnFile || '';
    const licLine = agv.licenseNumber
      ? ` · <span class="ch-meta-lbl">License</span> ${agv.licenseNumber} (FL DBPR)${agv.expiry ? `, exp ${agv.expiry}` : ''}${employer ? ` · ${employer}` : ''}`
      : '';
    const licNum = agv.licenseNumber || '';
    let recText = (agv.recommendation || '')
      .replace(new RegExp(licNum.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '')
      .replace(/License\s*#?\s*\d+/gi, '')
      .replace(/no concerns?\s*(found)?/gi, '')
      .replace(/proceed normally/gi, '')
      .replace(/no further verification.*?required/gi, '')
      .replace(/is active,?\s*current/gi, 'active')
      .replace(/on file with/gi, 'with')
      .replace(/under the FL DBPR/gi, '')
      .replace(/\(SL[\s-]*(?:Sales Associate)?\)/gi, '')
      .replace(/\(Sales Associate,?\s*FL DBPR\)/gi, '')
      .replace(/\(SL-?\)/gi, '')
      .replace(/SL Sales Associate/gi, 'Sales Associate')
      .replace(/holds an active Florida Sales Associate license/gi, 'holds an active Sales Associate license')
      .replace(/in FL DBPR records?/gi, '')
      .replace(/with in /gi, 'with ')
      .replace(/\s*[—–]\s*/g, ', ')
      .replace(/;\s*and\s*/g, '; ')
      .replace(/,\s*,/g, ',')
      .replace(/\.\s*\./g, '.')
      .replace(/\s+/g, ' ')
      .replace(/^\s*[,.\s;]+/, '')
      .trim();
    if (recText.length < 10) recText = '';
    agvEl.innerHTML = `
      <div class="ch-agent-line"><strong>${agv.name || '—'}</strong>${agv.brokerage ? ` · ${agv.brokerage}` : ''}${agentPhone ? ` · ${agentPhone}` : ''}${renewBadge}</div>
      <div class="ch-agent-line">${agentMlsLine}${licLine}</div>
      ${agv.concerns ? `<div class="ch-risk ch-risk--medium" style="margin-top:4px;"><div class="ch-risk-explanation">⚠ ${agv.concerns}</div></div>` : ''}
      ${recText ? `<div class="ch-rationale" style="margin-top:4px;">${recText}</div>` : ''}
    `;
  } else if (agvEl) {
    agvEl.innerHTML = `
      <div class="ch-agent-line"><strong>${listingData.agentName || '—'}</strong>${listingData.brokerageName ? ` · ${listingData.brokerageName}` : ''}${agentPhone ? ` · ${agentPhone}` : ''}</div>
      ${agentMlsLine ? `<div class="ch-agent-line">${agentMlsLine}</div>` : ''}
      <div class="ch-confidence" style="margin-top:4px;font-style:italic;">License verification available for FL agents via DBPR.</div>
    `;
  }

  const caEl = shadow.querySelector('#ch-comps-content');
  if (caEl) {
    const allComps  = listingData.nearbyHomes || [];
    const subPrice  = listingData.price || 0;
    const subSqft   = parseFloat((listingData.sqft || '').toString().replace(/[^0-9.]/g, '')) || 0;
    const subPpsq   = (subPrice > 0 && subSqft > 0) ? Math.round(subPrice / subSqft) : null;

    const parseBeds  = v => parseInt((v || '0').toString().replace(/[^0-9]/g,'')) || 0;
    const parseBaths = v => parseFloat((v || '0').toString().replace(/[^0-9.]/g,'')) || 0;
    const subBedsN   = parseBeds(listingData.beds || listingData.bedrooms);
    const subBathsN  = parseBaths(listingData.baths || listingData.bathrooms);

    const comps = subBedsN > 0
      ? allComps.filter(h => parseBeds(h.beds) === subBedsN)
      : allComps;

    const compBoxes = comps.map(h => {
      const pNum = h.priceNum || parseInt((h.price||'').replace(/[^0-9]/g,''), 10) || 0;
      const sqftStr = (h.sqft||'').toLowerCase().trim();
      const sqftK   = sqftStr.match(/^([\d.]+)k/);
      const sqftPlain = sqftStr.match(/^([\d,]+)\s*sqft/);
      const sqftNum  = sqftK ? Math.round(parseFloat(sqftK[1]) * 1000)
                    : sqftPlain ? parseInt(sqftPlain[1].replace(/,/g,''), 10)
                    : 0;
      const ppsq = (pNum > 0 && sqftNum > 0) ? Math.round(pNum / sqftNum) : null;

      const bedsDisplay = h.beds || '';
      const bathsDisplay = h.baths || '';

      let posLabel = '', posClass = '';
      if (ppsq && subPpsq) {
        const diff = Math.round(((subPpsq - ppsq) / ppsq) * 100);
        if (diff > 5)       { posLabel = `Subject +${diff}% above`; posClass = 'over'; }
        else if (diff < -5) { posLabel = `Subject ${diff}% below`;  posClass = 'under'; }
        else                { posLabel = `At market`;               posClass = 'fair'; }
      }

      const addrShort = (h.addr||'').trim();

      const addrSlug = (h.addr || h.address || '').trim()
        .replace(/,/g, '')           
        .replace(/\s+/g, '-')        
        .replace(/[^a-zA-Z0-9-]/g, '') 
        .replace(/-+/g, '-');        
      const compUrl = h.url
        || (h.zpid ? `https://www.zillow.com/homedetails/${addrSlug}/${h.zpid}_zpid/` : '')
        || (addrSlug ? `https://www.zillow.com/homes/${addrSlug}_rb/` : '');

      return `<div class="ch-comp-box${compUrl ? ' ch-comp-box--link' : ''}"${compUrl ? ` data-url="${compUrl}"` : ''}>
        <div class="ch-comp-addr">${compUrl ? `<a href="${compUrl}" target="_blank" rel="noopener" class="ch-comp-link">${addrShort}</a>` : addrShort}</div>
        <div class="ch-comp-stats">
          <span class="ch-comp-price">${h.price||'—'}</span>
          <span class="ch-comp-detail">${[bedsDisplay, bathsDisplay, h.sqft].filter(Boolean).join(' · ')}</span>
          ${ppsq ? `<span class="ch-comp-ppsq">~$${ppsq}/sqft</span>` : ''}
        </div>
        ${posLabel ? `<div class="ch-comp-pos ch-comp-pos--${posClass}">${posLabel}</div>` : ''}
      </div>`;
    }).join('');

    const compPpsqs = comps.map(h => {
      const p = h.priceNum || parseInt((h.price||'').replace(/[^0-9]/g,''), 10) || 0;
      const sqftStr = (h.sqft||'').toLowerCase();
      const sqftK = sqftStr.match(/^([\d.]+)k/);
      const sqftNum = sqftK ? Math.round(parseFloat(sqftK[1]) * 1000)
                   : parseInt(sqftStr.replace(/[^0-9]/g,''), 10) || 0;
      return (p > 0 && sqftNum > 0) ? Math.round(p / sqftNum) : 0;
    }).filter(v => v > 0).sort((a,b) => a-b);
    const medianPpsq = compPpsqs.length
      ? compPpsqs[Math.floor(compPpsqs.length / 2)]
      : null;
    if (medianPpsq && subPpsq) {
      const medDiff = Math.round(((subPpsq - medianPpsq) / medianPpsq) * 100);
      const badgeText = medDiff > 5  ? `+${medDiff}% vs comps`
                      : medDiff < -5 ? `${medDiff}% vs comps`
                      : 'At Market';
      const badgeVar  = medDiff > 5 ? 'over' : medDiff < -5 ? 'under' : 'fair';
      setBadge(shadow, '#ch-badge-comps', badgeText, badgeVar);
    }

    if (compBoxes) {
      const boxArr = compBoxes.split(/(?=<div class="ch-comp-box)/).filter(Boolean);
      const first6 = boxArr.slice(0, 6).join('');
      const rest   = boxArr.slice(6).join('');
      caEl.innerHTML = `<div class="ch-comp-grid">${first6}</div>` +
        (rest ? `
          <div id="ch-comp-more" class="ch-comp-grid" style="display:none;">${rest}</div>
          <button class="ch-comp-expand" data-comp-expand data-more="${boxArr.length - 6}">Show ${boxArr.length - 6} more ▾</button>` : '');
    } else {
      const isShowcase = !!(
        document.querySelector('[class*="showcase" i], [data-testid*="showcase" i]') ||
        Array.from(document.querySelectorAll('span, div, p')).find(el =>
          /^showcase$/i.test((el.textContent || '').trim()) && el.offsetParent !== null
        ) ||
        window.__zillow_listing_type === 'showcase'
      );
      caEl.innerHTML = isShowcase
        ? '<div class="ch-empty-state">⭐ Showcase listing — Zillow suppresses the Similar Homes section for these. Comparable analysis unavailable on this page.</div>'
        : '<div class="ch-empty-state">No similar homes found on this page.</div>';
    }
  }

  const risks = result.risks || [];
  if (listingData.hasAiPhotos) {
    const alreadyFlagged = risks.some(r => /AI|virtual stag|photo/i.test(r.title || ''));
    if (!alreadyFlagged) {
      risks.push({
        title: 'AI-Enhanced Photos',
        severity: 'low',
        explanation: 'Listing may include AI-enhanced or virtually staged photos. Request original unedited photos before making an offer to verify actual condition.'
      });
    }
  }
  const highCount = risks.filter(r => r.severity === 'high').length;
  const filteredRisks = risks.filter(r => {
    const combo = ((r.title || '') + ' ' + (r.explanation || '')).toLowerCase();
    return !(/request inspection contingency/i.test(combo) || /ask seller to address high.severity/i.test(combo));
  });
  const risksEl = shadow.querySelector('#ch-risks-content');
  if (risksEl) risksEl.innerHTML = filteredRisks.length > 0
    ? `${filteredRisks.map(r => `
        <div class="ch-risk ch-risk--${r.severity}">
          <div class="ch-risk-header">
            <span class="ch-risk-dot"></span>
            <span class="ch-risk-title">${r.title}</span>
            <span class="ch-risk-badge ch-risk-badge--${r.severity}">${r.severity}</span>
          </div>
          <div class="ch-risk-explanation">${r.explanation}</div>
        </div>`).join('')}`
    : '<div class="ch-empty-state">No significant risks identified.</div>';

  const actionsSection = shadow.querySelector('#ch-actions-section');
  const actions = result.actions || [];
  const filteredActions = actions.filter(a => !/request inspection contingency/i.test(a) && !/ask seller to address/i.test(a));
  if (inspectionBullet) filteredActions.unshift(inspectionBullet.replace(/^[\-–•*▸]\s*/, ''));
  if (actionsSection && filteredActions.length > 0) actionsSection.style.display = '';
  const actionsEl = shadow.querySelector('#ch-actions-content');
  if (actionsEl) actionsEl.innerHTML = filteredActions.length > 0
    ? `<ul class="ch-opp-bullets">${filteredActions.map(a => `<li>${a}</li>`).join('')}</ul>`
    : '';

  const fsboGuidance = result.fsboGuidance;
  if (fsboGuidance && Array.isArray(fsboGuidance) && fsboGuidance.length > 0) {
    const fsboSection = shadow.querySelector('#ch-fsbo-section');
    fsboSection.style.display = 'block';
    fsboSection.classList.remove('collapsed');
    shadow.querySelector('#ch-fsbo-content').innerHTML =
      `<ul class="ch-actions-list">${fsboGuidance.map(a => `<li class="ch-action-item"><span class="ch-action-check">○</span>${a}</li>`).join('')}</ul>`;
  }

}


function populateSoldPanel(result, listingData, shadow) {
  const analyzingBadge = shadow.querySelector('#ch-analyzing-badge');
  if (analyzingBadge) analyzingBadge.style.display = 'none';

  const tldrWrap = shadow.querySelector('#ch-tldr');
  const tldrEl   = shadow.querySelector('#ch-tldr-text');
  if (tldrEl && result.oneLineSummary) {
    tldrEl.textContent = result.oneLineSummary;
    if (tldrWrap) { tldrWrap.style.display = 'block'; tldrWrap.classList.add('ch-tldr--sold'); }
  }

  const priceEl = shadow.querySelector('#ch-prop-price-val');
  if (priceEl) {
    const sp = result.saleSnapshot?.soldPrice || listingData.soldPrice || listingData.price;
    if (sp > 0) priceEl.textContent = (listingData.isOffMarket ? 'Last Sold $' : 'Sold $') + Number(sp).toLocaleString();
  }

  const resultsEl = shadow.querySelector('#ch-results');
  if (!resultsEl) return;

  const ss  = result.saleSnapshot        || {};
  const cv  = result.currentValue        || {};
  const ap  = result.appreciationContext || {};
  const ph  = result.priceNarrative      || {};
  const lj  = result.listingJourney      || {};
  const tx  = result.taxSnapshot         || {};
  const np  = result.neighborhoodPulse   || {};
  const isOffMarket = listingData.isOffMarket || false;

  const infoRow = (label, val) => val
    ? `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:0.5px solid var(--border);font-size:10.5px;line-height:1.4;"><span style="color:var(--text-3);flex-shrink:0;width:85px;">${label}</span><span style="color:var(--text-1);flex:1;text-align:right;">${val}</span></div>` : '';

  resultsEl.innerHTML = `

    <!-- Sale Snapshot -->
    <div class="ch-section">
      <div class="ch-section-header">
        <span class="ch-section-icon">${isOffMarket ? '📌' : '🔒'}</span>
        <span class="ch-section-label">${isOffMarket ? 'Last Sale' : 'Sale Snapshot'}</span>
        ${ss.overUnderAsk !== undefined ? `<span class="ch-section-status ch-section-status--${ss.overUnderAsk > 0 ? 'over' : 'under'}">${ss.overUnderAsk > 0 ? '+' : ''}${ss.overUnderAsk}% vs Ask</span>` : ''}
        <span class="ch-section-spacer"></span>
        <button class="ch-toggle" data-section-toggle="#ch-sold-snap-body">▾</button>
      </div>
      <div id="ch-sold-snap-body" class="ch-section-body">
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:6px;">
          ${ss.soldPrice ? `<div><div class="ch-tax-label">Sold For</div><div class="ch-tax-val">$${Number(ss.soldPrice).toLocaleString()}</div></div>` : ''}
          ${ss.listPrice ? `<div><div class="ch-tax-label">Last Ask</div><div class="ch-tax-val">$${Number(ss.listPrice).toLocaleString()}</div></div>` : ''}
          ${ss.daysToSell != null ? `<div><div class="ch-tax-label">Days to Sell</div><div class="ch-tax-val">${ss.daysToSell}</div></div>` : ''}
          ${ss.daysSinceSale != null ? `<div><div class="ch-tax-label">${isOffMarket ? 'Time Since Sale' : 'Days Since Sale'}</div><div class="ch-tax-val">${ss.daysSinceSale > 365 ? Math.round(ss.daysSinceSale/365*10)/10 + ' yrs' : ss.daysSinceSale + 'd'}</div></div>` : ''}
        </div>
        ${infoRow('Sold', ss.soldDate)}
        ${infoRow('$/sqft', ss.pricePerSqft ? '$' + ss.pricePerSqft : '')}
        ${ss.summary ? `<div class="ch-rationale" style="margin-top:6px;">${ss.summary}</div>` : ''}
      </div>
    </div>

    <!-- Estimated Value Today (for off-market, this is key) -->
    <div class="ch-section">
      <div class="ch-section-header">
        <span class="ch-section-icon">📊</span>
        <span class="ch-section-label">${isOffMarket ? 'Current Estimated Value' : 'Estimated Value Today'}</span>
        ${cv.appreciation !== undefined ? `<span class="ch-section-status ch-section-status--${cv.appreciation >= 0 ? 'ok' : 'over'}">${cv.appreciation >= 0 ? '+' : ''}${cv.appreciation}% since sale</span>` : ''}
        <span class="ch-section-spacer"></span>
        <button class="ch-toggle" data-section-toggle="#ch-sold-value-body">▾</button>
      </div>
      <div id="ch-sold-value-body" class="ch-section-body">
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:4px;">
          ${cv.zestimate ? `<div><div class="ch-tax-label">Zestimate</div><div class="ch-tax-val">$${Number(cv.zestimate).toLocaleString()}</div></div>` : ''}
          ${cv.fhfaImplied ? `<div><div class="ch-tax-label">FHFA Estimate</div><div class="ch-tax-val">$${Number(cv.fhfaImplied).toLocaleString()}</div></div>` : ''}
          ${ss.soldPrice && cv.zestimate ? `<div><div class="ch-tax-label">Equity Change</div><div class="ch-tax-val ${cv.zestimate > ss.soldPrice ? '' : 'ch-tax--warning'}">${cv.zestimate >= ss.soldPrice ? '+' : '-'}$${Math.abs(cv.zestimate - ss.soldPrice).toLocaleString()}</div></div>` : ''}
        </div>
        ${cv.note ? `<div class="ch-rationale" style="margin-top:4px;">${cv.note}</div>` : ''}
      </div>
    </div>

    <!-- Seller Appreciation -->
    <div class="ch-section">
      <div class="ch-section-header">
        <span class="ch-section-icon">📈</span>
        <span class="ch-section-label">${isOffMarket ? 'Appreciation Since Sale' : 'Seller Appreciation'}</span>
        ${ap.vsMarket ? `<span class="ch-section-status ch-section-status--${ap.vsMarket === 'Above' ? 'over' : ap.vsMarket === 'Below' ? 'under' : 'fair'}">${ap.vsMarket} Market</span>` : ''}
        <span class="ch-section-spacer"></span>
        <button class="ch-toggle" data-section-toggle="#ch-sold-appr-body">▾</button>
      </div>
      <div id="ch-sold-appr-body" class="ch-section-body">
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:4px;">
          ${ap.previousPurchasePrice || ap.originalPurchasePrice ? `<div><div class="ch-tax-label">${isOffMarket ? 'Sold For' : 'Bought For'}</div><div class="ch-tax-val">$${Number(ap.previousPurchasePrice || ap.originalPurchasePrice).toLocaleString()}</div></div>` : ''}
          ${ap.sellerAppreciationPct != null || ap.totalAppreciationPct != null ? `<div><div class="ch-tax-label">Total Gain</div><div class="ch-tax-val">${ap.sellerAppreciationPct ?? ap.totalAppreciationPct}%</div></div>` : ''}
          ${ap.fhfaBenchmarkPct != null ? `<div><div class="ch-tax-label">FHFA Benchmark</div><div class="ch-tax-val">${ap.fhfaBenchmarkPct}%</div></div>` : ''}
        </div>
        ${infoRow(isOffMarket ? 'Sale Date' : 'Purchased', ap.previousPurchaseDate || ap.originalPurchaseDate)}
        ${infoRow('Years Held', ap.yearsHeld)}
        ${ap.interpretation ? `<div class="ch-rationale" style="margin-top:4px;">${ap.interpretation}</div>` : ''}
      </div>
    </div>

    <!-- Listing History -->
    ${lj.narrative || lj.daysToSell != null || (Array.isArray(ph.priceChain) && ph.priceChain.length > 0) ? `
    <div class="ch-section">
      <div class="ch-section-header">
        <span class="ch-section-icon">🕐</span>
        <span class="ch-section-label">Listing History</span>
        ${ph.totalListings > 1 ? `<span class="ch-section-status ch-section-status--warn">${ph.totalListings} Listings</span>` : ''}
        <span class="ch-section-spacer"></span>
        <button class="ch-toggle" data-section-toggle="#ch-sold-hist-body">▾</button>
      </div>
      <div id="ch-sold-hist-body" class="ch-section-body">
        ${ph.summary ? `<div class="ch-rationale" style="margin-bottom:6px;">${ph.summary}</div>` : ''}
        ${Array.isArray(ph.priceChain) ? ph.priceChain.map(e =>
          `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;border-bottom:0.5px solid var(--border);font-size:10px;"><span style="color:var(--text-3);flex-shrink:0;width:85px;">${e.date}</span><span style="flex:1;">${e.event}</span><span style="font-weight:600;">$${Number(e.price).toLocaleString()}</span></div>`
        ).join('') : ''}
      </div>
    </div>` : ''}

    <!-- Tax Snapshot -->
    ${tx.currentAnnual ? `
    <div class="ch-section">
      <div class="ch-section-header">
        <span class="ch-section-icon">🏛</span>
        <span class="ch-section-label">Tax Snapshot</span>
        <span class="ch-section-spacer"></span>
        <button class="ch-toggle" data-section-toggle="#ch-sold-tax-body">▾</button>
      </div>
      <div id="ch-sold-tax-body" class="ch-section-body">
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:4px;">
          <div><div class="ch-tax-label">Last Annual Tax</div><div class="ch-tax-val">$${Number(tx.currentAnnual).toLocaleString()}</div></div>
          ${tx.assessedValue ? `<div><div class="ch-tax-label">Assessed</div><div class="ch-tax-val">$${Number(tx.assessedValue).toLocaleString()}</div></div>` : ''}
          ${tx.newOwnerEstimate ? `<div><div class="ch-tax-label">New Owner Est.</div><div class="ch-tax-val">$${Number(tx.newOwnerEstimate).toLocaleString()}/yr</div></div>` : ''}
        </div>
        ${tx.note ? `<div class="ch-rationale" style="margin-top:4px;">${tx.note}</div>` : ''}
      </div>
    </div>` : ''}

    <!-- Neighborhood Pulse -->
    <div class="ch-section">
      <div class="ch-section-header">
        <span class="ch-section-icon">🏘</span>
        <span class="ch-section-label">Neighborhood Pulse</span>
        ${np.trend ? `<span class="ch-section-status ch-section-status--${np.trend === 'Rising' ? 'under' : np.trend === 'Declining' ? 'over' : 'fair'}">${np.trend}</span>` : ''}
        <span class="ch-section-spacer"></span>
        <button class="ch-toggle" data-section-toggle="#ch-sold-nbhd-body">▾</button>
      </div>
      <div id="ch-sold-nbhd-body" class="ch-section-body">
        ${np.summary ? `<div class="ch-rationale">${np.summary}</div>` : ''}
      </div>
    </div>

    <!-- Comparable Homes (bed+bath matched, linkable) -->
    <div class="ch-section" id="ch-sold-comps-section">
      <div class="ch-section-header">
        <span class="ch-section-icon">🏠</span>
        <span class="ch-section-label">Comparable Homes</span>
        <span class="ch-section-spacer"></span>
        <button class="ch-toggle" data-section-toggle="#ch-sold-comps-body">▾</button>
      </div>
      <div id="ch-sold-comps-body" class="ch-section-body">
        <div id="ch-sold-comps-content"><!-- populated --></div>
      </div>
    </div>

    <!-- Print -->
    <div class="ch-print-bar">
      <button id="ch-sold-print-btn" class="ch-print-btn">🖨 Print / Save PDF</button>
      <button id="ch-sold-downloadlogs-btn" class="ch-print-btn ch-downloadlogs-btn">📥 Download Logs</button>
    </div>

  `;

  resultsEl.querySelectorAll('[data-section-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = shadow.querySelector(btn.dataset.sectionToggle) ||
                     resultsEl.querySelector(btn.dataset.sectionToggle);
      const collapsed = target?.classList.toggle('collapsed');
      btn.textContent = collapsed ? '▸' : '▾';
    });
  });

  const soldCompsEl = resultsEl.querySelector('#ch-sold-comps-content');
  const allSoldComps = listingData.nearbyHomes || [];
  const pBeds = v => parseInt((v || '0').toString().replace(/[^0-9]/g,'')) || 0;
  const pBaths = v => parseFloat((v || '0').toString().replace(/[^0-9.]/g,'')) || 0;
  const sBeds = pBeds(listingData.beds || listingData.bedrooms);
  const sBaths = pBaths(listingData.baths || listingData.bathrooms);
  const soldComps = sBeds > 0 ? allSoldComps.filter(h => {
    const hB = pBeds(h.beds); const hBa = pBaths(h.baths);
    return hB === sBeds && (sBaths === 0 || Math.abs(hBa - sBaths) <= 1);
  }) : allSoldComps;
  const finalSoldComps = soldComps.length >= 2 ? soldComps : allSoldComps;
  if (soldCompsEl && finalSoldComps.length > 0) {
    soldCompsEl.innerHTML = `<div class="ch-comp-grid">${finalSoldComps.slice(0, 8).map(h => {
      const addr = (h.addr || h.address || '').trim();
      const addrSlug = addr.replace(/,/g,'').replace(/\s+/g,'-').replace(/[^a-zA-Z0-9-]/g,'').replace(/-+/g,'-');
      const compUrl = h.url || (h.zpid ? `https://www.zillow.com/homedetails/${addrSlug}/${h.zpid}_zpid/` : '') || (addrSlug ? `https://www.zillow.com/homes/${addrSlug}_rb/` : '');
      const pNum = h.priceNum || parseInt((h.price||'').toString().replace(/[^0-9]/g,''),10) || 0;
      const sqftStr = (h.sqft||'').toLowerCase().trim();
      const sqftK = sqftStr.match(/^([\d.]+)k/); const sqftP = sqftStr.match(/^([\d,]+)\s*sqft/);
      const sqftNum = sqftK ? Math.round(parseFloat(sqftK[1])*1000) : sqftP ? parseInt(sqftP[1].replace(/,/g,''),10) : 0;
      const ppsq = (pNum > 0 && sqftNum > 0) ? Math.round(pNum/sqftNum) : null;
      return `<div class="ch-comp-box${compUrl ? ' ch-comp-box--link' : ''}">
        <div class="ch-comp-addr">${compUrl ? `<a href="${compUrl}" target="_blank" rel="noopener" class="ch-comp-link">${addr}</a>` : addr}</div>
        <div class="ch-comp-stats"><span class="ch-comp-price">${h.price||'—'}</span><span class="ch-comp-detail">${[h.beds,h.baths,h.sqft].filter(Boolean).join(' · ')}</span>${ppsq ? `<span class="ch-comp-ppsq">~$${ppsq}/sqft</span>` : ''}</div>
      </div>`;
    }).join('')}</div>`;
  } else if (soldCompsEl) {
    soldCompsEl.innerHTML = '<div class="ch-empty-state">No comparable homes found nearby.</div>';
  }

  resultsEl.querySelector('#ch-sold-print-btn')?.addEventListener('click', () => {
    printAnalysis(shadow, listingData);
  });
}

function populateRentPanel(result, listingData, shadow) {
  const analyzingBadge = shadow.querySelector('#ch-analyzing-badge');
  if (analyzingBadge) analyzingBadge.style.display = 'none';

  const tldrWrap = shadow.querySelector('#ch-tldr');
  const tldrEl   = shadow.querySelector('#ch-tldr-text');
  if (tldrEl && result.oneLineSummary) {
    tldrEl.textContent = result.oneLineSummary;
    if (tldrWrap) { tldrWrap.style.display = 'block'; tldrWrap.classList.add('ch-tldr--rent'); }
  }

  const resultsEl = shadow.querySelector('#ch-results');
  if (!resultsEl) return;

  const rrc = result.rentRealityCheck || {};
  const tmc = result.trueMonthlyCost  || {};
  const aff = result.affordability    || {};
  const li  = result.leaseIntel       || {};
  const rvb = result.rentVsBuy        || {};
  const lnd = result.landlordIntel    || {};
  const rf  = result.redFlags         || [];

  const scamScore   = lnd.scamRiskScore || 0;
  const scamVariant = scamScore >= 7 ? 'over' : scamScore >= 4 ? 'warn' : 'ok';
  const scamLabel   = scamScore >= 7 ? 'High Risk' : scamScore >= 4 ? 'Review' : 'Looks Legit';

  const infoRow = (label, val) => val
    ? `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:0.5px solid var(--border);font-size:10.5px;line-height:1.4;"><span style="color:var(--text-3);flex-shrink:0;width:75px;">${label}</span><span style="color:var(--text-1);flex:1;text-align:right;">${val}</span></div>` : '';

  const scrapedRentZest = listingData.rentZestimate || 0;
  const rentAmt = listingData.rentPrice || (listingData.price > 0 && listingData.price <= 50000 ? listingData.price : 0);

  const rentTakehome = result._monthlyTakehome || listingData.userProfile?.monthlyTakehome || 0;
  const rentDebts = listingData.userProfile?.monthlyDebts || 0;
  const rentDisc = listingData.userProfile?.monthlyDiscretionary || 0;
  const userUtil = listingData.userProfile?.monthlyUtilities || 0;
  const estUtil  = tmc.estimatedUtilities ? parseInt(String(tmc.estimatedUtilities).replace(/[^0-9]/g,''),10) : (userUtil > 0 ? userUtil : 200);
  const estIns   = tmc.rentersInsurance ? parseInt(String(tmc.rentersInsurance).replace(/[^0-9]/g,''),10) : 15;
  const rentTotal = rentAmt + estUtil + estIns + rentDebts + rentDisc;
  const rentRemaining = rentTakehome > 0 ? rentTakehome - rentTotal : 0;
  const rentDenom = rentTakehome > 0 ? rentTakehome : rentTotal;
  const rentSeg = (v) => Math.max(Math.round(v / rentDenom * 100), v > 0 ? 1 : 0);
  const rentSegments = [
    { label: 'Rent',  val: rentAmt,  pct: rentSeg(rentAmt),  color: '#5b8def' },
    { label: 'Util',  val: estUtil,  pct: rentSeg(estUtil),  color: '#1abc9c' },
    { label: 'Ins',   val: estIns,   pct: rentSeg(estIns),   color: '#9b59b6' },
    rentDebts > 0 ? { label: 'Debts', val: rentDebts, pct: rentSeg(rentDebts), color: '#95a5a6' } : null,
    rentDisc > 0 ?  { label: 'Disc.', val: rentDisc,  pct: rentSeg(rentDisc),  color: '#7f8c8d' } : null,
  ].filter(Boolean);
  const rentRemainPct = rentTakehome > 0 ? Math.max(100 - rentSegments.reduce((s,x) => s + x.pct, 0), 0) : 0;
  const rentBarSegments = rentSegments.map(s =>
    `<div style="width:${s.pct}%;background:${s.color};height:100%;" title="${s.label}: $${s.val.toLocaleString()}"></div>`
  ).join('');
  const rentLegendItems = rentSegments.map(s =>
    `<div class="ch-afford-legend-item"><div class="ch-afford-legend-dot" style="background:${s.color};"></div>${s.label} $${s.val.toLocaleString()}</div>`
  ).join('');
  const rentAffordBadge = rentTakehome > 0
    ? `<span class="ch-section-status ch-section-status--${rentRemaining < 0 ? 'over' : rentRemaining < rentTakehome * 0.1 ? 'warn' : 'ok'}">${rentRemaining < 0 ? 'Stretched' : 'Affordable'}</span>`
    : (aff.verdict ? `<span class="ch-section-status ch-section-status--${aff.verdict === 'Affordable' ? 'ok' : 'warn'}">${aff.verdict}</span>` : '');

  resultsEl.innerHTML = `

    <!-- Lease Intel (moved above Rent Reality Check) -->
    <div class="ch-section">
      <div class="ch-section-header">
        <span class="ch-section-icon">📋</span>
        <span class="ch-section-label">Lease Intel</span>
        ${li.daysOnMarket !== undefined ? `<span class="ch-section-status ch-section-status--${li.daysOnMarket > 30 ? 'under' : 'neutral'}">${li.daysOnMarket} days${li.daysOnMarket > 30 ? ' · Leverage' : ''}</span>` : ''}
        <span class="ch-section-spacer"></span>
        <button class="ch-toggle" data-section-toggle="#ch-rent-lease-body">▾</button>
      </div>
      <div id="ch-rent-lease-body" class="ch-section-body">
        ${infoRow('Lease Term',  li.leaseTerms)}
        ${infoRow('Pets',        li.petPolicy)}
        ${infoRow('Laundry',     li.laundry)}
        ${infoRow('Parking',     li.parking)}
        ${infoRow('Deposit',     li.depositMin    ? '$' + Number(li.depositMin).toLocaleString()  : '')}
        ${infoRow('App Fee',     li.applicationFee ? '$' + li.applicationFee : '')}
        ${infoRow('Available',   li.availableDate)}
        ${infoRow('Utilities',   li.utilitiesIncluded)}
        ${li.note ? `<div class="ch-rationale" style="margin-top:6px;">${li.note}</div>` : ''}
      </div>
    </div>

    <!-- Rent Reality Check -->
    <div class="ch-section">
      <div class="ch-section-header">
        <span class="ch-section-icon">💰</span>
        <span class="ch-section-label">Rent Reality Check</span>
        ${rrc.marketPosition ? `<span class="ch-section-status ch-section-status--${rrc.marketPosition === 'Above Market' ? 'over' : rrc.marketPosition === 'Below Market' ? 'under' : 'fair'}">${rrc.marketPosition}</span>` : ''}
        <span class="ch-section-spacer"></span>
        <button class="ch-toggle" data-section-toggle="#ch-rent-rrc-body">▾</button>
      </div>
      <div id="ch-rent-rrc-body" class="ch-section-body">
        <div class="ch-tax-row">
          <div class="ch-tax-col"><div class="ch-tax-label">Asking Rent</div><div class="ch-tax-val">${rentAmt > 0 ? '$' + Number(rentAmt).toLocaleString() + '/mo' : '—'}</div></div>
          ${scrapedRentZest > 0 ? `<div class="ch-tax-col"><div class="ch-tax-label">Rent Zestimate</div><div class="ch-tax-val">$${Number(scrapedRentZest).toLocaleString()}/mo</div></div>` : (rrc.rentZestimate ? `<div class="ch-tax-col"><div class="ch-tax-label">Rent Zestimate</div><div class="ch-tax-val">$${Number(rrc.rentZestimate).toLocaleString()}/mo</div></div>` : '')}
          ${(() => {
            const rz = scrapedRentZest || rrc.rentZestimate || 0;
            const gap = (rentAmt > 0 && rz > 0) ? rentAmt - rz : (rrc.rentZestimateGap ?? null);
            return gap !== null ? `<div class="ch-tax-col"><div class="ch-tax-label">vs Market</div><div class="ch-tax-val ${gap > 0 ? 'ch-tax--warning' : ''}">${gap > 0 ? '+' : ''}$${Math.abs(gap).toLocaleString()}</div></div>` : '';
          })()}
        </div>
        ${rrc.rentRange ? `${infoRow('Market Range', '$' + Number(rrc.rentRange.low).toLocaleString() + ' – $' + Number(rrc.rentRange.high).toLocaleString() + '/mo')}` : ''}
        ${rrc.note ? `<div class="ch-rationale" style="margin-top:6px;">${rrc.note}</div>` : ''}
      </div>
    </div>

    <!-- Affordability (bar visual matching For Sale) -->
    <div class="ch-section">
      <div class="ch-section-header">
        <span class="ch-section-icon">🏦</span>
        <span class="ch-section-label">Affordability</span>
        ${rentAffordBadge}
        <span class="ch-section-spacer"></span>
        <button class="ch-toggle" data-section-toggle="#ch-rent-aff-body">▾</button>
      </div>
      <div id="ch-rent-aff-body" class="ch-section-body">
        ${rentTakehome > 0 ? `
        <div class="ch-afford-header-row">
          <div class="ch-afford-takehome-wrap">
            <span style="font-size:9px;color:var(--text-3);">Monthly Take-Home</span>
            <span class="ch-afford-takehome-val">$${Number(rentTakehome).toLocaleString()}</span>
          </div>
          <div class="ch-afford-result-wrap ${rentRemaining < 0 ? 'ch-afford-neg' : 'ch-afford-pos'}">
            ${rentRemaining < 0 ? `$${Math.abs(rentRemaining).toLocaleString()} short/mo` : `$${rentRemaining.toLocaleString()} left/mo`}
          </div>
        </div>
        <div class="ch-afford-single-bar">
          <div class="ch-afford-bar-track">
            ${rentBarSegments}
            ${rentRemainPct > 0 ? `<div style="width:${rentRemainPct}%;background:${rentRemaining < 0 ? 'var(--red-bg,#fde8e8)' : '#e8f5e9'};height:100%;" title="Remaining: $${Math.abs(rentRemaining).toLocaleString()}"></div>` : ''}
          </div>
        </div>
        <div class="ch-afford-legend">${rentLegendItems}</div>` : ''}
        ${aff.note ? `<div class="ch-rationale" style="margin-top:4px;">${aff.note}</div>` : ''}
      </div>
    </div>

    <!-- Landlord Cash Flow -->
    ${result.landlordCashFlow ? (() => {
      const cf = result.landlordCashFlow;
      const cfNum = cf.monthlyCashFlow !== null && cf.monthlyCashFlow !== undefined ? Number(cf.monthlyCashFlow) : null;
      const cov   = cf.coverageRatio ? Number(cf.coverageRatio) : null;
      const cfVariant = cfNum === null ? 'neutral' : cfNum < 0 ? 'over' : cov >= 1.25 ? 'ok' : 'fair';
      const cfBadge   = cfNum === null ? 'No sold price' : (cfNum >= 0 ? '+$' : '-$') + Math.abs(cfNum).toLocaleString() + '/mo';
      return `
    <div class="ch-section">
      <div class="ch-section-header">
        <span class="ch-section-icon">📊</span>
        <span class="ch-section-label">Landlord Cash Flow</span>
        <span class="ch-section-status ch-section-status--${cfVariant}">${cfBadge}</span>
        <span class="ch-section-spacer"></span>
        <button class="ch-toggle" data-section-toggle="#ch-rent-cashflow-body">▾</button>
      </div>
      <div id="ch-rent-cashflow-body" class="ch-section-body">
        ${cf.lastSoldPrice ? `
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:6px;">
          <div><div class="ch-tax-label">Last Sold</div><div class="ch-tax-val">$${Number(cf.lastSoldPrice).toLocaleString()}</div></div>
          ${cf.estimatedMortgage ? `<div><div class="ch-tax-label">P&I (${cf.investorRate||'—'})</div><div class="ch-tax-val">$${Number(cf.estimatedMortgage).toLocaleString()}/mo</div></div>` : ''}
          ${cf.estimatedHOA ? `<div><div class="ch-tax-label">HOA</div><div class="ch-tax-val">$${Number(cf.estimatedHOA).toLocaleString()}/mo</div></div>` : ''}
          ${cf.estimatedTax ? `<div><div class="ch-tax-label">Tax</div><div class="ch-tax-val">$${Number(cf.estimatedTax).toLocaleString()}/mo</div></div>` : ''}
        </div>
        <div style="display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;border-top:0.5px solid var(--border);font-size:11px;">
          <span style="font-weight:600;">Net Cash Flow</span>
          <span style="font-weight:700;${cfNum !== null && cfNum < 0 ? 'color:var(--red-text,#c0392b);' : ''}">${cfNum !== null ? (cfNum >= 0 ? '+' : '-') + '$' + Math.abs(cfNum).toLocaleString() + '/mo' : '—'}${cov ? ' (' + cov.toFixed(2) + 'x)' : ''}</span>
        </div>
        ` : `<div class="ch-rationale">No sold price found for this property.</div>`}
        ${cf.negotiationLeverage ? `<div class="ch-rationale" style="margin-top:4px;">${cf.negotiationLeverage}</div>` : ''}
      </div>
    </div>`;
    })() : ''}

    <!-- Landlord Intel -->
    <div class="ch-section">
      <div class="ch-section-header">
        <span class="ch-section-icon">🔎</span>
        <span class="ch-section-label">Landlord Intel</span>
        <span class="ch-section-status ch-section-status--${scamVariant}">${scamLabel}</span>
        <span class="ch-section-spacer"></span>
        <button class="ch-toggle" data-section-toggle="#ch-rent-lnd-body">▾</button>
      </div>
      <div id="ch-rent-lnd-body" class="ch-section-body">
        ${infoRow('Listed By',       lnd.name)}
        ${infoRow('Company',         lnd.company)}
        ${infoRow('Type',            lnd.type)}
        ${infoRow('Owner of Record', lnd.ownerOfRecord)}
        ${infoRow('Name Match',      lnd.ownerMatchStatus)}
        ${lnd.note ? `<div class="ch-tax-sub" style="margin-top:6px;">${lnd.note}</div>` : ''}
        ${rf.length > 0 ? `
          <div class="ch-tax-warn-badge" style="margin-top:10px;">⚠ Red Flags</div>
          ${rf.map(f => `
            <div class="ch-risk ch-risk--${f.severity || 'medium'}" style="margin-bottom:4px;">
              <div class="ch-risk-header">
                <span class="ch-risk-dot"></span>
                <span class="ch-risk-title">${f.title}</span>
                <span class="ch-risk-badge ch-risk-badge--${f.severity || 'medium'}">${f.severity || 'medium'}</span>
              </div>
              <div class="ch-risk-explanation">${f.explanation}</div>
            </div>`).join('')}` : ''}
      </div>
    </div>

    <!-- Rent vs Buy -->
    ${rvb.monthlyCostToOwn ? `
    <div class="ch-section">
      <div class="ch-section-header">
        <span class="ch-section-icon">🏡</span>
        <span class="ch-section-label">Rent vs Buy</span>
        ${rvb.verdict ? `<span class="ch-section-status ch-section-status--${rvb.verdict === 'Renting Wins' ? 'under' : rvb.verdict === 'Buying Wins' ? 'ok' : 'fair'}">${rvb.verdict}</span>` : ''}
        <span class="ch-section-spacer"></span>
        <button class="ch-toggle" data-section-toggle="#ch-rent-rvb-body">▾</button>
      </div>
      <div id="ch-rent-rvb-body" class="ch-section-body">
        <div class="ch-tax-row">
          <div class="ch-tax-col"><div class="ch-tax-label">Monthly Rent</div><div class="ch-tax-val">$${Number(listingData.price||0).toLocaleString()}</div></div>
          ${rvb.monthlyCostToOwn ? `<div class="ch-tax-col"><div class="ch-tax-label">PITI if Bought</div><div class="ch-tax-val">$${Number(rvb.monthlyCostToOwn).toLocaleString()}</div></div>` : ''}
          ${rvb.breakEvenYears  ? `<div class="ch-tax-col"><div class="ch-tax-label">Break-even</div><div class="ch-tax-val">${rvb.breakEvenYears} yrs</div></div>` : ''}
        </div>
        ${rvb.note ? `<div class="ch-tax-sub" style="margin-top:6px;">${rvb.note}</div>` : ''}
      </div>
    </div>` : ''}

    <!-- Similar Homes for Rent (bottom, linkable, bed-matched) -->
    <div class="ch-section" id="ch-rent-comps-section">
      <div class="ch-section-header">
        <span class="ch-section-icon">🏘</span>
        <span class="ch-section-label">Similar Homes for Rent</span>
        <span class="ch-section-spacer"></span>
        <button class="ch-toggle" data-section-toggle="#ch-rent-comps-body">▾</button>
      </div>
      <div id="ch-rent-comps-body" class="ch-section-body">
        <div id="ch-rent-comps-content"><!-- populated below --></div>
      </div>
    </div>

    <!-- Print -->
    <div class="ch-print-bar">
      <button id="ch-rent-print-btn" class="ch-print-btn">🖨 Print / Save PDF</button>
      <button id="ch-rent-downloadlogs-btn" class="ch-print-btn ch-downloadlogs-btn">📥 Download Logs</button>
    </div>

  `;

  resultsEl.querySelectorAll('[data-section-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = shadow.querySelector(btn.dataset.sectionToggle) ||
                     resultsEl.querySelector(btn.dataset.sectionToggle);
      const collapsed = target?.classList.toggle('collapsed');
      btn.textContent = collapsed ? '▸' : '▾';
    });
  });

  const rentCompsEl = resultsEl.querySelector('#ch-rent-comps-content');
  const allRentComps = listingData.nearbyHomes || [];
  const parseBeds = v => parseInt((v || '0').toString().replace(/[^0-9]/g,'')) || 0;
  const parseBaths = v => parseFloat((v || '0').toString().replace(/[^0-9.]/g,'')) || 0;
  const subBeds = parseBeds(listingData.beds || listingData.bedrooms);
  const subBaths = parseBaths(listingData.baths || listingData.bathrooms);
  const rentComps = subBeds > 0 ? allRentComps.filter(h => {
    const hBeds = parseBeds(h.beds);
    const hBaths = parseBaths(h.baths);
    return hBeds === subBeds && (subBaths === 0 || Math.abs(hBaths - subBaths) <= 1);
  }) : allRentComps;
  const finalRentComps = rentComps.length >= 2 ? rentComps : allRentComps;
  if (rentCompsEl && finalRentComps.length > 0) {
    rentCompsEl.innerHTML = `<div class="ch-comp-grid">${finalRentComps.slice(0, 8).map(h => {
      const addr = (h.addr || h.address || '').trim();
      const addrSlug = addr.replace(/,/g,'').replace(/\s+/g,'-').replace(/[^a-zA-Z0-9-]/g,'').replace(/-+/g,'-');
      const compUrl = h.url || (h.zpid ? `https://www.zillow.com/homedetails/${addrSlug}/${h.zpid}_zpid/` : '') || (addrSlug ? `https://www.zillow.com/homes/${addrSlug}_rb/` : '');
      const pNum = h.priceNum || parseInt((h.price||'').toString().replace(/[^0-9]/g,''), 10) || 0;
      const sqftStr = (h.sqft||'').toLowerCase().trim();
      const sqftK = sqftStr.match(/^([\d.]+)k/);
      const sqftPlain = sqftStr.match(/^([\d,]+)\s*sqft/);
      const sqftNum = sqftK ? Math.round(parseFloat(sqftK[1]) * 1000) : sqftPlain ? parseInt(sqftPlain[1].replace(/,/g,''),10) : 0;
      const ppsq = (pNum > 0 && sqftNum > 0) ? Math.round(pNum / sqftNum) : null;
      return `<div class="ch-comp-box${compUrl ? ' ch-comp-box--link' : ''}">
        <div class="ch-comp-addr">${compUrl ? `<a href="${compUrl}" target="_blank" rel="noopener" class="ch-comp-link">${addr}</a>` : addr}</div>
        <div class="ch-comp-stats">
          <span class="ch-comp-price">${h.price||'—'}</span>
          <span class="ch-comp-detail">${[h.beds, h.baths, h.sqft].filter(Boolean).join(' · ')}</span>
          ${ppsq ? `<span class="ch-comp-ppsq">~$${ppsq}/sqft</span>` : ''}
        </div>
      </div>`;
    }).join('')}</div>`;
  } else if (rentCompsEl) {
    rentCompsEl.innerHTML = '<div class="ch-empty-state">No similar rental listings found nearby.</div>';
  }

  resultsEl.querySelector('#ch-rent-print-btn')?.addEventListener('click', () => {
    printAnalysis(shadow, listingData);
  });
}

function showNoKeyState() {
  sendToPanel({ type: 'CH_NEEDS_KEY' });
}

function errorStateText(msg) {
  if (!msg || msg.includes('NO_API_KEY')) return 'No API key configured — add it in the extension settings.';
  if (msg.includes('API error 4'))        return `API error: ${msg}`;
  if (msg.includes('Network error') || msg.includes('Failed to fetch'))
                                          return 'Network error — click Analyze again.';
  if (msg.includes('timed out'))          return 'The analysis timed out — click Analyze again.';
  if (/truncat|incomplete|PARSE_ERROR/i.test(msg))
                                          return 'The analysis was cut off before it finished. Click Analyze to run it again.';
  return String(msg).slice(0, 160);
}

function showErrorState(msg) {
  chLog('error_shown', { msg: String(msg).slice(0, 300) });
  sendToPanel({ type: 'CH_FAILED', text: errorStateText(msg) });
}

function chToast(msg) {
  sendToPanel({ type: 'CH_TOAST', text: String(msg) });
}

function downloadDiagnosticLogs(listingData) {
  const result = chLastResult || {};
  const scraped = chLastScraped || listingData || {};
  const safe = (obj) => { try { return JSON.parse(JSON.stringify(obj)); } catch (e) { return {}; } };
  const s = safe(scraped); const r = safe(result);
  try { delete s.apiKey; delete s.userProfile; } catch (e) {}

  const prior = Array.isArray(scraped.priceHistory) ? scraped.priceHistory.find(h => /sold/i.test(h.event || '')) : null;
  const lines = [];
  lines.push('CLEAR HOME — DIAGNOSTIC LOG');
  lines.push('Generated: ' + new Date().toISOString());
  lines.push('Version: ' + ((chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?'));
  try { lines.push('Model: ' + (window.__chLastModelUsed || '(pref default)')); } catch (e) {}
  lines.push('URL: ' + location.href);
  lines.push('');
  lines.push('=== VALUE SNAPSHOT ===');
  lines.push('List price:        ' + scraped.price);
  lines.push('Sqft:              ' + scraped.sqft);
  lines.push('Beds/Baths:        ' + scraped.beds + ' / ' + scraped.baths + (scraped.bathsDetail ? ' (' + scraped.bathsDetail + ')' : ''));
  lines.push('Year built:        ' + scraped.yearBuilt);
  lines.push('Zestimate:         ' + scraped.zestimate);
  lines.push('Prior sale:        ' + (prior ? JSON.stringify(prior) : 'none'));
  lines.push('Offer strategy:    ' + (r.buyerOpportunity && r.buyerOpportunity.offerStrategy));
  lines.push('Market bottom:     ' + (r.buyerOpportunity && r.buyerOpportunity.fairValue));
  lines.push('Suggested offer:   ' + (r.buyerOpportunity && r.buyerOpportunity.suggestedOffer));
  lines.push('Aggressiveness %:  ' + (r.buyerOpportunity && r.buyerOpportunity.aggressivenessPct));
  lines.push('Motivation:        ' + JSON.stringify(r.buyerOpportunity && r.buyerOpportunity.motivationSignals));
  lines.push('Valuation status:  ' + (r.valuation && r.valuation.status));
  lines.push('Valuation range:   ' + (r.valuation && r.valuation.low) + ' - ' + (r.valuation && r.valuation.high));
  lines.push('Price/sqft:        ' + JSON.stringify(r.pricePerSqft));
  lines.push('Tax estimate:      ' + JSON.stringify(r.taxEstimate));
  lines.push('');
  lines.push('=== EVENT LOG (' + (chDiagLog ? chDiagLog.length : 0) + ' entries) ===');
  (chDiagLog || []).forEach(e => lines.push(e.t + '  [' + e.tag + ']  ' + (e.detail ? JSON.stringify(e.detail) : '')));
  lines.push('');
  lines.push('=== SCRAPED FIELDS AUDIT ===');
  const fv = (v) => {
    if (v === undefined || v === null || v === '' || v === 0 || v === '0' || v === false) return null;
    if (Array.isArray(v)) return v.length ? v.length + ' item(s)' : null;
    if (typeof v === 'object') return Object.keys(v).length ? JSON.stringify(v).slice(0, 70) : null;
    if (v === true) return 'Yes';
    return String(v).slice(0, 70);
  };
  const groups = {
    'CORE':                         ['address','price','sqft','beds','baths','bathsDetail','yearBuilt','lotSize','stories','propertyType','propertySubtype','homeStatus'],
    'FACTS & FEATURES':             ['heating','cooling','flooring','roofType','foundation','constructionMaterials','sewer','waterSource','fireplace','hasPool','poolDetail','spa','view','waterfront','appliances','interiorFeatures','exteriorFeatures','parking','garage','newConstruction','condition'],
    'BUILDER / MODEL':              ['builderName','propertyModel'],
    'AGENT / MLS':                  ['agentName','agentPhone','brokerageName','mlsId','mlsSource','originatingMls','isFSBO'],
    'FINANCIAL / HOA / TAX':        ['hoaFee','hoaName','zoning','parcelNumber','taxAssessedValueListing','taxAnnualAmountListing','lastSoldPrice','zestimate'],
    'LOCATION / SCHOOLS / CLIMATE': ['schools','nearbySchools','walkScore','bikeScore','floodZone','floodRiskLevel'],
    'PHOTOS / DESCRIPTION':         ['photoCount','photoUrls','description'],
  };
  let totalKeys = 0, filledKeys = 0;
  for (const [g, keys] of Object.entries(groups)) {
    lines.push('[' + g + ']');
    for (const k of keys) {
      const val = fv(s[k]);
      totalKeys++; if (val) filledKeys++;
      lines.push('  ' + (val ? '[x] ' : '[ ] ') + (k + ':').padEnd(24) + (val || '(empty)'));
    }
  }
  lines.push('');
  lines.push('Coverage: ' + filledKeys + '/' + totalKeys + ' audited fields populated');

  const flags = [];
  if (!fv(s.description))                          flags.push('description EMPTY — AI cannot see condition/financing disclosures (e.g. roof, cash-only)');
  if (!fv(s.agentName) && !s.isFSBO)              flags.push('agentName EMPTY — listing-agent license cannot be verified');
  if (!fv(s.heating) && !fv(s.cooling))           flags.push('heating AND cooling empty — Facts & Features may not have fully rendered');
  if (!fv(s.zestimate))                            flags.push('zestimate missing/0 — fair-value blend relies on FHFA + comps only');
  if (!fv(s.schools) && !fv(s.nearbySchools))     flags.push('no schools captured');
  if (s.photoCount === 1)                          flags.push('photoCount = 1 — photo gallery likely did not load');
  if (fv(s.roofType) && !/(shingle|tile|metal|asphalt|concrete|slate|wood|shake|membrane|flat|composition|foam|clay|architectural)/i.test(String(s.roofType)))
                                                   flags.push('roofType looks suspicious: "' + s.roofType + '"');
  if (fv(s.waterSource) && !/(public|private|well|city|municipal|cistern|spring|community|county|shared)/i.test(String(s.waterSource)))
                                                   flags.push('waterSource looks suspicious: "' + s.waterSource + '"');
  if (fv(s.price) && fv(s.sqft) && (s.price / s.sqft < 20 || s.price / s.sqft > 3000))
                                                   flags.push('price/sqft out of range: $' + Math.round(s.price / s.sqft) + '/sqft');
  if (fv(s.lotSize) && /(\d[\d,]{6,})/.test(String(s.lotSize))) flags.push('lotSize looks too large: "' + s.lotSize + '"');
  lines.push('');
  lines.push('[RED FLAGS] (' + flags.length + ')');
  if (!flags.length) lines.push('  none detected');
  else flags.forEach(f => lines.push('  (!) ' + f));
  lines.push('');

  try {
    const dbg = (typeof _chAgentDebug !== 'undefined') ? _chAgentDebug : {};
    lines.push('[AGENT CAPTURE DEBUG]');
    lines.push('  "Listed by" present in: mainText=' + (dbg.listedByIn?.mainText ? 'YES' : 'no')
      + ', shadowDOM=' + (dbg.listedByIn?.shadow ? 'YES' : 'no')
      + ', iframe=' + (dbg.listedByIn?.iframe ? 'YES' : 'no'));
    lines.push('  shadowDOM text length=' + (dbg.shadowLen || 0) + ', iframe text length=' + (dbg.frameLen || 0));
    lines.push('  __NEXT_DATA__ has "agentName"=' + (dbg.nextDataHasAgentName ? 'YES' : 'no') + ' (len=' + (dbg.nextDataLen || 0) + ')');
    lines.push('  brokerage="' + (dbg.brokerage || '') + '" findable in: NEXT_DATA=' + (dbg.brokerInNextData ? 'YES' : 'no')
      + ', deepText=' + (dbg.brokerInDeepText ? 'YES' : 'no') + ', bodyText=' + (dbg.brokerInBodyText ? 'YES' : 'no'));
    lines.push('  captured during scroll: name="' + (dbg.captured?.name || '') + '" phone="' + (dbg.captured?.phone || '') + '"');
    lines.push('  agent at scrape stage (pre-stamp): name="' + (dbg.finalAgent?.name || '') + '" phone="' + (dbg.finalAgent?.phone || '') + '"');
    lines.push('  AGENT IN FINAL DATA: name="' + (scraped.agentName || '') + '" phone="' + (scraped.agentPhone || '') + '"');
    lines.push('  outerHTML has "Listed by"=' + (dbg.outerHTMLHasListedBy ? 'YES' : 'no'));
    lines.push('  SNIPPET around "Listed by": ' + (dbg.snippet || '(not found in any source)'));
    lines.push('  node-level block found: ' + (dbg.blockFound || '(none)'));
    try {
      const bank = chReadAgent();
      lines.push('  sessionStorage bank: name="' + (bank.name || '') + '" phone="' + (bank.phone || '') + '"');
    } catch (e) {}
    lines.push('  final stamp: ' + (dbg.finalStamp ? JSON.stringify(dbg.finalStamp) : '(not run)'));
    lines.push('');
  } catch (e) {}

  lines.push('=== FULL SCRAPED LISTING DATA ===');
  lines.push(JSON.stringify(s, null, 2));
  lines.push('');
  lines.push('=== FULL ANALYSIS RESULT (post-processed) ===');
  lines.push(JSON.stringify(r, null, 2));
  lines.push('');
  lines.push('=== RAW API RESPONSE (pre-processing) ===');
  const _rawOk = !!(r && (r.valuation || r.keyHighlights));   
  if (_rawOk && chLastRawResponse && chLastRawResponse.length > 2000) {
    lines.push('(parse succeeded — raw truncated to first 2,000 chars; full raw is only kept when parsing fails)');
    lines.push(chLastRawResponse.slice(0, 2000) + ' …[truncated ' + (chLastRawResponse.length - 2000) + ' chars]');
  } else {
    lines.push(chLastRawResponse || '(not captured — run an analysis first)');
  }

  const text = lines.join('\n');
  const addrSlug = (scraped.address || 'listing').replace(/[^a-z0-9]+/gi, '-').slice(0, 40).toLowerCase();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = 'clearhome-logs-' + addrSlug + '-' + stamp + '.txt';

  chLog('logs_download_clicked', { filename, bytes: text.length });
  chToast('Preparing log download…');

  let done = false;
  const fallback = () => {
    if (done) return; done = true;
    try {
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.style.display = 'none';
      document.body.appendChild(a); a.click();
      setTimeout(() => { try { document.body.removeChild(a); } catch (e) {} URL.revokeObjectURL(url); }, 1000);
      chToast('Log saved: ' + filename);
    } catch (e) {
      try {
        const w = window.open('', '_blank');
        if (w) { w.document.title = filename; w.document.body.innerText = text; chToast('Opened log in new tab — save manually'); }
        else { chToast('Download blocked — check browser settings'); }
      } catch (e2) { alert('Clear Home log export failed: ' + e2); }
    }
  };

  try {
    chrome.runtime.sendMessage({ type: 'DOWNLOAD_LOGS', text, filename }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) { fallback(); }
      else { done = true; chToast('Log saved: ' + filename); }
    });
    setTimeout(() => { if (!done) fallback(); }, 1200);
  } catch (e) {
    fallback();
  }
}


function printAnalysis(shadow, listingData) {
  const sections = [];
  const grab = (id, label) => {
    const el = shadow.querySelector(id);
    if (!el || el.style.display === 'none') return;
    const content = el.innerHTML?.trim();
    if (!content || content === '<!-- populated -->') return;
    sections.push({ label, html: content });
  };

  const addr  = listingData.address || document.title.split('|')[0].trim();
  const rentAmt = listingData.rentPrice || 0;
  const mode  = listingData.listingMode || 'buy';
  const price = mode === 'rent'
    ? (rentAmt > 0 ? '$' + Number(rentAmt).toLocaleString() + '/mo' : (listingData.price > 0 && listingData.price <= 50000 ? '$' + Number(listingData.price).toLocaleString() + '/mo' : ''))
    : (listingData.price ? '$' + Number(listingData.price).toLocaleString() : '');
  const tldr  = shadow.querySelector('#ch-tldr-text')?.textContent?.trim() || '';
  const heroPhoto = listingData.photoUrls?.[0]
    || document.querySelector('meta[property="og:image"]')?.content
    || '';
  const verdictLabel = mode === 'sold'
    ? (listingData.isOffMarket ? 'OFF-MARKET ANALYSIS' : 'SALE SNAPSHOT')
    : mode === 'rent' ? 'RENTAL VERDICT' : 'CLEAR VERDICT';

  if (mode === 'buy') {
    grab('#ch-prop-meta-strip', 'Property Info');
    grab('#ch-highlights-content',   'Key Highlights');
    grab('#ch-valuation-content',    'Price Reality Check');
    grab('#ch-afford-content',       'Affordability');
    grab('#ch-actions-content',      'What To Do Next');
    grab('#ch-pricehistory-content', 'Price History & Appreciation');
    grab('#ch-tax-content',          'Estimated Tax Reset');
    grab('#ch-commute-content',      'Commute Estimates');
    grab('#ch-risks-content',        'Risks & Considerations');
    grab('#ch-agent-content',        'Agent Validation');
  } else if (mode === 'rent') {
    const resultsEl = shadow.querySelector('#ch-results');
    const grabR = (id, label) => {
      const el = resultsEl?.querySelector(id);
      if (!el || el.style.display === 'none') return;
      const content = el.innerHTML?.trim();
      if (!content || content === '<!-- populated -->') return;
      sections.push({ label, html: content });
    };
    grabR('#ch-rent-lease-body',     'Lease Intel');
    grabR('#ch-rent-rrc-body',       'Rent Reality Check');
    grabR('#ch-rent-aff-body',       'Affordability');
    grabR('#ch-rent-cashflow-body',  'Landlord Cash Flow');
    grabR('#ch-rent-lnd-body',       'Landlord Intel');
    grabR('#ch-rent-rvb-body',       'Rent vs Buy');
  } else if (mode === 'sold') {
    const resultsEl = shadow.querySelector('#ch-results');
    const grabS = (id, label) => {
      const el = resultsEl?.querySelector(id);
      if (!el || el.style.display === 'none') return;
      const content = el.innerHTML?.trim();
      if (!content || content === '<!-- populated -->') return;
      sections.push({ label, html: content });
    };
    grabS('#ch-sold-snap-body',     'Sale Snapshot');
    grabS('#ch-sold-value-body',    'Estimated Value');
    grabS('#ch-sold-appr-body',     'Appreciation');
    grabS('#ch-sold-hist-body',     'Listing History');
    grabS('#ch-sold-tax-body',      'Tax Snapshot');
    grabS('#ch-sold-nbhd-body',     'Neighborhood Pulse');
  }

  const compactSection = (html, label) => {
    try {
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      tpl.content.querySelectorAll('ul, ol').forEach(list => {
        const items = list.querySelectorAll(':scope > li');
        for (let i = 4; i < items.length; i++) items[i].remove();
      });
      const riskCards = tpl.content.querySelectorAll('.ch-risk');
      for (let i = 4; i < riskCards.length; i++) riskCards[i].remove();
      tpl.content.querySelectorAll('p, li, div, span').forEach(el => {
        if (el.children.length) return;                       
        const t = el.textContent || '';
        if (t.length > 190) {
          const cut = t.slice(0, 180);
          const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
          el.textContent = (end > 100 ? cut.slice(0, end + 1) : cut.trimEnd() + '…');
        }
      });
      return tpl.innerHTML;
    } catch (e) { return html; }
  };
  sections.forEach(s => { s.html = compactSection(s.html, s.label); });

  const fullWidthCount = Math.min(1, sections.length);   
  const topHtml = sections.slice(0, fullWidthCount).map(s => `
    <div class="section">
      <div class="section-label">${s.label}</div>
      <div class="section-body">${s.html}</div>
    </div>`).join('');
  const colsHtml = sections.slice(fullWidthCount).map(s => `
    <div class="section">
      <div class="section-label">${s.label}</div>
      <div class="section-body">${s.html}</div>
    </div>`).join('');
  const sectionsHtml = topHtml + (colsHtml ? `<div class="cols2">${colsHtml}</div>` : '');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Clear Home — ${addr}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=IBM+Plex+Mono:wght@500;600&display=swap">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root { --print-mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace; --print-display: 'Bricolage Grotesque', 'Inter', sans-serif; }
  body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 11px; color: #1a1a1a; background: #fff; padding: 24px 32px; max-width: 820px; margin: 0 auto; line-height: 1.45; -webkit-font-smoothing: antialiased; }
  .header { margin-bottom: 8px; border-bottom: 2px solid #1a1a2e; padding-bottom: 6px; }
  .header-top { display: flex; gap: 14px; align-items: flex-start; }
  .header-left { flex: 1; min-width: 0; }
  .hero-photo { width: 140px; height: 105px; object-fit: cover; border-radius: 6px; flex-shrink: 0; }
  .address { font-family: var(--print-display); font-size: 15px; font-weight: 700; color: #1a1a2e; line-height: 1.25; letter-spacing: -0.01em; display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .address-date { font-family: 'Inter', sans-serif; font-size: 9px; color: #888; font-weight: 400; white-space: nowrap; letter-spacing: 0; }
  .header-date { display: none; }
  .header-price { margin-top: 5px; }
  .price { font-family: var(--print-mono); font-size: 18px; font-weight: 600; color: #1a1a2e; letter-spacing: -0.01em; }
  .badge { display: none; }
  .tldr-label { font-size: 7px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: #888; margin-top: 5px; }
  .tldr { margin-top: 3px; padding: 6px 11px; background: #f0f4ff; border-left: 3px solid #1a1a2e; border-radius: 4px; font-size: 10px; font-weight: 500; color: #1a1a2e; line-height: 1.45; }
  .section { margin-bottom: 6px; break-inside: avoid; page-break-inside: avoid; }
  .section-label { font-size: 7.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #888; margin-bottom: 3px; border-bottom: 0.5px solid #e0e0e0; padding-bottom: 2px; }
  .section-body { line-height: 1.5; color: #222; }
  .ch-valuation-row { display: flex; justify-content: space-between; margin-bottom: 3px; font-weight: 600; font-size: 12px; }
  .ch-val-label { color: #555; font-weight: 500; font-size: 10px; }
  .ch-val-range { color: #1a1a2e; font-weight: 600; font-family: var(--print-mono); }
  .ch-rationale { font-size: 10px; color: #444; margin: 3px 0; line-height: 1.45; }
  .ch-confidence { font-size: 9px; color: #888; font-style: italic; margin: 2px 0; }
  .ch-risk { border-left: 2px solid #e67e22; padding: 2px 6px; margin: 2px 0; background: transparent; }
  .ch-risk--high { border-left-color: #c0392b; background: transparent; }
  .ch-risk--medium { border-left-color: #e67e22; background: transparent; }
  .ch-risk--low { border-left-color: #27ae60; background: transparent; }
  .ch-risk-badge { display: inline-block; font-size: 7px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 1px 4px; border-radius: 2px; }
  .ch-risk-badge--high   { background: rgba(192,57,43,0.25);  color: #c0392b; }
  .ch-risk-badge--medium { background: rgba(230,126,34,0.25); color: #b35e0a; }
  .ch-risk-badge--low    { background: rgba(39,174,96,0.25);  color: #1a7a42; }
  .ch-highlights-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 2px; text-align: left; }
  .ch-highlight-item { font-size: 10px; line-height: 1.45; padding-left: 12px; position: relative; text-align: left; }
  .ch-highlight-item::before { content: '→'; position: absolute; left: 0; color: #1a1a2e; font-weight: 700; font-size: 9px; }
  .ch-risk-title { font-weight: 600; font-size: 10px; }
  .ch-risk-explanation { font-size: 9px; color: #555; margin-top: 1px; }
  .ch-tax-row { display: flex; gap: 12px; margin-bottom: 4px; }
  .ch-tax-col { flex: 1; }
  .ch-tax-label { font-size: 8px; text-transform: uppercase; color: #888; letter-spacing: 0.05em; }
  .ch-tax-val { font-size: 12px; font-weight: 600; color: #1a1a2e; font-family: var(--print-mono); }
  .ch-tax-sub { font-size: 9px; color: #888; }
  .ch-tax-permo { font-size: 9px; color: #888; font-weight: 400; }
  .ch-tax-warn-badge { background: #fff3cd; color: #856404; font-size: 9px; padding: 2px 6px; border-radius: 3px; margin: 3px 0; display: inline-block; }
  .ch-ppsq-row { display: flex; align-items: center; gap: 5px; margin: 3px 0; font-size: 10px; }
  .ch-ppsq-label { color: #888; font-size: 8px; text-transform: uppercase; }
  .ch-ppsq-val { color: #333; }
  .ch-ppsq-verdict { font-weight: 600; }
  .ch-comp-grid, #ch-comp-more { display: grid !important; grid-template-columns: repeat(5, 1fr); gap: 4px; margin-bottom: 4px; }
  .ch-comp-box { border: 0.5px solid #ddd; border-radius: 4px; padding: 4px 5px; min-width: 0; overflow: hidden; }
  .ch-comp-addr { font-size: 8px; font-weight: 600; color: #1a1a2e; margin-bottom: 2px; word-break: break-word; }
  .ch-comp-price { font-size: 9px; font-weight: 600; display: block; font-family: var(--print-mono); }
  .ch-comp-detail { font-size: 8px; color: #666; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ch-comp-ppsq { font-size: 8px; color: #888; display: block; margin-top: 1px; }
  .ch-comp-pos { font-size: 7px; margin-top: 2px; padding: 1px 3px; border-radius: 2px; display: inline-block; }
  .ch-comp-pos--over { background: #fff0f0; color: #c0392b; }
  .ch-comp-pos--under { background: #f0fff4; color: #27ae60; }
  .ch-comp-pos--fair { background: #fffbf0; color: #e67e22; }
  .ch-comp-expand { display: none; }
  .ch-actions-list { padding-left: 0; list-style: none; }
  .ch-actions-list li { font-size: 10px; margin-bottom: 3px; line-height: 1.4; display: flex; align-items: flex-start; gap: 5px; }
  .ch-action-check { flex-shrink: 0; font-size: 10px; margin-top: 1px; }
  .ch-action-item { list-style: none; }
  .ch-one-liner { border-left: 2px solid #1a1a2e; padding: 4px 8px; margin: 4px 0; font-weight: 600; font-size: 11px; background: #f8f9ff; }
  .ch-agent-name { font-weight: 700; font-size: 11px; }
  .ch-agent-brokerage { font-size: 9px; color: #666; }
  .ch-mls-row { display: flex; gap: 4px; align-items: baseline; margin-bottom: 4px; }
  .ch-mls-label { font-size: 8px; font-weight: 700; text-transform: uppercase; color: #888; }
  .ch-mls-num { font-size: 11px; font-weight: 600; font-family: var(--print-mono); }
  .ch-mls-source { font-size: 9px; color: #888; }
  .ch-prop-meta { margin-bottom: 6px; padding-bottom: 5px; border-bottom: 0.5px solid #eee; }
  .ch-prop-meta-sub { font-size: 9px; color: #888; display: flex; gap: 4px; flex-wrap: wrap; }
  .ch-meta-label { color: #bbb; }
  .ch-afford-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 5px; }
  .ch-afford-item { flex: 1; min-width: 70px; }
  .ch-afford-total { font-size: 11px; font-weight: 600; margin: 3px 0; color: #1a1a2e; font-family: var(--print-mono); }
  .ch-piti-total { font-size: 11px; font-weight: 600; margin: 3px 0; font-family: var(--print-mono); }
  .ch-appreciation-row { display: flex; gap: 6px; margin: 2px 0; }
  .ch-appr-label, .ch-appr-val { font-size: 10px; }
  .ch-section-status { display: none; }
  .ch-empty-state { font-size: 10px; color: #aaa; font-style: italic; }
  .ch-tax-arrow { color: #888; font-size: 12px; align-self: center; padding: 0 4px; }
  .ch-propinfo-bar { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; padding: 6px 0; border-bottom: 0.5px solid #e0e0e0; }
  .ch-pinfo-chip { display: inline-flex; align-items: baseline; gap: 2px; padding: 1px 5px; background: #f5f5f5; border-radius: 3px; }
  .ch-pinfo-val { font-size: 11px; font-weight: 600; color: #1a1a2e; font-family: var(--print-mono); }
  .ch-pinfo-lbl { font-size: 8px; color: #888; text-transform: uppercase; }
  .ch-pinfo-sep { color: #ccc; padding: 0 2px; font-size: 10px; }
  .ch-commute-list { display: flex; flex-direction: column; gap: 4px; }
  .ch-commute-row { display: flex; align-items: center; gap: 8px; font-size: 10px; }
  .ch-commute-label { flex: 1; color: #444; }
  .ch-commute-time { font-weight: 600; color: #1a1a2e; font-family: var(--print-mono); }
  .ch-commute-dist { color: #888; font-size: 9px; }
  .ch-afford-bars { display: flex; flex-direction: column; gap: 8px; margin-bottom: 6px; }
  .ch-afford-scenario { display: flex; flex-direction: column; gap: 2px; }
  .ch-afford-scenario-label { display: flex; justify-content: space-between; font-size: 9px; font-weight: 600; }
  .ch-afford-bar-wrap { height: 5px; background: #eee; border-radius: 2px; overflow: hidden; }
  .ch-afford-bar { height: 100%; border-radius: 2px; }
  .ch-afford-scenario-nums { display: flex; gap: 8px; font-size: 8px; color: #666; }
  .ch-afford-pos { color: #1a7a42; font-weight: 600; }
  .ch-afford-neg { color: #c0392b; font-weight: 600; }
  .ch-afford-unaffordable { background: #fff5f5 !important; color: #c0392b; font-size: 9px; padding: 4px 6px; border-radius: 3px; margin-bottom: 4px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .ch-afford-totals { font-size: 8px; color: #888; margin-top: 4px; }
  .ch-afford-takehome { display: flex; align-items: baseline; gap: 6px; margin-bottom: 6px; font-size: 10px; }
  .ch-afford-takehome-val { font-weight: 700; color: #1a1a2e; }
  .ch-afford-header-row { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 4px; padding-bottom: 3px; border-bottom: 0.5px solid #eee; }
  .ch-afford-result-wrap { font-size: 11px; font-weight: 700; white-space: nowrap; }
  .ch-afford-bar-track { height: 10px; background: #f0f0f0; border-radius: 3px; overflow: hidden; display: flex; margin-bottom: 3px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .ch-afford-bar-track > div { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  .ch-afford-bar-track > div { height: 100%; }
  .ch-afford-legend { display: flex; flex-wrap: wrap; gap: 4px 8px; font-size: 8px; color: #555; margin-bottom: 4px; }
  .ch-afford-legend-item { display: flex; align-items: center; gap: 2px; }
  .ch-afford-legend-dot { width: 6px; height: 6px; border-radius: 2px; }
  .ch-sens-wrap { margin-top: 4px; padding-top: 3px; border-top: 0.5px solid #eee; }
  .ch-sens-title { font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #888; margin-bottom: 3px; }
  .ch-sens-table { width: 100%; border-collapse: collapse; font-size: 9px; table-layout: fixed; }
  .ch-sens-table th:first-child, .ch-sens-table td:first-child { width: 40%; text-align: left; }
  .ch-sens-table th { text-align: right; font-size: 7px; font-weight: 600; color: #888; text-transform: uppercase; padding: 2px 4px 2px 0; border-bottom: 0.5px solid #eee; }
  .ch-sens-table td { padding: 2px 4px 2px 0; border-bottom: 0.5px solid #f5f5f5; }
  .ch-sens-num { text-align: right; font-variant-numeric: tabular-nums; }
  .ch-afford-header-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 3px; padding-bottom: 2px; border-bottom: 0.5px solid #eee; }
  .ch-afford-takehome-wrap { display: flex; align-items: baseline; gap: 4px; }
  .ch-afford-result-wrap { font-size: 11px; font-weight: 700; }
  .ch-afford-takehome-val { font-size: 12px; font-weight: 700; color: #1a1a2e; }
  .ch-meta-row { font-size: 9px; color: #555; margin-bottom: 0; display: inline; }
  .ch-meta-row::after { content: '   '; white-space: pre; }
  .ch-meta-row--builder { margin-bottom: 0; }
  .ch-meta-row--stats { border-top: none; padding-top: 0; margin-top: 0; }
  .ch-prop-meta-strip { text-align: right; padding: 2px 0; margin-bottom: 4px; border-bottom: 0.5px solid #e0e0e0; }
  .section:first-child .section-body { text-align: left; }
  .section .section-body, .cols2 .section-body { text-align: left; }
  .ch-meta-chip strong { color: #1a1a2e; }
  .ch-meta-lbl { color: #999; font-size: 8px; text-transform: uppercase; }
  .ch-meta-sep { color: #ccc; margin: 0 3px; }
  .ch-opp-bullets { list-style: none; padding: 0; margin: 0; }
  .ch-opp-bullets li { font-size: 10px; line-height: 1.45; padding: 2px 0 2px 12px; position: relative; border-bottom: 0.5px solid #f0f0f0; }
  .ch-opp-bullets li:last-child { border-bottom: none; }
  .ch-opp-bullets li::before { content: '▸'; position: absolute; left: 0; color: #27ae60; font-weight: 700; font-size: 9px; }
  .ch-opp-para { border-left: 2px solid #27ae60; padding: 4px 8px; background: #f0fff4; border-radius: 3px; font-size: 10px; line-height: 1.45; }
  .ch-agent-line { font-size: 9px; color: #444; line-height: 1.5; margin-bottom: 1px; }
  .ch-agent-line strong { color: #1a1a2e; font-size: 10px; }
  .legal { font-size: 7px; color: #aaa; margin-top: 10px; padding-top: 6px; border-top: 0.5px solid #e0e0e0; line-height: 1.4; }
  .legal p { margin: 0 0 3px; }
  .footer { position: fixed; bottom: 0; left: 0; right: 0; padding: 5px 20px; border-top: 0.5px solid #e0e0e0; font-size: 8px; color: #bbb; display: flex; justify-content: space-between; background: #fff; }
  body { padding-bottom: 28px; }
  @media print { body { padding-bottom: 28px; } }
  .cols2 { columns: 2; column-gap: 16px; }
  .cols2 .section { break-inside: avoid; page-break-inside: avoid; margin-top: 0; margin-bottom: 5px; }
  .hero-photo { max-height: 100px !important; }
  @media print {
    body { padding: 0; font-size: 8.75px; line-height: 1.35; }
    p, li, div { orphans: 3; widows: 3; }
    .ch-one-liner { padding: 3px 8px !important; margin-bottom: 4px !important; }
    .ch-agent-line { margin-bottom: 2px !important; }
    .section-body { margin-top: 0 !important; }
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
    .section { break-inside: avoid; page-break-inside: avoid; }
    .cols2 { columns: 2; column-gap: 14px; }
    .hero-photo { max-height: 62px !important; width: 88px !important; }
    .legal { font-size: 6px; }
    @page { margin: 0.65cm; size: letter; }
  }
</style>
</head>
<body>
<div class="header">
  <div class="header-top">
    <div class="header-left">
      <div class="address"><span>${addr}</span><span class="address-date">Analysis Ran: ${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</span></div>
      <div class="header-price"><span class="price">${price}</span></div>
      <div class="tldr-label">${verdictLabel}</div>
      ${tldr ? `<div class="tldr">${tldr}</div>` : ''}
    </div>
    ${heroPhoto ? `<img class="hero-photo" src="${heroPhoto}" alt="${addr}" crossorigin="anonymous">` : ''}
  </div>
</div>
${sectionsHtml}
<div class="legal">
  <p>This analysis is generated with the assistance of AI and is provided for informational purposes only. It does not constitute a binding contract, professional appraisal, legal advice, or financial recommendation.</p>
  <p>All estimates, valuations, and projections are approximations based on publicly available data. Due diligence and verification are the sole responsibility of the buyer and their licensed agent or attorney.</p>
</div>
<div class="footer">
  <span>Clear Home v${chrome.runtime.getManifest().version}</span>
  <span>${location.href}</span>
</div>
<script>window.onload = () => {
  try {
    const target = 1005;
    const h = document.body.scrollHeight;
    if (h > target && h <= target * 1.4) {
      document.body.style.zoom = (target / h).toFixed(3);
    }
  } catch (e) {}
  window.print();
}<\/script>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  window.open(url, '_blank');
}

function applyTheme(theme) {
  if (!homePanel) return;
  homePanel.classList.remove('ch-light', 'ch-dark');
  if (theme === 'light') homePanel.classList.add('ch-light');
  if (theme === 'dark')  homePanel.classList.add('ch-dark');
}

const SVG_LOGO = `<svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- Roof, with eaves that overhang the walls -->
  <path d="M2.3 10.6L11 3.1L19.7 10.6" stroke="var(--accent)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
  <!-- Walls -->
  <path d="M4.9 9.4V18.7H17.1V9.4" stroke="var(--accent)" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/>
  <!-- Check, centred in the body — matches the toolbar icon -->
  <path d="M8.1 13.9L10.2 16.0L14.3 11.7" stroke="var(--accent)" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

function getPanelStyles() {
  return `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

:host {
  all: initial;
  position: fixed;
  top: 80px;
  right: 20px;
  z-index: 2147483640;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

#ch-panel {
  --bg:           #ffffff;
  --bg-2:         #f4f6fb;
  --bg-3:         #e8edf9;
  --border:       rgba(20,28,52,0.10);
  --border-2:     rgba(20,28,52,0.16);
  --text-1:       #141821;
  --text-2:       #3d465c;
  --text-3:       #6b7488;
  --text-4:       #a8b0c2;
  --green:        #1FA968;
  --amber:        #C77F18;
  --red:          #E5544E;
  --gold:         #C99A2E;
  --green-bg:     #e8f6ef;
  --amber-bg:     #fbf2e2;
  --red-bg:       #fdeceb;
  --green-text:   #0f7048;
  --amber-text:   #8a5510;
  --red-text:     #b13731;
  --accent:       #4F6BFF;
  --accent-light: #e7ebff;
  --spinner-ring: #dfe4fb;
  --spinner-tip:  #4F6BFF;
  --shadow:       0 8px 40px rgba(20,28,52,0.16), 0 1px 3px rgba(20,28,52,0.08);
  --mono:         'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace;
  --display:      'Bricolage Grotesque', 'Inter', sans-serif;

  position: relative;
  width: 340px;
  background: var(--bg);
  border: 0.5px solid var(--border-2);
  border-radius: 16px;
  box-shadow: var(--shadow);
  color: var(--text-1);
  font-size: 13px;
  line-height: 1.45;
  opacity: 0;
  transform: translateX(12px) scale(0.97);
  pointer-events: none;
  transition: opacity 0.2s ease, transform 0.2s ease;
  overflow: hidden;
  max-height: calc(100vh - 100px);
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--border-2) transparent;
}

#ch-panel.visible {
  opacity: 1;
  transform: translateX(0) scale(1);
  pointer-events: all;
}

@media (prefers-color-scheme: dark) {
  #ch-panel:not(.ch-light) {
    --bg:           #141821;
    --bg-2:         #1b2230;
    --bg-3:         #232c3e;
    --border:       rgba(255,255,255,0.08);
    --border-2:     rgba(255,255,255,0.14);
    --text-1:       #e9edf4;
    --text-2:       #b4bccd;
    --text-3:       #8a93a6;
    --text-4:       #5a6276;
    --green:        #33C77F;
    --amber:        #F4A33A;
    --red:          #E5544E;
    --gold:         #FFCB57;
    --green-bg:     #112a20;
    --amber-bg:     #2c2008;
    --red-bg:       #2e1413;
    --green-text:   #5fdca0;
    --amber-text:   #ffbe5e;
    --red-text:     #ff8a85;
    --accent:       #5C78FF;
    --accent-light: #232c52;
    --spinner-ring: #2b3242;
    --spinner-tip:  #5C78FF;
    --shadow:       0 10px 44px rgba(0,0,0,0.6), 0 1px 4px rgba(0,0,0,0.4);
  }
}

#ch-panel.ch-dark {
  --bg:           #141821;
  --bg-2:         #1b2230;
  --bg-3:         #232c3e;
  --border:       rgba(255,255,255,0.08);
  --border-2:     rgba(255,255,255,0.14);
  --text-1:       #e9edf4;
  --text-2:       #b4bccd;
  --text-3:       #8a93a6;
  --text-4:       #5a6276;
  --green:        #33C77F;
  --amber:        #F4A33A;
  --red:          #E5544E;
  --gold:         #FFCB57;
  --green-bg:     #112a20;
  --amber-bg:     #2c2008;
  --red-bg:       #2e1413;
  --green-text:   #5fdca0;
  --amber-text:   #ffbe5e;
  --red-text:     #ff8a85;
  --accent:       #5C78FF;
  --accent-light: #232c52;
  --spinner-ring: #2b3242;
  --spinner-tip:  #5C78FF;
  --shadow:       0 10px 44px rgba(0,0,0,0.6), 0 1px 4px rgba(0,0,0,0.4);
}

.ch-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 13px;
  border-bottom: 0.5px solid var(--border);
  background: var(--bg);
  position: sticky;
  top: 0;
  z-index: 2;
  cursor: grab;
  user-select: none;
}
.ch-header:active { cursor: grabbing; }

.ch-logo {
  display: flex;
  align-items: center;
  gap: 7px;
}

.ch-title {
  font-family: var(--display);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: none;
  color: var(--text-1);
}

.ch-close {
  appearance: none;
  -webkit-appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  font-size: 12px;
  font-family: -apple-system, sans-serif;
  color: var(--text-3);
  background: transparent;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  padding: 0;
  transition: background 0.12s, color 0.12s;
}
.ch-close:hover { background: var(--bg-2); color: var(--text-1); }
.ch-gear {
  background: transparent;
  border: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 4px;
  line-height: 0;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.2s, background 0.2s, transform 0.4s;
}
.ch-gear:hover { color: var(--text-1); background: var(--bg-2); transform: rotate(72deg); }

.ch-property-bar {
  padding: 8px 13px;
  background: var(--bg-2);
  border-bottom: 0.5px solid var(--border);
}

.ch-prop-address {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
  margin-bottom: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ch-prop-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ch-prop-price {
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--text-1);
}

.ch-prop-site {
  font-size: 10px;
  color: var(--text-3);
}

.ch-fsbo-badge {
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  padding: 2px 6px;
}

.ch-mode-badge {
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.05em;
  padding: 2px 6px;
  border-radius: 4px;
  margin-left: 2px;
}
.ch-mode-badge--sold {
  background: #f3e8ff;
  color: #7c3aed;
}
.ch-mode-badge--rent {
  background: #ecfdf5;
  color: #065f46;
}
.ch-mode-badge--sale {
  background: var(--accent-light);
  color: var(--accent);
}

@media (prefers-color-scheme: dark) {
  .ch-mode-badge--sold { background: #4c1d95; color: #e9d5ff; }
  .ch-mode-badge--rent { background: #064e3b; color: #a7f3d0; }
}

.ch-status-banner {
  padding: 7px 13px 7px;
  font-size: 10.5px;
  line-height: 1.45;
  border-bottom: 0.5px solid var(--border);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-status-banner--buy  { background: var(--accent-light); color: var(--accent); }
.ch-status-banner--sold { background: #f3e8ff; color: #5b21b6; }
.ch-status-banner--rent { background: #ecfdf5; color: #065f46; }
.ch-status-banner strong { font-weight: 700; }

@media (prefers-color-scheme: dark) {
  .ch-status-banner--buy  { background: #2a2250; color: var(--accent); }
  .ch-status-banner--sold { background: #3b1c6e; color: #c4b5fd; }
  .ch-status-banner--rent { background: #064e3b; color: #6ee7b7; }
}

.ch-tldr--sold { border-left: 3px solid #7c3aed; background: #f3e8ff; }
.ch-tldr--rent { border-left: 3px solid #065f46; background: #ecfdf5; }
.ch-tldr--sold .ch-tldr-label { color: #7c3aed; }
.ch-tldr--rent .ch-tldr-label { color: #065f46; }

.ch-tldr {
  padding: 10px 13px 11px;
  border-bottom: 1.5px solid var(--border);
  background: var(--bg-1);
  transition: background 0.2s;
}
.ch-tldr-label {
  font-family: var(--mono);
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-3);
  margin-bottom: 4px;
}
.ch-tldr-text {
  font-size: 11.5px;
  font-weight: 500;
  line-height: 1.55;
  color: var(--text-1);
}
.ch-tldr--over   { border-left: 3px solid var(--red-text);   background: var(--red-bg);   }
.ch-tldr--under  { border-left: 3px solid var(--green-text); background: var(--green-bg); }
.ch-tldr--fair   { border-left: 3px solid var(--accent);     background: var(--accent-light); }
.ch-tldr--over  .ch-tldr-label  { color: var(--red-text);   }
.ch-tldr--under .ch-tldr-label  { color: var(--green-text); }
.ch-tldr--fair  .ch-tldr-label  { color: var(--accent);     }
.ch-tldr--fair  .ch-tldr-text   { color: var(--text-1);     }

.ch-propinfo-bar {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 13px;
  background: var(--bg-2);
  border-bottom: 0.5px solid var(--border);
}
.ch-pinfo-row2 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  padding-top: 2px;
  border-top: 0.5px solid var(--border);
  margin-top: 2px;
}
.ch-pinfo-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 2px 6px;
}
.ch-pinfo-val {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-1);
}
.ch-pinfo-lbl {
  font-size: 9px;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-left: 2px;
}
.ch-pinfo-chip--hoa .ch-pinfo-val { color: var(--amber-text, #b35e0a); }
.ch-pinfo-sep {
  color: var(--text-4);
  font-size: 11px;
  padding: 0 2px;
}

.ch-commute-list { display: flex; flex-direction: column; gap: 6px; }
.ch-commute-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}
.ch-commute-label { flex: 1; color: var(--text-2); font-weight: 500; }
.ch-commute-time  { font-weight: 700; color: var(--text-1); font-size: 13px; }
.ch-commute-dist  { color: var(--text-3); font-size: 10px; }

.ch-afford-takehome {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 0.5px solid var(--border);
}
.ch-afford-header-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 0.5px solid var(--border);
}
.ch-afford-takehome-wrap {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
.ch-afford-result-wrap {
  font-size: 13px;
  font-weight: 700;
  white-space: nowrap;
}
.ch-afford-takehome-val { font-size: 14px; font-weight: 700; color: var(--text-1); }
.ch-afford-single-bar { margin-bottom: 8px; }
.ch-afford-bar-track {
  height: 14px;
  background: var(--bg-3);
  border-radius: 4px;
  overflow: hidden;
  display: flex;
  margin-bottom: 4px;
}
.ch-afford-bar-track > div { transition: width 0.3s ease; }
.ch-afford-result {
  font-size: 12px;
  font-weight: 700;
  text-align: right;
}
.ch-afford-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  font-size: 9px;
  color: var(--text-2);
  margin-bottom: 6px;
}
.ch-afford-legend-item { display: flex; align-items: center; gap: 3px; }
.ch-afford-legend-dot { width: 7px; height: 7px; border-radius: 2px; flex-shrink: 0; }
.ch-afford-pos  { color: var(--green-text, #1a7a42); font-weight: 600; }
.ch-afford-neg  { color: var(--red-text, #c0392b);   font-weight: 600; }
.ch-afford-unaffordable {
  background: var(--red-bg);
  color: var(--red-text);
  font-size: 10px;
  padding: 6px 8px;
  border-radius: 5px;
  margin-bottom: 6px;
  line-height: 1.5;
}
.ch-afford-totals {
  font-size: 9px;
  color: var(--text-3);
  margin-top: 4px;
}

.ch-sens-wrap {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 0.5px solid var(--border);
}
.ch-sens-title {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--text-3);
  margin-bottom: 5px;
}
.ch-sens-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 10px;
  table-layout: fixed;
}
.ch-sens-table th:first-child,
.ch-sens-table td:first-child { width: 40%; text-align: left; }
.ch-sens-table th {
  text-align: right;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  font-size: 8px;
  letter-spacing: 0.05em;
  padding: 3px 6px 3px 0;
  border-bottom: 0.5px solid var(--border);
}
.ch-sens-table td {
  padding: 4px 6px 4px 0;
  color: var(--text-1);
  border-bottom: 0.5px solid var(--border);
}
.ch-sens-table tr:last-child td { border-bottom: none; }
.ch-sens-num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--mono); }

.ch-prop-meta-strip {
  padding: 8px 13px 6px;
  border-bottom: 0.5px solid var(--border);
}

.ch-highlights-section { border-bottom: 1.5px solid var(--border); }

.ch-meta-row {
  font-size: 10px;
  line-height: 1.5;
  color: var(--text-2);
  margin-bottom: 2px;
  word-break: break-word;
}
.ch-meta-row--builder {
  margin-bottom: 3px;
}
.ch-meta-row--stats {
  margin-top: 1px;
  padding-top: 3px;
  border-top: 0.5px solid var(--border);
}
.ch-meta-chip {
  display: inline;
  white-space: normal;
}
.ch-meta-chip strong {
  color: var(--text-1);
  font-weight: 700;
}
.ch-meta-lbl {
  color: var(--text-3);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.ch-meta-sep {
  color: var(--text-4);
  margin: 0 4px;
}

.ch-highlights-list {
  list-style: none;
  padding: 0;
  margin: 4px 0 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.ch-highlight-item {
  font-size: 11px;
  color: var(--text-1);
  line-height: 1.5;
  padding-left: 14px;
  position: relative;
}
.ch-highlight-item::before {
  content: '→';
  position: absolute;
  left: 0;
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
}

.ch-analyzing-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--mono);
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--accent);
  padding: 2px 6px;
  background: var(--accent-light);
  border-radius: 4px;
  margin-left: 2px;
}

.ch-activity {
  padding: 8px 13px 10px;
  border-bottom: 0.5px solid var(--border);
  min-height: 60px;
}
.ch-activity-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 140px;
  overflow: hidden;
}
.ch-activity-item {
  font-size: 10px;
  color: var(--text-2);
  padding: 2px 0;
  opacity: 1;
  transition: opacity 0.3s;
  display: flex;
  align-items: center;
  gap: 6px;
}
.ch-activity-item::before {
  content: '';
  display: inline-block;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
  opacity: 0.7;
}
.ch-activity-item--new {
  opacity: 0;
}

@keyframes ch-spin { to { transform: rotate(360deg); } }

.ch-trigger-body {
  padding: 16px 14px 18px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.ch-trigger-addr {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
  text-align: center;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ch-run-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 10px;
  font-family: 'Inter', sans-serif;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.01em;
  padding: 10px 20px;
  cursor: pointer;
  transition: opacity 0.15s, transform 0.1s, box-shadow 0.15s;
  box-shadow: 0 2px 10px rgba(79,107,255,0.28);
  width: 100%;
}
.ch-run-btn:hover { opacity: 0.92; box-shadow: 0 4px 16px rgba(79,107,255,0.36); }
.ch-run-btn:active { opacity: 0.85; transform: translateY(1px); }
.ch-run-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  animation: ch-pulse 1.2s ease-in-out infinite;
}
@keyframes ch-pulse {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 0.85; }
}
.ch-trigger-note {
  font-size: 9px;
  color: var(--text-3);
  letter-spacing: 0.03em;
}

.ch-results {}

.ch-section {
  border-bottom: 0.5px solid var(--border);
}

.ch-section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 13px;
  cursor: default;
}

.ch-section-icon { font-size: 13px; flex-shrink: 0; }

.ch-section-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--text-1);
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ch-section-status {
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 2px 7px;
  border-radius: 4px;
  white-space: nowrap;
  flex-shrink: 0;
}
.ch-section-status--over     { background: var(--red-bg);    color: var(--red-text);   }
.ch-section-status--under    { background: var(--green-bg);   color: var(--green-text); }
.ch-section-status--fair     { background: var(--accent-light); color: var(--accent);     }
.ch-section-status--warn     { background: var(--amber-bg);   color: var(--amber-text); }
.ch-section-status--ok       { background: var(--green-bg);   color: var(--green-text); }
.ch-section-status--neutral  { background: var(--bg-2);       color: var(--text-3);     }
.ch-section-status--good     { background: #e8f5e9;           color: #2e7d32;           }

.ch-section-spacer { flex: 1; }

.ch-toggle {
  appearance: none;
  background: none;
  border: none;
  font-size: 10px;
  color: var(--text-3);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
  transition: background 0.1s;
}
.ch-toggle:hover { background: var(--bg-2); }

.ch-section-body {
  padding: 4px 13px 12px;
  overflow: hidden;
}

.ch-section-body.collapsed {
  display: none;
}

.ch-valuation-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.ch-val-label {
  font-size: 10px;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.ch-val-range {
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 700;
  color: var(--text-1);
}

.ch-status-chip {
  display: inline-block;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 4px 12px;
  border-radius: 20px;
  margin-bottom: 8px;
}

.ch-status--over  { background: var(--red-bg);   color: var(--red-text);   }
.ch-status--under { background: var(--green-bg);  color: var(--green-text); }
.ch-status--fair  { background: var(--bg-3);      color: var(--accent);     }

.ch-ppsq-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--text-3);
  margin-bottom: 6px;
  flex-wrap: wrap;
}

.ch-ppsq-val { color: var(--text-2); flex: 1; }

.ch-ppsq-verdict {
  font-size: 9px;
  font-weight: 700;
  font-family: var(--mono);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 3px;
}

.ch-ppsq-verdict--below-market   { background: var(--green-bg);  color: var(--green-text); }
.ch-ppsq-verdict--at-market      { background: rgba(39,174,96,.15); color: #1a7a42; }
.ch-ppsq-verdict--above-market   { background: var(--amber-bg);  color: var(--amber-text, #b35e0a); }
.ch-ppsq-verdict--well-overpriced{ background: var(--red-bg);    color: var(--red-text); }

.ch-rationale {
  font-size: 10px;
  color: var(--text-2);
  font-style: italic;
  margin-bottom: 5px;
  line-height: 1.5;
}

.ch-confidence {
  font-size: 10px;
  color: var(--text-3);
}

.ch-one-liner {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-1);
  font-weight: 500;
  padding: 7px 10px;
  background: var(--bg-2);
  border-radius: 7px;
  border-left: 3px solid var(--accent);
  line-height: 1.45;
}

.ch-opp-bullets {
  list-style: none;
  padding: 0;
  margin: 0 0 8px;
}
.ch-opp-bullets li {
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--text-1);
  padding: 3px 0 3px 14px;
  position: relative;
  border-bottom: 0.5px solid var(--border);
}
.ch-opp-bullets li:last-child { border-bottom: none; }
.ch-opp-bullets li::before {
  content: '▸';
  position: absolute;
  left: 0;
  color: var(--green-text, #1a7a42);
  font-size: 10px;
  font-weight: 700;
}
.ch-opp-para {
  font-size: 10.5px;
  line-height: 1.55;
  color: var(--text-2);
  padding: 6px 10px;
  border-left: 3px solid var(--green);
  background: var(--green-bg);
  border-radius: 4px;
}

.ch-risk {
  margin-bottom: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  border-left: 3px solid transparent;
}

.ch-risk--high   { background: var(--red-bg);   border-color: var(--red);   }
.ch-risk--medium { background: var(--amber-bg);  border-color: var(--amber); }
.ch-risk--low    { background: var(--bg-2);      border-color: var(--text-4);}

.ch-risk-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.ch-risk-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.ch-risk--high   .ch-risk-dot { background: var(--red);   }
.ch-risk--medium .ch-risk-dot { background: var(--amber); }
.ch-risk--low    .ch-risk-dot { background: var(--text-4);}

.ch-risk-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-1);
  flex: 1;
}

.ch-risk-badge {
  font-family: var(--mono);
  font-size: 8px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 5px;
  border-radius: 3px;
}

.ch-risk-badge--high   { background: var(--red-bg);   color: var(--red-text);   }
.ch-risk-badge--medium { background: var(--amber-bg);  color: var(--amber-text); }
.ch-risk-badge--low    { background: var(--bg-3);      color: var(--text-3);     }

.ch-risk-explanation {
  font-size: 10px;
  color: var(--text-2);
  line-height: 1.45;
}

.ch-actions-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ch-action-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 11px;
  color: var(--text-2);
  line-height: 1.45;
}

.ch-action-check {
  color: var(--accent);
  font-size: 12px;
  flex-shrink: 0;
  margin-top: 0px;
}

.ch-print-bar {
  padding: 10px 13px 14px;
  border-top: 0.5px solid var(--border);
  display: flex;
  gap: 8px;
}
.ch-print-btn {
  width: 100%;
  padding: 8px;
  background: var(--bg-2);
  border: 0.5px solid var(--border);
  border-radius: 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
  font-family: -apple-system, sans-serif;
}
.ch-print-btn:hover { background: var(--accent-light); color: var(--accent); }
.ch-downloadlogs-btn { color: var(--text-3); }
.ch-downloadlogs-btn:hover { background: var(--bg-3, var(--bg-2)); color: var(--text-1); }
@media print { .ch-print-bar { display: none !important; } }

.ch-fsbo-section {
  border-top: 0.5px solid var(--border);
  border-bottom: none;
}

.ch-empty-state {
  font-size: 10px;
  color: var(--text-3);
  font-style: italic;
  padding: 4px 0;
}

.ch-afford-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
  margin-bottom: 8px;
}

.ch-comp-grid {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.ch-comp-box {
  background: var(--bg-2);
  border-radius: 7px;
  padding: 7px 8px;
  border-left: 3px solid var(--border);
}
.ch-comp-addr {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 3px;
}
.ch-comp-link {
  color: var(--accent, #5b8def);
  text-decoration: none;
  font-weight: 600;
}
.ch-comp-link:hover { text-decoration: underline; }
.ch-comp-box--link { cursor: pointer; }
.ch-comp-box--link:hover { border-color: var(--accent, #5b8def); background: var(--accent-light, rgba(91,141,239,0.06)); }
.ch-comp-stats {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.ch-comp-price {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-1);
}
.ch-comp-detail {
  font-size: 10px;
  color: var(--text-2);
}
.ch-comp-ppsq {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-2);
  margin-left: auto;
}
.ch-comp-pos {
  font-size: 9px;
  font-weight: 600;
  margin-top: 3px;
  padding: 1px 5px;
  border-radius: 4px;
  display: inline-block;
}
.ch-comp-pos--over   { background: var(--red-bg, rgba(192,57,43,.12));   color: var(--red-text, #c0392b); }
.ch-comp-pos--under  { background: var(--green-bg, rgba(39,174,96,.12));  color: var(--green-text, #27ae60); }
.ch-comp-pos--fair   { background: var(--amber-bg, rgba(230,126,34,.12)); color: var(--amber, #e67e22); }
.ch-comp-expand {
  width: 100%;
  margin-top: 5px;
  padding: 5px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-2);
  cursor: pointer;
  text-align: center;
}
.ch-comp-expand:hover { background: var(--bg-3, var(--bg-2)); color: var(--text-1); }

.ch-afford-item {
  background: var(--bg-2);
  border-radius: 7px;
  padding: 6px 6px 5px;
  text-align: center;
}

.ch-afford-label {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-3);
  margin-bottom: 3px;
}

.ch-afford-num {
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--text-1);
  line-height: 1.2;
}

.ch-piti-total {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--bg-2);
  border-radius: 7px;
  padding: 7px 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-1);
}

.ch-risk-item {
  border-left: 2.5px solid var(--border);
  padding: 6px 8px;
  border-radius: 0 6px 6px 0;
  margin-bottom: 6px;
}

.ch-afford-total {
  font-size: 11px;
  color: var(--text-2);
  margin-top: 6px;
  margin-bottom: 4px;
}
.ch-afford-total strong { color: var(--text-1); }
.ch-dti-warn { color: var(--amber) !important; }

.ch-appreciation-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.ch-appr-label { font-size: 10px; color: var(--text-3); }
.ch-appr-val   { font-family: var(--mono); font-size: 11px; font-weight: 700; color: var(--text-1); }
.ch-appr-high  { color: var(--amber); }

.ch-pha-stat-row {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}
.ch-pha-stat {
  flex: 1;
  background: var(--bg-2);
  border-radius: 6px;
  padding: 5px 8px;
  text-align: center;
  min-width: 0;
}
.ch-pha-stat-lbl {
  font-size: 8px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--text-3);
  margin-bottom: 1px;
  line-height: 1.3;
  word-break: break-word;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-pha-stat-val {
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 700;
  color: var(--text-1);
  white-space: nowrap;
}

.ch-mls-row {
  display: flex;
  align-items: baseline;
  gap: 5px;
  margin-bottom: 7px;
  padding-bottom: 6px;
  border-bottom: 0.5px solid var(--border);
}
.ch-mls-label {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-3);
}
.ch-mls-num {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-1);
  font-family: var(--mono);
}
.ch-mls-source {
  font-size: 10px;
  color: var(--text-3);
}
.ch-agent-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
}
.ch-agent-row-full {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 3px;
}
.ch-agent-name { font-size: 11px; font-weight: 600; color: var(--text-1); }
.ch-agent-brokerage { font-size: 10px; color: var(--text-3); margin-bottom: 4px; }
.ch-agent-line {
  font-size: 10px;
  color: var(--text-2);
  line-height: 1.6;
  margin-bottom: 2px;
}
.ch-agent-line strong { color: var(--text-1); font-size: 11px; }

.ch-agent-status {
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  padding: 2px 7px;
  border-radius: 4px;
}
.ch-agent-status--active     { background: var(--green-bg);  color: var(--green-text); }
.ch-agent-status--inactive   { background: var(--red-bg);    color: var(--red-text);   }
.ch-agent-status--unverified { background: var(--amber-bg);  color: var(--amber-text); }

.ch-tax-sub {
  font-size: 9px;
  color: var(--text-3);
  margin-top: 2px;
}
.ch-tax-permo {
  font-size: 10px;
  color: var(--text-3);
  font-weight: 400;
}

.ch-agent-row, .ch-model-row {
  font-size: 10px;
  color: var(--text-3);
  margin-top: 5px;
  line-height: 1.4;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ch-agent-row strong, .ch-model-row strong { color: var(--text-2); }
.ch-prop-meta {
  margin-bottom: 8px;
  padding-bottom: 7px;
  border-bottom: 0.5px solid var(--border);
}
.ch-prop-model {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
  letter-spacing: 0.01em;
  margin-bottom: 2px;
}
.ch-prop-meta-sub {
  font-size: 10px;
  color: var(--text-2);
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-meta-label {
  color: var(--text-3);
  font-weight: 500;
  margin-right: 2px;
}
.ch-meta-dot { color: var(--text-3); padding: 0 1px; }

.ch-tax-row {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
  margin-bottom: 8px;
}

.ch-tax-row.ch-stat-4 {
  grid-template-columns: repeat(2, 1fr);
}

.ch-tax-row.ch-tax-row--arrow {
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
}

.ch-tax-col {
  background: var(--bg-2);
  border-radius: 8px;
  padding: 8px 10px;
  text-align: center;
  min-width: 0;
}

.ch-tax-label {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-3);
  margin-bottom: 3px;
}

.ch-tax-val {
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 700;
  color: var(--text-1);
}

.ch-tax-val.ch-tax--warning { color: var(--amber); }

.ch-tax-arrow {
  font-size: 14px;
  color: var(--text-4);
  flex-shrink: 0;
  text-align: center;
  padding: 0 4px;
}

.ch-tax-warn-badge {
  font-size: 10px;
  font-weight: 600;
  color: var(--amber-text);
  background: var(--amber-bg);
  border-radius: 6px;
  padding: 5px 8px;
  margin-bottom: 6px;
}

.ch-error {
  display: none;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 22px 16px;
  text-align: center;
  font-size: 11px;
  color: var(--red);
}
.ch-error-icon { font-size: 20px; }

.ch-no-key {
  display: none;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 24px 20px;
  text-align: center;
}
.ch-no-key-icon { font-size: 24px; }
.ch-no-key-text { font-size: 11px; color: var(--text-2); line-height: 1.5; }
.ch-no-key-hint { font-size: 10px; color: var(--text-3); }

.ch-legal {
  padding: 10px 13px;
  font-size: 8px;
  line-height: 1.5;
  color: var(--text-4);
  border-top: 0.5px solid var(--border);
}
.ch-legal p { margin: 0 0 4px; }
.ch-legal p:last-child { margin-bottom: 0; }

.ch-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 13px;
  border-top: 0.5px solid var(--border);
  background: var(--bg);
  position: sticky;
  bottom: 0;
}

.ch-footer-brand {
  font-size: 10px;
  color: var(--text-4);
}

.ch-footer-disclaimer {
  font-size: 9px;
  color: var(--text-4);
  font-style: italic;
}

  `;
}
