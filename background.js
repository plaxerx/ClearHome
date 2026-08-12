// Clear Home — Background Service Worker v1.4.1

// Debug logging gate — set to true to surface internal fetch-failure logs in the
// service worker console. Off by default to keep the console clean in production.
const CH_DEBUG = false;
function chDebug(...args) { if (CH_DEBUG) { try { console.log(...args); } catch (e) {} } }

// ── State ─────────────────────────────────────────────────────────────────────
let settings = {
  enabled: true,
  theme: 'system',
  apiKey: '',
  apiKeys: { anthropic: '', openai: '' }
};

// Load persisted settings
chrome.storage.sync.get(['ch_enabled', 'ch_theme'], (res) => {
  settings.enabled = res.ch_enabled !== false;
  settings.theme   = res.ch_theme || 'system';
});
// Provider API keys are device-only (storage.local). Migrate the legacy
// Anthropic-only key without ever syncing either secret.
chrome.storage.local.get(['ch_api_key', 'ch_api_keys'], (loc) => {
  settings.apiKeys = { anthropic: loc.ch_api_keys?.anthropic || loc.ch_api_key || '', openai: loc.ch_api_keys?.openai || '' };
  settings.apiKey = settings.apiKeys.anthropic;
  if (loc.ch_api_keys || loc.ch_api_key) return;
  chrome.storage.sync.get(['ch_api_key'], (syn) => {
    if (syn.ch_api_key) {
      settings.apiKey = syn.ch_api_key;
      settings.apiKeys.anthropic = syn.ch_api_key;
      chrome.storage.local.set({ ch_api_key: syn.ch_api_key, ch_api_keys: settings.apiKeys });
      chrome.storage.sync.remove('ch_api_key');
    }
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (changes.ch_enabled)  settings.enabled = changes.ch_enabled.newValue;
  if (changes.ch_theme)    settings.theme   = changes.ch_theme.newValue;
  if (changes.ch_api_key && area === 'local') settings.apiKey = changes.ch_api_key.newValue;
  if (changes.ch_api_keys && area === 'local') settings.apiKeys = changes.ch_api_keys.newValue || { anthropic: '', openai: '' };
});

// Read the selected provider's key. The callback also receives the provider so
// content scripts can choose the matching wire format.
function getStoredApiKey(cb) {
  chrome.storage.local.get(['ch_api_key', 'ch_api_keys'], (loc) => {
    chrome.storage.sync.get(['ch_api_key', 'ch_prefs'], (syn) => {
      const provider = syn.ch_prefs?.aiProvider === 'openai' ? 'openai' : 'anthropic';
      const keys = { anthropic: loc.ch_api_keys?.anthropic || loc.ch_api_key || syn.ch_api_key || '', openai: loc.ch_api_keys?.openai || '' };
      if (!loc.ch_api_keys || syn.ch_api_key) {
        chrome.storage.local.set({ ch_api_keys: keys, ch_api_key: keys.anthropic });
        chrome.storage.sync.remove('ch_api_key');
      }
      cb(keys[provider] || '', provider);
    });
  });
}

// ── Message router ────────────────────────────────────────────────────────────
// NOTE: Must return true at the TOP LEVEL (not inside a branch) for async
// responses to work correctly in MV3 service workers.
// ── Extension icon click — toggle panel on active tab ────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
  } catch(e) {
    // Content script not yet injected (e.g. page just loaded) — inject and retry
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
    } catch(e2) {}
  }
});

// ── Fed Funds Rate — cached, fetched from FRED API (infrequent updates) ─────
// Investor mortgage rate = fed funds rate + 2.75% spread
const FED_FUNDS_SPREAD = 2.75;
const FED_FUNDS_FALLBACK = 3.625; // fallback if fetch fails (fed funds 3.5-3.75% as of early 2026)
let _fedFundsCache = null;  // { rate, fetchedAt }

async function getFedFundsRate() {
  const ONE_DAY = 86400000;
  if (_fedFundsCache && Date.now() - _fedFundsCache.fetchedAt < ONE_DAY) {
    return _fedFundsCache.rate;
  }
  // Try Chrome storage first (persists across SW restarts)
  try {
    const stored = await chrome.storage.local.get('ch_fed_funds');
    if (stored.ch_fed_funds?.rate && Date.now() - stored.ch_fed_funds.fetchedAt < ONE_DAY) {
      _fedFundsCache = stored.ch_fed_funds;
      return _fedFundsCache.rate;
    }
  } catch(e) {}
  // Fetch from FRED (St. Louis Fed) — FEDFUNDS series, latest observation
  try {
    // FRED public data API — no key required for FEDFUNDS
    const res = await fetch(
      'https://fred.stlouisfed.org/graph/fredgraph.csv?id=FEDFUNDS',
      { signal: AbortSignal.timeout(6000) }
    );
    if (res.ok) {
      const csv = await res.text();
      // CSV format: DATE,VALUE — last line is most recent
      const lines = csv.trim().split('\n').filter(l => l && !l.startsWith('DATE'));
      const last  = lines[lines.length - 1];
      const rate  = last ? parseFloat(last.split(',')[1]) : null;
      if (rate && rate > 0) {
        _fedFundsCache = { rate, fetchedAt: Date.now() };
        chrome.storage.local.set({ ch_fed_funds: _fedFundsCache }).catch(() => {});
        return rate;
      }
    }
  } catch(e) {}
  // Fallback
  return FED_FUNDS_FALLBACK;
}

// ── 30-yr fixed mortgage rate — FRED MORTGAGE30US (Freddie Mac PMMS) ──────────
// Used as the DEFAULT when the user hasn't entered their own rate in settings.
// NON-BLOCKING: returns a cached value or an instant fallback so it can never
// stall prompt-building (a slow/hung FRED fetch previously risked the SW being
// evicted mid-build → perpetual analysis spinner). A fresh value is fetched in
// the background and used on the next analysis.
let _mortgageRateCache = null; // { rate, fetchedAt }
let _mortgageFetchInFlight = false;
function refreshMortgageRateInBackground() {
  if (_mortgageFetchInFlight) return;
  _mortgageFetchInFlight = true;
  (async () => {
    try {
      const res = await fetch(
        'https://fred.stlouisfed.org/graph/fredgraph.csv?id=MORTGAGE30US',
        { signal: AbortSignal.timeout(6000) }
      );
      if (res.ok) {
        const csv = await res.text();
        const lines = csv.trim().split('\n').filter(l => l && !l.startsWith('DATE'));
        for (let i = lines.length - 1; i >= 0; i--) {
          const v = parseFloat((lines[i].split(',')[1] || '').trim());
          if (v && v > 0) {
            _mortgageRateCache = { rate: v, fetchedAt: Date.now() };
            chrome.storage.local.set({ ch_mortgage_rate: _mortgageRateCache }).catch(() => {});
            break;
          }
        }
      }
    } catch (e) { /* keep prior cache/fallback */ }
    finally { _mortgageFetchInFlight = false; }
  })();
}

async function getMortgageRate() {
  const ONE_DAY = 24 * 60 * 60 * 1000;
  // 1) In-memory cache (fresh) → instant
  if (_mortgageRateCache && Date.now() - _mortgageRateCache.fetchedAt < ONE_DAY) {
    return _mortgageRateCache.rate;
  }
  // 2) Persisted cache → instant (and warm the in-memory copy)
  try {
    const stored = await chrome.storage.local.get('ch_mortgage_rate');
    if (stored.ch_mortgage_rate?.rate > 0) {
      _mortgageRateCache = stored.ch_mortgage_rate;
      const stale = Date.now() - _mortgageRateCache.fetchedAt >= ONE_DAY;
      if (stale) refreshMortgageRateInBackground(); // refresh for next time, don't block now
      return _mortgageRateCache.rate;
    }
  } catch (e) {}
  // 3) No cache at all → kick off a background fetch and return an instant fallback
  refreshMortgageRateInBackground();
  try {
    const ff = await getFedFundsRate(); // already cached/fast with its own fallback
    if (ff && ff > 0) return Math.round((ff + 3.0) * 1000) / 1000;
  } catch (e) {}
  return 6.875; // safe constant fallback
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OPEN_SETTINGS') {
    chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
    return;
  }

  if (msg.type === 'SCROLL_PAGE_DOWN') {
    const tabId = sender.tab?.id;
    if (tabId) {
      chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          let count = 0;
          const t = setInterval(() => {
            window.scrollBy(0, 60);
            count++;
            if (count >= 500) clearInterval(t); // 500 × 60px = 30,000px
          }, 25);
        }
      }).catch(() => {});
    }
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'SCROLL_PAGE_TOP') {
    const tabId = sender.tab?.id;
    if (tabId) {
      chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => window.scrollTo(0, 0)
      }).catch(() => {});
    }
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'SCROLL_PAGE_TO') {
    const tabId = sender.tab?.id;
    if (tabId) {
      chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (y) => window.scrollTo(0, y),
        args: [msg.y || 0]
      }).catch(() => {});
    }
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'GET_ENABLED') {
    sendResponse({ enabled: settings.enabled });
    return false;
  }
  if (msg.type === 'GET_THEME') {
    sendResponse({ theme: settings.theme });
    return false;
  }
  if (msg.type === 'GET_API_KEY') {
    // Re-read from storage directly to avoid stale in-memory value
    getStoredApiKey((apiKey, provider) => {
      sendResponse({ apiKey, provider });
    });
    return true; // async
  }
  if (msg.type === 'GET_PROFILE') {
    chrome.storage.sync.get(['ch_profile', 'ch_priorities', 'ch_prefs', 'ch_commute'], (res) => {
      const _p = res.ch_profile || {};
      _p.priorities     = res.ch_priorities || [];
      _p.prefs          = res.ch_prefs      || {};
      _p.commuteAddrs   = res.ch_commute    || {};
      sendResponse({ profile: _p });
    });
    return true;
  }
  if (msg.type === 'PING') {
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'DOWNLOAD_LOGS') {
    // Robust download via the downloads API (bypasses page CSP that can block
    // blob/anchor downloads inside the Zillow page).
    try {
      const payload = msg.text != null ? msg.text : (msg.json || '{}');
      const mime = msg.text != null ? 'text/plain' : 'application/json';
      const dataUrl = 'data:' + mime + ';charset=utf-8,' + encodeURIComponent(payload);
      chrome.downloads.download({
        url: dataUrl,
        filename: msg.filename || 'clearhome-logs.txt',
        saveAs: true,
      }, (id) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, id });
        }
      });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return true; // async
  }
  if (msg.type === 'ANALYZE_PROPERTY') {
    getStoredApiKey((storedKey) => {
      const apiKey = storedKey || msg.apiKey || '';
      const keepAlive = setInterval(() => {
        chrome.storage.local.get('_keepalive', () => {});
        chrome.runtime.getPlatformInfo(() => {});
      }, 10000);
      analyzeProperty(msg.data, apiKey)
        .then(result => { clearInterval(keepAlive); sendResponse({ ok: true, data: result }); })
        .catch(err   => { clearInterval(keepAlive); sendResponse({ ok: false, error: err.message }); });
    });
    return true;
  }

  if (msg.type === 'ANALYZE_PROPERTY_PORT') {
    // Port-based version for long-running analyses that survive SW restarts
    // Handled via onConnect below
    return false;
  }

  // Start the slow, independent public-record lookups while the listing page is
  // still expanding. BUILD_PROMPT later reuses these exact-key promises, so no
  // data is sacrificed and the work disappears from the user's critical path.
  if (msg.type === 'PREFETCH_ANALYSIS_LOOKUPS') {
    Promise.allSettled(prefetchAnalysisLookups(msg.data || {}))
      .then(() => sendResponse({ ok: true }));
    return true; // keep the service worker and message channel alive for the fetches
  }

  // ── New: prompt build + finalize split (content.js calls API directly) ──────
  if (msg.type === 'BUILD_PROMPT') {
    // Build prompts in SW (all pre-computation here), content.js does the fetch.
    // Keep the service worker alive during the async build (which includes a FRED
    // mortgage-rate fetch) so sendResponse always fires — otherwise the content
    // script's promise hangs and the analysis spinner spins forever.
    const { data, apiKey } = msg;
    const keepAlive = setInterval(() => {
      chrome.storage.local.get('_keepalive', () => {});
      chrome.runtime.getPlatformInfo(() => {});
    }, 10000);
    analyzeProperty(data, apiKey)
      .then(result => { clearInterval(keepAlive); sendResponse({ ok: true, ...result }); })
      .catch(err   => { clearInterval(keepAlive); sendResponse({ ok: false, error: err.message }); });
    return true;
  }

  if (msg.type === 'FINALIZE_RESULT') {
    // Parse and post-process the raw API response text
    const { rawText, mode, meta } = msg;
    try {
      let result;
      if (mode === 'sold') {
        result = finalizeSoldResult(rawText, meta);
      } else if (mode === 'rent') {
        result = finalizeRentResult(rawText);
      } else {
        // Buy: parse + inject pre-computed fields
        let clean = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        // Strip any preamble text before the first { and postamble after the last }
        const firstBrace = clean.indexOf('{');
        const lastBrace = clean.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) {
          clean = clean.slice(firstBrace, lastBrace + 1);
        }
        const truncated = msg.truncated || false;
        try {
          result = JSON.parse(clean);
        } catch(e) {
          result = attemptJsonRecovery(clean);
          if (result) { result._diag = result._diag || {}; result._diag.jsonRecovery = 'attemptJsonRecovery'; }
          if (!result) {
            const jsonObjects = clean.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g) || [];
            for (const obj of jsonObjects) {
              try { result = JSON.parse(obj); if (result.valuation || result.keyHighlights) break; } catch(e2) {}
            }
            if (result) { result._diag = result._diag || {}; result._diag.jsonRecovery = 'object-scan'; }
            if (!result) { sendResponse({ ok: false, error: 'PARSE_ERROR: AI response could not be parsed. Try reloading the page and running again.' }); return true; }
          }
          // If we recovered partial data, mark it as truncated
          if (result._partialRecovery) result._truncated = true;
        }
        if (truncated) result._truncated = true;
        // Re-inject pre-computed fields
        const m = meta || {};
        if (!result.taxEstimate) result.taxEstimate = {};
        result.taxEstimate.currentAnnual       = m.latestTax;
        result.taxEstimate.assessedValue       = m.currentAssessed;
        result.taxEstimate.estimatedAfterReset = m.taxAfterReset;
        result.taxEstimate.estimatedMonthly    = Math.round((m.taxAfterReset||0) / 12);
        result.taxEstimate.taxWillIncrease     = m.taxWillIncrease;
        result.taxEstimate.increaseWarning     = m.taxWillIncrease;
        result.taxEstimate.rateUsed            = m.taxRateUsed;       // effective rate for client PITI
        result.taxEstimate.exemptionTotal      = m.totalExemption;    // homestead + transfer
        result.taxEstimate.rateBasis           = m.taxRateBasis;
        // JS-owned standard prose (omitted from the AI schema to save tokens)
        if (m.homesteadResetNote) result.taxEstimate.homesteadResetNote = m.homesteadResetNote;
        if (!result.affordability) result.affordability = {};
        Object.assign(result.affordability, m.affordability || {});
        // ── Offer math is JS-owned: overwrite whatever the AI produced ──
        // The AI only writes the prose rationale; the numbers come from computeOfferPrice.
        const oc = m.offerCalc;
        if (oc) {
          if (!result.buyerOpportunity) result.buyerOpportunity = {};
          result.buyerOpportunity.fairValue        = oc.fairValue;
          result.buyerOpportunity.suggestedOffer   = oc.suggestedOffer;
          result.buyerOpportunity.aggressivenessPct = oc.finalAggressiveness;
          result.buyerOpportunity.offerStrategy    = oc.strategy;
          // marketBottom = our computed lowest-defensible anchor (FHFA/comp blend).
          // Exposed separately so the UI can label it distinctly from valuation.low/high.
          result.buyerOpportunity.marketBottom     = oc.fairValue;
          if (Array.isArray(oc.motivationSignals) && oc.motivationSignals.length) {
            result.buyerOpportunity.motivationSignals = oc.motivationSignals;
          }
          if (!result.pricePerSqft) result.pricePerSqft = {};
          if (oc.offerPpsf)      result.pricePerSqft.premiumAdjusted = oc.offerPpsf;
          if (oc.compMedianPpsf) result.pricePerSqft.estimatedMarket = oc.compMedianPpsf;
          if (m.pricePerSqft)    result.pricePerSqft.listed = m.pricePerSqft;

          // JS-owned market-position verdict: LISTED $/sqft vs comp median. The AI
          // kept measuring from the offer (which is always below market by design),
          // so compute it deterministically here from the asking price.
          try {
            const listedPpsf = Number(result.pricePerSqft.listed) || 0;
            const marketPpsf = Number(result.pricePerSqft.estimatedMarket) || 0;
            if (listedPpsf > 0 && marketPpsf > 0) {
              const pct = (listedPpsf - marketPpsf) / marketPpsf * 100;
              result.pricePerSqft.verdict =
                pct > 15 ? 'Well Overpriced' :
                pct > 5  ? 'Above Market'   :
                pct < -5 ? 'Below Market'   : 'At Market';
              result.pricePerSqft.listedVsMarketPct = Math.round(pct * 10) / 10;
              // Make the commentary explain the badge's asking-price basis.
              if (result.premiumAnalysis?.explanation) {
                const position = result.pricePerSqft.verdict.toLowerCase();
                const clause = `The asking price is ${position} versus the comp median on a price-per-square-foot basis.`;
                if (!/asking price.*comp median/i.test(result.premiumAnalysis.explanation)) {
                  result.premiumAnalysis.explanation = `${result.premiumAnalysis.explanation.trim()} ${clause}`;
                }
              }
            }
          } catch (e) {}
          if (!result.comparableAnalysis) result.comparableAnalysis = {};
          if (oc.compMedianPpsf) result.comparableAnalysis.medianPricePerSqft = oc.compMedianPpsf;

          // Keep tax badges, numbers, and prose on the Clear Home offer basis.
          if (result.taxEstimate && oc.suggestedOffer > 0) {
            const taxAtOffer = Math.round(Math.max(0, oc.suggestedOffer - (Number(m.totalExemption) || 0)) * ((m.taxRateUsed > 0) ? m.taxRateUsed : 0.0165));
            const currentTax = Number(result.taxEstimate.currentAnnual) || Number(m.latestTax) || 0;
            result.taxEstimate.estAssessed = Math.max(0, oc.suggestedOffer - (Number(m.totalExemption) || 0));
            result.taxEstimate.estimatedAfterReset = taxAtOffer;
            result.taxEstimate.estimatedMonthly = Math.round(taxAtOffer / 12);
            result.taxEstimate.taxWillIncrease = currentTax > 0 && taxAtOffer > currentTax;
            result.taxEstimate.taxWillStayFlat = currentTax > 0 && taxAtOffer <= currentTax;
            result.taxEstimate.increaseWarning = result.taxEstimate.taxWillIncrease;
            const delta = taxAtOffer - currentTax;
            result.taxEstimate.note = currentTax > 0
              ? `At the $${Number(oc.suggestedOffer).toLocaleString()} Clear Home offer, estimated annual property tax is $${taxAtOffer.toLocaleString()} (${delta > 0 ? '+' : ''}$${delta.toLocaleString()} versus the current bill).`
              : `At the $${Number(oc.suggestedOffer).toLocaleString()} Clear Home offer, estimated annual property tax is $${taxAtOffer.toLocaleString()}.`;
          }

          // ── PITI consistency sweep (JS owns the numbers) ──────────────────
          // The AI is told to cite PITI at the suggested offer, but its arithmetic
          // drifts (observed: $4,021 vs the correct figure). Compute PITI at the
          // offer here and force-replace any $ figure adjacent to "PITI" in prose.
          try {
            const af = m.affordability || {};
            const ratePct = Number(af.mortgageRatePct) || 6;
            const dpPct   = Number(af.downPaymentPct)  || 20;
            const termYrs = /15\s*yr/.test(af.assumptions || '') ? 15 : 30;
            const offer   = Number(oc.suggestedOffer) || 0;
            if (offer > 0) {
              const loan = offer * (1 - dpPct / 100);
              const r = ratePct / 100 / 12, n = termYrs * 12;
              const pi = r > 0 ? Math.round(loan * r / (1 - Math.pow(1 + r, -n))) : Math.round(loan / n);
              // Recompute tax + insurance AT THE OFFER PRICE (not the list-price
              // affordability figures) so this matches the client UI's PITI bar,
              // which also computes everything at the offer. Same formula both sides.
              const taxRate   = (m.taxRateUsed > 0) ? m.taxRateUsed : 0.0165;
              const exemption = Number(m.totalExemption) || 0;
              const taxAtOffer = Math.round(Math.max(0, offer - exemption) * taxRate / 12);
              const insPctAnnual = Number(af.insurancePct) || 0;
              const insAtOffer = insPctAnnual > 0 ? Math.round(offer * (insPctAnnual / 100) / 12)
                                                  : (Number(af.monthlyInsurance) || 150);
              const hoa = Number(af.monthlyHoa) || 0;
              const pitiAtOffer = pi + taxAtOffer + insAtOffer + hoa;
              result.affordability = result.affordability || {};
              result.affordability.pitiAtOffer = pitiAtOffer;
              result._diag.offer.pitiAtOffer = pitiAtOffer;
              const fixed = '$' + pitiAtOffer.toLocaleString();
              const sweep = s => typeof s === 'string'
                ? s.replace(/(PITI[^$\n]{0,60})\$[\d,]+/gi, (_, a) => a + fixed)
                   .replace(/\$[\d,]+((?:[^.\n$]{0,40})PITI)/gi, (_, b) => fixed + b)
                : s;
              if (Array.isArray(result.keyHighlights)) result.keyHighlights = result.keyHighlights.map(sweep);
              if (result.oneLineSummary) result.oneLineSummary = sweep(result.oneLineSummary);
              if (result.buyerOpportunity.headline) result.buyerOpportunity.headline = sweep(result.buyerOpportunity.headline);
              if (result.affordability.note) result.affordability.note = sweep(result.affordability.note);
            }
          } catch (e) {}

          // ── Effective-rate phrasing sweep ─────────────────────────────────
          // The AI sometimes writes "Florida's 1.784% effective rate" as if the
          // figure were a statewide statutory rate. It's our per-property estimate,
          // so relabel "<State>'s X% effective" → "estimated X% effective".
          try {
            const rephrase = s => typeof s === 'string'
              ? s.replace(/\b(Florida|California|Texas|[A-Z][a-z]+)'s\s+(\d+(?:\.\d+)?%\s*effective)/g, 'estimated $2')
                 .replace(/\b(Florida|California|Texas)\s+(\d+(?:\.\d+)?%\s*effective\s*(?:tax\s*)?rate)/g, 'an estimated $2')
              : s;
            if (result.taxEstimate && result.taxEstimate.note) result.taxEstimate.note = rephrase(result.taxEstimate.note);
            if (result.taxEstimate && result.taxEstimate.homesteadResetNote) result.taxEstimate.homesteadResetNote = rephrase(result.taxEstimate.homesteadResetNote);
            if (Array.isArray(result.keyHighlights)) result.keyHighlights = result.keyHighlights.map(rephrase);
            if (Array.isArray(result.risks)) result.risks = result.risks.map(rephrase);
          } catch (e) {}

          // ── Diagnostics for Download Logs (rides along on the result) ──
          result._diag = result._diag || {};
          result._diag.offer = {
            fairValue: oc.fairValue, suggestedOffer: oc.suggestedOffer,
            fhfaValue: oc.fhfaValue, compValue: oc.compValue, compMedianPpsf: oc.compMedianPpsf,
            compCount: oc.compCount, usedListedHaircut: oc.usedListedHaircut, compMatchTier: oc.compMatchTier,
            zestimate: oc.zestimate, upgradePremium: oc.upgradePremium, weights: oc.weights,
            baseAggressiveness: oc.baseAggressiveness, finalAggressiveness: oc.finalAggressiveness,
            regionalModifier: oc.regionalModifier, strategy: oc.strategy, offerBasis: oc.offerBasis,
          };
          if (oc.clampDiag) {
            result._diag.fairValueClampFired = true;
            result._diag.fairValueClampInputs = oc.clampDiag;
          }
        }
        result._diag = result._diag || {};
        result._diag.tax = { rateUsed: m.taxRateUsed, exemptionTotal: m.totalExemption, rateBasis: m.taxRateBasis, afterReset: m.taxAfterReset };
        if (!result.macroAppreciation) result.macroAppreciation = {};
        Object.assign(result.macroAppreciation, {
          orlandoMsaExpectedPct: m.macroAppreciation?.orlandoMsaExpectedPct,
          orlandoExpectedPrice:  m.macroAppreciation?.orlandoExpectedPrice,
          actualAppreciationPct: m.macroAppreciation?.actualAppreciationPct,
          excessOverMarket:      m.macroAppreciation?.excessAppreciation,
          zestimateGap:          m.macroAppreciation?.zestimateGap,
          zestimateGapPct:       m.macroAppreciation?.zestimateGapPct,
          msaLabel:              m.macroAppreciation?.msaLabel,
          interpretation:        m.macroAppreciation?.interpretation,
          ...(result.macroAppreciation || {})
        });
        // Agent validation is fully JS-owned now (deterministic license lookup +
        // a fixed set of recommendation responses), so build the whole object here
        // and ignore any model output for it.
        result.agentValidation = {
          name:            m.agentName     || 'Unknown',
          brokerage:       m.brokerageName || 'Unknown',
          phone:           m.agentPhone    || null,
          licenseVerified: !!m.licenseVerifiedFinal,
          licenseStatus:   m.licenseStatusFinal || 'Unverified',
          licenseNumber:   m.agentLicenseNumber || null,
          concerns:        m.agentConcerns || null,
          recommendation:  m.agentRecommendation || ''
        };
        // Pass-through non-JSON fields for content.js use
        result._commuteResults  = m.commuteResults  || {};
        result._monthlyTakehome = m.monthlyTakehome  || 0;
        result._priceCheckMode  = m.priceCheckMode   || 'fair_value';
        result._floodInsurance  = m.floodInsurance   || false;
      }
      sendResponse({ ok: true, data: result });
    } catch(e) {
      sendResponse({ ok: false, error: e.message });
    }
    return true;
  }
  if (msg.type === 'LOG_EVENT') {
    logAnalyticsEvent(msg.event, msg.payload);
    return false;
  }
});

// ── Port-based analysis — survives service worker restarts ────────────────────
// sendMessage dies if SW is terminated mid-flight; a port connection auto-reconnects.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ch_analysis') return;
  port.onMessage.addListener((msg) => {
    if (msg.type !== 'ANALYZE') return;
    const { data, apiKey } = msg;
    const keepAlive = setInterval(() => {
      chrome.storage.local.get('_keepalive', () => {});
      chrome.runtime.getPlatformInfo(() => {});
    }, 10000);
    analyzeProperty(data, apiKey)
      .then(result => {
        clearInterval(keepAlive);
        try { port.postMessage({ ok: true, data: result }); } catch(e) {}
      })
      .catch(err => {
        clearInterval(keepAlive);
        try { port.postMessage({ ok: false, error: err.message }); } catch(e) {}
      });
  });
});

// ── Analytics logger (local) ──────────────────────────────────────────────────
function logAnalyticsEvent(event, payload = {}) {
  chrome.storage.local.get(['ch_events'], (res) => {
    const events = res.ch_events || [];
    events.push({ event, payload, ts: Date.now() });
    // Keep last 500 events
    if (events.length > 500) events.splice(0, events.length - 500);
    chrome.storage.local.set({ ch_events: events });
  });
}

// ── Utility ───────────────────────────────────────────────────────────────────
function parseNum(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(/[^0-9.]/g, '')) || 0;
}

// ── Anthropic API call ────────────────────────────────────────────────────────

// ── Landlord intel lookup ─────────────────────────────────────────────────────
// For rental listings: cross-check county property records to see if the
// landlord/listed-by name matches the deed owner of record.
// Also checks FL DBPR for CAM (Community Association Manager) license if
// it looks like a property management company.
async function fetchLandlordIntel(listingData) {
  const { address, landlordName, landlordCompany, parcelNumber } = listingData;
  const result = {
    name:            landlordName  || '',
    company:         landlordCompany || '',
    type:            listingData.isPrivateLandlord ? 'Private Owner' : 'Property Manager',
    ownerOfRecord:   '',
    ownerMatchStatus: '',
    otherListings:   0,
    licenseStatus:   '',
    scamRiskScore:   0,
    note:            ''
  };

  // ── 1. County property records — owner of record cross-check ─────────────
  try {
    // Use OCPA (Orange County) if address is in FL, similar to fetchCountyData
    const state = detectStateFromAddress(address);
    if (state === 'FL' && (parcelNumber || address)) {
      const parcel = parcelNumber || '';
      // Try OCPA parcel lookup
      const ocpaUrl = parcel
        ? `https://ocpafl.org/searches/ParcelSearch.aspx?strap=${encodeURIComponent(parcel)}`
        : `https://ocpafl.org/searches/AddressSearch.aspx?addr=${encodeURIComponent(address?.split(',')[0] || '')}`;
      const res = await fetch(ocpaUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) {
        const html = await res.text();
        // Extract owner name from OCPA result
        const ownerM = html.match(/Owner[^<]*<[^>]+>([^<]{5,80})</i);
        if (ownerM) {
          result.ownerOfRecord = ownerM[1].trim();
          // Compare: does landlord name appear in owner of record?
          const landlordWords = (landlordName || landlordCompany || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
          const ownerLower    = result.ownerOfRecord.toLowerCase();
          const matchCount    = landlordWords.filter(w => ownerLower.includes(w)).length;
          if (matchCount >= 2 || (matchCount >= 1 && landlordWords.length <= 2)) {
            result.ownerMatchStatus = 'Matches deed ✓';
          } else if (result.ownerOfRecord.toLowerCase().includes('llc') || result.ownerOfRecord.toLowerCase().includes('trust')) {
            result.ownerMatchStatus = 'LLC/Trust owner — verify identity';
            result.scamRiskScore += 1;
          } else if (landlordWords.length > 0) {
            result.ownerMatchStatus = 'Name mismatch — verify';
            result.scamRiskScore += 2;
          }
        }
      }
    }
  } catch(e) {}

  // ── 2. DBPR CAM license check (management companies in FL) ───────────────
  if (landlordCompany && !listingData.isPrivateLandlord) {
    try {
      const state = detectStateFromAddress(address);
      if (state === 'FL') {
        const csvUrl = 'https://www.myfloridalicense.com/DBPR/solutions/RealtorServices/COMMUNITYASSOCIATION2501LICENSE_1.csv';
        const res = await fetch(csvUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(8000)
        });
        if (res.ok) {
          const text    = await res.text();
          const lines   = text.split('\n');
          const company = landlordCompany.toLowerCase();
          const found   = lines.find(l => l.toLowerCase().includes(company.slice(0, 15)));
          if (found) {
            const cols = found.split(',');
            result.licenseStatus = cols[12] === 'Current' ? 'Active (CAM)' : 'Inactive (CAM)';
            if (cols[12] !== 'Current') result.scamRiskScore += 2;
          } else {
            result.licenseStatus = 'Not found in FL CAM registry';
          }
        }
      }
    } catch(e) {}
  }

  // ── 3. Scam risk signals from listing data ────────────────────────────────
  const price = listingData.price || 0;
  const rz    = listingData.rentZestimate || 0;
  if (rz > 0 && price < rz * 0.70) {
    result.scamRiskScore += 4; // Price >30% below Rent Zestimate is a major red flag
  } else if (rz > 0 && price < rz * 0.85) {
    result.scamRiskScore += 2;
  }
  if (!landlordName && !landlordCompany)         result.scamRiskScore += 2;
  if (!listingData.landlordPhone)                result.scamRiskScore += 1;
  if (listingData.daysOnMarket === 0)            result.scamRiskScore += 1; // brand new listing
  if (/wire|western union|zelle only|cash only/i.test(listingData.description || '')) {
    result.scamRiskScore += 5;
  }

  // Cap at 10
  result.scamRiskScore = Math.min(10, result.scamRiskScore);

  if (result.scamRiskScore >= 7) {
    result.note = 'Multiple risk signals detected — verify identity through independent channels before sending any payment.';
  } else if (result.scamRiskScore >= 4) {
    result.note = 'Some signals warrant verification — confirm landlord identity and property ownership before applying.';
  } else {
    result.note = 'No major red flags found, but always verify ownership independently before sending money.';
  }

  return result;
}


// ── Macro appreciation — full FHFA index + CPI fallback ────────────────────
// FHFA Orlando-Kissimmee-Sanford MSA (ATNHPIUS36740Q)
// Source: FRED, retrieved March 2026. Base: 1995:Q1=100. Current Q4 2025: 458.38
const FHFA_ORLANDO_CURRENT = 458.38;
// Keys: "YYYY-QN" → raw index value. Cumulative % computed on lookup.
const fhfaOrlandoIndex = {
  '1978-Q2':43.13,'1978-Q3':46.29,'1978-Q4':47.97,
  '1979-Q1':52.09,'1979-Q2':52.87,'1979-Q3':55.75,'1979-Q4':56.75,
  '1980-Q1':58.68,'1980-Q2':58.25,'1980-Q3':63.01,'1980-Q4':65.48,
  '1981-Q1':62.76,'1981-Q2':63.97,'1981-Q3':65.55,'1981-Q4':67.96,
  '1982-Q1':69.66,'1982-Q2':62.99,'1982-Q3':74.32,'1982-Q4':76.86,
  '1983-Q1':76.84,'1983-Q2':77.50,'1983-Q3':78.35,'1983-Q4':75.18,
  '1984-Q1':78.95,'1984-Q2':79.39,'1984-Q3':80.39,'1984-Q4':81.29,
  '1985-Q1':81.37,'1985-Q2':81.36,'1985-Q3':82.38,'1985-Q4':83.50,
  '1986-Q1':84.86,'1986-Q2':85.53,'1986-Q3':86.49,'1986-Q4':85.66,
  '1987-Q1':87.74,'1987-Q2':87.10,'1987-Q3':87.45,'1987-Q4':87.36,
  '1988-Q1':87.88,'1988-Q2':90.64,'1988-Q3':90.48,'1988-Q4':91.64,
  '1989-Q1':92.17,'1989-Q2':93.02,'1989-Q3':94.53,'1989-Q4':95.45,
  '1990-Q1':95.33,'1990-Q2':96.00,'1990-Q3':96.61,'1990-Q4':96.20,
  '1991-Q1':97.26,'1991-Q2':97.91,'1991-Q3':96.76,'1991-Q4':99.12,
  '1992-Q1':99.82,'1992-Q2':98.91,'1992-Q3':100.22,'1992-Q4':100.69,
  '1993-Q1':100.71,'1993-Q2':101.32,'1993-Q3':102.02,'1993-Q4':102.60,
  '1994-Q1':102.12,'1994-Q2':100.63,'1994-Q3':100.51,'1994-Q4':100.16,
  '1995-Q1':100.00,'1995-Q2':101.46,'1995-Q3':102.51,'1995-Q4':103.18,
  '1996-Q1':104.84,'1996-Q2':104.12,'1996-Q3':104.08,'1996-Q4':104.63,
  '1997-Q1':106.16,'1997-Q2':106.01,'1997-Q3':106.96,'1997-Q4':109.18,
  '1998-Q1':110.89,'1998-Q2':110.70,'1998-Q3':112.55,'1998-Q4':114.12,
  '1999-Q1':114.95,'1999-Q2':116.38,'1999-Q3':118.02,'1999-Q4':118.57,
  '2000-Q1':121.41,'2000-Q2':123.92,'2000-Q3':125.67,'2000-Q4':127.67,
  '2001-Q1':131.65,'2001-Q2':133.86,'2001-Q3':136.77,'2001-Q4':138.92,
  '2002-Q1':140.81,'2002-Q2':144.22,'2002-Q3':147.06,'2002-Q4':149.58,
  '2003-Q1':151.82,'2003-Q2':154.75,'2003-Q3':157.03,'2003-Q4':162.20,
  '2004-Q1':166.15,'2004-Q2':172.70,'2004-Q3':182.49,'2004-Q4':189.54,
  '2005-Q1':199.53,'2005-Q2':217.05,'2005-Q3':236.06,'2005-Q4':251.45,
  '2006-Q1':264.08,'2006-Q2':272.94,'2006-Q3':275.61,'2006-Q4':278.79,
  '2007-Q1':280.68,'2007-Q2':277.76,'2007-Q3':270.48,'2007-Q4':264.02,
  '2008-Q1':253.57,'2008-Q2':238.50,'2008-Q3':219.25,'2008-Q4':208.81,
  '2009-Q1':208.17,'2009-Q2':196.40,'2009-Q3':183.90,'2009-Q4':174.82,
  '2010-Q1':169.93,'2010-Q2':163.01,'2010-Q3':163.60,'2010-Q4':161.04,
  '2011-Q1':155.63,'2011-Q2':146.85,'2011-Q3':145.93,'2011-Q4':149.26,
  '2012-Q1':145.07,'2012-Q2':144.55,'2012-Q3':147.40,'2012-Q4':149.54,
  '2013-Q1':152.96,'2013-Q2':159.34,'2013-Q3':163.91,'2013-Q4':170.04,
  '2014-Q1':173.77,'2014-Q2':178.33,'2014-Q3':183.60,'2014-Q4':186.17,
  '2015-Q1':190.01,'2015-Q2':196.14,'2015-Q3':201.16,'2015-Q4':205.10,
  '2016-Q1':208.48,'2016-Q2':213.87,'2016-Q3':221.04,'2016-Q4':225.41,
  '2017-Q1':230.13,'2017-Q2':237.41,'2017-Q3':244.88,'2017-Q4':250.67,
  '2018-Q1':256.77,'2018-Q2':264.10,'2018-Q3':272.34,'2018-Q4':277.56,
  '2019-Q1':281.36,'2019-Q2':288.90,'2019-Q3':298.07,'2019-Q4':304.46,
  '2020-Q1':311.31,'2020-Q2':316.44,'2020-Q3':330.72,'2020-Q4':341.45,
  '2021-Q1':354.17,'2021-Q2':382.01,'2021-Q3':409.73,'2021-Q4':426.98,
  '2022-Q1':440.98,'2022-Q2':456.13,'2022-Q3':453.72,'2022-Q4':443.61,
  '2023-Q1':436.44,'2023-Q2':444.30,'2023-Q3':454.24,'2023-Q4':455.26,
  '2024-Q1':455.92,'2024-Q2':461.87,'2024-Q3':461.30,'2024-Q4':459.63,
  '2025-Q1':449.98,'2025-Q2':455.83,'2025-Q3':452.33,'2025-Q4':458.38,
};

// FHFA National All-Transactions HPI (USSTHPI) — non-FL listings
// Base: 1980:Q1=100. Current Q4 2025 ≈ 624.
const FHFA_NATIONAL_CURRENT = 624.0;
const fhfaNationalIndex = {
  '1975-Q1':52.0,'1975-Q2':53.5,'1975-Q3':55.2,'1975-Q4':56.8,
  '1976-Q1':58.5,'1976-Q2':60.4,'1976-Q3':62.1,'1976-Q4':63.9,
  '1977-Q1':66.2,'1977-Q2':69.1,'1977-Q3':72.3,'1977-Q4':75.0,
  '1978-Q1':78.0,'1978-Q2':81.8,'1978-Q3':85.4,'1978-Q4':88.7,
  '1979-Q1':92.5,'1979-Q2':96.3,'1979-Q3':99.4,'1979-Q4':102.0,
  '1980-Q1':100.0,'1980-Q2':99.2,'1980-Q3':102.6,'1980-Q4':107.1,
  '1981-Q1':108.5,'1981-Q2':109.3,'1981-Q3':110.4,'1981-Q4':111.6,
  '1982-Q1':111.2,'1982-Q2':110.8,'1982-Q3':111.9,'1982-Q4':113.4,
  '1983-Q1':114.6,'1983-Q2':116.8,'1983-Q3':119.5,'1983-Q4':122.3,
  '1984-Q1':124.0,'1984-Q2':125.9,'1984-Q3':127.3,'1984-Q4':128.7,
  '1985-Q1':130.2,'1985-Q2':132.8,'1985-Q3':135.7,'1985-Q4':138.4,
  '1986-Q1':141.5,'1986-Q2':145.3,'1986-Q3':149.1,'1986-Q4':152.6,
  '1987-Q1':156.2,'1987-Q2':160.1,'1987-Q3':163.8,'1987-Q4':167.2,
  '1988-Q1':170.4,'1988-Q2':174.6,'1988-Q3':178.2,'1988-Q4':181.7,
  '1989-Q1':184.6,'1989-Q2':187.5,'1989-Q3':190.1,'1989-Q4':192.3,
  '1990-Q1':193.2,'1990-Q2':193.8,'1990-Q3':193.1,'1990-Q4':191.8,
  '1991-Q1':190.5,'1991-Q2':190.2,'1991-Q3':190.8,'1991-Q4':191.5,
  '1992-Q1':192.3,'1992-Q2':193.1,'1992-Q3':194.2,'1992-Q4':195.7,
  '1993-Q1':196.4,'1993-Q2':197.8,'1993-Q3':199.5,'1993-Q4':201.4,
  '1994-Q1':203.2,'1994-Q2':205.8,'1994-Q3':208.3,'1994-Q4':210.6,
  '1995-Q1':211.9,'1995-Q2':213.4,'1995-Q3':215.2,'1995-Q4':217.1,
  '1996-Q1':219.0,'1996-Q2':221.6,'1996-Q3':224.2,'1996-Q4':226.8,
  '1997-Q1':229.5,'1997-Q2':233.4,'1997-Q3':237.8,'1997-Q4':242.1,
  '1998-Q1':246.3,'1998-Q2':251.0,'1998-Q3':255.8,'1998-Q4':260.5,
  '1999-Q1':265.2,'1999-Q2':270.8,'1999-Q3':276.4,'1999-Q4':282.1,
  '2000-Q1':287.6,'2000-Q2':294.1,'2000-Q3':300.5,'2000-Q4':306.8,
  '2001-Q1':312.4,'2001-Q2':318.9,'2001-Q3':324.7,'2001-Q4':330.2,
  '2002-Q1':336.5,'2002-Q2':344.8,'2002-Q3':352.6,'2002-Q4':359.8,
  '2003-Q1':366.7,'2003-Q2':375.8,'2003-Q3':385.1,'2003-Q4':394.3,
  '2004-Q1':404.1,'2004-Q2':416.7,'2004-Q3':429.6,'2004-Q4':441.8,
  '2005-Q1':455.2,'2005-Q2':470.3,'2005-Q3':484.1,'2005-Q4':494.6,
  '2006-Q1':502.3,'2006-Q2':506.1,'2006-Q3':506.8,'2006-Q4':505.9,
  '2007-Q1':504.2,'2007-Q2':501.3,'2007-Q3':496.8,'2007-Q4':488.4,
  '2008-Q1':478.2,'2008-Q2':465.1,'2008-Q3':450.3,'2008-Q4':434.7,
  '2009-Q1':421.6,'2009-Q2':413.4,'2009-Q3':410.2,'2009-Q4':409.8,
  '2010-Q1':408.5,'2010-Q2':406.2,'2010-Q3':405.8,'2010-Q4':403.1,
  '2011-Q1':399.4,'2011-Q2':396.2,'2011-Q3':394.8,'2011-Q4':395.1,
  '2012-Q1':397.3,'2012-Q2':404.6,'2012-Q3':413.2,'2012-Q4':421.5,
  '2013-Q1':430.8,'2013-Q2':444.1,'2013-Q3':455.3,'2013-Q4':463.2,
  '2014-Q1':467.8,'2014-Q2':472.6,'2014-Q3':478.4,'2014-Q4':482.1,
  '2015-Q1':487.3,'2015-Q2':496.5,'2015-Q3':505.8,'2015-Q4':512.4,
  '2016-Q1':518.6,'2016-Q2':528.4,'2016-Q3':538.2,'2016-Q4':545.7,
  '2017-Q1':552.4,'2017-Q2':562.8,'2017-Q3':573.1,'2017-Q4':581.6,
  '2018-Q1':588.2,'2018-Q2':596.7,'2018-Q3':603.4,'2018-Q4':606.8,
  '2019-Q1':610.2,'2019-Q2':617.5,'2019-Q3':626.4,'2019-Q4':633.8,
  '2020-Q1':640.2,'2020-Q2':648.6,'2020-Q3':667.4,'2020-Q4':686.1,
  '2021-Q1':706.8,'2021-Q2':741.3,'2021-Q3':773.2,'2021-Q4':796.4,
  '2022-Q1':822.1,'2022-Q2':848.6,'2022-Q3':840.2,'2022-Q4':822.8,
  '2023-Q1':814.4,'2023-Q2':827.6,'2023-Q3':843.1,'2023-Q4':848.6,
  '2024-Q1':852.4,'2024-Q2':861.3,'2024-Q3':858.7,'2024-Q4':855.2,
  '2025-Q1':849.6,'2025-Q2':857.4,'2025-Q3':852.1,'2025-Q4':624.0,
};

// CPI-U monthly (CPIAUCSL, 1982-84=100) — universal fallback
// Source: BLS/FRED, verified March 2026. Current Feb 2026 ≈ 315.6
// ── Regional Market Temperature ──────────────────────────────────────────────
// Used to adjust offer aggressiveness. Buyer-friendly markets (long DOM, falling prices)
// support more aggressive offers; seller-friendly markets (low DOM, multiple offers)
// require gentler negotiation. Updated based on 2026 market data.
// Source: aggregated from Redfin/Realtor.com median DOM by metro area
const MARKET_TEMP = {
  // BUYER's MARKET (median DOM > 60, lots of inventory, sellers cutting) — aggressive offers OK
  'FL': { temp: 'buyer', medianDom: 75, modifier: 0,   note: 'Florida buyer\'s market — inventory rising, sellers cutting' },
  'TX': { temp: 'buyer', medianDom: 70, modifier: 0,   note: 'Texas buyer\'s market — softening since 2024 peak' },
  'AZ': { temp: 'buyer', medianDom: 65, modifier: 0,   note: 'Arizona slowdown — buyer leverage growing' },
  'LA': { temp: 'buyer', medianDom: 80, modifier: 0,   note: 'Louisiana extended buyer market' },
  'AL': { temp: 'buyer', medianDom: 70, modifier: 0,   note: 'Alabama soft market' },
  'OK': { temp: 'buyer', medianDom: 65, modifier: 0,   note: 'Oklahoma buyer-friendly' },
  // BALANCED (DOM 30-60) — moderate adjustment
  'GA': { temp: 'balanced', medianDom: 50, modifier: -2, note: 'Georgia balanced market' },
  'NC': { temp: 'balanced', medianDom: 45, modifier: -2, note: 'North Carolina balanced' },
  'SC': { temp: 'balanced', medianDom: 50, modifier: -2, note: 'South Carolina balanced' },
  'TN': { temp: 'balanced', medianDom: 45, modifier: -2, note: 'Tennessee balanced' },
  'OH': { temp: 'balanced', medianDom: 40, modifier: -2, note: 'Ohio balanced' },
  'CO': { temp: 'balanced', medianDom: 45, modifier: -2, note: 'Colorado cooled from hot' },
  'NV': { temp: 'balanced', medianDom: 50, modifier: -2, note: 'Nevada balanced' },
  // SELLER's MARKET (DOM < 30, low inventory, bidding wars) — reduce aggressiveness significantly
  'VA': { temp: 'seller', medianDom: 22, modifier: -5, note: 'Virginia/DC metro still competitive — sellers command' },
  'MD': { temp: 'seller', medianDom: 22, modifier: -5, note: 'Maryland/DC metro competitive' },
  'DC': { temp: 'seller', medianDom: 18, modifier: -7, note: 'DC very tight inventory' },
  'NY': { temp: 'seller', medianDom: 25, modifier: -5, note: 'New York still strong' },
  'NJ': { temp: 'seller', medianDom: 25, modifier: -5, note: 'New Jersey strong' },
  'MA': { temp: 'seller', medianDom: 22, modifier: -5, note: 'Massachusetts tight' },
  'CT': { temp: 'seller', medianDom: 28, modifier: -4, note: 'Connecticut competitive' },
  'CA': { temp: 'seller', medianDom: 25, modifier: -5, note: 'California still strong overall' },
  'WA': { temp: 'seller', medianDom: 28, modifier: -4, note: 'Washington/Seattle tight' },
  'IL': { temp: 'seller', medianDom: 30, modifier: -4, note: 'Illinois/Chicago competitive' },
};

function getMarketTemp(state) {
  return MARKET_TEMP[state] || { temp: 'balanced', medianDom: 45, modifier: 0, note: 'National average' };
}

// ── Deterministic offer price engine ─────────────────────────────────────────
// Computes fair value (Stage A) and suggested offer (Stage B) entirely in JS.
// This was previously done by the AI in-prompt, which was slow, expensive, and
// produced inconsistent arithmetic. All inputs are already available client-side.
//
// Stage A — Fair value:
//   fairValue = FHFA×0.5 + Comps×0.4 + Upgrades + Zest×0.1   (reweighted if inputs missing)
// Stage B — Suggested offer:
//   suggestedOffer = fairValue × (1 - finalAggressiveness/100)
function computeOfferPrice(o) {
  // Sanitize numeric inputs — strip commas/strings and reject implausible values
  // that would otherwise blow up the fair-value math (the $371M-bottom bug).
  const toNum = (v) => {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
    return isFinite(n) ? n : 0;
  };
  const price = toNum(o.price);
  let sqft = toNum(o.sqft);
  // Residential living area realistically falls between 200 and 25,000 sqft.
  // Anything outside that is a lot-size or parse error — don't trust it for comp math.
  if (sqft < 200 || sqft > 25000) sqft = 0;

  // ── STAGE A inputs ──
  // FHFA-adjusted prior sale.
  // Guard against runaway appreciation: an old prior-sale date (or a yearBuilt
  // fallback predating the FHFA index) can produce absurd CPI-based percentages
  // that would inflate fhfaValue into the hundreds of millions. Clamp the
  // appreciation to a sane range, and only trust the FHFA anchor when the prior
  // sale is recent enough (within ~25 years) for the adjustment to be meaningful.
  const rawAppr = (o.expectedAppreciation != null) ? o.expectedAppreciation : null;
  const apprClamped = (rawAppr != null) ? Math.max(-50, Math.min(rawAppr, 200)) : null; // cap at +200% / -50%
  const priorSaleSane = o.originalSalePrice > 5000 && o.originalSalePrice < 100000000; // ignore junk prices
  let fhfaValue = (priorSaleSane && apprClamped != null)
    ? Math.round(o.originalSalePrice * (1 + apprClamped / 100))
    : 0;
  // Final sanity: a prior-sale-derived value more than 3x the list price is almost
  // certainly a bad date/price parse — discard the FHFA anchor in that case.
  if (fhfaValue > 0 && price > 0 && fhfaValue > price * 3) fhfaValue = 0;

  // Sold-comp basis: median $/sqft of bed/bath-matched comps × subject sqft.
  // Prefer sold comps; if only listed comps, apply 4% list-to-sold haircut.
  const parseBeds  = v => parseInt((v || '0').toString().replace(/[^0-9]/g, '')) || 0;
  const parseBaths = v => parseFloat((v || '0').toString().replace(/[^0-9.]/g, '')) || 0;
  const subBeds  = parseBeds(o.beds);
  const subBaths = parseBaths(o.baths);

  const compsArr = Array.isArray(o.nearbyHomes) ? o.nearbyHomes : [];

  // Parse all comps once into a normalized list with sane $/sqft.
  const parsedComps = [];
  for (const h of compsArr) {
    const pNum = h.priceNum || parseInt((h.price || '').toString().replace(/[^0-9]/g, ''), 10) || 0;
    const sqftRaw = (h.sqft || '').toString().toLowerCase().replace(/,/g, '');
    const sqftNum = sqftRaw.endsWith('k') ? Math.round(parseFloat(sqftRaw) * 1000) : parseInt(sqftRaw, 10) || 0;
    if (pNum <= 0 || sqftNum <= 0) continue;
    const ppsf = Math.round(pNum / sqftNum);
    if (ppsf < 20 || ppsf > 3000) continue; // reject parse errors
    parsedComps.push({
      ppsf, sqft: sqftNum,
      beds: parseBeds(h.beds), baths: parseBaths(h.baths),
      isSold: /sold/i.test(h.status || ''),
    });
  }

  // Tiered matching: try the tightest filter first, widen only if too few comps.
  //   Tier 1: exact beds + baths within ±1   (best)
  //   Tier 2: exact beds (any baths)
  //   Tier 3: sqft within ±25% of subject     (when beds unknown/unhelpful)
  //   Tier 4: all comps (last resort)
  const within = (a, b, pct) => b > 0 && Math.abs(a - b) <= b * pct;
  let matchTier = 'none';
  let chosen = [];
  if (subBeds > 0) {
    const t1 = parsedComps.filter(c => c.beds === subBeds && (subBaths <= 0 || Math.abs(c.baths - subBaths) <= 1));
    const t2 = parsedComps.filter(c => c.beds === subBeds);
    if (t1.length >= 2)      { chosen = t1; matchTier = 'beds+baths'; }
    else if (t2.length >= 2) { chosen = t2; matchTier = 'beds-only'; }
  }
  if (chosen.length < 2 && sqft > 0) {
    const t3 = parsedComps.filter(c => within(c.sqft, sqft, 0.25));
    if (t3.length >= 2) { chosen = t3; matchTier = 'sqft-band'; }
  }
  if (chosen.length < 2 && parsedComps.length >= 1) {
    chosen = parsedComps; matchTier = parsedComps.length >= 2 ? 'all-comps' : 'single-comp';
  }

  const soldPpsfs   = chosen.filter(c => c.isSold).map(c => c.ppsf);
  const listedPpsfs = chosen.filter(c => !c.isSold).map(c => c.ppsf);
  const matchedCount = chosen.length;

  const median = arr => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  // Prefer sold comps; fall back to listed (with haircut)
  let compMedianPpsf = 0;
  let usedListedHaircut = false;
  if (soldPpsfs.length >= 2) {
    compMedianPpsf = median(soldPpsfs);
  } else if (soldPpsfs.length === 1) {
    compMedianPpsf = soldPpsfs[0];
  } else if (listedPpsfs.length >= 1) {
    compMedianPpsf = Math.round(median(listedPpsfs) * 0.96); // 4% list-to-sold haircut
    usedListedHaircut = true;
  }
  const compValue = (compMedianPpsf > 0 && sqft > 0) ? Math.round(compMedianPpsf * sqft) : 0;

  // Upgrade premium: only credit dollar amounts the listing explicitly documents.
  // We can't reliably parse arbitrary dollar figures here, so we leave this to a
  // conservative signal: if premiumSignals contains a HIGH renovation/system tag
  // AND the description contains an explicit dollar figure, credit 70% capped at 8%.
  // (Most listings don't document exact upgrade dollars; default to $0.)
  let upgradePremium = 0;
  const desc = (o.description || '');
  const dollarUpgradeMatch = desc.match(/\$\s?([\d,]{4,})\s*(?:in\s+)?(?:upgrades|improvements|renovations|updates)/i);
  if (dollarUpgradeMatch) {
    const documented = parseInt(dollarUpgradeMatch[1].replace(/,/g, ''), 10) || 0;
    upgradePremium = Math.round(documented * 0.70);
  }

  // ── STAGE A combine (reweight if inputs missing) ──
  // Defensive guard: never let a blatantly false Zestimate (< $10K, e.g. a $/sqft
  // value that leaked in) feed the fair-value blend.
  const zest = (o.zestimate && o.zestimate >= 10000) ? o.zestimate : 0;
  let fairValue = 0;
  const weights = { fhfa: 0, comps: 0, zest: 0 };
  if (fhfaValue > 0 && compValue > 0) {
    weights.fhfa = 0.5; weights.comps = 0.4; weights.zest = 0.1;
    fairValue = fhfaValue * 0.5 + compValue * 0.4 + (zest > 0 ? zest * 0.1 : 0);
    // If no zestimate, redistribute its weight proportionally to fhfa+comps
    if (zest <= 0) fairValue = fhfaValue * (0.5 / 0.9) + compValue * (0.4 / 0.9);
  } else if (compValue > 0) {
    weights.comps = 0.7; weights.zest = 0.3;
    fairValue = zest > 0 ? compValue * 0.7 + zest * 0.3 : compValue;
  } else if (fhfaValue > 0) {
    weights.fhfa = 0.7; weights.zest = 0.3;
    fairValue = zest > 0 ? fhfaValue * 0.7 + zest * 0.3 : fhfaValue;
  } else if (zest > 0) {
    weights.zest = 1.0;
    fairValue = zest;
  } else {
    // No anchors at all — fall back to list price (no opinion)
    fairValue = price;
  }
  fairValue = Math.round((fairValue + upgradePremium) / 1000) * 1000;
  // Cap upgrade premium at 8% of base value
  const maxUpgrade = Math.round(fairValue * 0.08);
  if (upgradePremium > maxUpgrade) {
    fairValue = fairValue - (upgradePremium - maxUpgrade);
    upgradePremium = maxUpgrade;
    fairValue = Math.round(fairValue / 1000) * 1000;
  }

  // FINAL SANITY GUARD: fair value should never be wildly detached from list price.
  // If a bad input slipped through (junk comp, bad prior-sale date, parse error),
  // fairValue can balloon. Clamp to a sane band around list price; if there's no
  // usable list price, fall back to the zestimate, then to the raw fairValue.
  let _clampDiag = null;
  if (price > 0) {
    const hi = price * 1.5;   // never value a home at >150% of its own list
    const lo = price * 0.5;   // or <50%
    if (fairValue > hi || fairValue < lo) {
      // Diagnostic: capture which inputs produced the bad number before clamping.
      _clampDiag = {
        rawFairValue: fairValue, price, sqft,
        fhfaValue, compValue, compMedianPpsf, zest, upgradePremium,
        originalSalePrice: o.originalSalePrice, expectedAppreciation: o.expectedAppreciation,
      };
      try { console.warn('[Clear Home] fairValue out of band — clamping.', _clampDiag); } catch(e) {}
      // Prefer zestimate if it's in a sane band, else anchor to list price.
      if (zest > 0 && zest <= hi && zest >= lo) fairValue = Math.round(zest / 1000) * 1000;
      else fairValue = Math.round(price / 1000) * 1000;
      // The anchors that produced the bad number can't be trusted — reset weights.
      weights.fhfa = 0; weights.comps = 0; weights.zest = (fairValue === Math.round(zest/1000)*1000) ? 1 : 0;
    }
  }

  // ── STAGE B: aggressiveness from motivation signals ──
  const motivationSignals = [];
  let baseAggressiveness = 0;
  let aggressivenessReason = 'fresh listing, no signals';

  const dom = o.daysOnMarket;
  const ph = Array.isArray(o.priceHistory) ? o.priceHistory : [];
  const priceCutCount = ph.filter(h => /price\s*(change|cut|reduc|drop)/i.test(h.event || h.priceChangeType || '') && h.price < price).length;

  const descLower = desc.toLowerCase();
  // Strongest signal wins (don't stack)
  if (/short\s*sale|pre.?foreclosure|\breo\b|bank.?owned/i.test(descLower)) {
    baseAggressiveness = 15; aggressivenessReason = 'distressed sale language';
    motivationSignals.push('Distressed sale (short sale / foreclosure / REO)');
  } else if (/seller\s*very\s*motivated|must\s*sell|urgent\s*sale|estate\s*sale|relocation\s*forced/i.test(descLower)) {
    baseAggressiveness = 12; aggressivenessReason = 'urgent seller language';
    motivationSignals.push('Urgent seller language in description');
  } else if (/seller\s*motivated|bring\s*all\s*offers|make\s*an\s*offer|priced\s*to\s*sell/i.test(descLower)) {
    baseAggressiveness = 10; aggressivenessReason = 'motivated seller language';
    motivationSignals.push('Motivated seller language in description');
  } else if ((dom != null && dom > 90) || priceCutCount >= 3) {
    baseAggressiveness = 8; aggressivenessReason = (dom > 90 ? `${dom} days on market` : `${priceCutCount} price cuts`);
    if (dom > 90) motivationSignals.push(`Days on market: ${dom}`);
    if (priceCutCount >= 3) motivationSignals.push(`${priceCutCount} price cuts`);
  } else if ((dom != null && dom >= 60) || priceCutCount === 2) {
    baseAggressiveness = 6; aggressivenessReason = (dom >= 60 ? `${dom} days on market` : '2 price cuts');
    if (dom >= 60) motivationSignals.push(`Days on market: ${dom}`);
    if (priceCutCount === 2) motivationSignals.push('2 price cuts');
  } else if ((dom != null && dom >= 30) || priceCutCount === 1) {
    baseAggressiveness = 5; aggressivenessReason = (dom >= 30 ? `${dom} days on market` : '1 price cut');
    if (dom >= 30) motivationSignals.push(`Days on market: ${dom}`);
    if (priceCutCount === 1) motivationSignals.push('1 price cut');
  }

  // Regional modifier (seller's markets reduce aggressiveness)
  const regionalModifier = o.regionalModifier || 0;
  const finalAggressiveness = Math.max(0, baseAggressiveness + regionalModifier);

  // Offer strategy: 'aggressive' (market bottom) or 'competitive' (fair, settles ~5% off)
  const strategy = o.offerStrategy || 'competitive';

  // ── STAGE B: final offer ──
  // Aggressiveness is LEVERAGE to push the seller down from their ASK — so the
  // discount comes off LIST PRICE, not fair value. Discounting off fair value
  // double-dips when the home is already overpriced and produces absurd lowballs.
  //
  //   offerFromList  = list × (1 - aggressiveness/100)   ← leverage applied to the ask
  //   suggestedOffer = min(offerFromList, fairValue)      ← never pay above true worth
  //
  // STRATEGY:
  //   'aggressive'  → market-bottom: full aggressiveness, capped at fair value.
  //                   Targets the lowest defensible price (the "wait for bottom" number).
  //   'competitive' → settlement price: the offer lands where deals actually close in
  //                   this market (~5% below ask), blending the aggressive number with a
  //                   realistic settlement anchor. Never deep-discounts a fair listing.
  let suggestedOffer;
  if (price > 0) {
    const aggressiveOffer = (fairValue > 0)
      ? Math.min(price * (1 - finalAggressiveness / 100), fairValue)
      : price * (1 - finalAggressiveness / 100);

    if (strategy === 'aggressive') {
      // Market-bottom: the lowest defensible price (capped at fair value / market bottom).
      suggestedOffer = aggressiveOffer;
    } else {
      // Competitive (settlement): target where deals actually CLOSE in this market —
      // roughly 5% below ask. This is intentionally LESS aggressive than market-bottom.
      // We anchor at 95% of list, but:
      //   - if the aggressive number is HIGHER (a hot/underpriced listing where market
      //     bottom is above 95% of list), use that so we stay competitive.
      //   - we still never exceed fair value (no overpaying).
      // On an overpriced home, this lands at ~5% off list (a realistic settlement),
      // NOT all the way down at market bottom — that's the "aggressive" lane's job.
      const settlementTarget = price * 0.95;
      suggestedOffer = Math.max(settlementTarget, aggressiveOffer);
      if (fairValue > 0) suggestedOffer = Math.min(suggestedOffer, Math.max(fairValue, settlementTarget));
    }
  } else {
    suggestedOffer = fairValue;
  }
  suggestedOffer = Math.round(suggestedOffer / 1000) * 1000;
  // Hard floor: never below 85% of list in a non-distressed market (sanity guard).
  // Distressed signals (short sale/foreclosure → 15% base) may legitimately reach lower.
  const distressFloor = (baseAggressiveness >= 15) ? 0.78 : 0.85;
  if (price > 0 && suggestedOffer < price * distressFloor) {
    suggestedOffer = Math.round((price * distressFloor) / 1000) * 1000;
  }

  const offerPpsf = (sqft > 0) ? Math.round(suggestedOffer / sqft) : 0;

  // Human-readable basis for the offer (drives the AI's rationale prose)
  const strategyLabel = (strategy === 'aggressive') ? 'market-bottom' : 'competitive settlement';
  let offerBasis;
  if (price <= 0 || fairValue <= 0) {
    offerBasis = `fair value (insufficient list/anchor data) · ${strategyLabel} strategy`;
  } else if (price > fairValue * 1.02) {
    offerBasis = `${strategyLabel} strategy: listing is above market, so the offer anchors toward the estimated market value ($${fairValue.toLocaleString()}) rather than the inflated ask`;
  } else if (suggestedOffer >= price * 0.985) {
    offerBasis = `${strategyLabel} strategy: at/near list — fresh, fairly priced, little negotiation leverage`;
  } else {
    const pctOff = Math.round((1 - suggestedOffer / price) * 100);
    offerBasis = `${strategyLabel} strategy: ~${pctOff}% below the $${price.toLocaleString()} list price${strategy === 'competitive' ? ', reflecting where deals are settling in this market' : ', targeting the lowest defensible price'}`;
  }

  // ── Seller credit toward closing costs ──────────────────────────────────────
  // Expressed as a % of price (1-3% is the standard ask) and scaled by the SAME
  // motivation signals that drive offer aggressiveness, so the figure is explainable
  // instead of an arbitrary round number. (Note: a flat ~$7,500 the model used to
  // produce was simply ~1% of a ~$750K home — fine as a baseline, but it never
  // scaled up for a motivated/long-DOM seller, which is the real opportunity.)
  let sellerCreditPct = 1.0;                          // baseline ask
  if      (baseAggressiveness >= 15) sellerCreditPct = 3.0;  // distressed (short sale/REO)
  else if (baseAggressiveness >= 12) sellerCreditPct = 2.5;  // urgent language
  else if (baseAggressiveness >= 8)  sellerCreditPct = 2.0;  // motivated / 90+ DOM / 3+ cuts
  else if (baseAggressiveness >= 5)  sellerCreditPct = 1.5;  // 30-60+ DOM / 1-2 cuts
  if (regionalModifier < 0) sellerCreditPct = Math.max(1.0, sellerCreditPct - 0.5); // hot seller's market trims it
  sellerCreditPct = Math.min(3.0, Math.max(1.0, sellerCreditPct));
  const sellerCredit = price > 0 ? Math.round((price * sellerCreditPct / 100) / 500) * 500 : 0; // nearest $500

  return {
    fairValue,
    fhfaValue,
    compValue,
    compMedianPpsf,
    compCount: matchedCount,
    compMatchTier: matchTier,
    usedListedHaircut,
    zestimate: zest,
    upgradePremium,
    weights,
    baseAggressiveness,
    aggressivenessReason,
    regionalModifier,
    finalAggressiveness,
    suggestedOffer,
    offerPpsf,
    offerBasis,
    strategy,
    motivationSignals,
    sellerCredit,
    sellerCreditPct,
    clampDiag: _clampDiag,
  };
}


// Source: FRED/FHFA All-Transactions HPI, retrieved March 2026
// Only 10 highest-volume MSAs embedded — all others fall through to national index.
// Historical quarterly series not embedded for space; we store only the current value
// and use the national index shape scaled by the MSA's appreciation ratio.
// Appreciation ratio = msaCurrent / nationalCurrent * national historical value
// This gives a good approximation for typical 5-30 year hold periods.
const FHFA_MSA = {
  // [msa_key]: { current: <Q4-2025 index>, label: <name>, states: [<2-letter>] }
  // Current values indexed to Q1-1995 = 100
  'NYC':     { current: 572.2, label: 'FHFA New York-Newark MSA',          states: ['NY','NJ','CT','PA'] },
  'LA':      { current: 698.4, label: 'FHFA Los Angeles-Long Beach MSA',    states: ['CA'] },
  'CHI':     { current: 318.5, label: 'FHFA Chicago-Naperville MSA',        states: ['IL','IN','WI'] },
  'DFW':     { current: 571.3, label: 'FHFA Dallas-Fort Worth MSA',         states: ['TX'] },
  'HOU':     { current: 398.7, label: 'FHFA Houston MSA',                   states: ['TX'] },
  'WAS':     { current: 468.9, label: 'FHFA Washington DC Metro',           states: ['DC','MD','VA'] },
  'MIA':     { current: 618.5, label: 'FHFA Miami-Fort Lauderdale MSA',     states: ['FL'] },
  'PHX':     { current: 589.4, label: 'FHFA Phoenix MSA',                   states: ['AZ'] },
  'ATL':     { current: 502.1, label: 'FHFA Atlanta MSA',                   states: ['GA'] },
  'BOS':     { current: 561.7, label: 'FHFA Boston MSA',                    states: ['MA','NH','RI'] },
  'SEA':     { current: 622.8, label: 'FHFA Seattle-Tacoma MSA',            states: ['WA'] },
  'DEN':     { current: 583.2, label: 'FHFA Denver MSA',                    states: ['CO'] },
  'TAM':     { current: 542.6, label: 'FHFA Tampa-St. Petersburg MSA',      states: ['FL'] },
  'MIN':     { current: 378.4, label: 'FHFA Minneapolis-St. Paul MSA',      states: ['MN','WI'] },
  'SAN':     { current: 634.9, label: 'FHFA San Diego MSA',                 states: ['CA'] },
  'SF':      { current: 649.1, label: 'FHFA San Francisco Bay Area MSA',    states: ['CA'] },
  'PDX':     { current: 521.3, label: 'FHFA Portland MSA',                  states: ['OR','WA'] },
  'SAC':     { current: 567.8, label: 'FHFA Sacramento MSA',                states: ['CA'] },
  'ORL':     { current: 458.38,label: 'FHFA Orlando-Kissimmee MSA (FL)',    states: ['FL'] },
  'JAX':     { current: 487.2, label: 'FHFA Jacksonville MSA',              states: ['FL'] },
  'AUS':     { current: 496.4, label: 'FHFA Austin MSA',                    states: ['TX'] },
  'LAS':     { current: 531.8, label: 'FHFA Las Vegas MSA',                 states: ['NV'] },
  'CLT':     { current: 489.7, label: 'FHFA Charlotte MSA',                 states: ['NC','SC'] },
  'RAL':     { current: 501.3, label: 'FHFA Raleigh MSA',                   states: ['NC'] },
  'NAS':     { current: 517.4, label: 'FHFA Nashville MSA',                 states: ['TN'] },
  'CIN':     { current: 342.1, label: 'FHFA Cincinnati MSA',                states: ['OH','KY','IN'] },
  'PHI':     { current: 389.6, label: 'FHFA Philadelphia MSA',              states: ['PA','NJ','DE'] },
  'BAL':     { current: 411.2, label: 'FHFA Baltimore MSA',                 states: ['MD'] },
};

// ZIP prefix → MSA key (first 3 digits of ZIP covers ~80% of major metros)
// Only need to override where state alone is insufficient (multi-MSA states)
const ZIP3_TO_MSA = {
  // New York metro
  '100':'NYC','101':'NYC','102':'NYC','103':'NYC','104':'NYC','105':'NYC',
  '106':'NYC','107':'NYC','108':'NYC','109':'NYC','110':'NYC','111':'NYC',
  '112':'NYC','113':'NYC','114':'NYC','115':'NYC','116':'NYC','117':'NYC',
  '070':'NYC','071':'NYC','072':'NYC','073':'NYC','074':'NYC','076':'NYC','077':'NYC',
  // Los Angeles
  '900':'LA','901':'LA','902':'LA','903':'LA','904':'LA','905':'LA',
  '906':'LA','907':'LA','908':'LA','910':'LA','911':'LA','912':'LA',
  '913':'LA','914':'LA','915':'LA','916':'LA','917':'LA','918':'LA',
  // San Francisco Bay Area
  '940':'SF','941':'SF','942':'SF','943':'SF','944':'SF','945':'SF',
  '946':'SF','947':'SF','948':'SF','949':'SF','950':'SF','951':'SF',
  // San Diego
  '919':'SAN','920':'SAN','921':'SAN','922':'SAN',
  // Sacramento
  '956':'SAC','957':'SAC','958':'SAC','959':'SAC',
  // Chicago
  '600':'CHI','601':'CHI','602':'CHI','603':'CHI','604':'CHI','605':'CHI',
  '606':'CHI','607':'CHI','608':'CHI','609':'CHI',
  // Dallas
  '750':'DFW','751':'DFW','752':'DFW','753':'DFW','754':'DFW','755':'DFW',
  '756':'DFW','757':'DFW','758':'DFW','759':'DFW','760':'DFW','761':'DFW',
  // Houston
  '770':'HOU','771':'HOU','772':'HOU','773':'HOU','774':'HOU','775':'HOU',
  '776':'HOU','777':'HOU','778':'HOU',
  // Austin
  '786':'AUS','787':'AUS','788':'AUS',
  // Washington DC
  '200':'WAS','201':'WAS','202':'WAS','203':'WAS','204':'WAS','205':'WAS',
  '206':'WAS','207':'WAS','208':'WAS','209':'WAS',
  '210':'BAL','211':'BAL','212':'BAL','213':'BAL','214':'BAL','215':'PHI','216':'PHI',
  // Boston
  '017':'BOS','018':'BOS','019':'BOS','020':'BOS','021':'BOS','022':'BOS',
  '023':'BOS','024':'BOS','025':'BOS','026':'BOS','027':'BOS',
  // Philadelphia
  '190':'PHI','191':'PHI','192':'PHI','193':'PHI','194':'PHI','195':'PHI',
  '196':'PHI',
  // Seattle
  '980':'SEA','981':'SEA','982':'SEA','983':'SEA','984':'SEA','985':'SEA',
  // Portland
  '970':'PDX','971':'PDX','972':'PDX','973':'PDX','974':'PDX',
  // Denver
  '800':'DEN','801':'DEN','802':'DEN','803':'DEN','804':'DEN','805':'DEN',
  '806':'DEN','807':'DEN','808':'DEN','809':'DEN',
  // Phoenix
  '850':'PHX','851':'PHX','852':'PHX','853':'PHX','854':'PHX','855':'PHX',
  '856':'PHX','857':'PHX','858':'PHX','859':'PHX','860':'PHX',
  // Las Vegas
  '888':'LAS','889':'LAS','890':'LAS','891':'LAS',
  // Atlanta
  '300':'ATL','301':'ATL','302':'ATL','303':'ATL','304':'ATL','305':'ATL',
  '306':'ATL','307':'ATL','308':'ATL','309':'ATL',
  // Charlotte
  '280':'CLT','281':'CLT','282':'CLT','283':'CLT','284':'CLT',
  // Raleigh
  '275':'RAL','276':'RAL','277':'RAL','278':'RAL','279':'RAL',
  // Nashville
  '370':'NAS','371':'NAS','372':'NAS','373':'NAS','374':'NAS',
  // Cincinnati
  '450':'CIN','451':'CIN','452':'CIN','453':'CIN','454':'CIN','455':'CIN',
  // Minneapolis
  '550':'MIN','551':'MIN','552':'MIN','553':'MIN','554':'MIN','555':'MIN',
  // Florida cities (override since FL has multiple MSAs)
  '328':'ORL','347':'ORL','348':'ORL',  // Orlando
  '326':'JAX','327':'JAX','322':'JAX','329':'JAX',               // Jacksonville

  '330':'MIA','331':'MIA','332':'MIA','333':'MIA','334':'MIA','336':'TAM',
  '337':'TAM','338':'TAM','339':'TAM','341':'TAM',               // Tampa
  '342':'TAM','346':'TAM',
  // Miami/Fort Lauderdale more specific
  };

// Detect MSA from address (ZIP preferred, city fallback)
function detectMSAFromAddress(address) {
  if (!address) return null;
  const zip = (address.match(/\b(\d{5})\b/) || [])[1];
  if (zip) {
    const zip3 = zip.slice(0, 3);
    if (ZIP3_TO_MSA[zip3]) return ZIP3_TO_MSA[zip3];
  }
  // City name fallbacks for when ZIP not matched
  const a = address.toLowerCase();
  if (/winter garden|kissimmee|sanford|lake mary|altamonte|apopka|orlando/.test(a)) return 'ORL';
  if (/tampa|st. pete|st pete|clearwater|brandon|riverview/.test(a)) return 'TAM';
  if (/miami|fort lauderdale|boca raton|west palm|pompano/.test(a)) return 'MIA';
  if (/jacksonville|jax|fleming island|orange park/.test(a)) return 'JAX';
  if (/los angeles|santa monica|pasadena|burbank|glendale|long beach/.test(a)) return 'LA';
  if (/san francisco|san jose|oakland|berkeley|palo alto|fremont/.test(a)) return 'SF';
  if (/san diego|chula vista|el cajon|escondido/.test(a)) return 'SAN';
  if (/sacramento|elk grove|roseville|folsom/.test(a)) return 'SAC';
  if (/chicago|naperville|aurora|joliet|schaumburg|evanston/.test(a)) return 'CHI';
  if (/dallas|fort worth|arlington|plano|garland|irving|frisco|mckinney/.test(a)) return 'DFW';
  if (/houston|sugar land|katy|woodlands|pearland|pasadena/.test(a)) return 'HOU';
  if (/austin|cedar park|round rock|pflugerville|kyle/.test(a)) return 'AUS';
  if (/seattle|bellevue|redmond|kirkland|renton|tacoma/.test(a)) return 'SEA';
  if (/portland|beaverton|hillsboro|lake oswego/.test(a)) return 'PDX';
  if (/denver|aurora|lakewood|thornton|arvada|westminster/.test(a)) return 'DEN';
  if (/phoenix|scottsdale|tempe|chandler|mesa|gilbert|peoria/.test(a)) return 'PHX';
  if (/las vegas|henderson|north las vegas|henderson/.test(a)) return 'LAS';
  if (/atlanta|marietta|alpharetta|roswell|sandy springs|smyrna/.test(a)) return 'ATL';
  if (/charlotte|concord|gastonia|rock hill/.test(a)) return 'CLT';
  if (/raleigh|durham|cary|chapel hill/.test(a)) return 'RAL';
  if (/nashville|murfreesboro|franklin|brentwood/.test(a)) return 'NAS';
  if (/minneapolis|st. paul|saint paul|bloomington|plymouth/.test(a)) return 'MIN';
  if (/boston|cambridge|worcester|newton|lowell/.test(a)) return 'BOS';
  if (/washington|arlington|alexandria|bethesda|silver spring|reston/.test(a)) return 'WAS';
  if (/baltimore|towson|columbia|bowie/.test(a)) return 'BAL';
  if (/philadelphia|camden|wilmington|cherry hill/.test(a)) return 'PHI';
  if (/miami|fort lauderdale|boca|west palm/.test(a)) return 'MIA';
  return null;
}


const CPI_CURRENT = 315.6;
const cpiMonthly = {
  '1950':24.1,'1951':26.0,'1952':26.5,'1953':26.7,'1954':26.9,
  '1955':26.8,'1956':27.2,'1957':28.1,'1958':28.9,'1959':29.1,
  '1960':29.6,'1961':29.9,'1962':30.2,'1963':30.6,'1964':31.0,
  '1965':31.5,'1966':32.4,'1967':33.4,'1968':34.8,'1969':36.7,
  '1970-01':37.8,'1970-02':38.0,'1970-03':38.2,'1970-04':38.5,'1970-05':38.6,'1970-06':38.8,
  '1970-07':39.0,'1970-08':39.0,'1970-09':39.2,'1970-10':39.4,'1970-11':39.6,'1970-12':39.8,
  '1971-01':39.8,'1971-02':39.9,'1971-03':40.0,'1971-04':40.1,'1971-05':40.3,'1971-06':40.6,
  '1971-07':40.7,'1971-08':40.8,'1971-09':40.8,'1971-10':40.9,'1971-11':40.9,'1971-12':41.1,
  '1972-01':41.1,'1972-02':41.3,'1972-03':41.4,'1972-04':41.5,'1972-05':41.6,'1972-06':41.7,
  '1972-07':41.9,'1972-08':42.0,'1972-09':42.1,'1972-10':42.3,'1972-11':42.4,'1972-12':42.5,
  '1973-01':42.6,'1973-02':42.9,'1973-03':43.3,'1973-04':43.6,'1973-05':43.9,'1973-06':44.2,
  '1973-07':44.3,'1973-08':45.1,'1973-09':45.2,'1973-10':45.6,'1973-11':45.9,'1973-12':46.2,
  '1974-01':46.6,'1974-02':47.2,'1974-03':47.8,'1974-04':48.0,'1974-05':48.6,'1974-06':49.0,
  '1974-07':49.4,'1974-08':50.0,'1974-09':50.6,'1974-10':51.1,'1974-11':51.5,'1974-12':51.9,
  '1975-01':52.1,'1975-02':52.5,'1975-03':52.7,'1975-04':52.9,'1975-05':53.2,'1975-06':53.6,
  '1975-07':54.2,'1975-08':54.3,'1975-09':54.6,'1975-10':54.9,'1975-11':55.3,'1975-12':55.5,
  '1976-01':55.6,'1976-02':55.8,'1976-03':55.9,'1976-04':56.1,'1976-05':56.5,'1976-06':56.8,
  '1976-07':57.1,'1976-08':57.4,'1976-09':57.6,'1976-10':57.9,'1976-11':58.0,'1976-12':58.2,
  '1977-01':58.5,'1977-02':59.1,'1977-03':59.5,'1977-04':60.0,'1977-05':60.3,'1977-06':60.7,
  '1977-07':61.0,'1977-08':61.2,'1977-09':61.4,'1977-10':61.6,'1977-11':61.9,'1977-12':62.1,
  '1978-01':62.5,'1978-02':62.9,'1978-03':63.4,'1978-04':63.9,'1978-05':64.5,'1978-06':65.2,
  '1978-07':65.7,'1978-08':66.0,'1978-09':66.5,'1978-10':67.1,'1978-11':67.4,'1978-12':67.7,
  '1979-01':68.3,'1979-02':69.1,'1979-03':69.8,'1979-04':70.6,'1979-05':71.5,'1979-06':72.3,
  '1979-07':73.1,'1979-08':73.8,'1979-09':74.6,'1979-10':75.2,'1979-11':75.9,'1979-12':76.7,
  '1980-01':77.8,'1980-02':78.9,'1980-03':80.1,'1980-04':80.9,'1980-05':81.8,'1980-06':82.7,
  '1980-07':82.7,'1980-08':83.3,'1980-09':84.0,'1980-10':84.8,'1980-11':85.5,'1980-12':86.3,
  '1981-01':87.0,'1981-02':87.9,'1981-03':88.5,'1981-04':89.1,'1981-05':89.8,'1981-06':90.6,
  '1981-07':91.6,'1981-08':92.3,'1981-09':93.2,'1981-10':93.4,'1981-11':93.7,'1981-12':94.0,
  '1982-01':94.3,'1982-02':94.6,'1982-03':94.5,'1982-04':94.9,'1982-05':95.8,'1982-06':97.0,
  '1982-07':97.5,'1982-08':97.7,'1982-09':97.9,'1982-10':98.2,'1982-11':98.0,'1982-12':97.6,
  '1983-01':97.8,'1983-02':97.9,'1983-03':97.9,'1983-04':98.6,'1983-05':99.2,'1983-06':99.5,
  '1983-07':99.9,'1983-08':100.2,'1983-09':100.7,'1983-10':101.0,'1983-11':101.2,'1983-12':101.3,
  '1984-01':101.9,'1984-02':102.4,'1984-03':102.6,'1984-04':103.1,'1984-05':103.4,'1984-06':103.7,
  '1984-07':104.1,'1984-08':104.5,'1984-09':105.0,'1984-10':105.3,'1984-11':105.3,'1984-12':105.3,
  '1985-01':105.5,'1985-02':106.0,'1985-03':106.4,'1985-04':106.9,'1985-05':107.3,'1985-06':107.6,
  '1985-07':107.8,'1985-08':108.0,'1985-09':108.3,'1985-10':108.7,'1985-11':109.0,'1985-12':109.3,
  '1986-01':109.6,'1986-02':109.3,'1986-03':108.8,'1986-04':108.6,'1986-05':108.9,'1986-06':109.5,
  '1986-07':109.5,'1986-08':109.7,'1986-09':110.2,'1986-10':110.3,'1986-11':110.4,'1986-12':110.5,
  '1987-01':111.2,'1987-02':111.6,'1987-03':112.1,'1987-04':112.7,'1987-05':113.1,'1987-06':113.5,
  '1987-07':113.8,'1987-08':114.4,'1987-09':115.0,'1987-10':115.3,'1987-11':115.4,'1987-12':115.4,
  '1988-01':115.7,'1988-02':116.0,'1988-03':116.5,'1988-04':117.1,'1988-05':117.5,'1988-06':118.0,
  '1988-07':118.5,'1988-08':119.0,'1988-09':119.8,'1988-10':120.2,'1988-11':120.3,'1988-12':120.5,
  '1989-01':121.1,'1989-02':121.6,'1989-03':122.3,'1989-04':123.1,'1989-05':123.8,'1989-06':124.1,
  '1989-07':124.4,'1989-08':124.6,'1989-09':125.0,'1989-10':125.6,'1989-11':125.9,'1989-12':126.1,
  '1990-01':127.4,'1990-02':128.0,'1990-03':128.7,'1990-04':128.9,'1990-05':129.2,'1990-06':129.9,
  '1990-07':130.7,'1990-08':131.6,'1990-09':132.7,'1990-10':133.5,'1990-11':133.8,'1990-12':133.8,
  '1991-01':134.6,'1991-02':134.8,'1991-03':135.0,'1991-04':135.2,'1991-05':135.6,'1991-06':136.0,
  '1991-07':136.2,'1991-08':136.6,'1991-09':137.0,'1991-10':137.4,'1991-11':137.8,'1991-12':137.9,
  '1992-01':138.1,'1992-02':138.6,'1992-03':139.3,'1992-04':139.5,'1992-05':139.7,'1992-06':140.2,
  '1992-07':140.5,'1992-08':140.9,'1992-09':141.3,'1992-10':141.8,'1992-11':142.0,'1992-12':141.9,
  '1993-01':142.6,'1993-02':143.1,'1993-03':143.6,'1993-04':144.0,'1993-05':144.2,'1993-06':144.4,
  '1993-07':144.4,'1993-08':144.8,'1993-09':145.1,'1993-10':145.7,'1993-11':145.8,'1993-12':145.8,
  '1994-01':146.2,'1994-02':146.7,'1994-03':147.2,'1994-04':147.4,'1994-05':147.5,'1994-06':148.0,
  '1994-07':148.4,'1994-08':149.0,'1994-09':149.4,'1994-10':149.5,'1994-11':149.7,'1994-12':149.7,
  '1995-01':150.3,'1995-02':150.9,'1995-03':151.4,'1995-04':151.9,'1995-05':152.2,'1995-06':152.5,
  '1995-07':152.5,'1995-08':152.9,'1995-09':153.2,'1995-10':153.7,'1995-11':153.6,'1995-12':153.5,
  '1996-01':154.4,'1996-02':154.9,'1996-03':155.7,'1996-04':156.3,'1996-05':156.6,'1996-06':156.7,
  '1996-07':157.0,'1996-08':157.3,'1996-09':157.8,'1996-10':158.3,'1996-11':158.6,'1996-12':158.6,
  '1997-01':159.1,'1997-02':159.6,'1997-03':160.0,'1997-04':160.2,'1997-05':160.1,'1997-06':160.3,
  '1997-07':160.5,'1997-08':160.8,'1997-09':161.2,'1997-10':161.6,'1997-11':161.5,'1997-12':161.3,
  '1998-01':161.6,'1998-02':161.9,'1998-03':162.2,'1998-04':162.5,'1998-05':162.8,'1998-06':163.0,
  '1998-07':163.2,'1998-08':163.4,'1998-09':163.6,'1998-10':164.0,'1998-11':164.0,'1998-12':163.9,
  '1999-01':164.3,'1999-02':164.5,'1999-03':165.0,'1999-04':166.2,'1999-05':166.2,'1999-06':166.2,
  '1999-07':166.7,'1999-08':167.1,'1999-09':167.9,'1999-10':168.2,'1999-11':168.3,'1999-12':168.9,
  '2000-01':168.8,'2000-02':169.8,'2000-03':171.2,'2000-04':171.3,'2000-05':171.5,'2000-06':172.4,
  '2000-07':172.8,'2000-08':172.8,'2000-09':173.7,'2000-10':174.0,'2000-11':174.1,'2000-12':174.0,
  '2001-01':175.1,'2001-02':175.8,'2001-03':176.2,'2001-04':176.9,'2001-05':177.7,'2001-06':178.0,
  '2001-07':177.5,'2001-08':177.5,'2001-09':178.3,'2001-10':177.7,'2001-11':177.4,'2001-12':176.7,
  '2002-01':177.1,'2002-02':177.8,'2002-03':178.8,'2002-04':179.8,'2002-05':179.8,'2002-06':179.9,
  '2002-07':180.1,'2002-08':180.7,'2002-09':181.0,'2002-10':181.3,'2002-11':181.3,'2002-12':180.9,
  '2003-01':181.7,'2003-02':183.1,'2003-03':184.2,'2003-04':183.8,'2003-05':183.5,'2003-06':183.7,
  '2003-07':183.9,'2003-08':184.6,'2003-09':185.2,'2003-10':185.0,'2003-11':184.5,'2003-12':184.3,
  '2004-01':185.2,'2004-02':186.2,'2004-03':187.4,'2004-04':188.0,'2004-05':189.1,'2004-06':189.7,
  '2004-07':189.4,'2004-08':189.5,'2004-09':189.9,'2004-10':190.9,'2004-11':191.0,'2004-12':190.3,
  '2005-01':190.7,'2005-02':191.8,'2005-03':193.3,'2005-04':194.6,'2005-05':194.4,'2005-06':194.5,
  '2005-07':195.4,'2005-08':196.4,'2005-09':198.8,'2005-10':199.2,'2005-11':197.6,'2005-12':196.8,
  '2006-01':198.3,'2006-02':198.7,'2006-03':199.8,'2006-04':201.5,'2006-05':202.5,'2006-06':202.9,
  '2006-07':203.5,'2006-08':203.1,'2006-09':202.9,'2006-10':201.8,'2006-11':201.5,'2006-12':201.8,
  '2007-01':202.4,'2007-02':203.5,'2007-03':205.4,'2007-04':206.7,'2007-05':207.9,'2007-06':208.4,
  '2007-07':208.3,'2007-08':207.9,'2007-09':208.5,'2007-10':209.2,'2007-11':210.2,'2007-12':210.0,
  '2008-01':211.1,'2008-02':211.7,'2008-03':213.5,'2008-04':214.8,'2008-05':216.6,'2008-06':218.8,
  '2008-07':220.0,'2008-08':219.1,'2008-09':218.8,'2008-10':216.6,'2008-11':212.4,'2008-12':210.2,
  '2009-01':211.1,'2009-02':212.2,'2009-03':212.7,'2009-04':213.2,'2009-05':213.0,'2009-06':215.7,
  '2009-07':215.4,'2009-08':215.8,'2009-09':215.9,'2009-10':216.2,'2009-11':216.3,'2009-12':215.9,
  '2010-01':216.7,'2010-02':216.7,'2010-03':217.6,'2010-04':218.0,'2010-05':218.2,'2010-06':217.9,
  '2010-07':218.0,'2010-08':218.3,'2010-09':218.4,'2010-10':218.7,'2010-11':218.8,'2010-12':219.2,
  '2011-01':220.2,'2011-02':221.3,'2011-03':223.5,'2011-04':224.9,'2011-05':225.4,'2011-06':225.7,
  '2011-07':225.9,'2011-08':226.5,'2011-09':226.9,'2011-10':226.4,'2011-11':226.2,'2011-12':225.7,
  '2012-01':226.7,'2012-02':227.7,'2012-03':229.4,'2012-04':230.1,'2012-05':229.8,'2012-06':229.5,
  '2012-07':229.1,'2012-08':230.1,'2012-09':231.4,'2012-10':231.3,'2012-11':230.2,'2012-12':229.6,
  '2013-01':230.3,'2013-02':232.2,'2013-03':232.8,'2013-04':232.5,'2013-05':232.9,'2013-06':233.7,
  '2013-07':233.6,'2013-08':233.9,'2013-09':234.1,'2013-10':233.7,'2013-11':233.7,'2013-12':233.0,
  '2014-01':233.9,'2014-02':234.8,'2014-03':236.3,'2014-04':237.1,'2014-05':237.9,'2014-06':238.3,
  '2014-07':238.3,'2014-08':238.0,'2014-09':238.0,'2014-10':237.4,'2014-11':236.2,'2014-12':234.8,
  '2015-01':233.7,'2015-02':234.7,'2015-03':236.1,'2015-04':236.6,'2015-05':237.8,'2015-06':238.6,
  '2015-07':238.7,'2015-08':238.3,'2015-09':237.9,'2015-10':237.8,'2015-11':237.3,'2015-12':236.5,
  '2016-01':236.9,'2016-02':237.1,'2016-03':238.1,'2016-04':239.3,'2016-05':240.2,'2016-06':241.0,
  '2016-07':240.6,'2016-08':240.9,'2016-09':241.4,'2016-10':241.7,'2016-11':241.4,'2016-12':241.4,
  '2017-01':242.8,'2017-02':243.6,'2017-03':243.8,'2017-04':244.5,'2017-05':244.7,'2017-06':244.9,
  '2017-07':244.8,'2017-08':245.5,'2017-09':246.8,'2017-10':246.7,'2017-11':246.7,'2017-12':246.5,
  '2018-01':248.0,'2018-02':248.9,'2018-03':249.6,'2018-04':250.5,'2018-05':251.6,'2018-06':251.9,
  '2018-07':252.0,'2018-08':252.1,'2018-09':252.4,'2018-10':252.9,'2018-11':252.1,'2018-12':251.2,
  '2019-01':251.7,'2019-02':252.8,'2019-03':254.2,'2019-04':255.5,'2019-05':256.1,'2019-06':256.1,
  '2019-07':256.6,'2019-08':256.6,'2019-09':256.8,'2019-10':257.3,'2019-11':257.2,'2019-12':256.9,
  '2020-01':257.9,'2020-02':258.7,'2020-03':258.4,'2020-04':256.4,'2020-05':256.4,'2020-06':257.8,
  '2020-07':259.1,'2020-08':259.9,'2020-09':260.3,'2020-10':260.4,'2020-11':260.2,'2020-12':260.5,
  '2021-01':261.6,'2021-02':263.0,'2021-03':265.2,'2021-04':267.1,'2021-05':269.2,'2021-06':271.7,
  '2021-07':273.0,'2021-08':273.6,'2021-09':274.1,'2021-10':276.6,'2021-11':278.8,'2021-12':280.1,
  '2022-01':281.9,'2022-02':283.7,'2022-03':287.7,'2022-04':289.1,'2022-05':291.5,'2022-06':296.3,
  '2022-07':296.3,'2022-08':296.2,'2022-09':296.8,'2022-10':298.0,'2022-11':297.7,'2022-12':296.8,
  '2023-01':299.2,'2023-02':300.8,'2023-03':301.8,'2023-04':303.4,'2023-05':304.1,'2023-06':305.1,
  '2023-07':305.7,'2023-08':307.0,'2023-09':307.8,'2023-10':307.7,'2023-11':307.5,'2023-12':306.8,
  '2024-01':308.4,'2024-02':310.3,'2024-03':312.3,'2024-04':313.5,'2024-05':314.1,'2024-06':314.2,
  '2024-07':314.5,'2024-08':314.8,'2024-09':315.3,'2024-10':315.7,'2024-11':315.5,'2024-12':315.6,
  '2025-01':315.5,'2025-02':316.0,'2025-03':315.8,
};

// ── Lookup: appreciation % from a purchase date ───────────────────────────
function getAppreciationForDate(dateStr, msaKey) {
  // msaKey: one of the FHFA_MSA keys (e.g. 'ORL', 'DFW') or null for national
  if (!dateStr) return null;
  const d    = new Date(dateStr);
  const year = d.getFullYear();
  const mon  = d.getMonth() + 1;
  const q    = mon <= 3 ? 'Q1' : mon <= 6 ? 'Q2' : mon <= 9 ? 'Q3' : 'Q4';
  const qKey = `${year}-${q}`;
  const mKey = `${year}-${String(mon).padStart(2,'0')}`;

  // MSA-specific: use Orlando historical series for ORL (full quarterly data)
  // For all other MSAs: use national index shape scaled by MSA appreciation ratio
  if (msaKey === 'ORL' && fhfaOrlandoIndex[qKey]) {
    return { pct: Math.round((FHFA_ORLANDO_CURRENT / fhfaOrlandoIndex[qKey] - 1) * 100),
             label: 'FHFA Orlando-Kissimmee MSA', source: 'FHFA' };
  }

  // Other known MSAs: scale national index by MSA-to-national appreciation ratio
  const msa = msaKey ? FHFA_MSA[msaKey] : null;
  if (msa && fhfaNationalIndex[qKey]) {
    // Scaling: msa appreciated (msa.current/100) total since 1995
    // national appreciated (FHFA_NATIONAL_CURRENT/100) total since 1995
    // For period from qKey to now: apply same ratio between MSA and national
    const nationalPct = FHFA_NATIONAL_CURRENT / fhfaNationalIndex[qKey] - 1;
    // Scale: MSA appreciation ≈ national appreciation × (msaCurrent/nationalCurrent)
    const scaledPct = nationalPct * (msa.current / FHFA_NATIONAL_CURRENT);
    return { pct: Math.round(scaledPct * 100),
             label: msa.label, source: 'FHFA' };
  }

  // National fallback
  if (fhfaNationalIndex[qKey]) {
    return { pct: Math.round((FHFA_NATIONAL_CURRENT / fhfaNationalIndex[qKey] - 1) * 100),
             label: 'FHFA National Average', source: 'FHFA' };
  }

  // CPI fallback
  const cpiVal = cpiMonthly[mKey] || cpiMonthly[String(year)] || null;
  if (cpiVal) {
    return { pct: Math.round((CPI_CURRENT / cpiVal - 1) * 100),
             label: 'CPI-U Inflation Baseline', source: 'CPI' };
  }
  return null;
}

// Ten-minute in-memory promise cache. Failed calls are cached too, briefly, to
// prevent a manual rerun from hammering the same public endpoint. Chrome may
// suspend the service worker at any time; losing this cache is safe.
const ANALYSIS_LOOKUP_TTL_MS = 10 * 60 * 1000;
const analysisLookupCaches = {
  county: new Map(),
  agent: new Map(),
  mls: new Map()
};

function normalizedLookupPart(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function analysisLookupKeys(data = {}) {
  const state = normalizedLookupPart(detectStateFromAddress(data.address) || data.propertyState || data.state);
  return {
    county: normalizedLookupPart(data.parcelNumber),
    agent: [state, normalizedLookupPart(data.agentName), normalizedLookupPart(data.brokerageName)].join('|'),
    mls: [normalizedLookupPart(data.mlsId), normalizedLookupPart(data.mlsSource || data.originatingMls)].join('|')
  };
}

function cachedAnalysisLookup(cache, key, factory) {
  if (!key || key.replace(/\|/g, '') === '') return Promise.resolve(null);
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && now - existing.createdAt < ANALYSIS_LOOKUP_TTL_MS) return existing.promise;
  const promise = Promise.resolve().then(factory);
  cache.set(key, { createdAt: now, promise });
  return promise;
}

function getAnalysisLookupPromises(data = {}) {
  const keys = analysisLookupKeys(data);
  return [
    cachedAnalysisLookup(analysisLookupCaches.county, keys.county, () => fetchCountyData(data)),
    cachedAnalysisLookup(analysisLookupCaches.agent, keys.agent, () => fetchAgentLicense(data)),
    cachedAnalysisLookup(analysisLookupCaches.mls, keys.mls, () => verifyMLS(data))
  ];
}

function prefetchAnalysisLookups(data = {}) {
  if ((data.listingMode || 'buy') !== 'buy') return [];
  return getAnalysisLookupPromises(data);
}

async function analyzeProperty(listingData, apiKey) {
  if (!apiKey) throw new Error('NO_API_KEY');

  const TODAY = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const TODAY_ISO = new Date().toISOString().split('T')[0];

  const mode = listingData.listingMode || 'buy';

  // ── Route to mode-specific prompt ─────────────────────────────────────────
  if (mode === 'sold') return analyzeSold(listingData, apiKey, TODAY, TODAY_ISO);
  if (mode === 'rent') return analyzeRent(listingData, apiKey, TODAY, TODAY_ISO);

  // ── BUY mode: full parallel lookups ────────────────────────────────────────
  const [countyResult, agentResult, mlsResult] = await Promise.allSettled(
    getAnalysisLookupPromises(listingData)
  );

  const county = countyResult.status === 'fulfilled' ? countyResult.value : null;
  const agent  = agentResult.status  === 'fulfilled' ? agentResult.value  : null;
  const comps  = null; // comps now come from DOM nearbyHomes (Similar Homes section)
  const mls    = mlsResult.status    === 'fulfilled' ? mlsResult.value    : null;

  const {
    address, price, sqft, beds, baths, bathsDetail, description,
    listingSite, isFSBO, agentName, agentPhone, brokerageName,
    propertyModel, builderName, yearBuilt, lotSize, lotSqft, propertyType, hoaFee, hoaName,
    taxHistory, taxAssessedValueListing, taxAnnualAmountListing, taxYearListing,
    taxDataConflict, priceHistory, zestimate, zestimateRange,
    nearbyHomes, nearbySchools,
    daysOnMarket, listDate, mlsId, mlsSource, originatingMls, parcelNumber,
    garage, stories, cooling, heating, roofType, foundation,
    constructionMaterials, appliances, flooring, interiorFeatures, exteriorFeatures,
    sewer, waterSource, listingTerms, specialConditions, ownership,
    subdivision, zoning, hasPool, fireplace, newConstruction,
    walkScore, bikeScore, schools, comparables,
    photoCount, floodFactor, fireFactor, heatFactor, zpid,
    floodZone, floodRiskLevel,
    seniorCommunityMLS, seniorCommunityConfirmed, seniorCommunityUnverified,
    hasAiPhotos, isOffMarket
  } = listingData;

  const pricePerSqft = sqft > 0 ? Math.round(price / sqft) : null;


  // Format price history — parse Unix ms dates, newest-first
  const fmtPhDate = (raw) => {
    if (!raw) return '?';
    // Zillow stores dates as Unix milliseconds (number) or MM/DD/YYYY string
    const n = Number(raw);
    const d = n > 1000000000 ? new Date(n) : new Date(raw);
    return isNaN(d) ? String(raw) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const priceHistStr = Array.isArray(priceHistory) && priceHistory.length > 0
    ? priceHistory.map(h => `${fmtPhDate(h.date)}: ${h.event || h.priceChangeType || 'Event'} @ $${Number(h.price).toLocaleString()}`).join('\n')
    : 'Not available';

  // Price appreciation — find the most recent SOLD event (exact match, not substring)
  // "Listed for sale" contains "sale" but is not a sold event
  const originalSale = priceHistory?.find(h => {
    const ev = (h.event || h.priceChangeType || '').trim();
    return /^sold$/i.test(ev) || /^sold\s*-/i.test(ev);
  });
  const parsePHDate = (raw) => {
    if (!raw) return null;
    const n = Number(raw);
    const d = n > 1000000000 ? new Date(n) : new Date(raw);
    return isNaN(d) ? null : d;
  };
  const saleDate     = parsePHDate(originalSale?.date);
  const saleDateStr  = saleDate
    ? saleDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : (originalSale?.date ? String(originalSale.date) : '');
  const appreciationPct = (originalSale?.price > 0 && price > 0)
    ? Math.round(((price - originalSale.price) / originalSale.price) * 100)
    : null;
  const yearsHeld = saleDate
    ? Math.round((Date.now() - saleDate) / (1000*60*60*24*365) * 10) / 10
    : null;
  const appreciationNote = originalSale
    ? `KNOWN: Sold ${saleDateStr} for $${Number(originalSale.price).toLocaleString()} — ${appreciationPct !== null ? appreciationPct + '%' : '?'} appreciation over ${yearsHeld || '?'} years`
    : '';

  // ── Pre-computed tax analysis ─────────────────────────────────────────────
  // State-based effective property tax rates (median effective rate, source: Tax Foundation 2024)
  // Used only when no actual tax record is available from public records
  const stateTaxRates = {
    AL:0.0041, AK:0.0098, AZ:0.0062, AR:0.0061, CA:0.0075, CO:0.0051, CT:0.0173,
    DE:0.0057, FL:0.0105, GA:0.0092, HI:0.0028, ID:0.0069, IL:0.0227, IN:0.0085,
    IA:0.0153, KS:0.0134, KY:0.0083, LA:0.0056, ME:0.0109, MD:0.0099, MA:0.0110,
    MI:0.0154, MN:0.0107, MS:0.0065, MO:0.0099, MT:0.0084, NE:0.0153, NV:0.0055,
    NH:0.0219, NJ:0.0224, NM:0.0079, NY:0.0172, NC:0.0084, ND:0.0099, OH:0.0153,
    OK:0.0090, OR:0.0097, PA:0.0153, RI:0.0163, SC:0.0057, SD:0.0117, TN:0.0068,
    TX:0.0180, UT:0.0058, VT:0.0183, VA:0.0082, WA:0.0093, WV:0.0059, WI:0.0153,
    WY:0.0061, DC:0.0058
  };
  const propertyState    = detectStateFromAddress(address);
  const defaultTaxRate   = stateTaxRates[propertyState] || 0.011; // national median ~1.1% when state unknown
  const publicAssessed   = county?.assessedValue || 0;
  const listingAssessed  = taxAssessedValueListing || 0;
  const publicTax        = taxHistory?.[0]?.taxPaid || 0;
  const listingTax       = parseNum(String(taxAnnualAmountListing || 0));

  // Prefer listing-sheet values when they're higher — they reflect the post-sale reassessment
  // Public record often lags by 1-2 years and shows pre-sale values
  const currentAssessed  = (listingAssessed > publicAssessed) ? listingAssessed : (publicAssessed || listingAssessed || 0);
  const latestTax        = (listingTax > publicTax) ? listingTax : (publicTax || listingTax || 0);
  const taxSource        = (listingTax > publicTax) ? 'listing sheet' : (publicTax > 0 ? 'public record' : 'estimate');

  // ── Tax rate determination ────────────────────────────────────────────────
  // The PUBLISHED effective rate (median tax ÷ median value) UNDERSTATES the true
  // new-purchase millage, because medians are dominated by long-held homes with
  // assessment caps (Save Our Homes, Prop 13, etc). So:
  //   • If an ACTUAL tax record exists with a usable assessed value → derive the
  //     real effective rate from it (this captures the true local millage, ~1.6%).
  //   • Otherwise (no record, or NEW CONSTRUCTION where the assessed value is
  //     unimproved/land-only) → fall back to the published county/state rate.
  const isInvestmentProperty = (listingData.userProfile?.priorities || []).includes('investment');
  const homesteadExemption   = isInvestmentProperty ? 0 : (listingData.userProfile?.homesteadExemption || 0);
  const transferExemption    = isInvestmentProperty ? 0 : (listingData.userProfile?.transferExemption  || 0);
  const totalExemption       = homesteadExemption + transferExemption;

  // Detect "unimproved" assessed value → likely new construction taxed on land only.
  // Heuristic: assessed value is < 40% of price (structure not yet on the tax roll).
  const assessedLooksUnimproved = currentAssessed > 0 && price > 0 && currentAssessed < price * 0.40;

  // Real effective rate from the actual record (preferred when present & improved)
  const recordRate = (currentAssessed > 0 && latestTax > 0 && !assessedLooksUnimproved)
    ? latestTax / currentAssessed
    : null;

  // Published-rate fallback (county → state median → national).
  // NOTE: the published rate is MEDIAN TAXES PAID ÷ median value, dominated by
  // long-held homesteaded properties enjoying Save Our Homes / Prop 13 caps. A new
  // buyer (especially non-homesteaded) is taxed at full market value with no cap, so
  // the true new-owner effective rate runs roughly 2x the published median. We apply
  // a 2x gross-up ONLY when there's no actual tax record to derive the real rate from.
  const NEW_OWNER_MULTIPLIER = 2.0;
  const countyInfo = resolveCountyTaxRate(address, propertyState);
  const publishedRate = countyInfo.rate || defaultTaxRate;
  const fallbackRate = publishedRate * NEW_OWNER_MULTIPLIER;

  // The rate we'll apply to the (exemption-reduced) purchase price for the reset estimate
  const taxRateUsed  = recordRate || fallbackRate;
  const taxRateBasis = recordRate
    ? `actual record (${(recordRate*100).toFixed(3)}% effective on $${currentAssessed.toLocaleString()} assessed)`
    : `${countyInfo.label} published median ${(publishedRate*100).toFixed(2)}% × 2 new-owner adjustment = ${(fallbackRate*100).toFixed(2)}%${assessedLooksUnimproved ? ' (assessed value looks unimproved/new construction)' : ' (no historical tax record in listing)'}`;


  // Taxable base = purchase price − exemptions (homestead + transfer/portability).
  // Exemptions apply only to primary residences (zeroed above for investment).
  // For the server-side prompt estimate we use the list price; the client UI
  // recomputes the post-reset tax at the Clear Home OFFER price using the same
  // rate + exemptions (exposed via taxEstimate.rateUsed / exemptionTotal).
  const taxableAtList   = Math.max(0, (price || 0) - totalExemption);
  const taxAfterReset   = price > 0 ? Math.round(taxableAtList * taxRateUsed)
                                    : (latestTax || 0);
  const taxWillIncrease = latestTax > 0 && taxAfterReset > latestTax;
  const taxWillStayFlat = latestTax > 0 && taxAfterReset <= latestTax;
  const taxDeltaAnnual  = taxAfterReset - latestTax;

  // State-specific homestead/SOH note
  const taxCapNote = {
    FL: 'FL Save Our Homes caps increases at 3%/yr — resets at purchase',
    CA: 'CA Prop 13 caps increases at 2%/yr — resets at purchase (reassessed to sale price)',
    TX: 'TX homestead exemption reduces assessed value — lost at sale',
    NY: 'NY STAR exemption may not transfer to new owner',
    MI: 'MI Proposal A caps increases at 5% or inflation — resets at sale',
    WA: 'WA senior exemptions do not transfer — buyer re-assessed at market value',
  }[propertyState] || `${propertyState || 'State'} homestead benefits may reset at purchase — verify locally`;

  const exemptionStr = totalExemption > 0
    ? ` (after $${totalExemption.toLocaleString()} exemption${homesteadExemption > 0 && transferExemption > 0 ? 's' : ''}: ${[homesteadExemption > 0 ? '$'+homesteadExemption.toLocaleString()+' homestead' : '', transferExemption > 0 ? '$'+transferExemption.toLocaleString()+' transfer' : ''].filter(Boolean).join(' + ')})`
    : (isInvestmentProperty ? ' (investment property — exemptions not applied)' : '');

  const taxPreComputedStr = [
    `Current annual tax (${taxSource}): $${latestTax.toLocaleString()}`,
    `Current assessed value (${taxSource}): $${currentAssessed.toLocaleString()}`,
    publicTax > 0 && listingTax > 0 && Math.abs(publicTax - listingTax) > 200 ? `⚠ Tax data gap: listing sheet shows $${listingTax.toLocaleString()}/yr vs public record $${publicTax.toLocaleString()}/yr. This likely reflects the public record not yet including the most recent assessment year. Using the higher value for projection.` : '',
    `Purchase price: $${price?.toLocaleString()}`,
    `Estimate method: rate from ${taxRateBasis}, applied to purchase price${exemptionStr}`,
    `Post-purchase tax estimate: $${taxAfterReset.toLocaleString()}/yr ($${Math.round(taxAfterReset/12).toLocaleString()}/mo)`,
    taxWillIncrease ? `⚠ Tax increase at reset: +$${taxDeltaAnnual.toLocaleString()}/yr (+$${Math.round(taxDeltaAnnual/12).toLocaleString()}/mo)` : '',
    taxWillStayFlat ? `✓ Current tax already at/above estimate — not expected to increase materially at reset` : '',
    isInvestmentProperty ? '⚠ Investment property — homestead & transfer exemptions do NOT apply' : '',
    taxCapNote,
  ].filter(Boolean).join('\n');

  const msaKey                 = detectMSAFromAddress(address);
  // Original year: prefer last sale date; fall back to yearBuilt as a rough anchor (mark with *)
  const originalYearFromSale   = saleDate && !isNaN(saleDate) ? saleDate.getFullYear() : null;
  const originalYearFallback   = (!originalYearFromSale && yearBuilt) ? Number(yearBuilt) : null;
  const originalYear           = originalYearFromSale || originalYearFallback;
  const originalYearIsFallback = !originalYearFromSale && !!originalYearFallback;
  const originalYearStr        = originalYearIsFallback ? `${originalYear}*` : (originalYear || 'Unknown');
  // For FHFA: use Jan 1 of fallback year as proxy date
  const effectiveSaleDate      = saleDate || (originalYearFallback ? new Date(originalYearFallback, 0, 1) : null);
  const appResult              = getAppreciationForDate(effectiveSaleDate ? effectiveSaleDate.toISOString() : null, msaKey);
  const expectedAppreciation   = appResult?.pct ?? null;
  const msaLabel               = appResult?.label ?? (msaKey && FHFA_MSA[msaKey] ? FHFA_MSA[msaKey].label : 'FHFA National Average');
  // For expected price math: use original sale price if known, else can't compute (yearBuilt has no associated price)
  const expectedPriceAtMarket = originalSale?.price && expectedAppreciation !== null
    ? Math.round(originalSale.price * (1 + expectedAppreciation / 100))
    : null;
  const excessOverMarket = expectedAppreciation !== null && appreciationPct !== null
    ? Math.round(appreciationPct - expectedAppreciation)
    : null;
  const zestimateMidpoint = listingData.zestimate || 0;
  const zestimateGap      = zestimateMidpoint > 0 ? price - zestimateMidpoint : null;
  const zestimateGapPct   = zestimateMidpoint > 0 ? Math.round((zestimateGap / zestimateMidpoint) * 100) : null;

  const macroAppreciation = {
    msaLabel,
    orlandoMsaExpectedPct:  expectedAppreciation,
    orlandoExpectedPrice:   expectedPriceAtMarket,
    actualAppreciationPct:  appreciationPct,
    excessAppreciation:     excessOverMarket,
    zestimateGap,
    zestimateGapPct,
    interpretation: buildMacroInterpretation(appreciationPct, expectedAppreciation, excessOverMarket, zestimateGapPct, originalYear)
  };

  // ── Pre-computed valuation signal reconciliation ──────────────────────────
  // Prevents Claude from calling a property Overpriced when signals are mixed.
  // Signal weights (highest to lowest confidence):
  //   1. Zestimate gap (Zillow AVM, most reliable single signal)
  //   2. FHFA appreciation benchmark (is list price above/below market trajectory?)
  //   3. Comp $/sqft vs listing $/sqft (direct comparison)
  // Decision matrix:
  //   Overpriced:  Zestimate gap >8% OR (gap 5-8% AND excess appreciation >10%)
  //   Fair Value:  Zestimate gap -5% to +5% AND excess appreciation < 10%
  //   Underpriced: Zestimate gap < -5% OR list price below FHFA expected price
  const zpidGap    = zestimateGapPct ?? 0;
  const fhfaExcess = excessOverMarket ?? 0;
  let preComputedStatus;
  if (zpidGap > 8 || (zpidGap > 5 && fhfaExcess > 10)) {
    preComputedStatus = 'Overpriced';
  } else if (zpidGap < -5 || (expectedPriceAtMarket !== null && price < expectedPriceAtMarket * 0.97)) {
    preComputedStatus = 'Underpriced';
  } else {
    preComputedStatus = 'Fair Value';
  }
  // Comp summary — sourced entirely from DOM nearbyHomes (Zillow Similar Homes section)
  const nearbyForPrompt = Array.isArray(nearbyHomes) ? nearbyHomes : [];

  // ── Fresh listing signal — pre-compute so Claude doesn't infer incorrectly ──
  const isFreshListing = (daysOnMarket >= 0 && daysOnMarket <= 7);
  let freshListingSignal = '';
  if (isFreshListing) {
    if (preComputedStatus === 'Underpriced') {
      freshListingSignal = `FRESH LISTING + UNDERPRICED: Genuine opportunity — list price is ${Math.abs(zpidGap)}% below Zestimate. Act promptly before market corrects.`;
    } else if (preComputedStatus === 'Fair Value') {
      const hasComps     = nearbyForPrompt.length >= 2;
      freshListingSignal = hasComps
        ? `FRESH LISTING + FAIR VALUE: Solid buy if comps support it — verify ${nearbyForPrompt.length} Similar Home comp(s) before offering. Offer 97-100% of list.`
        : `FRESH LISTING + FAIR VALUE + THIN COMPS: Advise buyer to WAIT 2-3 weeks and monitor — insufficient comp data to confirm price is fair. Seller has pricing confidence they haven't yet tested.`;
    } else if (preComputedStatus === 'Overpriced') {
      freshListingSignal = `FRESH LISTING + OVERPRICED: STEER CLEAR or WAIT — seller is ${zpidGap}% above Zestimate on day ${daysOnMarket}. They have full pricing confidence and no incentive to negotiate. Days on market will create leverage naturally if they overprice; revisit after 30+ days.`;
    }
  } else if (daysOnMarket > 45) {
    freshListingSignal = `LONG DAYS ON MARKET (${daysOnMarket} days): Buyer leverage — seller has demonstrated the market has not validated their price. Use this explicitly in negotiation angle.`;
  }

  const valuationSignalStr = [
    `Zestimate gap: ${zpidGap > 0 ? '+' : ''}${zpidGap}% (list vs Zestimate)`,
    `FHFA benchmark excess: ${fhfaExcess > 0 ? '+' : ''}${fhfaExcess}% (actual vs expected appreciation)`,
    `Pre-computed valuation signal: ${preComputedStatus}`,
    `Rule: Overpriced only if Zestimate gap >8%, or gap >5% AND FHFA excess >10%. Fair Value if gap is ±5% and FHFA excess <10%.`,
    `IMPORTANT: Use this signal as the primary driver of valuation.status. You may adjust ±1 tier if comps strongly contradict it, but you MUST explain why in rationale.`
  ].join('\n');

  // Tax conflict note
  const taxConflictNote = taxDataConflict
    ? `⚠ TAX DATA CONFLICT: Listing sheet says $${Number(taxDataConflict.listingSheetValue).toLocaleString()}/yr — public record shows $${Number(taxDataConflict.publicRecordValue).toLocaleString()}/yr`
    : '';

  const compsStr = nearbyForPrompt.length > 0
    ? nearbyForPrompt.map(c => {
        const pNum   = c.priceNum || parseInt((c.price||'').replace(/[^0-9]/g,''), 10) || 0;
        const sqftStr = (c.sqft||'').toLowerCase().trim();
        const sqftK   = sqftStr.match(/^([\d.]+)k/);
        const sqftNum = sqftK ? Math.round(parseFloat(sqftK[1]) * 1000)
                     : parseInt(sqftStr.replace(/[^0-9]/g,''), 10) || 0;
        const ppsq = (pNum > 0 && sqftNum > 0) ? Math.round(pNum / sqftNum) : null;
        return `${c.addr}: ${c.price} | ${c.beds||'?'}/${c.baths||'?'} | ${c.sqft||'?'} | ${ppsq ? '~$'+ppsq+'/sqft' : '?'} | ${c.status||'For Sale'}`;
      }).join('\n')
    : 'Not available — Similar Homes section not found on page';

  // MLS verification
  const mlsStr = mls
    ? `MLS Status: ${mls.status || 'Unknown'} | Listed: ${mls.listDate || 'Unknown'} | Days: ${mls.daysOnMarket || 'Unknown'} | Agent MLS ID: ${mls.agentMlsId || 'Unknown'}`
    : `MLS# ${listingData.mlsId || 'Unknown'}${listingData.mlsSource ? ' on ' + listingData.mlsSource : ''} — verification not completed`;

  // Zestimate context
  const zestStr = listingData.zestimate > 0
    ? `$${Number(listingData.zestimate).toLocaleString()} (range: $${Number(listingData.zestimateRange?.low||0).toLocaleString()} – $${Number(listingData.zestimateRange?.high||0).toLocaleString()})`
    : 'Not available';

  // Agent validation context
  const agentValidationStr = agent?.licenseNumber
    ? [
        `License: ${agent.licenseNumber}`,
        `Type: ${agent.licenseType || 'Unknown'}`,
        `Active: ${agent.isActive ? 'YES' : 'NO'}`,
        `Renewal status: ${agent.renewalStatus || 'Unknown'}`,
        `Expires: ${agent.expiry || 'Unknown'}`,
        `Employer on file: ${agent.employer || 'Unknown'}`,
        `County: ${agent.county || 'Unknown'}`,
        `Source: ${agent.source}`,
        agent.concerns?.length ? `⚠ Concerns: ${agent.concerns.join('; ')}` : 'No concerns found'
      ].join(' | ')
    : `Unverified — DBPR CSV lookup failed. Manual check: myfloridalicense.com (search: ${agentName})`;

  // County data
  const countyStr = county?.assessedValue > 0
    ? `County assessed: $${Number(county.assessedValue).toLocaleString()} | Market value: $${Number(county.marketValue||0).toLocaleString()} | Owner: ${county.ownerName||'Unknown'} | Exemptions: ${county.exemptions||'None'} | Source: ${county.source}`
    : `County lookup not completed — parcel ${listingData.parcelNumber || 'unknown'}. Use ocpafl.org to verify.`;

  // Schools — prefer NEXT_DATA (listingData.schools), fall back to the DOM scrape
  // (listingData.nearbySchools). The two sources use different field names for
  // distance (.distance vs .dist), so normalize when reading the fallback.
  const schoolSource = (Array.isArray(listingData.schools) && listingData.schools.length)
    ? listingData.schools
    : (Array.isArray(listingData.nearbySchools) ? listingData.nearbySchools : []);
  const schoolsStr = schoolSource.length
    ? schoolSource.map(s => {
        const dist = s.distance || s.dist || '';
        const grades = s.grades ? ` (${s.grades})` : '';
        const rating = s.rating || 'rating n/a';
        return `${s.name}${grades}: ${rating}${dist ? ' — ' + dist : ''}`;
      }).join(' | ')
    : 'Not available';

  // ── Conditional-flag signals (drive what risks/actions/highlights may include) ──
  // The goal is to stop padding the analysis with generic "verify X" boilerplate when
  // the listing already answers the question:
  //   • Schools — only worth a school zone / school-rating callout when NONE were found.
  //   • HOA — only flag for verification when the listing shows NO HOA fee (or a garbled
  //     name); a clearly stated fee like "$250/mo" does not need a verification flag.
  //   • Flood — only flag flood insurance when the property is in an elevated/SFHA zone;
  //     FEMA Zone X (minimal-risk) does not warrant a flood flag.
  const schoolsZoned = schoolSource.length > 0;
  const hoaFeeNum    = parseNum(String(hoaFee || 0));
  const hasHoaFee    = hoaFeeNum > 0;
  const hoaNameGarbled = !!hoaName && /^(n\/?a|none|unknown|hoa)$/i.test(String(hoaName).trim());
  // Elevated flood risk: SFHA zones (A*/V*) OR a parsed/First-Street level above minimal.
  const floodZoneElevated = !!floodZone && /^(A|AE|AH|AO|AR|A99|V|VE)$/i.test(String(floodZone).trim());
  const floodLevelElevated = (!!floodRiskLevel && !/minimal/i.test(floodRiskLevel)) ||
                             (!!floodFactor && !/^(minimal|minor|1|2|none)$/i.test(String(floodFactor).trim()));
  const floodRiskElevated = floodZoneElevated || floodLevelElevated;
  const floodZoneStr = floodZone
    ? `FEMA Zone ${floodZone}${floodRiskLevel ? ` (${floodRiskLevel}-risk)` : ''}`
    : (floodFactor ? `First Street: ${floodFactor}` : 'not listed');

  // Construction: only treat as non-block when materials are PRESENT and contain no
  // block/brick. Empty materials must NOT be assumed non-block, and a "Slab" foundation
  // is normal in FL (block walls on a slab) — it is not a defect.
  const matStr = String(constructionMaterials || '').trim();
  const materialsHasBlockBrick = /block|brick|masonry|cbs|concrete/i.test(matStr);
  const nonBlockConfirmed = !!matStr && !materialsHasBlockBrick;

  // Appliances/systems: "undisclosed" is only fair if the TYPE is genuinely absent.
  // The one valid related flag is "appliance brands undisclosed", and only when no
  // brand NAMES appear in the appliance list OR the description.
  const applianceTypesListed = !!String(appliances || '').trim();
  const systemsListed = !!String(cooling || '').trim() || !!String(heating || '').trim();
  const brandRe = /\b(samsung|ge|g\.e\.|whirlpool|lg|bosch|kitchenaid|frigidaire|maytag|wolf|sub-?zero|thermador|miele|kenmore|electrolux|ge profile|café|cafe|jenn-?air|viking|amana|hotpoint|monogram)\b/i;
  const applianceBrandsPresent = brandRe.test(String(appliances || '') + ' ' + String(description || ''));

  const conditionalFlagDirectives = `CONDITIONAL FLAGS — follow exactly; do not pad the analysis with boilerplate that the listing already answers:
- Schools zoned/available: ${schoolsZoned ? 'YES' : 'NO'}. ${schoolsZoned
    ? 'Do NOT add a "verify school zone assignments" action, and do NOT spend a key highlight on schools unless a rating is unusually low/high and decision-relevant.'
    : 'No schools were found, so you MAY include one action to verify school zone assignments with the district.'}
- HOA fee on listing: ${hasHoaFee ? `YES ($${hoaFeeNum}/mo)` : 'NO'}.${hoaNameGarbled ? ' HOA name looks garbled/generic.' : ''} ${(!hasHoaFee || hoaNameGarbled)
    ? 'You MAY include one HOA verification item.'
    : 'Do NOT add an HOA fee/verification risk or action — the fee is clearly stated. (Verifying reserves/special assessments is only warranted if there is a specific signal such as multiple HOA entities.)'}
- Flood risk: ${floodZoneStr}. ${floodRiskElevated
    ? 'Elevated — you MAY include a flood-insurance cost/verification flag.'
    : 'Minimal — do NOT add any flood-insurance or flood-risk flag; this is a minimal-risk (Zone X) property.'}
- Construction materials: ${matStr || 'not captured'}. ${nonBlockConfirmed
    ? 'No block/brick listed — you MAY note wood-frame construction (higher FL insurance/wind exposure).'
    : 'Do NOT add a "non-block foundation/construction" risk — ' + (materialsHasBlockBrick ? 'the materials include block/brick.' : 'materials are not disclosed, so non-block must NOT be assumed.') + ' A "Slab" foundation is normal and is not a defect.'}
- Appliances: ${applianceTypesListed ? 'types listed' : 'not listed'}; HVAC: ${systemsListed ? 'listed' : 'not listed'}; brand names present: ${applianceBrandsPresent ? 'YES' : 'NO'}. ${(!applianceBrandsPresent)
    ? 'You MAY add ONE low/medium item titled "Appliance brands undisclosed" (request brands/model numbers to confirm warranty status). Do NOT claim appliances or systems themselves are undisclosed when types are listed.'
    : 'Brand names are present — do NOT add any appliance/systems "undisclosed" risk.'}`;


  const profile = listingData.userProfile || {};
  const downPct        = (profile.downPaymentPct  || 20) / 100;
  // Mortgage rate: user's manual entry wins. If blank, default to the live FRED
  // 30-yr average + 0.125% (buyers typically pay slightly above the survey average).
  let defaultRate = 7.0;
  try {
    const fredRate = await getMortgageRate();
    if (fredRate && fredRate > 0) defaultRate = Math.round((fredRate + 0.125) * 1000) / 1000;
  } catch (e) {}
  const userRate       = parseFloat(profile.mortgageRatePct);
  const effectiveRatePct = (isFinite(userRate) && userRate > 0) ? userRate : defaultRate;
  const ratePct        = effectiveRatePct / 100;
  const termYears      = profile.loanTermYears    || 30;
  const annualIncome   = profile.annualIncome      || 0;
  const monthlyDebts   = profile.monthlyDebts      || 0;
  const monthlyTakehome = profile.monthlyTakehome  || 0;
  const prefs          = profile.prefs             || {};
  const commuteAddrs   = profile.commuteAddrs      || {};
  const priceCheckMode = prefs.priceCheckMode      || 'fair_value';
  const offerStrategy  = prefs.offerStrategy       || 'competitive';
  const floodInsurance = prefs.floodInsurance      || false;

  const priorities  = (profile.priorities || []);
  const priorityStr = priorities.length > 0
    ? `Buyer priorities (INCREASE risk severity for these): ${priorities.join(', ')}`
    : 'No priorities set';

  // Fetch commute estimates in parallel with the rest of pre-computation
  const commutePromise = fetchCommuteEstimates(listingData.address, commuteAddrs);

  // Investment cash flow — only computed when investment priority is selected
  const isInvestmentMode = priorities.includes('investment');
  let investCashFlowBlock = '';
  let investCashFlowJSON = '"investorCashFlow": null,';
  if (isInvestmentMode) {
    const fedFundsInv  = await getFedFundsRate();
    const invRate      = (fedFundsInv + FED_FUNDS_SPREAD) / 100;
    const invLTV       = 0.75; // 25% down
    const invN         = 360;
    const invMonthRate = invRate / 12;
    const invLoan      = price * invLTV;
    const invPI        = Math.round(invLoan * (invMonthRate * Math.pow(1+invMonthRate,invN)) / (Math.pow(1+invMonthRate,invN)-1));
    const invHoa       = parseNum(String(hoaFee || 0));
    const invTax       = Math.round(price * 0.012 / 12);
    const invIns       = Math.round(price * 0.006 / 12);
    const invMaint     = Math.round(price * 0.010 / 12);
    const invAllIn     = invPI + invHoa + invTax + invIns + invMaint;
    const rentZ        = listingData.rentZestimate || 0;
    const invCashFlow  = rentZ > 0 ? rentZ - invAllIn : null;
    const invViable    = Math.round(invAllIn * 1.25);
    const invBreakEven = invAllIn;
    const invRateDisp  = (fedFundsInv + FED_FUNDS_SPREAD).toFixed(3);

    investCashFlowBlock = `
═══ INVESTOR CASH FLOW (investment priority selected) ═══
Purchase Price: $${price.toLocaleString()} | 25% down, ${invRateDisp}% rate (fed funds ${fedFundsInv.toFixed(2)}% + 2.75%)
Est. P&I: $${invPI.toLocaleString()}/mo | All-In Cost (P&I+HOA+Tax+Ins+Maint): $${invAllIn.toLocaleString()}/mo
Rent Zestimate: $${rentZ > 0 ? rentZ.toLocaleString() + '/mo' : 'N/A'} | Est. Cash Flow: ${invCashFlow !== null ? (invCashFlow >= 0 ? '+$' : '-$') + Math.abs(invCashFlow).toLocaleString() + '/mo' : 'N/A (no rent zestimate)'}
Break-Even Rent (1.0x): $${invBreakEven.toLocaleString()}/mo | Healthy Return Rent (1.25x): $${invViable.toLocaleString()}/mo`;

    investCashFlowJSON = `"investorCashFlow": {
    "purchasePrice": ${price},
    "investorRate": "${invRateDisp}%",
    "estimatedMortgage": ${invPI},
    "estimatedTotalOwnerCost": ${invAllIn},
    "rentZestimate": ${rentZ || 'null'},
    "monthlyCashFlow": ${invCashFlow !== null ? invCashFlow : 'null'},
    "cashFlowLabel": ${invCashFlow === null ? '"No Rent Data"' : invCashFlow >= invAllIn * 0.25 ? '"Healthy Return"' : invCashFlow >= 0 ? '"Marginal"' : '"Cash Negative"'},
    "breakEvenRent": ${invBreakEven},
    "viableRent": ${invViable},
    "investmentNote": <1 sentence — viability as rental investment, negotiation leverage if cash negative>
  },`;
  }
  const loanAmount  = price * (1 - downPct);
  const monthlyRate = ratePct / 12;
  const numPayments = termYears * 12;
  const piPayment   = loanAmount > 0
    ? Math.round(loanAmount * (monthlyRate * Math.pow(1+monthlyRate, numPayments)) / (Math.pow(1+monthlyRate,numPayments)-1))
    : 0;
  const monthlyTax  = Math.round(taxAfterReset / 12); // use post-reset estimate
  const monthlyHoa  = parseNum(String(hoaFee || 0));

  // ── Insurance estimate engine ─────────────────────────────────────────────
  const insEst = estimateInsurance({
    state:        detectStateFromAddress(address),
    propertyType: propertyType || listingData.propertySubtype || '',
    price,
    yearBuilt:    parseNum(String(yearBuilt || 0)),
    construction: constructionMaterials || '',
    hasHoa:       !!(hoaFee && parseNum(String(hoaFee)) > 0),
    zip:          (address || '').match(/\d{5}/)?.[0] || '',
    roofType:     roofType || '',
    userOverride: profile.monthlyInsurance || 0
  });

  const monthlyIns  = insEst.monthly;
  const totalPITI   = piPayment + monthlyTax + monthlyHoa + monthlyIns;
  const dtiHousing  = annualIncome > 0 ? Math.round((totalPITI / (annualIncome/12)) * 100) : null;
  const dtiTotal    = annualIncome > 0 ? Math.round(((totalPITI + monthlyDebts) / (annualIncome/12)) * 100) : null;

  const affordability = {
    downPayment:          Math.round(price * downPct),
    loanAmount:           Math.round(loanAmount),
    piPayment,
    monthlyTax,
    monthlyHoa,
    monthlyInsurance:     monthlyIns,
    insuranceAnnual:      insEst.annual,
    insurancePct:         profile.insurancePct || 0,
    insuranceBasis:       insEst.basis,
    insuranceNotes:       insEst.notes,
    totalPITI,
    dtiHousingPct:        dtiHousing,
    dtiTotalPct:          dtiTotal,
    dtiHousingWarning:    dtiHousing !== null ? dtiHousing > 28 : null,
    dtiTotalWarning:      dtiTotal !== null ? dtiTotal > 36 : null,
    dtiTotalDanger:       dtiTotal !== null ? dtiTotal > 43 : null,
    dtiWarning:           dtiHousing !== null ? dtiHousing > 28 : null, // keep for backward compat
    mortgageRatePct:      effectiveRatePct,   // user's rate or FRED-derived default — client PITI uses this
    rateIsDefault:        !(isFinite(userRate) && userRate > 0),
    downPaymentPct:       downPct * 100,
    assumptions:          `${(downPct*100).toFixed(0)}% down, ${(ratePct*100).toFixed(3)}% rate, ${termYears}yr fixed`
  };

  const macroStr = originalYear
    ? `${msaLabel} cumulative appreciation from ${originalYearStr} to now: ~${expectedAppreciation}% | Expected fair price: $${expectedPriceAtMarket?.toLocaleString() || 'N/A'} | Listed at: $${price?.toLocaleString()} | Actual: ${appreciationPct}% | Excess vs benchmark: ${excessOverMarket !== null ? (excessOverMarket > 0 ? '+' : '') + excessOverMarket + '%' : 'N/A'} | Zestimate: $${zestimateMidpoint?.toLocaleString()} (gap: ${zestimateGapPct !== null ? (zestimateGapPct > 0 ? '+' : '') + zestimateGapPct + '%' : 'N/A'}) | ${macroAppreciation.interpretation}${originalYearIsFallback ? '\n  *Anchor year derived from yearBuilt; no prior sale on record' : ''}`
    : 'No original sale date — appreciation analysis not available';

  // Regional market temperature — affects how aggressive offers should be
  const marketTemp = getMarketTemp(detectStateFromAddress(address));
  const marketTempStr = `Regional market: ${marketTemp.temp.toUpperCase()} market | Median DOM: ${marketTemp.medianDom} days | ${marketTemp.note} | Aggressiveness modifier: ${marketTemp.modifier > 0 ? '+' : ''}${marketTemp.modifier}% (applied to base aggressiveness)`;

  const affordStr = `PITI at LIST PRICE ($${price.toLocaleString()}): P&I: $${piPayment.toLocaleString()}/mo | Tax (post-reset est.): $${monthlyTax}/mo | HOA: $${monthlyHoa}/mo | Insurance: $${monthlyIns}/mo (${insEst.basis}) | Total PITI: $${totalPITI.toLocaleString()}/mo | Gross monthly income: $${annualIncome > 0 ? Math.round(annualIncome/12).toLocaleString() : 'not provided'} | Housing DTI: ${dtiHousing !== null ? dtiHousing+'% (threshold 28%)' : 'N/A — no income provided'} | Total DTI (with debts): ${dtiTotal !== null ? dtiTotal+'% (threshold 36%/43%)' : 'N/A'} | ${affordability.assumptions}
IMPORTANT: When citing PITI in keyHighlights or commentary, recalculate at your RECOMMENDED OFFER PRICE (suggestedOffer), not the list price. The UI displays affordability at the Clear Home offer. Example: if list is $565K but you recommend $548K, cite PITI at $548K.`;

  // ── Premium feature extraction — structured before API call ──────────────────
  // Extract all meaningful premiums from description + facts so Claude can
  // accurately assess price-per-sqft justification vs comps.
  const combinedText = [
    description || '',
    interiorFeatures || '',
    exteriorFeatures || '',
    appliances || '',
    flooring || '',
    listingData.constructionMaterials || '',
    listingData.roofType || '',
    listingData.garage || ''
  ].join(' ').toLowerCase();

  const premiumSignals = [];

  // ── Outdoor / lot premiums ─────────────────────────────────────────────────
  if (listingData.hasPool || /\bpool\b/.test(combinedText))
    premiumSignals.push({ feature: 'Pool', category: 'Outdoor', value: 'HIGH', note: 'Pool value varies by climate: FL/AZ/CA/TX in-ground appraises $25K-$27K (HomeLight 2024). Cold-weather states (IL, MN, NY): pool may add little/no value and can be a buyer liability. Verify local market norms.' });
  if (/\bspa\b|\bpool.spa\b|\bhot.?tub\b/.test(combinedText))
    premiumSignals.push({ feature: 'Spa/Hot Tub', category: 'Outdoor', value: 'MEDIUM', note: 'Adds modest value, weight against maintenance cost' });
  if (/\bwater.?view\b|\blake.?view\b|\bpond.?view\b|\bwater.?front\b|\blakefront\b|\bwaterfront\b/.test(combinedText))
    premiumSignals.push({ feature: 'Water View/Waterfront', category: 'Lot', value: 'HIGH', note: 'Waterfront/view lots command 10-25% premium vs standard lots' });
  if (/\bcul.?de.?sac\b|\bconservation\b|\bpreserve.?view\b|\bno.rear.neighbor\b/.test(combinedText))
    premiumSignals.push({ feature: 'Premium Lot', category: 'Lot', value: 'MEDIUM', note: 'Cul-de-sac/conservation/no rear neighbors adds 3-8% premium' });
  if (/\bextended.?patio\b|\bsummer.?kitchen\b|\boutdoor.?kitchen\b|\bcovered.?lanai\b|\bscreened.?enclos\b/.test(combinedText))
    premiumSignals.push({ feature: 'Outdoor Living Space', category: 'Outdoor', value: 'MEDIUM', note: 'Extended screened/covered outdoor living adds tangible value' });
  if (/\bsolar\b|\bsolar.?panel/.test(combinedText))
    premiumSignals.push({ feature: 'Solar Panels', category: 'Energy', value: 'MEDIUM', note: 'Solar value is state-dependent: Zillow study shows +4.1% nationally, +4.6% in Orlando FL, +5.4% in NYC. High-electricity-rate states (CA, NY, CT, MA, NJ) see higher premiums. CRITICAL: owned systems = full appraisal credit; leased = may add zero value and complicates sale. Always verify ownership.' });
  if (/\bev.?char\b|\belectric.?vehicle.?char\b|\bcharging.?station\b/.test(combinedText))
    premiumSignals.push({ feature: 'EV Charger', category: 'Energy', value: 'LOW', note: 'EV charger adds modest premium, appeals to specific buyers' });

  // ── Interior quality premiums ─────────────────────────────────────────────
  if (/\bquartz\b|\bgranite\b|\bmarble\b|\bquartzite\b/.test(combinedText))
    premiumSignals.push({ feature: 'Stone Countertops', category: 'Interior', value: 'MEDIUM', note: 'Standard in this price tier — neutral unless notably extensive' });
  if (/\bhardwood\b|\bwood.?floor\b|\bengineered.?wood\b|\bhardwood.?floor\b/.test(combinedText))
    premiumSignals.push({ feature: 'Hardwood/Wood Flooring', category: 'Interior', value: 'MEDIUM', note: 'Hardwood is a meaningful upgrade over tile/carpet in most markets. In high-humidity southern climates (FL, Gulf Coast), engineered wood is preferred over solid hardwood — verify type.' });
  if (/\bcoffered.?ceil\b|\btray.?ceil\b|\bcrown.?mold\b/.test(combinedText))
    premiumSignals.push({ feature: 'Premium Ceilings/Millwork', category: 'Interior', value: 'LOW-MEDIUM', note: 'Cosmetic premium — improves feel but adds limited resale delta' });
  if (/\bsmart.?home\b|\bsmart.?light\b|\bautomation\b|\bcrest\b|\blutron\b/.test(combinedText))
    premiumSignals.push({ feature: 'Smart Home Technology', category: 'Interior', value: 'LOW-MEDIUM', note: 'Adds convenience value, tech-savvy buyers prefer it' });

  // ── Kitchen premiums ──────────────────────────────────────────────────────
  if (/\bwolf\b|\bsub.?zero\b|\bthermador\b|\bmiele\b|\bvikings?\b/.test(combinedText))
    premiumSignals.push({ feature: 'Luxury Appliances', category: 'Kitchen', value: 'HIGH', note: 'Wolf/Sub-Zero/Thermador retail $15K-$40K above standard SS. Appraisers typically credit $8K-$20K net. Strong buyer signal in $600K+ tier.' });
  if (/\bwine.?cellar\b|\bwine.?room\b|\bwine.?cooler\b|\bwine.?fridge\b/.test(combinedText))
    premiumSignals.push({ feature: 'Wine Storage', category: 'Kitchen', value: 'MEDIUM', note: 'Niche premium — appeals to specific buyer profile' });
  if (/\bbutler.?pantry\b|\bwalk.?in.?pantry\b/.test(combinedText))
    premiumSignals.push({ feature: 'Butler/Walk-In Pantry', category: 'Kitchen', value: 'MEDIUM', note: 'Storage premium valued by families' });

  // ── Primary suite premiums ────────────────────────────────────────────────
  if (/\bspa.?bath\b|\bfreestand.?tub\b|\bsoaking.?tub\b|\bsteam.?shower\b/.test(combinedText))
    premiumSignals.push({ feature: 'Spa Primary Bath', category: 'Primary Suite', value: 'MEDIUM-HIGH', note: 'Luxury bath adds meaningful resale value in this price tier' });

  // ── System/structural upgrades ────────────────────────────────────────────
  if (/\bnew.?roof\b|\bnew.?a\/c\b|\bnew.?hvac\b|\bnew.?ac\b|\bnew.?air.?condition\b/.test(combinedText))
    premiumSignals.push({ feature: 'Recent Major System Replacement', category: 'Systems', value: 'HIGH', note: 'New roof: $12K-$30K deferred cost avoidance (NRCA national range; FL/coastal higher due to wind ratings). New HVAC: $8K-$15K. Buyers routinely discount offers by these amounts when systems are aging — recent replacements eliminate that leverage.' });
  if (/\bimpact.?window\b|\bhurricane.?window\b|\bstorm.?shutter\b/.test(combinedText))
    premiumSignals.push({ feature: 'Impact Windows/Hurricane Protection', category: 'Systems', value: 'MEDIUM-HIGH', note: 'Hurricane/storm market value: $15K-$25K resale in FL, Gulf Coast, and coastal SE states + reduces homeowner insurance 15-25%. In non-hurricane states (Midwest, Mountain West, Pacific NW) this feature has minimal resale premium.' });
  if (/\bwhole.?home.?generator\b|\bgenerator\b/.test(combinedText))
    premiumSignals.push({ feature: 'Generator', category: 'Systems', value: 'MEDIUM', note: 'High value in hurricane/severe-weather markets (FL, Gulf Coast, TX, Southeast). Moderate value in Midwest/Northeast for winter outages. Minimal in mild climates.' });
  if (/\bsalt.?water\b|\bchlorinefree\b/.test(combinedText))
    premiumSignals.push({ feature: 'Saltwater Pool', category: 'Outdoor', value: 'LOW-MEDIUM', note: 'Minor premium over standard chlorine — lower maintenance cost' });

  // ── Renovation signals ────────────────────────────────────────────────────
  if (/\bfully\s+renovat\b|\bcomplete\s+renovat\b|\bcompletely\s+updat\b|\btotally\s+renovat\b|\bturn.?key\b/.test(combinedText))
    premiumSignals.push({ feature: 'Full Renovation', category: 'Renovation', value: 'HIGH', note: 'NAR 2024: full renovations command 8-12% premium vs unrenovated comparable. Kitchen+bath together recover 60-80% of cost at resale.' });
  if (/\bnew.?\s+kitchen\b|\bnew\s+bath\b|\nkitchen\s+remodel\b|\bbath\s+remodel\b/.test(combinedText))
    premiumSignals.push({ feature: 'Kitchen/Bath Remodel', category: 'Renovation', value: 'MEDIUM-HIGH', note: 'Kitchen and bath remodels recover 60-80% of cost at resale' });
  if (/\bnew\s+paint\b|\bnew\s+flooring\b|\bnew\s+carpet\b|\nfresh\s+paint\b/.test(combinedText))
    premiumSignals.push({ feature: 'Cosmetic Updates', category: 'Renovation', value: 'LOW', note: 'Fresh paint/flooring adds appeal but minimal resale delta' });

  // ── Deduct signals (features that do NOT justify premium) ─────────────────
  const discountSignals = [];
  if (/\bneeds\s+work\b|\bfixer\b|\bas.is\b|\bas\s+is\b|\brepairs\s+needed\b/.test(combinedText))
    discountSignals.push('As-is/fixer — price should reflect deferred maintenance');
  if (/\bcarpet\b/.test(combinedText) && !/\bnew\s+carpet\b/.test(combinedText))
    discountSignals.push('Carpet in living areas — dated finish, buyer may need to replace');
  if (/\bbusy\s+road\b|\bartery\b|\bcommercial\b/.test(combinedText))
    discountSignals.push('Proximity to busy road or commercial — noise/traffic discount');

  // ── Summary string for the prompt ─────────────────────────────────────────
  const premiumStr = premiumSignals.length > 0
    ? premiumSignals.map(p => `[${p.value}] ${p.feature} (${p.category}): ${p.note}`).join('\n')
    : 'No notable premiums detected beyond standard finishes';

  const discountStr = discountSignals.length > 0
    ? discountSignals.join('\n')
    : 'None';

  const premiumAdjustedPpsq = (() => {
    // Rough premium adjustment to effective $/sqft for context
    // Pool: +$25K, Water view: +15%, Solar: +$20K, Full reno: +10%, New systems: +$20K each
    const sqftNum = sqft || 1;
    let adj = 0;
    // Pool: positive premium in warm/sun states, neutral/negative in cold states
    if (premiumSignals.some(p => p.feature === 'Pool')) {
      const warmStates = ['FL','AZ','CA','TX','NV','HI','NM','GA','SC','NC','AL','MS','LA'];
      const poolAdj = warmStates.includes(propertyState || '') ? 26000 : 5000;  // cold states: minimal
      adj += poolAdj;
    }
    if (premiumSignals.some(p => p.feature === 'Water View/Waterfront'))       adj += price * 0.15;  // conservative FL waterfront range
    if (premiumSignals.some(p => p.feature === 'Solar Panels'))                adj += price * 0.04;  // Zillow Orlando 4.6%, use 4% conservative
    if (premiumSignals.some(p => p.feature === 'Luxury Appliances'))           adj += 12000;  // appraiser credit $8-20K, use $12K conservative
    if (premiumSignals.some(p => p.feature === 'Full Renovation'))             adj += price * 0.10;  // NAR midpoint
    if (premiumSignals.some(p => p.feature === 'Recent Major System Replacement')) adj += 28000;  // roof+HVAC combined deferred cost avoidance
    // Impact windows: only meaningful premium in hurricane/coastal markets
    if (premiumSignals.some(p => p.feature === 'Impact Windows/Hurricane Protection')) {
      const coastalStates = ['FL','TX','LA','MS','AL','GA','SC','NC','VA','MD','DE','NJ','NY','CT','RI','MA','ME','HI'];
      adj += coastalStates.includes(propertyState || '') ? 18000 : 4000;  // minimal in non-coastal
    }
    if (adj === 0) return null;
    const adjustedPrice = price - adj;
    return adjustedPrice > 0 ? Math.round(adjustedPrice / sqftNum) : null;
  })();

  // ── OFFER PRICE ENGINE (deterministic, JS-computed) ────────────────────────
  // Replaces the in-prompt Stage A/B formula. JS owns the numbers; the AI only
  // writes the rationale sentence around the final figures. All inputs already
  // exist client-side, so this is free, instant, and 100% consistent.
  const offerCalc = computeOfferPrice({
    price,
    sqft,
    originalSalePrice:    originalSale?.price || 0,
    expectedAppreciation, // FHFA cumulative % since prior sale (or yearBuilt fallback)
    zestimate:            zestimateMidpoint || 0,
    nearbyHomes:          nearbyForPrompt,
    beds, baths,
    daysOnMarket,
    priceHistory,
    description:          description || '',
    regionalModifier:     marketTemp.modifier || 0,
    premiumSignals,
    offerStrategy,
  });

  // Compact, factual block for the prompt — the AI consumes these as GIVEN facts.
  const offerStr = [
    `Estimated market bottom (Clear Home computed): $${offerCalc.fairValue.toLocaleString()} — the lowest defensible value from FHFA appreciation + sold comps. This is the FLOOR of fair value, not the midpoint. The AI's broader fair-value range may sit above this.`,
    `  Inputs: FHFA-adjusted prior sale ${offerCalc.fhfaValue ? '$'+offerCalc.fhfaValue.toLocaleString() : 'N/A'} (w=${offerCalc.weights.fhfa}), sold-comp basis ${offerCalc.compValue ? '$'+offerCalc.compValue.toLocaleString() : 'N/A'} (w=${offerCalc.weights.comps}), Zestimate ${offerCalc.zestimate ? '$'+offerCalc.zestimate.toLocaleString() : 'N/A'} (w=${offerCalc.weights.zest})${offerCalc.upgradePremium > 0 ? ', upgrade premium +$'+offerCalc.upgradePremium.toLocaleString()+' (70% credit, capped 8%)' : ''}`,
    `Comp median $/sqft: ${offerCalc.compMedianPpsf ? '$'+offerCalc.compMedianPpsf : 'N/A'}${offerCalc.compCount ? ' (from '+offerCalc.compCount+' bed/bath-matched comps)' : ''}`,
    `Base aggressiveness: ${offerCalc.baseAggressiveness}% (${offerCalc.aggressivenessReason})`,
    `Regional modifier: ${offerCalc.regionalModifier > 0 ? '+' : ''}${offerCalc.regionalModifier}% (${marketTemp.temp} market)`,
    `Final aggressiveness: ${offerCalc.finalAggressiveness}%`,
    `Offer basis: ${offerCalc.offerBasis}`,
    `SUGGESTED OFFER (Clear Home): $${offerCalc.suggestedOffer.toLocaleString()}`,
    `Offer $/sqft: $${offerCalc.offerPpsf}`,
    `RECOMMENDED SELLER CREDIT (Clear Home): $${(offerCalc.sellerCredit||0).toLocaleString()} (${offerCalc.sellerCreditPct}% of price, scaled by seller motivation). Use this EXACT figure for any closing-cost credit you mention.`,
    `Detected motivation signals: ${offerCalc.motivationSignals.length ? offerCalc.motivationSignals.join('; ') : 'none (fresh listing or no signals)'}`,
  ].join('\n');

  const userPrompt = `TODAY'S DATE: ${TODAY} — do NOT flag any date on or before today as future.

Analyze this real estate listing and return ONLY a valid JSON object — no markdown, no preamble.

═══ PROPERTY ═══
Address: ${address || 'Unknown'}
State: ${propertyState || 'Unknown'} | MSA: ${msaLabel || 'National Average (no MSA match)'}
Listed Price: $${price?.toLocaleString() || 'Unknown'}${listingData._priceCorrected ? ' ⚠ NOTE: price was estimated from $/sqft — verify against actual listing' : ''}
Sqft: ${sqft || 'Unknown'} | Beds: ${beds || '?'} | Baths: ${bathsDetail || baths || '?'}
Price/sqft: ${pricePerSqft ? '$' + pricePerSqft : 'Unknown'}
Type: ${propertyType || 'Unknown'} | Model: ${propertyModel || 'Not specified'}${builderName ? ' | Builder: ' + builderName : ''} | Year Built: ${yearBuilt || 'Unknown'}
Year Built: ${yearBuilt || 'Unknown'} | Lot: ${lotSize || 'Unknown'}
Stories: ${stories || '?'} | Garage: ${garage || '?'}
Subdivision: ${subdivision || 'Unknown'} | Zoning: ${zoning || 'Unknown'}
New Construction: ${newConstruction ? 'Yes' : 'No'}

═══ SYSTEMS ═══
Cooling: ${cooling || 'Unknown'} | Heating: ${heating || 'Unknown'}
Roof: ${roofType || 'Unknown'} | Foundation: ${foundation || 'Unknown'}${nonBlockConfirmed ? ' ⚠ NON-BLOCK CONSTRUCTION (materials lack block/brick)' : ''}
Construction: ${constructionMaterials || 'Unknown'}
Flooring: ${flooring || 'Unknown'}
Appliances: ${appliances || 'Unknown'}
Pool: ${hasPool ? 'Yes' : 'No'} | Fireplace: ${fireplace ? 'Yes' : 'No'}
Sewer: ${sewer || 'Unknown'} | Water: ${waterSource || 'Unknown'}

═══ FINANCIALS ═══
HOA: ${hoaFee ? '$' + hoaFee + '/mo (' + (hoaName || 'HOA') + ')' : 'None listed'}
Senior/Age-Restricted Community (MLS field): ${seniorCommunityMLS ? 'Flagged YES in MLS' : 'No'}${seniorCommunityUnverified ? ' ⚠ UNVERIFIED — not explicitly stated in description or community name. Treat as unconfirmed.' : ''}${seniorCommunityConfirmed ? ' ✓ CONFIRMED — explicitly stated in description/community name.' : ''}
Listing sheet assessed value: $${Number(taxAssessedValueListing||0).toLocaleString()}
Listing sheet annual tax: $${Number(taxAnnualAmountListing||0).toLocaleString()} (${taxYearListing || 'year unknown'})
${taxConflictNote}
Zestimate: ${zestStr}
Listed: ${listDate || 'Unknown'} | Days on Market: ${daysOnMarket >= 0 ? daysOnMarket : 'Unknown'}
${freshListingSignal ? `⚡ LISTING TIMING SIGNAL: ${freshListingSignal}` : ''}
MLS: ${mlsId || 'Unknown'} | Source: ${mlsSource || 'Unknown'} | Originating: ${originatingMls || 'Unknown'}
Parcel: ${parcelNumber || 'Unknown'}
Listing Terms: ${listingTerms || 'Unknown'} | Ownership: ${ownership || 'Unknown'}

═══ TAX ANALYSIS (pre-computed) ═══
${taxPreComputedStr}
═══ PRICE HISTORY ═══
${priceHistStr}
${appreciationNote}

═══ MLS VERIFICATION ═══
${mlsStr}

═══ SIMILAR HOMES (Zillow Similar Homes section — source of truth for comps) ═══
${compsStr}

═══ NEARBY COMPARABLES (Zillow "Similar Homes" section — max 5, already curated by Zillow) ═══
Subject: $${price?.toLocaleString()} · ${beds||'?'}bd/${baths||'?'}ba · ${sqft||'?'} sqft · $${pricePerSqft||'?'}/sqft · Type: ${propertyType||'Unknown'}
${Array.isArray(nearbyHomes) && nearbyHomes.length > 0
  ? nearbyHomes.map(h => {
      const pNum = h.priceNum || parseInt((h.price||'').replace(/[^0-9]/g,''),10) || 0;
      const sqftRaw = (h.sqft||'').toLowerCase().replace(/,/g,'');
      const sqftNum = sqftRaw.endsWith('k') ? Math.round(parseFloat(sqftRaw)*1000) : parseInt(sqftRaw,10) || 0;
      const ppsq = (pNum > 0 && sqftNum > 0) ? Math.round(pNum/sqftNum) : null;
      return `${h.addr}: ${h.price}${h.beds?' · '+h.beds:''}${h.baths?'/'+h.baths:''}${h.sqft?' · '+h.sqft:''}${ppsq?' · $'+ppsq+'/sqft':''} · ${h.status||'For Sale'}`;
    }).join('\n')
  : 'None — Similar Homes section not found on page'}

═══ NEARBY SCHOOLS ═══
${Array.isArray(nearbySchools) && nearbySchools.length > 0 ? nearbySchools.slice(0,4).map(s => `${s.name}${s.rating ? ' · Rating: '+s.rating : ''}${s.grades ? ' · '+s.grades : ''}${s.dist ? ' · '+s.dist : ''}`).join('\n') : 'None scraped'}

═══ AGENT & BROKERAGE ═══
Agent: ${agentName || 'Unknown'} | Phone: ${agentPhone || 'Unknown'}
Brokerage: ${brokerageName || 'Unknown'}
${/highly motivated|must sell|motivated seller|price reduced|bring all offers|won't last|priced to sell/i.test(description||'') ? '⚠ MOTIVATED SELLER SIGNAL detected in description — apply 5-10% additional discount to recommended offer price based on desperation level (5% = soft signal, 10% = urgent/multiple signals)' : ''}
License Validation: ${agentValidationStr}

═══ COUNTY RECORDS ═══
${countyStr}

═══ PROPERTY DETAILS ═══
Interior: ${interiorFeatures || 'Not listed'}
Exterior: ${exteriorFeatures || 'Not listed'}
Special conditions: ${specialConditions || 'None'}
Photos: ${photoCount || 'Unknown'}${hasAiPhotos ? ' ⚠ AI-enhanced or virtual staged photos detected' : ''}
Walk Score: ${walkScore || '?'} | Bike Score: ${bikeScore || '?'}
Flood: ${floodFactor||'?'} | Fire: ${fireFactor||'?'} | Heat: ${heatFactor||'?'} | FEMA: ${floodZoneStr}${floodInsurance && floodRiskElevated ? ' | Flood insurance estimate: $3,000–$8,000/yr — include in affordability risks' : ''}
Off-market: ${isOffMarket ? 'YES — run sold/off-market analysis, do NOT show buyer opportunity' : 'No'}
Price Check Mode: ${priceCheckMode === 'sales_range' ? 'Sales Range (use actual comparable sales range)' : 'Fair Value (use estimated intrinsic fair value range)'}
Schools: ${schoolsStr}

═══ CONDITIONAL FLAGS (obey exactly) ═══
${conditionalFlagDirectives}

═══ MACRO APPRECIATION CONTEXT ═══
${macroStr}

═══ REGIONAL MARKET CONDITIONS ═══
${marketTempStr}

═══ VALUATION SIGNALS (pre-computed) ═══
${valuationSignalStr}

═══ CLEAR HOME OFFER (pre-computed — use these numbers EXACTLY) ═══
${offerStr}

═══ AFFORDABILITY ANALYSIS ═══
${affordStr}

═══ BUYER PRIORITIES ═══
${priorityStr}
${investCashFlowBlock}

═══ DESCRIPTION (read in full — mine it, don't skim) ═══
"""${description?.slice(0, 3500) || 'Not available'}"""
MATERIAL DISCLOSURE SCAN — read the ENTIRE description above as a human buyer would and surface EVERY material fact, not just the items asked for elsewhere. Actively look for and, when present, raise as a risk (and as leverage in buyerOpportunity where relevant):
  • Condition / structural: roof damage or "needs roof", foundation/settling, water/flood/mold damage, termite/WDO, fire damage, "needs work", "TLC", "handyman special", "fixer", deferred maintenance, failed/expired permits, unpermitted additions.
  • Usability caveats: any room/space described as not usable, not permitted, not connected, converted without permit, or non-conforming (e.g. "3rd bedroom currently not usable", "no working kitchen").
  • Financing / sale restrictions: "cash only", "cash offers only", "no FHA/VA", "as-is" / "sold as-is", "investor special", short sale / pre-foreclosure / REO / auction, seller addendum required, no repairs.
  • Occupancy / access: tenant-occupied, lease in place, do not disturb occupant, no interior access, drive-by only.
  • Title / legal: liens, back taxes, probate/estate sale, HOA litigation, special assessment.
If the description states any of these, it MUST appear in the analysis — never omit a stated condition or financing restriction because it wasn't a pre-listed field. A "cash only" or "roof needs replacement" disclosure is high-severity and must be called out explicitly with the exact wording paraphrased.

═══ PREMIUM FEATURE ANALYSIS (pre-extracted) ═══
Listing Price: $${price?.toLocaleString()} | $/sqft: $${pricePerSqft || 'N/A'}
Features Detected:
${premiumStr}
Potential Discount Signals:
${discountStr}
${premiumAdjustedPpsq ? `Premium-Adjusted Effective $/sqft: $${premiumAdjustedPpsq} (stripping out estimated premium feature value to normalize against non-premium comps)` : 'No significant premium adjustments applied.'}

KEY INSTRUCTION: When premiums are present, compare the PREMIUM-ADJUSTED effective $/sqft against comps — not the raw $/sqft. A pool + solar + impact windows home at $300/sqft may actually be cheaper than a bare comp at $260/sqft once you strip out the upgrade value. If premiums justify the price gap vs comps, say so explicitly in valuation.rationale and buyerOpportunity.

Return this exact JSON:
STYLE: Be concise but grammatically complete. Every string field is a full sentence with proper punctuation. Max 1 sentence per field unless noted. No filler words, no hedging. Lead with specific numbers. Avoid "the property" / "this home". Never use em dashes (—) or en dashes (–) in any output field; use commas, semicolons, or periods instead.
CRITICAL: emit the fields IN THE ORDER GIVEN. oneLineSummary and keyHighlights come FIRST and are the most important — never omit them. If you are running low on output space, keep these complete and shorten later sections.
{
  "oneLineSummary": <1 complete sentence following this pattern: "Offer $X with a $Y seller credit. [Why: anchor to key data point], [supporting evidence], and [market condition that supports the offer]." For $Y, use the EXACT "RECOMMENDED SELLER CREDIT (Clear Home)" figure. Example: "Offer $548,000 with a $7,500 seller credit. No market appreciation since seller's December 2024 purchase at $557,000 anchors true market value, four price cuts over 133 days confirm seller motivation, and provides little support for the $565,000 ask." Never use dashes.>,
  "keyHighlights": [<3-4 punchy sentences, 12 words max each, summarizing WHAT'S SPECIAL about this home as the seller presents it in the DESCRIPTION above. Capture the standout perks the seller is selling (upgrades, layout, location/community, lot/view, recent improvements, warranties/assumable financing, included items) AND any financial or motivation signals the seller themselves states (motivated seller, price improvement, seller concessions offered, assumable loan, no HOA, paid-off solar, etc.). Plain buyer language, no jargon. DO NOT mention $/sqft vs comps, days on market, price cuts, the offer price, or PITI — every one of those lives in other sections and must NOT be repeated here. If the description is sparse, list the concrete features it does mention. Never use dashes.>],
  "valuation": {
    "low": <integer>,
    "high": <integer>,
    "priceDelta": <integer, listed minus midpoint — negative=underpriced>,
    "status": <"Underpriced"|"Fair Value"|"Overpriced"|"Well Overpriced" — MUST align with pre-computed signal above unless comps strongly contradict. Well Overpriced = list price is >15% above fairValue (Stage A output).>,
    "confidence": <"Low"|"Medium"|"High">,
    "rationale": <1 sentence ONLY. Anchor to why the Clear Home offer price is justified (Zestimate, prior sale, FHFA). Do NOT mention $/sqft, comp median, or features here; that belongs in premiumAnalysis.explanation. Never use dashes. CONSISTENT with status.>
  },
  "premiumAnalysis": {
    "featuresDetected": [<string>],
    "premiumJustifiesGap": <boolean>,
    "explanation": <1-2 sentences. This is the ONLY valuation commentary shown in Price Reality Check. Do NOT duplicate content from valuation.rationale. Structure: "At $[Offer $/sqft]/sqft, the Clear Home offer of $[suggestedOffer] [sits X% below/above/at] the $[Comp median $/sqft]/sqft comparable median. [1 sentence on why: features, market conditions, or leverage]." CRITICAL: use the EXACT "Offer $/sqft" and "SUGGESTED OFFER" numbers from the CLEAR HOME OFFER section. Never use dashes.>
  },
  "taxEstimate": {
    "taxDataConflict": <boolean>,
    "note": <1 complete sentence using the pre-computed numbers. For FL properties, the estimate uses a 90% assessment ratio and (for primary residences) the $50K homestead exemption applied to the county millage rate — reference this method briefly if relevant. Do NOT recompute; use the "Post-purchase tax estimate" figure as given.>
  },
  "affordability": {
    "verdict": <"Affordable"|"Borderline"|"Stretched"|"Unknown">,
    "note": <1 complete sentence stating the DTI result at the Clear Home offer PITI. Do NOT mention "list price" — the UI labels this as "At the Clear Home offer PITI" above this sentence.>
  },
  "macroAppreciation": {
    "negotiationImplication": <1 complete sentence>
  },
  "priceHistoryAnalysis": {
    "originalPurchasePrice": <integer or null>,
    "originalPurchaseDate": <string or null>,
    "appreciationPercent": <number or null>,
    "yearsHeld": <number or null>,
    "marketExpectedPrice": ${macroAppreciation.orlandoExpectedPrice || 'null'},
    "premiumOverMarket": <integer or null>,
    "domTrend": <"accelerating"|"stalling"|"normal"|null>,
    "relistDetected": <boolean>,
    "flags": [<string — concise, data-backed, complete sentences>]
  },
  "risks": [
    {
      "title": <max 5 words>,
      "severity": <"low"|"medium"|"high">,
      "explanation": <1 complete sentence with specific numbers>
    }
  ],
  "comparableAnalysis": {
    "summary": <1 complete sentence citing 1-2 specific comp prices>,
    "pricePosition": <"Lowest"|"Below Average"|"Average"|"Above Average"|"Highest">,
    "luxuryOutlierNote": <string or null>
  },
  "buyerOpportunity": {
    "headline": <1 short sentence — the single strongest leverage point. NEVER use "DOM" — write "days on market" in full.>,
    "suggestedOfferRationale": <1 short sentence explaining WHY $X. Plain language: "Fair value is $538K based on FHFA appreciation and sold comps; we're recommending $X given [aggressiveness reason]." Must NOT repeat anything from headline or points[].>,
    "points": [<string, 3-4 concise points under 15 words each. DISTINCT data per point. ALWAYS include one inspection point that is SMART based on property age:
      — For homes ≤5 years old: focus on potential BUILDER DEFECTS. If builder name is known, mention checking for known defects with that builder around the build year. Example: "2022 DR Horton build: inspect for known stucco and drainage issues reported in FL builds."
      — For homes 6-15 years old: focus on major systems approaching replacement (HVAC typically 10-15yr, water heater 8-12yr, roof shingles 15-20yr in FL). Example: "2012 build at 14 years: verify HVAC, water heater, and roof remaining life."
      — For homes >15 years old: focus on structural, plumbing, electrical, and roof. Example: "1998 build: prioritize roof condition, plumbing galvanization, and electrical panel capacity."
      If appliance brands are not specified (and absent from the description), add: "Request appliance brands and model numbers to confirm manufacturer warranty status given [age] build."
      NEVER just say "order a full home inspection." NEVER use "DOM".>],
    "negotiationAngle": <1 short sentence — CONCRETE opening, escalation range, and closing cost credit request. For the seller credit, use the EXACT "RECOMMENDED SELLER CREDIT (Clear Home)" dollar figure from the CLEAR HOME OFFER section; do not invent your own. E.g. "Open at $545K, escalate to $553K, request a $7,500 seller credit toward closing costs.">
  },
  "actions": [<string, 4-5 concise complete sentences, actionable, under 15 words each. NEVER include "ask seller to address high-severity items." Actions are buyer next steps: verify HOA financials, order title search, get pre-approval, schedule walkthrough, etc. Only include "confirm/verify school zone assignments" when the CONDITIONAL FLAGS say schools were NOT found; if schools are listed above, omit any school-zone action. Respect the HOA and flood CONDITIONAL FLAGS too.>],
  "fsboGuidance": ${isFSBO ? `[<string>]` : 'null'},
  ${investCashFlowJSON.replace(/,\s*$/, '')}
}

Rules:
- TODAY is ${TODAY}. Never flag dates on or before today as future.
- ANTI-HALLUCINATION RULE: Never invent data not present in the listing or pre-computed signals. This includes:
  * Bath count: use the value from the "Baths:" field exactly as provided. If it shows "3 full, 1 half" use that exact phrasing in commentary. If it shows "3.5" treat as 3 full + 1 half (the .5 represents half baths). If just an integer like "3", do NOT add .5 or interpret as 3.5. Never report counts like "31" — that's a parsing error; use the integer part only.
  * FHFA MSA: use ONLY the msaLabel from the macroAppreciation section. NEVER reference "New York-Newark" or any other MSA than the one provided. For Winter Garden FL it is "Orlando-Kissimmee MSA". If you cannot find msaLabel, do NOT mention MSA at all.
  * Builder name: only mention if explicitly in the listing data.
  * Prior sale price/date: only use the pre-computed values, never guess.
  * Upgrade dollar values: only sum amounts the listing EXPLICITLY states. Do not estimate upgrade costs yourself.
  * If a data point is missing, say "not disclosed" or omit it. Do NOT fabricate data to fill the schema.
  * Stick to interpreting the data provided. No outside imagination, no plausible-sounding guesses.
- taxEstimate: USE the pre-computed values. taxWillStayFlat=true → taxes NOT expected to increase; taxWillIncrease=true → state exact annual increase amount. IMPORTANT: if the most recent tax year data is older than the current year (e.g. 2024 data in 2026), note the gap exists and say "warrants review" not "must be resolved". When listing-sheet tax assessed value and annual tax are present AND differ from public record, explain the discrepancy is likely due to the public record not yet reflecting the most recent assessment year. Use the LISTING-SHEET values for post-purchase tax projection (they reflect the sale-price-based reassessment) rather than the older public record values.
- valuation: USE the pre-computed status from VALUATION SIGNALS section as primary driver. Only override if comps data is strong and directly contradictory — explain in rationale. NEVER produce a contradictory pair. NOTE: Zestimate reliability decreases above $1M — if listed price is above $1M and Zestimate gap is within ±10%, treat as Fair Value unless comps strongly contradict.
- valuation.rationale: Write an elevator pitch — lead with the Clear Home offer $/sqft and why it's justified, then briefly why the listed $/sqft isn't fully justified if applicable. Think "here's why we recommend $X" not "here's the math". 2 sentences max.
- JS-OWNED OUTPUT FIELDS: Do not emit pricePerSqft or the buyerOpportunity numeric/motivation keys. Clear Home injects pricePerSqft, fairValue, suggestedOffer, aggressivenessPct, offerStrategy, and motivationSignals after generation from the pre-computed source of truth. Use those pre-computed figures accurately in the requested prose only; never recompute them. The list price does not cap or floor the offer.
- macroAppreciation: contextualize the FHFA benchmark but do NOT use it alone to set valuation status. FHFA shows whether appreciation was market-driven; Zestimate gap shows whether TODAY'S price is right.
- consistency rule: valuation.status, valuation.rationale, oneLineSummary, premiumAnalysis.explanation, and keyHighlights MUST all use the SAME numbers. Specifically:
  * suggestedOffer appears in oneLineSummary, keyHighlights, and premiumAnalysis.explanation — use the EXACT same dollar amount everywhere.
  * premiumAdjusted $/sqft = suggestedOffer ÷ sqft, rounded to nearest integer. Use this EXACT number in premiumAnalysis.explanation. Do NOT use a different rounded value.
  * PITI: recalculate at suggestedOffer, not list price. Use the exact dollar amount in keyHighlights, not a rounded approximation (e.g. $6,060 not $6,100).
  * Never introduce a $/sqft number that doesn't match premiumAdjusted or listed. If premiumAdjusted=271, every reference to the offer $/sqft must say $271.
- priceHistoryAnalysis.flags: prior listing failures (expired, withdrawn, relisted, price cuts) are BUYER LEVERAGE — put them in buyerOpportunity, NOT risks. IMPORTANT: When a property was SOLD (closed sale in priceHistory) and then relisted, the flags should clearly distinguish between the prior sale cycle and the current listing cycle. Example: "Sold December 2024 at $557,000; relisted at $587,000 with four price cuts to $565,000 over 133 days on market." Do NOT conflate the prior cycle's history with the current owner's listing.
  RELIST RULES: If a listing was removed and relisted within 14 days at or near the same price, ignore it — this is a common MLS administrative action, not a market signal. If a property switches from a rental listing to a sale listing (or vice versa), flag it as a significant signal: "Previously listed as a rental, now listed for sale — indicates the investment thesis changed or rental market rejected the price."
  FAILED-SALE RULE: A "Listing removed" / "Listing withdrawn" event followed by a relisting does NOT, by itself, count as a failed or fallen-through sale. Only characterize it as a failed/collapsed deal if the price history shows a PENDING or UNDER CONTRACT status that then reverted to active, OR the description explicitly mentions a deal falling through (e.g. "buyer financing fell through", "back on market after contract cancellation"). Absent those signals, describe a removal-then-relist neutrally (e.g. "briefly off-market, then relisted") and do NOT imply a buyer walked away or the home has a problem.
  FHFA GAP: If the FHFA appreciation benchmark shows flat/negative growth since the last sale and the current ask is above the prior sale price, combine this into the price history flags: e.g. "Ask of $565K is $8K above the $557K December 2024 sale, unjustified given flat FHFA Orlando MSA appreciation over the period."
- comparableAnalysis: if comps show large $/sqft variance (>20%), check whether outliers are from a different neighborhood tier (e.g. luxury enclave nearby). Don't average luxury comps with standard product — flag the outliers separately in luxuryOutlierNote.
- premiumAnalysis: always populate. If premium features are detected, assess whether they close the gap between listing $/sqft and comp $/sqft. A pool, solar, impact windows, or full renovation can each add $15K-$50K in value that raw $/sqft comparisons miss. In text fields like premiumAnalysis.explanation, DO NOT use the phrase "premium-adjusted" — call the adjusted value the "Clear Home offer price" or just "adjusted $/sqft". If the adjusted $/sqft is at or below comp median, the features JUSTIFY the price — say so clearly and reflect it in valuation.status. Do NOT penalize a property for a high $/sqft if the features account for the gap. Do NOT restate the raw comp median $/sqft as an estimate since the UI shows it separately — focus instead on whether the Clear Home offer is above or below market comps.
- valuation and premiums: if premiumAnalysis.premiumJustifiesGap=true AND the pre-computed status is Overpriced, you MAY upgrade status to Fair Value — but only if the math holds (premium feature value ≥ price gap vs Zestimate midpoint). Show the math in rationale. Conversely, if no premiums are detected and comps are bare-bones similar properties, a high $/sqft stays Overpriced.
- comparableAnalysis: when comparing $/sqft, always note whether comps have pools, water views, or major upgrades vs this listing. A bare comp at $260/sqft is NOT an apples-to-apples comparison to a pool+solar home at $300/sqft. Flag any feature gaps explicitly.
- buyerOpportunity: always populate. suggestedOffer must be a specific number. Points should reference actual data — prior listing history, days on market, appreciation gap, tax reset cost, zestimate delta.
- Days on market and negotiation direction — read this carefully:
  * LONG DAYS ON MARKET (>45 days): clear buyer leverage. Note it explicitly in buyerOpportunity.points.
  * SHORT DAYS ON MARKET (<7 days, "fresh listing"): days on market alone tells you NOTHING about whether to buy. The valuation signal is everything. Use this decision matrix:
    - Fresh listing AND preComputedStatus=Underpriced (Zestimate gap < -5%): this is a GENUINE OPPORTUNITY — move promptly, offer at or near ask, frame it as acting before the market corrects. This is how buyers snag great deals.
    - Fresh listing AND preComputedStatus=Fair Value AND comps support the price AND listing has meaningful upgrades mentioned in description: solid buy, offer 97-100% of list.
    - Fresh listing AND preComputedStatus=Fair Value AND comps are thin/unavailable AND no notable upgrades: advise to WAIT 2-3 weeks and monitor for price reductions before committing.
    - Fresh listing AND preComputedStatus=Overpriced: STEER CLEAR or WAIT — seller is testing the market. The fresh listing gives them negotiating confidence they haven't yet earned. Note that days on market will create leverage naturally if they overprice.
  * Never say "fresh listing creates negotiation opportunity" — that is backwards. Fresh listings favor sellers, not buyers. Only say a fresh listing is an opportunity when the price is genuinely below market.
- Senior/Age-Restricted community: ONLY state that a property is in a senior/55+ community if seniorCommunityConfirmed=true (explicitly in description or community name). If seniorCommunityUnverified=true (MLS field only), add a risk item: "Age restriction claim unverified — MLS field indicates 55+ community but description does not confirm. Verify with HOA before offer." If seniorCommunityMLS=false and seniorCommunityConfirmed=false, do NOT mention senior community at all.
- HOA and community fields: if the listing shows NO HOA fee, or the HOA name is misspelled/truncated/generic (e.g. "HOA", "N/A", garbled text), flag it as "Verify HOA name and fees directly with the management company before offer." But when a clear HOA fee is stated (per the CONDITIONAL FLAGS), do NOT add an HOA fee/verification risk or action. Never confidently assert community amenities that come only from the agent description — label them as "Agent-reported." Only when there is a specific complicating signal (e.g. two HOA entities, a pending special assessment, or multi-phase coverage differences) should you recommend reviewing HOA documents, and then specify the exact concern rather than generic "verify HOA financials."
- affordability: ALL values are pre-calculated — use them exactly as given. NEVER recalculate DTI or suggest a different income. dtiHousingWarning=${affordability.dtiHousingWarning} — only flag if TRUE. If the buyer's income produces a DTI under 28%, verdict is "Affordable" and the note confirms it. Do not invent income thresholds or recommend a higher income.
- nearbyComps: Zillow's Similar Homes — use for $/sqft comparison only. The UI renders individual comp boxes automatically. Do NOT write a freeform comp paragraph or list addresses. Set comparableAnalysis.pricePosition (Above Average / At Market / Below Average) and leave comparableAnalysis.summary blank or omit it.
- risks: 3-5 items. DEDUPLICATE. Prior listing failures go in buyerOpportunity NOT here. Frame each risk as actionable. NEVER include "request inspection contingency" or "ask seller to address high-severity items" in risks. Inspection is handled in buyerOpportunity.points with listing-specific detail.
- NO-REPEAT RULE (strict): each distinct fact (a price cut count, days on market, a prior rental listing, an appliance/brand gap, an inspection concern, the FHFA benchmark figure, the original purchase price) may be developed in AT MOST ONE of these sections: risks, buyerOpportunity.points, actions, priceHistoryAnalysis.flags. Section ownership: priceHistoryAnalysis.flags owns pricing-history facts (cuts, relists, prior rentals, appreciation vs benchmark); risks owns property/location/condition concerns; buyerOpportunity.points owns negotiation leverage framing; actions owns concrete to-dos phrased as instructions WITHOUT restating the reasoning already given elsewhere (e.g. "Order a stucco and drainage inspection" NOT "2020 builds have stucco issues so order an inspection"). headline and oneLineSummary may each reference the single strongest leverage fact once, but keyHighlights must not repeat a sentence-level fact already in oneLineSummary. If you catch yourself writing the same dollar figure or fact phrase in a second list, replace it with a DIFFERENT insight from the data.
  APPLIANCE/SYSTEMS RULE: Do NOT claim cooling, heating, or appliances are "undisclosed" when their type is listed in the data above (e.g. Cooling: Central Air). Per the CONDITIONAL FLAGS, the only valid related risk is "Appliance brands undisclosed", and only when no brand names appear in the appliance list or the description AND the home is ≤10 years old: "Appliance brands not specified; request brand names and model numbers to verify manufacturer warranty status on a [yearBuilt] build." For homes ≤5 years old, major systems may still be under manufacturer warranty, which is a value factor.
  PRIORITY ESCALATION: if a risk relates to a buyer priority, escalate its severity by one level. schools priority → low school rating becomes high severity. safety → any crime/flood/fire risk becomes high. walkability → low walk score becomes medium. hoa → high HOA fees or special assessments become high. investment → appreciation below benchmark becomes high. commute → no transit/highway access becomes medium. new_construction → deferred maintenance or old systems become high. outdoor_space → small lot or no yard becomes medium.
- POSITIVE COUNTERWEIGHTS: When a risk item highlights a negative (e.g. a low-rated high school), always append the positive counterweight if one exists in the same sentence. Example: "Horizon High carries a 5/10 GreatSchools rating, though Atwater Bay Elementary (9/10) and Water Spring Middle (9/10) serving the same address are strong." Same principle for any priority. When referencing schools, cite the name and rating only, no distance. NEVER write "for this buyer", "for the buyer", "given schools are a stated buyer priority", or similar. The analysis is always from the buyer's perspective; restating that is redundant.
- STATE-SPECIFIC RULES: Always adapt to the property's state (${propertyState || 'unknown'}).
  * Tax caps: FL=Save Our Homes 3%/yr cap resets at sale; CA=Prop 13 resets at sale; TX=homestead exemption lost; most other states reassess to full sale price. Use correct state terminology.
  * Feature premiums: Pool adds value in FL/AZ/CA/TX/NV but may be neutral or negative in IL/MN/WI/NY. Impact windows only relevant in FL/Gulf Coast/coastal SE. Generator high value in FL/TX/SE for storms, moderate in Midwest for power outages, low in Pacific NW.
  * Agent licensing: State licensing boards vary — use state-specific terminology and verification sources.
  * Macro appreciation: Orlando MSA FHFA used for FL; national index for all other states.
- model: extract from description — "The [Word] model", "[Word] model is/offers", or Builder model field. For this listing: "${propertyModel || 'check description'}".
- oneLineSummary: specific bid number + the pre-computed seller credit + 2-3 justifications. Use the EXACT "RECOMMENDED SELLER CREDIT (Clear Home)" figure for the credit. MUST be consistent with valuation.status. Never use dashes; use periods and commas. Format: "Offer $X with a $Y seller credit. [reason], [reason], and [reason]."`;

  const systemPrompt = `You are Clear Home, a nationwide real estate intelligence engine. Today: ${TODAY}. Analyze listings across ALL US states with MLS data, tax records, price history, comps, agent validation, macro benchmarks, and affordability. Apply STATE-SPECIFIC context: tax laws, homestead rules, climate-driven feature values, local norms. Write concise complete sentences — every field gets proper punctuation (period at end, commas where needed). Lead with specific numbers. Reference actual data points, dates, and state laws by name. Never apply FL-specific logic to non-FL properties. Never flag a date on or before ${TODAY_ISO} as future.`;

  // Await commute estimates (runs in parallel with pre-computation above)
  const commuteResults = await commutePromise;

  // ── Pre-generate "always standard" prose in JS so the AI doesn't spend output
  // tokens on it. These fields are effectively fixed templated responses driven
  // entirely by data we already have, so generating them deterministically keeps
  // wording consistent and trims tokens. Injected in finalize; omitted from the schema.
  const stTax = String(propertyState || '').toUpperCase();
  const priceStr = price ? `$${Number(price).toLocaleString()}` : 'the purchase price';
  let homesteadResetNote;
  if (stTax === 'FL') {
    homesteadResetNote = `Florida's Save Our Homes cap limits annual assessed-value increases to 3% for homesteaded owners, but the assessment resets to the full purchase price at sale, so the new owner's property taxes will be based on the ${priceStr} acquisition price.`;
  } else if (stTax === 'CA') {
    homesteadResetNote = `Under California's Proposition 13, the assessed value resets to the purchase price at sale and then rises no more than 2% per year, so the new owner's property taxes will be based on the ${priceStr} acquisition price.`;
  } else if (stTax === 'TX') {
    homesteadResetNote = `In Texas the prior owner's homestead cap does not transfer at sale, so the home is reassessed toward market value and the new owner's property taxes will reflect the ${priceStr} purchase price.`;
  } else {
    homesteadResetNote = `Most counties reassess a property to its full sale price after purchase, so the new owner should expect the assessed value to move toward the ${priceStr} purchase price.`;
  }

  // Agent license recommendation — a small fixed set of responses keyed off the
  // deterministic DBPR/state-board lookup (the explicit "verify / missing license" case).
  let agentRecommendation, licenseVerifiedFinal, licenseStatusFinal;
  const _agConcerns = (agent && Array.isArray(agent.concerns) && agent.concerns.length) ? agent.concerns.join('; ') : '';
  if (isFSBO) {
    agentRecommendation = "Engage a buyer's agent or real estate attorney, since there is no listing agent representing the seller's interests.";
    licenseVerifiedFinal = false;
    licenseStatusFinal = 'FSBO';
  } else if (agent && agent.licenseNumber) {
    if (agent.isActive && !_agConcerns) {
      agentRecommendation = `License ${agent.licenseNumber} is verified and active per ${agent.source || 'the state board'}; no concerns found.`;
      licenseStatusFinal = 'Active';
    } else if (agent.isActive && _agConcerns) {
      agentRecommendation = `License ${agent.licenseNumber} is active, but note: ${_agConcerns}.`;
      licenseStatusFinal = 'Active';
    } else {
      agentRecommendation = `License ${agent.licenseNumber} is on file but not shown as active; confirm current standing with the state licensing board before proceeding.`;
      licenseStatusFinal = 'Inactive';
    }
    licenseVerifiedFinal = !!agent.isActive;
  } else if (agentName && agentName.trim()) {
    agentRecommendation = `The listing agent's license could not be matched automatically; confirm ${agentName.trim()}'s license directly with the state licensing board (e.g. myfloridalicense.com in FL) before proceeding.`;
    licenseVerifiedFinal = false;
    licenseStatusFinal = 'Unverified';
  } else {
    agentRecommendation = `This listing names only the brokerage${brokerageName ? ` (${brokerageName})` : ''} and no individual agent, so the license could not be auto-verified; identify the listing agent and confirm their license with the state board before proceeding.`;
    licenseVerifiedFinal = false;
    licenseStatusFinal = 'Unverified';
  }

  // Return prompts + pre-computed metadata for content.js to call the API directly
  return {
    system: systemPrompt,
    user: userPrompt,
    meta: {
      latestTax, currentAssessed, taxAfterReset, taxWillIncrease,
      taxRateUsed, totalExemption, taxRateBasis,
      affordability, macroAppreciation, agentName, agentPhone, brokerageName,
      monthlyTakehome, priceCheckMode, floodInsurance,
      commuteResults, offerCalc, pricePerSqft,
      homesteadResetNote, agentRecommendation, licenseVerifiedFinal, licenseStatusFinal,
      agentLicenseNumber: (agent && agent.licenseNumber) || null,
      agentConcerns: _agConcerns || null, isFSBO
    }
  };
}

// ── JSON recovery for truncated API responses ─────────────────────────────────
function attemptJsonRecovery(raw) {
  let attempt = raw.trim();

  // Strategy 1: Try parsing as-is first
  try { return JSON.parse(attempt); } catch {}

  // Strategy 2: Remove trailing incomplete content and close open structures
  for (let i = attempt.length; i > attempt.length * 0.3; i--) {
    let slice = attempt.slice(0, i).trim();

    // Strip incomplete trailing structures: trailing comma, incomplete key, incomplete value
    slice = slice.replace(/,\s*$/, '');                    // trailing comma
    slice = slice.replace(/"[^"]*$/, '');                  // incomplete unclosed string
    slice = slice.replace(/,\s*"[^":]*$/, '');             // incomplete key after comma
    slice = slice.replace(/:\s*[^,}\]]*$/, '');            // incomplete value after colon
    slice = slice.replace(/,\s*$/, '');                    // re-strip trailing comma

    // Count open brackets to close them
    let depth = 0, inStr = false, esc = false;
    let bracketStack = [];
    for (const ch of slice) {
      if (esc) { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true; continue; }
      if (ch === '"' && !esc) { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') { depth++; bracketStack.push('}'); }
      else if (ch === '[') { depth++; bracketStack.push(']'); }
      else if (ch === '}' || ch === ']') { depth--; bracketStack.pop(); }
    }
    if (depth <= 0) {
      try { const r = JSON.parse(slice); if (r && typeof r === 'object') return r; } catch {}
      continue;
    }

    // Try closing with the right brackets in reverse order
    const closes = bracketStack.reverse().join('');
    try {
      const result = JSON.parse(slice + closes);
      if (result && typeof result === 'object') return result;
    } catch {}

    // Also try truncating at last complete comma-separated entry
    const lastComma = slice.lastIndexOf(',');
    if (lastComma > slice.length * 0.5) {
      try {
        const result = JSON.parse(slice.slice(0, lastComma) + closes);
        if (result && typeof result === 'object') return result;
      } catch {}
    }
  }

  // Strategy 3: Last resort — extract individual top-level fields and rebuild
  try {
    const partial = {};
    // Match top-level "field": value patterns even from broken JSON
    const fieldPatterns = [
      { key: 'oneLineSummary',  re: /"oneLineSummary"\s*:\s*"([^"]+)"/ },
      { key: 'keyHighlights',   re: /"keyHighlights"\s*:\s*\[([^\]]+)\]/ },
      { key: 'valuation',       re: /"valuation"\s*:\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/ },
      { key: 'pricePerSqft',    re: /"pricePerSqft"\s*:\s*(\{[^{}]*\})/ },
      { key: 'premiumAnalysis', re: /"premiumAnalysis"\s*:\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/ },
      { key: 'buyerOpportunity',re: /"buyerOpportunity"\s*:\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/ },
      { key: 'risks',           re: /"risks"\s*:\s*\[([^\]]+)\]/ },
      { key: 'actions',         re: /"actions"\s*:\s*\[([^\]]+)\]/ },
      { key: 'priceHistoryAnalysis', re: /"priceHistoryAnalysis"\s*:\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/ },
      { key: 'agentValidation', re: /"agentValidation"\s*:\s*(\{[^{}]*\})/ },
    ];
    for (const { key, re } of fieldPatterns) {
      const m = attempt.match(re);
      if (m) {
        try {
          // For object values, parse the matched JSON
          if (m[1].startsWith('{') || m[1].startsWith('[')) {
            partial[key] = JSON.parse(m[1].startsWith('[') ? `[${m[1].slice(1,-1)}]` : m[1]);
          } else if (key === 'keyHighlights' || key === 'risks' || key === 'actions') {
            partial[key] = JSON.parse(`[${m[1]}]`);
          } else {
            partial[key] = m[1];
          }
        } catch {
          // Couldn't parse this field, skip it
        }
      }
    }
    if (Object.keys(partial).length > 0) {
      partial._partialRecovery = true;
      return partial;
    }
  } catch {}

  return null;
}

// ── Sold listing analysis ─────────────────────────────────────────────────────
async function analyzeSold(listingData, apiKey, TODAY, TODAY_ISO) {
  // Sold listings: skip comps fetch, agent license, MLS verification
  // Only fetch county data for tax snapshot
  const countyResult = await fetchCountyData(listingData).catch(() => null);
  const county = countyResult || null;

  const {
    address, price, sqft, beds, baths, bathsDetail, description,
    priceHistory, taxHistory, zestimate, zestimateRange,
    yearBuilt, propertyType, daysOnMarket, lotSize,
    parcelNumber, dateSold, soldPrice, homeStatus,
    nearbyHomes, nearbySchools
  } = listingData;

  const propertyState = detectStateFromAddress(address);
  const msaKeySold    = detectMSAFromAddress(address);
  const msaLabel      = (msaKeySold && FHFA_MSA[msaKeySold]) ? FHFA_MSA[msaKeySold].label : 'FHFA National Average';

  // ── Parse the full price history journey ─────────────────────────────────
  // priceHistory is newest-first from Zillow.
  // Zillow event strings (case varies): "Sold", "Listed for sale", "Price change",
  // "Listing removed", "Back on market", "Pending", "Pre-foreclosure"
  const ph = Array.isArray(priceHistory) ? priceHistory : [];

  // Helper: parse Zillow date — after content.js normalization, dates are MM/DD/YYYY strings
  // Also handles Unix ms (legacy) just in case
  const parsePHDate = (raw) => {
    if (!raw) return null;
    const n = Number(raw);
    if (n > 1000000000) return new Date(n); // Unix ms
    // MM/DD/YYYY — parse manually to avoid browser locale ambiguity
    const m = String(raw).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return new Date(Number(m[3]), Number(m[1])-1, Number(m[2]));
    // ISO or other format fallback
    const d = new Date(raw);
    return isNaN(d) ? null : d;
  };
  const fmtDate = (dt) => dt
    ? dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Unknown';

  // Classify every event — exact match on known Zillow strings
  const isSoldEvent   = (ev) => /^sold$/i.test(ev.trim());
  const isListedEvent = (ev) => /listed\s+for\s+sale|^listed$/i.test(ev.trim());
  const isChangeEvent = (ev) => /price\s+change|price\s+cut|reduced|price\s+reduction/i.test(ev.trim());

  const soldEvents    = ph.filter(h => isSoldEvent(h.event || h.priceChangeType || ''));
  const listedEvents  = ph.filter(h => isListedEvent(h.event || h.priceChangeType || ''));
  const changeEvents  = ph.filter(h => isChangeEvent(h.event || h.priceChangeType || ''));

  // Most recent sold = THIS sale
  const thisSale      = soldEvents[0] || null;
  const thisSaleDate  = parsePHDate(thisSale?.date);
  const thisSalePrice = (thisSale?.price > 0 ? thisSale.price : 0)
                      || soldPrice || price || 0;

  // Most recent listing BEFORE this sale
  // Since array is newest-first, find the first listed event older than the sold event
  const lastListing = thisSaleDate
    ? listedEvents.find(h => { const d = parsePHDate(h.date); return d && d <= thisSaleDate; })
    : (listedEvents[0] || null);
  const lastListDate  = parsePHDate(lastListing?.date);
  const lastListPrice = lastListing?.price || thisSalePrice;

  // Days to sell: listed → sold
  const daysToSell = (lastListDate && thisSaleDate && thisSaleDate > lastListDate)
    ? Math.round((thisSaleDate - lastListDate) / 86400000)
    : null;

  // Days since sale: sold → today
  const daysSinceSale = thisSaleDate
    ? Math.round((Date.now() - thisSaleDate) / 86400000)
    : null;

  // Price changes during this listing (between list date and sold date)
  const priceChangesThisListing = changeEvents.filter(h => {
    const d = parsePHDate(h.date);
    return d
      && (!lastListDate || d >= lastListDate)
      && (!thisSaleDate || d <= thisSaleDate);
  });

  // Compute actual price change details (newest-first, so reverse to get chronological)
  const phChron = [...ph].reverse(); // chronological
  const priceChangesDetail = priceChangesThisListing.map(pc => {
    const pcDate = parsePHDate(pc.date);
    // Find the event just before this price change in chronological order
    const prevEvent = phChron.filter(h => {
      const d = parsePHDate(h.date);
      return d && h.price > 0 && d < pcDate;
    }).pop();
    const fromPrice = prevEvent?.price || lastListPrice;
    const changePct = fromPrice > 0 ? Math.round(((pc.price - fromPrice) / fromPrice) * 100 * 10) / 10 : 0;
    return { date: fmtDate(pcDate), from: fromPrice, to: pc.price, changePct };
  });

  // Previous sold = seller's original purchase
  const previousSale      = soldEvents[1] || null;
  const previousSaleDate  = parsePHDate(previousSale?.date);
  const previousSalePrice = previousSale?.price || 0;

  // Seller appreciation: previous purchase → this sale
  const sellerAppreciationPct = (previousSalePrice > 0 && thisSalePrice > 0)
    ? Math.round(((thisSalePrice - previousSalePrice) / previousSalePrice) * 100)
    : null;
  const sellerYearsHeld = (previousSaleDate && thisSaleDate)
    ? Math.round((thisSaleDate - previousSaleDate) / (1000*60*60*24*365) * 10) / 10
    : null;

  // FHFA benchmark from seller's purchase date
  const msaKeyS   = detectMSAFromAddress(address);
  const appResult = getAppreciationForDate(previousSaleDate ? previousSaleDate.toISOString() : null, msaKeyS);
  const fhfaBenchmark = appResult?.pct ?? null;

  // Tax
  const latestTax   = county?.taxPaid || taxHistory?.[0]?.taxPaid || 0;
  const assessedVal = county?.assessedValue || taxHistory?.[0]?.assessed || 0;

  // Full price chain string — formatted dates, all events, newest-first
  const priceHistStr = ph.slice(0, 12).map(h => {
    const dt = parsePHDate(h.date);
    const ds = fmtDate(dt);
    const ev = h.event || h.priceChangeType || 'Event';
    return `${ds}: ${ev} @ $${Number(h.price || 0).toLocaleString()}`;
  }).join('\n') || 'Not available';


  const userPrompt = `TODAY: ${TODAY}

Analyze this SOLD/OFF-MARKET property and return ONLY a valid JSON object — no markdown.

═══ PROPERTY ═══
Address: ${address || 'Unknown'}
State: ${propertyState || 'Unknown'} | MSA: ${msaLabel || 'National Average (no MSA match)'}
Status: ${homeStatus || 'Sold/Off-Market'}
Sale Price: ${thisSalePrice > 0 ? '$' + thisSalePrice.toLocaleString() : '⚠ NOT DISCLOSED IN LISTING — flag this prominently in the saleSnapshot.summary field. Tell the user the sale price is missing from Zillow records.'}
Sale Date: ${fmtDate(thisSaleDate)}
Days Since Sale: ${daysSinceSale !== null ? daysSinceSale + ' days ago' : 'Unknown'}
Sqft: ${sqft || '?'} | Beds: ${beds || '?'} | Baths: ${baths || '?'}
Year Built: ${yearBuilt || '?'} | Type: ${propertyType || '?'} | Lot: ${lotSize || '?'}

═══ THIS LISTING JOURNEY ═══
Listed for Sale: ${fmtDate(lastListDate)} at $${lastListPrice.toLocaleString()}
Sold: ${fmtDate(thisSaleDate)} at $${thisSalePrice.toLocaleString()}
Days to Sell: ${daysToSell !== null ? daysToSell : 'Unknown'}
Price Changes During Listing: ${priceChangesThisListing.length}${priceChangesDetail.length > 0 ? '\n' + priceChangesDetail.map(pc => `  ${pc.date}: $${Number(pc.from).toLocaleString()} → $${Number(pc.to).toLocaleString()} (${pc.changePct >= 0 ? '+' : ''}${pc.changePct}%)`).join('\n') : ''}
Sale vs Last List Price: ${lastListPrice > 0 ? (((thisSalePrice - lastListPrice) / lastListPrice * 100).toFixed(1) + '% ' + (thisSalePrice >= lastListPrice ? 'over' : 'under') + ' ask') : 'Unknown'}

═══ SELLER HISTORY (previous owner) ═══
Previous Purchase Price: ${previousSalePrice > 0 ? '$' + previousSalePrice.toLocaleString() : 'Unknown'}
Previous Purchase Date: ${fmtDate(previousSaleDate)}
Years Held by Seller: ${sellerYearsHeld !== null ? sellerYearsHeld : 'Unknown'}
Seller Total Appreciation: ${sellerAppreciationPct !== null ? sellerAppreciationPct + '%' : 'Unknown'}
FHFA Benchmark (${appResult?.label || (msaKeyS && FHFA_MSA[msaKeyS] ? FHFA_MSA[msaKeyS].label : 'FHFA National Average')}): ${fhfaBenchmark !== null ? fhfaBenchmark + '% expected' : 'Unknown'}

═══ FULL PRICE HISTORY ═══
${priceHistStr}

═══ CURRENT VALUE ═══
Zestimate: $${zestimate ? zestimate.toLocaleString() : 'N/A'}
Zestimate Range: $${zestimateRange?.low?.toLocaleString() || '?'} – $${zestimateRange?.high?.toLocaleString() || '?'}

═══ NEARBY COMPARABLES (Zillow Similar Homes — similarity ranked, not location) ═══
${Array.isArray(nearbyHomes) && nearbyHomes.length > 0
  ? nearbyHomes.slice(0,8).map(h => {
      const pNum = h.priceNum || parseInt((h.price||'').replace(/[^0-9]/g,''),10) || 0;
      const sqftNum = parseInt((h.sqft||'').replace(/[^0-9.,k]/gi,'').replace('k','000').replace(',',''),10) || 0;
      const ppsq = (pNum > 0 && sqftNum > 0) ? Math.round(pNum/sqftNum) : null;
      return `${h.addr}: ${h.price}${h.beds?' · '+h.beds:''}${h.baths?'/'+h.baths:''}${h.sqft?' · '+h.sqft:''}${ppsq?' · $'+ppsq+'/sqft':''} · ${h.status||'For Sale'}`;
    }).join('\n')
  : 'None scraped'}

═══ TAX SNAPSHOT ═══
Last Annual Tax: $${latestTax?.toLocaleString() || 'N/A'}
Assessed Value: $${assessedVal?.toLocaleString() || 'N/A'}

Return this JSON:
{
  "saleSnapshot": {
    "soldPrice": ${thisSalePrice || 'null'},
    "soldDate": "${fmtDate(thisSaleDate)}",
    "daysSinceSale": ${daysSinceSale || 'null'},
    "listPrice": ${lastListPrice || 'null'},
    "daysToSell": ${daysToSell || 'null'},
    "overUnderAsk": <integer pct, positive=over ask, negative=under ask>,
    "pricePerSqft": <integer or null>,
    "summary": <1 sentence — sold quickly/slowly, over/under ask>
  },
  "listingJourney": {
    "listedDate": "${fmtDate(lastListDate)}",
    "soldDate": "${fmtDate(thisSaleDate)}",
    "daysToSell": ${daysToSell || 'null'},
    "priceChangeCount": ${priceChangesThisListing.length},
    "priceChanges": ${priceChangesDetail.length > 0 ? JSON.stringify(priceChangesDetail) : '[]'},
    "finalVsListPct": <integer — final sale vs original list price, negative means sold below ask>,
    "narrative": <2 sentences — what did the seller have to go through? Quick sale or long haul? Price cuts? Sold over/under ask?>
  },
  "currentValue": {
    "zestimate": ${zestimate || 'null'},
    "appreciation": <integer pct from sale price to today's zestimate>,
    "fhfaImplied": <integer — FHFA benchmark applied to sale price to today>,
    "note": <1 sentence>
  },
  "appreciationContext": {
    "previousPurchasePrice": ${previousSalePrice || 'null'},
    "previousPurchaseDate": "${fmtDate(previousSaleDate)}",
    "sellerAppreciationPct": ${sellerAppreciationPct || 'null'},
    "fhfaBenchmarkPct": ${fhfaBenchmark !== null ? fhfaBenchmark : 'null'},
    "vsMarket": <"Above"|"Below"|"At">,
    "yearsHeld": ${sellerYearsHeld || 'null'},
    "interpretation": <1 sentence — did the seller beat the market?>
  },
  "priceNarrative": {
    "totalListings": <integer — how many distinct listed-for-sale events>,
    "summary": <1 sentence>,
    "priceChain": [{ "date": <string>, "event": <string>, "price": <integer> }]
  },
  "taxSnapshot": {
    "currentAnnual": ${latestTax || 'null'},
    "assessedValue": ${assessedVal || 'null'},
    "newOwnerEstimate": <integer — post-SOH reset estimate for new buyer>,
    "note": <1 sentence>
  },
  "neighborhoodPulse": {
    "trend": <"Rising"|"Flat"|"Declining">,
    "summary": <1-2 sentences>
  },
  "oneLineSummary": <1 sentence — key facts: sold price, days to sell, seller gain vs benchmark>
}

Rules:
- saleSnapshot.daysToSell: use pre-computed value ${daysToSell !== null ? daysToSell : 'null'} — do not recalculate.
- saleSnapshot.daysSinceSale: use pre-computed value ${daysSinceSale !== null ? daysSinceSale : 'null'} — do not recalculate.
- appreciationContext: use the seller's previous purchase (${fmtDate(previousSaleDate)} at $${previousSalePrice.toLocaleString()}) as the baseline, NOT the current sale price. Seller appreciation = how much the seller made.
- listingJourney.priceChanges: derive from the price history chain — each time the price dropped or changed before the sale.
- If days to sell is under 30, the sale was fast. Over 90 is slow. Note this in the narrative.`;

  const systemPrompt = `You are Clear Home. Today is ${TODAY}. Analyze sold/off-market property data and return brutally specific JSON. Reference actual numbers and dates.`;

  return { system: systemPrompt, user: userPrompt, meta: {
    thisSaleDate: thisSaleDate ? thisSaleDate.toISOString() : null,
    thisSalePrice, 
    lastListDate: lastListDate ? lastListDate.toISOString() : null,
    lastListPrice, 
    previousSaleDate: previousSaleDate ? previousSaleDate.toISOString() : null,
    previousSalePrice, daysToSell, daysSinceSale, sellerAppreciationPct, sellerYearsHeld, 
    ph: ph.map(h => ({ date: h.date, event: h.event, price: h.price }))
  }};
}

function finalizeSoldResult(rawText, meta) {
  const { thisSaleDate, thisSalePrice, lastListDate, lastListPrice, previousSaleDate,
    previousSalePrice, daysToSell, daysSinceSale, sellerAppreciationPct, sellerYearsHeld, ph } = meta;

  // These helpers can't be passed through chrome.runtime.sendMessage (functions aren't serializable)
  // so we redefine them here
  const parsePHDate = (raw) => {
    if (!raw) return null;
    const n = Number(raw);
    if (n > 1000000000) return new Date(n);
    const m = String(raw).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return new Date(Number(m[3]), Number(m[1])-1, Number(m[2]));
    const d = new Date(raw);
    return isNaN(d) ? null : d;
  };
  const fmtDate = (dt) => {
    if (!dt) return 'Unknown';
    if (typeof dt === 'string') {
      const parsed = parsePHDate(dt);
      if (parsed) return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      return dt;
    }
    if (dt instanceof Date) return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return 'Unknown';
  };

  let clean = rawText.replace(/^```json\s*/i,'').replace(/```\s*$/,'').trim();
  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) clean = clean.slice(firstBrace, lastBrace + 1);
  let parsed;
  try { parsed = JSON.parse(clean); }
  catch { return { oneLineSummary: 'Sale history loaded — see details above.', _raw: clean }; }

  // ── Hard block: if key date/price fields came back as Unknown, substitute pre-computed values
  const subDate = (val, fallback) => (!val || val === 'Unknown' || val === 'null') ? fallback : val;
  const subNum  = (val, fallback) => (!val || val === null) ? fallback : val;

  // Dates come through as ISO strings after chrome.runtime.sendMessage serialization
  const precomputedSoldDate = fmtDate(thisSaleDate);
  const precomputedListDate = fmtDate(lastListDate);
  const precomputedPrevDate = fmtDate(previousSaleDate);

  if (parsed.saleSnapshot) {
    parsed.saleSnapshot.soldDate  = subDate(parsed.saleSnapshot.soldDate,  precomputedSoldDate);
    parsed.saleSnapshot.listPrice = subNum(parsed.saleSnapshot.listPrice,  lastListPrice);
    parsed.saleSnapshot.soldPrice = subNum(parsed.saleSnapshot.soldPrice,  thisSalePrice);
    parsed.saleSnapshot.daysToSell   = subNum(parsed.saleSnapshot.daysToSell,   daysToSell);
    parsed.saleSnapshot.daysSinceSale = subNum(parsed.saleSnapshot.daysSinceSale, daysSinceSale);
  }
  if (parsed.listingJourney) {
    parsed.listingJourney.soldDate   = subDate(parsed.listingJourney.soldDate,   precomputedSoldDate);
    parsed.listingJourney.listedDate = subDate(parsed.listingJourney.listedDate, precomputedListDate);
    parsed.listingJourney.daysToSell = subNum(parsed.listingJourney.daysToSell, daysToSell);
  }
  if (parsed.appreciationContext) {
    parsed.appreciationContext.previousPurchaseDate  = subDate(parsed.appreciationContext.previousPurchaseDate,  precomputedPrevDate);
    parsed.appreciationContext.previousPurchasePrice = subNum(parsed.appreciationContext.previousPurchasePrice, previousSalePrice);
    parsed.appreciationContext.sellerAppreciationPct = subNum(parsed.appreciationContext.sellerAppreciationPct, sellerAppreciationPct);
    parsed.appreciationContext.yearsHeld = subNum(parsed.appreciationContext.yearsHeld, sellerYearsHeld);
  }
  // Hard-rebuild priceChain if it's empty or has Unknown dates
  if (!Array.isArray(parsed.priceNarrative?.priceChain) || parsed.priceNarrative.priceChain.length === 0
    || parsed.priceNarrative.priceChain.some(e => !e.date || e.date === 'Unknown')) {
    parsed.priceNarrative = parsed.priceNarrative || {};
    parsed.priceNarrative.priceChain = ph.map(h => ({
      date:  fmtDate(parsePHDate(h.date)),
      event: h.event || '',
      price: h.price || 0
    })).filter(e => e.date && e.date !== 'Unknown' && e.event);
  }

  return parsed;
}

// ── Rental listing analysis ───────────────────────────────────────────────────
async function analyzeRent(listingData, apiKey, TODAY, TODAY_ISO) {
  // Rental: skip comps, MLS, agent license. Run county lookup + landlord intel in parallel.
  const [countyResult, landlordResult] = await Promise.allSettled([
    fetchCountyData(listingData),
    fetchLandlordIntel(listingData)
  ]);
  const county   = countyResult.status   === 'fulfilled' ? countyResult.value   : null;
  const landlord = landlordResult.status === 'fulfilled' ? landlordResult.value : null;

  const {
    address, sqft, beds, baths, description,
    rentZestimate, rentZestimateRange, zestimate,
    leaseTerms, petPolicy, laundry, parkingType,
    applicationFee, depositMin, availableDate, utilitiesIncluded,
    landlordName, landlordCompany, isPrivateLandlord, daysOnMarket,
    propertyType, yearBuilt, hoaFee, priceHistory,
    nearbyHomes, nearbySchools
  } = listingData;

  // Rent price: use rentPrice (locked from DOM quick scrape — most reliable source).
  // Fall back chain: rentPrice → listingData.price if valid monthly → priceHistory → rentZestimate
  let price = listingData.rentPrice > 0 ? listingData.rentPrice : 0;
  if (!price && listingData.price > 0 && listingData.price <= 50000) price = listingData.price;
  if (!price) {
    const ph0 = Array.isArray(priceHistory) ? priceHistory : [];
    for (const h of ph0) {
      const ev = (h.event || h.priceChangeType || '').toLowerCase();
      if (/listed.*rent|price.*change|reduced/i.test(ev) && h.price >= 500 && h.price <= 50000) {
        price = Number(h.price); break;
      }
    }
  }
  if (!price && rentZestimate > 0) price = rentZestimate;

  const propertyState = detectStateFromAddress(address);
  const msaKeyRent    = detectMSAFromAddress(address);
  const msaLabel      = (msaKeyRent && FHFA_MSA[msaKeyRent]) ? FHFA_MSA[msaKeyRent].label : 'FHFA National Average';

  // If no Rent Zestimate from Zillow, fetch market rent data from web
  let marketRentContext = '';
  if (!rentZestimate || rentZestimate === 0) {
    try {
      const zip   = (address || '').match(/\d{5}/)?.[0] || '';
      const query = `average rent ${beds}BR ${propertyType || 'house'} ${zip || address?.split(',').slice(-2).join(',') || ''} 2025`;
      const res   = await fetch(`https://www.zillow.com/rental-manager/price-my-rental/?zip=${zip}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
        signal: AbortSignal.timeout(5000)
      }).catch(() => null);
      // Build market context string for the prompt regardless
      marketRentContext = `No Rent Zestimate available. Based on ${beds}BR rentals in ${zip || 'this area'}, typical market rent is $${Math.round((price || 2500) * 0.93).toLocaleString()} – $${Math.round((price || 2500) * 1.07).toLocaleString()}/mo (estimate). Claude should use web knowledge of ${zip} rental market to assess whether asking rent of $${(price||0).toLocaleString()}/mo is above/at/below market.`;
    } catch(e) {}
  }

  // Profile affordability
  const profile     = listingData.userProfile || {};
  const priorities  = profile.priorities || [];
  const annualIncome = profile.annualIncome || 0;
  const monthlyIncome = annualIncome > 0 ? Math.round(annualIncome / 12) : 0;
  const rentToIncome  = monthlyIncome > 0 ? Math.round((price / monthlyIncome) * 100) : null;
  const incomeGuideline = monthlyIncome > 0 ? Math.round(monthlyIncome * 0.30) : null;

  // Estimate utilities by sqft and property type
  const sqftNum = parseNum(String(sqft || 0));
  const estUtils = sqftNum > 0 ? Math.round(sqftNum * 0.065) : 120; // ~$0.065/sqft avg
  const rentersIns = 18; // ~$18/mo average
  const trueMonthly = price + estUtils + rentersIns;

  // Landlord estimated cash flow — based solely on last sold price (no Zestimate)
  // Assumes investor mortgage: 25% down, rate = fed funds + 2.75% spread, 30yr fixed
  // All-in = P&I + HOA + property tax + landlord insurance + maintenance reserve
  // + utilities only if landlord pays them (mentioned in description)
  const fedFunds   = await getFedFundsRate();
  const invRateAnn = fedFunds + FED_FUNDS_SPREAD; // e.g. 3.625 + 2.75 = 6.375%
  const INV_RATE   = invRateAnn / 100;
  const INV_LTV    = 0.75;  // 75% LTV — 25% down
  const VIABLE_X   = 1.25; // 1.25x all-in = healthy investor return

  const lastSoldPrice = listingData.lastSoldPrice || 0;
  const purchaseBasis = lastSoldPrice > 50000 ? lastSoldPrice : 0;

  let landlordMortgage = 0;
  let landlordCashFlow = null;
  let landlordCashFlowLabel = '';
  let landlordTotalOwnerCost = 0;
  let coverageRatio = null;
  let breakEvenRent = 0;
  let viableRent = 0;
  let invRateDisplay = invRateAnn.toFixed(2) + '%';

  // Utilities flag — declared outside if block so prompt/JSON can reference it
  const descLower = (description || '').toLowerCase();
  const landlordPaysUtils = /landlord pays|owner pays|utilities included|water included|electric included/i.test(descLower);

  if (purchaseBasis > 0) {
    const monthlyRate = INV_RATE / 12;
    const n    = 360;
    const loan = purchaseBasis * INV_LTV; // 75% of purchase price
    landlordMortgage = Math.round(loan * (monthlyRate * Math.pow(1+monthlyRate,n)) / (Math.pow(1+monthlyRate,n)-1));

    const hoaM   = parseNum(String(hoaFee || 0));
    const taxM   = Math.round(purchaseBasis * 0.012 / 12); // ~1.2% annual property tax
    const insM   = Math.round(purchaseBasis * 0.006 / 12); // ~0.6% annual landlord insurance
    const maintM = Math.round(purchaseBasis * 0.010 / 12); // ~1% annual maintenance reserve
    const utilM  = landlordPaysUtils ? 200 : 0; // ~$200/mo if landlord pays utilities

    landlordTotalOwnerCost = landlordMortgage + hoaM + taxM + insM + maintM + utilM;

    landlordCashFlow = price - landlordTotalOwnerCost;
    coverageRatio    = landlordTotalOwnerCost > 0
      ? Math.round((price / landlordTotalOwnerCost) * 100) / 100 : null;
    breakEvenRent    = landlordTotalOwnerCost;
    viableRent       = Math.round(landlordTotalOwnerCost * VIABLE_X);

    // Label based purely on math — no feel
    if (coverageRatio !== null && coverageRatio >= VIABLE_X) {
      landlordCashFlowLabel = `+$${landlordCashFlow.toLocaleString()}/mo (${coverageRatio.toFixed(2)}x — healthy return)`;
    } else if (landlordCashFlow !== null && landlordCashFlow >= 0) {
      landlordCashFlowLabel = `+$${landlordCashFlow.toLocaleString()}/mo (${coverageRatio?.toFixed(2)}x — marginal, below 1.25x threshold)`;
    } else if (landlordCashFlow !== null) {
      landlordCashFlowLabel = `-$${Math.abs(landlordCashFlow).toLocaleString()}/mo (${coverageRatio?.toFixed(2)}x — cash negative)`;
    }
  }

  // Rent vs Buy (if zestimate available)
  let piPayment = 0;
  if (zestimate > 0) {
    const rate = (profile.mortgageRatePct || 7.0) / 100 / 12;
    const n    = 360;
    const loan = zestimate * 0.80;
    piPayment  = Math.round(loan * (rate * Math.pow(1+rate,n)) / (Math.pow(1+rate,n)-1));
  }


  const userPrompt = `TODAY: ${TODAY}

Analyze this FOR RENT listing and return ONLY a valid JSON object — no markdown.

═══ RENTAL PROPERTY ═══
Address: ${address || 'Unknown'}
Monthly Rent: $${(price||0).toLocaleString()}/mo
Sqft: ${sqft||'?'} | Beds: ${beds||'?'} | Baths: ${baths||'?'}
Type: ${propertyType||'?'} | Year Built: ${yearBuilt||'?'}
Days Listed: ${daysOnMarket || 0}

═══ RENT MARKET DATA ═══
Rent Zestimate: $${rentZestimate?.toLocaleString() || 'N/A'}/mo
Rent Zestimate Range: $${rentZestimateRange?.low?.toLocaleString()||'?'} – $${rentZestimateRange?.high?.toLocaleString()||'?'}
Zestimate (purchase value): $${zestimate?.toLocaleString() || 'N/A'}
${marketRentContext || ''}

═══ LEASE DETAILS (from Facts & Features) ═══
Lease Terms: ${leaseTerms || 'Not specified'}
Pets: ${petPolicy || 'Not specified'}
Laundry: ${laundry || 'Not specified'}
Parking: ${parkingType || 'Not specified'}
Application Fee: $${applicationFee || 'Unknown'}
Deposit: $${depositMin || 'Unknown'}
Available: ${availableDate || 'Not specified'}
Utilities Included: ${utilitiesIncluded || 'Not specified'}

═══ LANDLORD ═══
Listed By: ${landlordName || 'Unknown'}
Company: ${landlordCompany || 'N/A'}
Private Owner: ${isPrivateLandlord ? 'Yes' : 'No'}
Owner of Record (county): ${landlord?.ownerOfRecord || 'Not retrieved'}
Owner Match Status: ${landlord?.ownerMatchStatus || 'Unknown'}
License Status: ${landlord?.licenseStatus || 'Not checked'}
Scam Risk Score: ${landlord?.scamRiskScore ?? 0}/10

═══ AFFORDABILITY ═══
Buyer Monthly Income: $${monthlyIncome > 0 ? monthlyIncome.toLocaleString() : 'Not provided'}
Rent-to-Income: ${rentToIncome !== null ? rentToIncome + '%' : 'Unknown'}
30% Guideline Max: $${incomeGuideline?.toLocaleString() || 'Unknown'}

═══ TRUE COST ESTIMATE ═══
Rent: $${(price||0).toLocaleString()}
Est. Utilities: $${estUtils}
Renter's Insurance: $${rentersIns}
Est. All-In: $${trueMonthly.toLocaleString()}/mo

═══ LANDLORD ESTIMATED CASH FLOW ═══
Last Sold Price: $${purchaseBasis > 0 ? purchaseBasis.toLocaleString() : 'Unknown — cash flow N/A'}
Investor Mortgage: 25% down ($${purchaseBasis > 0 ? Math.round(purchaseBasis*0.25).toLocaleString() : '—'}), 75% LTV, ${invRateDisplay} (fed funds ${fedFunds.toFixed(2)}% + 2.75% spread), 30yr fixed
P&I: $${landlordMortgage > 0 ? landlordMortgage.toLocaleString() : '—'}/mo
HOA: $${parseNum(String(hoaFee||0)) > 0 ? parseNum(String(hoaFee||0)).toLocaleString() : '0'}/mo
Property Tax: $${purchaseBasis > 0 ? Math.round(purchaseBasis*0.012/12).toLocaleString() : '—'}/mo (~1.2% annual)
Insurance: $${purchaseBasis > 0 ? Math.round(purchaseBasis*0.006/12).toLocaleString() : '—'}/mo (~0.6% annual)
Maintenance Reserve: $${purchaseBasis > 0 ? Math.round(purchaseBasis*0.010/12).toLocaleString() : '—'}/mo (~1% annual)
${landlordPaysUtils ? 'Utilities (landlord pays — noted in description): ~$200/mo' : 'Utilities: tenant pays (not mentioned in description)'}
Total All-In Estimated Owner Cost: $${landlordTotalOwnerCost > 0 ? landlordTotalOwnerCost.toLocaleString() : '—'}/mo
Asking Rent: $${price.toLocaleString()}/mo
Estimated Net Cash Flow: ${landlordCashFlowLabel || 'N/A — no sold price found'}
Break-Even Rent (1.0x): $${breakEvenRent > 0 ? breakEvenRent.toLocaleString() : '—'}/mo | Healthy Return Rent (1.25x): $${viableRent > 0 ? viableRent.toLocaleString() : '—'}/mo

═══ RENT vs BUY ═══
If purchased at Zestimate ($${zestimate?.toLocaleString()||'N/A'}), 20% down at 7%: P&I $${piPayment?.toLocaleString()}/mo

Return this JSON:
{
  "rentRealityCheck": {
    "rentZestimate": <integer>,
    "rentZestimateGap": <integer — ask minus zestimate>,
    "rentRange": { "low": <integer>, "high": <integer> },
    "marketPosition": <"Below Market"|"At Market"|"Above Market">,
    "note": <1 sentence>
  },
  "trueMonthlyCost": {
    "estimatedUtilities": ${estUtils},
    "rentersInsurance": ${rentersIns},
    "parking": <string or null>,
    "totalEstimate": ${trueMonthly}
  },
  "affordability": {
    "rentToIncomeRatio": ${rentToIncome || 'null'},
    "guideline": ${incomeGuideline || 'null'},
    "verdict": <"Affordable"|"Borderline"|"Stretched"|"Unknown">,
    "note": <1 sentence — only if income provided>
  },
  "leaseIntel": {
    "leaseTerms": <string — if listing says "Contact for details" or similar, return "Contact for details">,
    "petPolicy": <string — if not specified, return "Not specified">,
    "laundry": <string>,
    "parking": <string>,
    "depositMin": <integer or null>,
    "applicationFee": <integer or null>,
    "availableDate": <string>,
    "utilitiesIncluded": <string — if listing mentions tenant pays, say "Tenant pays all utilities">,
    "daysOnMarket": ${daysOnMarket || 0},
    "note": <1 short sentence max. If DOM >30 days, note leverage. Do not repeat lease terms already shown in fields above. Never use dashes.>
  },
  "landlordIntel": {
    "name": "${(landlordName||'').replace(/"/g,"'")}",
    "company": "${(landlordCompany||'').replace(/"/g,"'")}",
    "type": "${isPrivateLandlord ? 'Private Owner' : 'Property Manager'}",
    "ownerOfRecord": "${(landlord?.ownerOfRecord||'').replace(/"/g,"'")}",
    "ownerMatchStatus": "${(landlord?.ownerMatchStatus||'').replace(/"/g,"'")}",
    "otherListings": <integer — estimate from context>,
    "licenseStatus": "${landlord?.licenseStatus||''}",
    "scamRiskScore": ${landlord?.scamRiskScore ?? 0},
    "note": "${(landlord?.note||'').replace(/"/g,"'")}"
  },
  "landlordCashFlow": {
    "lastSoldPrice": ${purchaseBasis || 'null'},
    "investorRate": "${invRateDisplay}",
    "estimatedMortgage": ${landlordMortgage || 'null'},
    "estimatedHOA": ${parseNum(String(hoaFee||0)) || 0},
    "estimatedTax": ${purchaseBasis > 0 ? Math.round(purchaseBasis*0.012/12) : 'null'},
    "landlordPaysUtilities": ${landlordPaysUtils},
    "estimatedTotalOwnerCost": ${landlordTotalOwnerCost || 'null'},
    "monthlyCashFlow": ${landlordCashFlow !== null ? landlordCashFlow : 'null'},
    "coverageRatio": ${coverageRatio !== null ? coverageRatio : 'null'},
    "cashFlowLabel": <"Healthy Return" | "Marginal" | "Cash Negative" | "No Data">,
    "breakEvenRent": ${breakEvenRent || 'null'},
    "viableRent": ${viableRent || 'null'},
    "negotiationLeverage": <1 sentence — state the math first (cash flow ±$X/mo), then the leverage implication. No feel, no speculation beyond the numbers.>
  },
  "rentVsBuy": {
    "monthlyCostToOwn": ${piPayment || 'null'},
    "breakEvenYears": <integer — rough estimate if buying would build equity faster>,
    "verdict": <"Renting Wins"|"Buying Wins"|"Close Call"|"Data Insufficient">,
    "note": <1 sentence>
  },
  "redFlags": [
    { "title": <max 5 words>, "severity": <"low"|"medium"|"high">, "explanation": <1 sentence> }
  ],
  "oneLineSummary": <1 sentence — rent vs market + landlord signal + affordability in one verdict>
}

Rules:
- rentRealityCheck: if Rent Zestimate is N/A, use your knowledge of ${(address||'').split(',').slice(-3).join(',').trim()} rental market for ${beds}BR homes to estimate a fair market range. State the source as "Market estimate" in the note.
- redFlags: only include real signals from the data above. If scam risk score is low and no flags, return empty array.
- landlordIntel.scamRiskScore: use the pre-computed value — ${landlord?.scamRiskScore ?? 0}.
- affordability: only populate if income was provided (${annualIncome > 0 ? 'YES — $' + annualIncome.toLocaleString() : 'NO'}).
- rentVsBuy: only populate if zestimate is available ($${zestimate?.toLocaleString() || 'N/A'}).
- leaseIntel: populate ALL fields from the Lease Details section above. If a field says "Contact for details", "Call for info", or similar, return that exact phrase as the value, do NOT rephrase as "unspecified" or "undisclosed". If DOM > 30 days, note leverage in leaseIntel.note. The note should NOT repeat field values already shown (lease term, pets, etc.) and should be max 1 sentence.
- leaseIntel.daysOnMarket: ${daysOnMarket || 0} — use this exact number.
- AUTOMATIC PRIORITY WEIGHTING FOR RENTALS — always apply these, escalate further if selected in buyer priorities:
  * Schools: always flag school district/rating — escalate to HIGH if buyer selected Schools priority (${priorities.includes('schools') ? 'SELECTED — HIGH severity' : 'not selected — medium severity'})
  * Safety/Crime: always include a note on neighborhood safety signals — escalate to HIGH if buyer selected Safety (${priorities.includes('safety') ? 'SELECTED — HIGH severity' : 'not selected — medium severity'})
  * Commute: always note highway/transit access — escalate to HIGH if buyer selected Commute (${priorities.includes('commute') ? 'SELECTED — HIGH severity' : 'not selected — medium severity'})
  For unselected schools/safety/commute: include as medium severity in redFlags or leaseIntel.note. For selected ones: HIGH severity red flag with specific data.`;

  const systemPrompt = `You are Clear Home. Today is ${TODAY}. Analyze rental listings with landlord verification and provide tenant-protective intelligence. Return specific, actionable JSON.`;

  return { system: systemPrompt, user: userPrompt, meta: {} };
}

function finalizeRentResult(rawText) {
  const clean = rawText.replace(/^```json\s*/i,'').replace(/```\s*$/,'').trim();
  try { return JSON.parse(clean); } catch { return { oneLineSummary: 'Rental analysis loaded.', _raw: clean }; }
}

// ── Commute estimate via OpenStreetMap Nominatim + OSRM ──────────────────────
// Geocodes addresses with Nominatim, routes with OSRM driving profile.
// Returns estimated drive minutes, rounded to nearest 5 if > 10.
// Geocode results are cached in chrome.storage.local to avoid repeated Nominatim calls.

const _geocodeMemCache = {}; // in-memory cache for current SW lifetime

async function geocodeAddress(addressStr) {
  if (!addressStr?.trim()) return null;
  const cacheKey = 'gc_' + addressStr.trim().toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 80);

  // 1. In-memory cache (instant)
  if (_geocodeMemCache[cacheKey]) return _geocodeMemCache[cacheKey];

  // 2. storage.local cache (fast, survives SW restart)
  try {
    const stored = await new Promise(r => chrome.storage.local.get([cacheKey], r));
    if (stored[cacheKey]?.lat) {
      _geocodeMemCache[cacheKey] = stored[cacheKey];
      return stored[cacheKey];
    }
  } catch {}

  // 3. Nominatim fetch (slow, rate-limited)
  try {
    const q = encodeURIComponent(addressStr.trim());
    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`, {
      headers: { 'User-Agent': 'ClearHome/1.2 (real-estate-extension)' }
    });
    const data = await res.json();
    if (!data?.length) return null;
    const coords = { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
    // Cache for future runs
    _geocodeMemCache[cacheKey] = coords;
    chrome.storage.local.set({ [cacheKey]: coords }).catch(() => {});
    return coords;
  } catch { return null; }
}

async function fetchOSRMRoute(fromCoords, toCoords) {
  // fromCoords/toCoords: { lat, lon }
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${fromCoords.lon},${fromCoords.lat};${toCoords.lon},${toCoords.lat}?overview=false`;
    const res  = await fetch(url);
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes?.length) return null;
    const minutes = data.routes[0].duration / 60;
    // Round to nearest 5 if > 10, else round to nearest minute
    const rounded = minutes > 10 ? Math.round(minutes / 5) * 5 : Math.round(minutes);
    return { minutes: rounded, distanceMiles: Math.round(data.routes[0].distance / 1609.34 * 10) / 10 };
  } catch { return null; }
}

async function fetchCommuteEstimates(listingAddress, commuteAddrs) {
  if (!listingAddress || !commuteAddrs || !Object.keys(commuteAddrs).length) return {};
  const fromCoords = await geocodeAddress(listingAddress);
  if (!fromCoords) return {};

  // Pre-resolve all destination geocodes — cached ones are instant, only fresh ones need delay
  const keys = ['work1','work2','flex1','flex2','flex3'];
  const entries = keys.map(k => ({ key: k, entry: commuteAddrs[k] })).filter(e => e.entry?.addr?.trim());

  // Batch geocode destinations: check cache first, collect uncached for sequential fetch
  const destCoords = {};
  const uncached = [];
  for (const { key, entry } of entries) {
    const cacheKey = 'gc_' + entry.addr.trim().toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 80);
    if (_geocodeMemCache[cacheKey]) {
      destCoords[key] = _geocodeMemCache[cacheKey];
    } else {
      try {
        const stored = await new Promise(r => chrome.storage.local.get([cacheKey], r));
        if (stored[cacheKey]?.lat) {
          _geocodeMemCache[cacheKey] = stored[cacheKey];
          destCoords[key] = stored[cacheKey];
          continue;
        }
      } catch {}
      uncached.push({ key, entry });
    }
  }

  // Fetch uncached geocodes with Nominatim delay (only these need the 1.1s wait)
  for (const { key, entry } of uncached) {
    const toCoords = await geocodeAddress(entry.addr);
    if (toCoords) destCoords[key] = toCoords;
    // Nominatim rate limit: 1 req/sec — only delay if more uncached remain
    if (uncached.indexOf(uncached.find(u => u.key === key)) < uncached.length - 1) {
      await new Promise(r => setTimeout(r, 1100));
    }
  }

  // Fetch OSRM routes in parallel (OSRM has no strict rate limit)
  const results = {};
  const routePromises = entries
    .filter(({ key }) => destCoords[key])
    .map(async ({ key, entry }) => {
      const route = await fetchOSRMRoute(fromCoords, destCoords[key]);
      if (route) results[key] = { label: entry.label || key, ...route };
    });
  await Promise.all(routePromises);

  return results;
}

// ── Orange County Property Appraiser — ArcGIS FeatureServer ──────────────────
// OCPA exposes parcel data via ArcGIS REST at vgispublic.ocpafl.org.
// Layer 45 (SV_PARCELS) has owner, assessed value, market value, taxes.
// Layer 0 (Parcels) has building characteristics incl. year built and sqft.
async function fetchCountyData(listingData) {
  const { parcelNumber } = listingData;
  if (!parcelNumber) return null;

  const pid = parcelNumber.replace(/[^0-9A-Z]/gi, '');
  const result = { source: 'Orange County PA', parcel: pid };

  // ── Attempt 1: OCPA public web property card (HTML scrape) ───────────────
  // This page loads as a JS SPA but the data API it calls is public.
  // The underlying call is to their internal API — we hit it directly.
  try {
    const cardUrl = `https://www.ocpafl.org/Searches/ParcelSearch.aspx?parcel=${pid}`;
    const res = await fetch(cardUrl, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (res.ok) {
      const html = await res.text();
      // OCPA embeds JSON data in a script tag or inline data attributes
      const ownerM    = html.match(/(?:Owner|NAME1)["\s:]+([^"<\n]{3,60})/i);
      const assessM   = html.match(/(?:Total Assessed|TOTAL_ASSD)["\s:$]+([0-9,]+)/i);
      const marketM   = html.match(/(?:Total Market|TOTAL_MKT)["\s:$]+([0-9,]+)/i);
      const taxM      = html.match(/(?:Ad Valorem Tax|TAXES)["\s:$]+([0-9,]+)/i);
      const yearM     = html.match(/(?:Year Built|YR_BLT)["\s:]+(\d{4})/i);
      const sqftM     = html.match(/(?:Living Area|TOT_LVG_AR|Sq\.?\s*Ft)["\s:]+([0-9,]+)/i);
      const exemptM   = html.match(/(?:Exemption|EXMPT)["\s:]+([^"<\n]{2,40})/i);

      if (ownerM || assessM) {
        if (ownerM)  result.ownerName     = ownerM[1].trim();
        if (assessM) result.assessedValue = parseFloat(assessM[1].replace(/,/g, ''));
        if (marketM) result.marketValue   = parseFloat(marketM[1].replace(/,/g, ''));
        if (taxM)    result.annualTax     = parseFloat(taxM[1].replace(/,/g, ''));
        if (yearM)   result.yearBuiltCounty = yearM[1];
        if (sqftM)   result.sqftCounty    = parseFloat(sqftM[1].replace(/,/g, ''));
        if (exemptM) result.exemptions    = exemptM[1].trim();
        result.fetchMethod = 'html';
        return result;
      }
    }
  } catch (e) {
    chDebug('[ClearHome] OCPA HTML fetch failed:', e.message);
  }

  // ── Attempt 2: OCPA ArcGIS FeatureServer — Parcel layer ──────────────────
  // The public ArcGIS REST service at vgispublic.ocpafl.org exposes parcel
  // features. We query by PID field. No API key needed.
  const arcgisBase = 'https://vgispublic.ocpafl.org/server/rest/services';
  const parcelLayers = [
    `${arcgisBase}/Parcel_Public/FeatureServer/0`,
    `${arcgisBase}/Nearby_Amenities_MIL1/FeatureServer/14`,
    `${arcgisBase}/OCPA/Parcels/FeatureServer/0`
  ];

  for (const layerUrl of parcelLayers) {
    try {
      const queryUrl = `${layerUrl}/query?` + new URLSearchParams({
        where:     `PID='${pid}' OR PARNUM='${pid}' OR PIN='${pid}'`,
        outFields: '*',
        f:         'json',
        resultRecordCount: 1
      });
      const res = await fetch(queryUrl, {
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) continue;
      const json = await res.json();
      const feat = json?.features?.[0]?.attributes;
      if (!feat) continue;

      result.ownerName     = feat.NAME1 || feat.OWNER || feat.OWN_NAME || '';
      result.assessedValue = feat.TOTAL_ASSD || feat.TOT_ASSD || feat.ASSD_VAL || 0;
      result.marketValue   = feat.TOTAL_MKT  || feat.TOT_MKT  || feat.MKT_VAL  || 0;
      result.landValue     = feat.LAND_MKT   || feat.LAND_VAL || 0;
      result.buildingValue = feat.BLDG_MKT   || feat.BLDG_VAL || 0;
      result.annualTax     = feat.TAXES || feat.TAX_AMT || 0;
      result.yearBuiltCounty = feat.YR_BLT || feat.YEAR_BUILT || feat.ACT_YR_BLT || '';
      result.sqftCounty    = feat.TOT_LVG_AR || feat.LIVG_AREA || feat.BLDG_SQFT || 0;
      result.exemptions    = feat.EXMPT_DESC || feat.EXEMPTIONS || '';
      result.landUse       = feat.DOR_DESC || feat.LAND_USE || '';
      result.subdivision   = feat.SUB_DESC || feat.SUBDIV || '';
      result.fetchMethod   = 'arcgis';
      return result;
    } catch (e) {
      chDebug(`[ClearHome] ArcGIS layer failed (${layerUrl}):`, e.message);
    }
  }

  // ── Attempt 3: Tax estimator page ────────────────────────────────────────
  try {
    const taxUrl = `https://taxestimator.ocpafl.org/Details.aspx?parcel=${pid}`;
    const res = await fetch(taxUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (res.ok) {
      const html = await res.text();
      const assessM = html.match(/Assessed Value[^$]*\$?([\d,]+)/i);
      const taxM    = html.match(/Ad Valorem[^$]*\$?([\d,]+)/i);
      const ownerM  = html.match(/Owner[^:]*:\s*([^\n<]{4,60})/i);
      if (assessM || taxM) {
        if (assessM) result.assessedValue = parseFloat(assessM[1].replace(/,/g,''));
        if (taxM)    result.annualTax     = parseFloat(taxM[1].replace(/,/g,''));
        if (ownerM)  result.ownerName     = ownerM[1].trim();
        result.fetchMethod = 'tax_estimator';
        return result;
      }
    }
  } catch (e) {
    chDebug('[ClearHome] Tax estimator fetch failed:', e.message);
  }

  result.fetchMethod = 'failed';
  result.manualUrl   = `https://www.ocpafl.org/Searches/ParcelSearch.aspx?parcel=${pid}`;
  return result;
}

// ── Real estate license verification — multi-state ────────────────────────────
// Strategy by state:
//   FL  → DBPR statewide CSV (weekly updated, all brokers + sales associates)
//   NY  → NY DOS open data CSV (data.ny.gov)
//   CA  → DRE eLicensing HTML search
//   TX  → TREC license lookup HTML
//   All others → ARELLO manual lookup URL (no API key required for manual)
//
// FL DBPR CSV column layout (REALESTATE2501LICENSE_1.csv):
//   0: licenseCode  1: licenseeName  2: dbaName  3: rank  4: addr1  5: addr2
//   6: addr3  7: city  8: state  9: zip  10: countyName  11: licenseNumber
//   12: primaryStatus  13: secondaryStatus  14: originalLicenseDate
//   15: statusEffectiveDate  16: licenseExpirationDate  17: alternateLicenseNumber
//   18: selfProprietorName  19: employerName  20: employerLicenseNumber

async function fetchAgentLicense(listingData) {
  const { agentName, brokerageName, address } = listingData;
  if (!agentName) return null;

  // Detect state from listing address
  const state = detectStateFromAddress(address);

  const parts     = agentName.trim().split(/\s+/);
  const firstName = (parts[0] || '').toUpperCase();
  const lastName  = (parts[parts.length - 1] || '').toUpperCase();

  // ── Florida — DBPR statewide CSV ──────────────────────────────────────────
  if (state === 'FL' || state === 'Florida' || !state) {
    const result = await lookupFLDBPR(firstName, lastName, agentName, brokerageName);
    if (result) return result;
  }

  // ── New York — DOS open data ───────────────────────────────────────────────
  if (state === 'NY' || state === 'New York') {
    const result = await lookupNYDOS(firstName, lastName);
    if (result) return result;
  }

  // ── Other states — state-specific HTML scrape ─────────────────────────────
  const htmlResult = await lookupStateHTML(state, firstName, lastName, agentName);
  if (htmlResult) return htmlResult;

  // ── Universal fallback — ARELLO manual search URL ─────────────────────────
  return {
    status:    'Unverified',
    isActive:  null,
    source:    'lookup_failed',
    concerns:  [`Could not auto-verify license for ${state || 'unknown state'}`],
    manualUrl: `https://www.arello.com/index.cfm?fm=search&firstName=${encodeURIComponent(parts[0]||'')}&lastName=${encodeURIComponent(lastName)}`,
    stateUrl:  getStateLicenseLookupUrl(state, agentName)
  };
}

// ── FL DBPR statewide CSV lookup ──────────────────────────────────────────────
async function lookupFLDBPR(firstName, lastName, agentName, brokerageName) {
  // Try statewide file first, then region files as fallback
  const csvUrls = [
    // Statewide — all FL sales associates and brokers (best option)
    'https://www2.myfloridalicense.com/sto/file_download/extracts/REALESTATE2501LICENSE_1.csv',
    // Orange County specific (faster, smaller)
    'https://www2.myfloridalicense.com/sto/file_download/extracts/RE_rgn12.csv',
    // Out of state agents licensed in FL
    'https://www2.myfloridalicense.com/sto/file_download/extracts/RE_rgn14.csv',
    'https://www2.myfloridalicense.com/sto/file_download/extracts/RE_rgn11.csv',
  ];

  for (const csvUrl of csvUrls) {
    try {
      const res = await fetch(csvUrl, {
        headers: { 'Accept': 'text/csv,text/plain,*/*', 'User-Agent': 'Mozilla/5.0' }
      });
      if (!res.ok) continue;

      const text  = await res.text();
      const lines = text.split('\n');
      const matches = [];

      for (const line of lines) {
        if (!line.trim()) continue;
        if (!line.toUpperCase().includes(lastName)) continue;

        const cols = parseCSVLine(line);
        if (cols.length < 13) continue;

        // REALESTATE2501LICENSE_1.csv layout:
        // 0:licCode 1:name 2:dba 3:rank 4:addr1 5:addr2 6:addr3
        // 7:city 8:state 9:zip 10:county 11:licNum 12:primaryStatus
        // 13:secondaryStatus 14:origDate 15:statusDate 16:expiry
        // 17:altLicNum 18:selfPropName 19:employerName 20:employerLicNum

        const nameCol      = (cols[1] || '').toUpperCase().trim();
        const rank         = (cols[3] || '').trim();
        const licNum       = (cols[11] || cols[17] || '').trim();
        const primaryStatus = (cols[12] || '').trim();   // "Current" / "Delinquent"
        const activeStatus  = (cols[13] || '').trim();   // "Active" / "Inactive"
        const issued        = (cols[14] || '').trim();
        const expiry        = (cols[16] || '').trim();
        const employer      = (cols[19] || '').trim();
        const city          = (cols[7]  || '').trim();
        const county        = (cols[10] || '').trim();

        // Name format: "SILVA, JOHN" or "JOHN SILVA"
        const nameParts = nameCol.includes(',')
          ? { last: nameCol.split(',')[0].trim(), first: (nameCol.split(',')[1] || '').trim() }
          : { last: nameCol.split(' ').pop(), first: nameCol.split(' ')[0] };

        if (!nameParts.last.includes(lastName)) continue;
        if (firstName && nameParts.first && !nameParts.first.includes(firstName)) continue;

        matches.push({
          fullName:      cols[1]?.trim() || agentName,
          licenseType:   rank,
          licenseNumber: licNum,
          renewalStatus: primaryStatus,
          activeStatus,
          isActive:      activeStatus === 'Active' && primaryStatus === 'Current',
          issued, expiry,
          employer,
          city, county,
          source: 'FL DBPR (statewide CSV)',
          csvUrl
        });
      }

      if (!matches.length) continue;

      // Prefer broker (BK) over sales associate (SL), then exact first name match
      const best = matches.find(m => /broker/i.test(m.licenseType) && m.fullName.toUpperCase().includes(firstName))
                || matches.find(m => /broker/i.test(m.licenseType))
                || matches.find(m => m.fullName.toUpperCase().includes(firstName))
                || matches[0];

      // Build concerns
      best.concerns = [];
      if (best.renewalStatus && best.renewalStatus !== 'Current') {
        best.concerns.push(`Renewal status: ${best.renewalStatus}`);
      }
      if (best.activeStatus && best.activeStatus !== 'Active') {
        best.concerns.push(`License not active (${best.activeStatus})`);
      }
      if (best.expiry) {
        const daysLeft = Math.floor((new Date(best.expiry) - new Date()) / 86400000);
        if (daysLeft > 0 && daysLeft < 90) best.concerns.push(`Expires in ${daysLeft} days`);
        if (daysLeft <= 0) best.concerns.push(`License EXPIRED on ${best.expiry}`);
      }
      if (brokerageName && best.employer && !best.employer.toUpperCase().includes(brokerageName.toUpperCase().slice(0,10))) {
        best.concerns.push(`Employer on file (${best.employer}) differs from listing brokerage`);
      }

      return best;
    } catch (e) {
      chDebug('[ClearHome] FL DBPR fetch failed:', e.message);
    }
  }
  return null;
}

// ── New York — DOS active license CSV ─────────────────────────────────────────
async function lookupNYDOS(firstName, lastName) {
  try {
    // NY publishes RE broker/salesperson active licenses on data.ny.gov
    const url = 'https://data.ny.gov/api/views/tested-csv-link/rows.csv?accessType=DOWNLOAD';
    // Fallback: NY DOS search portal
    const searchUrl = `https://dos.ny.gov/licensing/lookup/licopen.asp?p_field=Name&p_value=${encodeURIComponent(lastName + ', ' + firstName)}&p_license_type=30&p_status=A`;
    const res = await fetch(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const html = await res.text();
    const licNumM  = html.match(/([A-Z0-9]{8,12})/);
    const statusM  = html.match(/(Active|Inactive|Expired)/i);
    const expiryM  = html.match(/(\d{2}\/\d{2}\/\d{4})/);
    if (licNumM) {
      return {
        fullName: `${firstName} ${lastName}`,
        licenseNumber: licNumM[1],
        activeStatus: statusM?.[1] || 'Unknown',
        isActive: /active/i.test(statusM?.[1] || ''),
        expiry: expiryM?.[1] || '',
        source: 'NY DOS',
        concerns: []
      };
    }
  } catch (e) {
    chDebug('[ClearHome] NY DOS lookup failed:', e.message);
  }
  return null;
}

// ── State HTML lookup — for states with public search portals ─────────────────
async function lookupStateHTML(state, firstName, lastName, agentName) {
  const stateUrls = {
    'TX': `https://www.trec.texas.gov/apps/license-holder-search/?name=${encodeURIComponent(lastName + ' ' + firstName)}`,
    'CA': `https://www2.dre.ca.gov/PublicASP/pplinfo.asp?License_id=`,
    'GA': `https://verify.sos.ga.gov/verification/Search.aspx?facility=Y&skill=R1&district=N`,
    'NC': `https://www.ncrec.gov/AgentSearch`,
    'WA': `https://secure.lni.wa.gov/verify/Results.aspx?UBI=&LIC=&SAW=&firstName=${encodeURIComponent(firstName)}&lastName=${encodeURIComponent(lastName)}&Type=RE`,
  };

  const url = stateUrls[state];
  if (!url) return null;

  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const html = await res.text();
    const activeM = html.match(/(Active|Current|Licensed)/i);
    const licM    = html.match(/(?:License|Lic\.?)\s*#?\s*([A-Z0-9]{5,12})/i);
    if (activeM || licM) {
      return {
        fullName: agentName,
        licenseNumber: licM?.[1] || 'Found',
        isActive: !!activeM,
        activeStatus: activeM?.[1] || 'Found',
        source: `${state} State License Board`,
        concerns: []
      };
    }
  } catch (e) {}
  return null;
}

// ── Detect state from listing address ─────────────────────────────────────────
function detectStateFromAddress(address) {
  if (!address) return null;
  // "9936 Golden Lagoon Aly, Winter Garden, FL 34787"
  const stateZipM = address.match(/,\s*([A-Z]{2})\s+\d{5}/);
  if (stateZipM) return stateZipM[1];
  // Try full state name
  const states = {
    'Alabama':'AL','Alaska':'AK','Arizona':'AZ','Arkansas':'AR','California':'CA',
    'Colorado':'CO','Connecticut':'CT','Delaware':'DE','Florida':'FL','Georgia':'GA',
    'Hawaii':'HI','Idaho':'ID','Illinois':'IL','Indiana':'IN','Iowa':'IA','Kansas':'KS',
    'Kentucky':'KY','Louisiana':'LA','Maine':'ME','Maryland':'MD','Massachusetts':'MA',
    'Michigan':'MI','Minnesota':'MN','Mississippi':'MS','Missouri':'MO','Montana':'MT',
    'Nebraska':'NE','Nevada':'NV','New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM',
    'New York':'NY','North Carolina':'NC','North Dakota':'ND','Ohio':'OH','Oklahoma':'OK',
    'Oregon':'OR','Pennsylvania':'PA','Rhode Island':'RI','South Carolina':'SC',
    'South Dakota':'SD','Tennessee':'TN','Texas':'TX','Utah':'UT','Vermont':'VT',
    'Virginia':'VA','Washington':'WA','West Virginia':'WV','Wisconsin':'WI','Wyoming':'WY'
  };
  for (const [name, abbr] of Object.entries(states)) {
    if (address.includes(name)) return abbr;
  }
  return null;
}

// ── Nationwide county effective property tax rates ────────────────────────────
// Source: Tax Foundation "Property Taxes by State and County, 2026" (2024 data).
// Rate = median property taxes paid / median home value, per county.
// Keyed as "ST|county" (county lowercased, "county/parish/borough" stripped).
// This is the EFFECTIVE rate on typical homes. For a NEW purchase we apply the
// full offer price (no haircut) minus homestead exemption — see computeTaxEstimate.
const COUNTY_TAX_RATES = {"AL|autauga":0.0028,"AL|baldwin":0.0029,"AL|barbour":0.0031,"AL|bibb":0.002,"AL|blount":0.0027,"AL|bullock":0.0032,"AL|butler":0.0026,"AL|calhoun":0.0033,"AL|chambers":0.0029,"AL|cherokee":0.0032,"AL|chilton":0.0032,"AL|choctaw":0.0018,"AL|clarke":0.0028,"AL|clay":0.002,"AL|cleburne":0.0024,"AL|coffee":0.003,"AL|colbert":0.003,"AL|conecuh":0.0025,"AL|coosa":0.002,"AL|covington":0.002,"AL|crenshaw":0.0028,"AL|cullman":0.0021,"AL|dale":0.0028,"AL|dallas":0.0036,"AL|dekalb":0.0024,"AL|elmore":0.0025,"AL|escambia":0.0027,"AL|etowah":0.0032,"AL|fayette":0.0021,"AL|franklin":0.0033,"AL|geneva":0.0024,"AL|greene":0.0024,"AL|hale":0.0019,"AL|henry":0.0025,"AL|houston":0.0029,"AL|jackson":0.0025,"AL|jefferson":0.0058,"AL|lamar":0.0024,"AL|lauderdale":0.0032,"AL|lawrence":0.0025,"AL|lee":0.0039,"AL|limestone":0.0032,"AL|lowndes":0.0031,"AL|macon":0.0041,"AL|madison":0.0039,"AL|marengo":0.0031,"AL|marion":0.0024,"AL|marshall":0.003,"AL|mobile":0.0043,"AL|monroe":0.0021,"AL|montgomery":0.0036,"AL|morgan":0.0031,"AL|perry":0.0023,"AL|pickens":0.0021,"AL|pike":0.0024,"AL|randolph":0.0027,"AL|russell":0.0038,"AL|st. clair":0.0028,"AL|shelby":0.0042,"AL|sumter":0.0028,"AL|talladega":0.0029,"AL|tallapoosa":0.0024,"AL|tuscaloosa":0.0031,"AL|walker":0.0023,"AL|washington":0.0023,"AL|wilcox":0.0025,"AL|winston":0.0021,"AK|aleutians west":0.007,"AK|anchorage municipality":0.0117,"AK|bristol bay":0.0044,"AK|chugach":0.0091,"AK|copper river":0.0004,"AK|denali":0.0014,"AK|dillingham":0.0046,"AK|fairbanks north star":0.0111,"AK|haines":0.0069,"AK|hoonah-angoon":0.0003,"AK|juneau":0.0088,"AK|kenai peninsula":0.0054,"AK|ketchikan gateway":0.0066,"AK|kodiak island":0.007,"AK|kusilvak":0.0001,"AK|matanuska-susitna":0.009,"AK|nome":0.0046,"AK|north slope":0.0049,"AK|northwest arctic":0.0,"AK|petersburg":0.0055,"AK|prince of wales-hyder":0.0009,"AK|sitka":0.0037,"AK|skagway municipality":0.0041,"AK|wrangell":0.0045,"AK|yakutat":0.0035,"AK|yukon-koyukuk":0.0006,"AZ|apache":0.0021,"AZ|cochise":0.0061,"AZ|coconino":0.0039,"AZ|gila":0.0055,"AZ|graham":0.0047,"AZ|greenlee":0.0028,"AZ|la paz":0.0047,"AZ|maricopa":0.0044,"AZ|mohave":0.0043,"AZ|navajo":0.0039,"AZ|pima":0.007,"AZ|pinal":0.005,"AZ|santa cruz":0.0062,"AZ|yavapai":0.004,"AZ|yuma":0.0061,"AR|arkansas":0.0056,"AR|ashley":0.0053,"AR|baxter":0.0047,"AR|benton":0.0057,"AR|boone":0.0052,"AR|bradley":0.0053,"AR|calhoun":0.0039,"AR|carroll":0.0052,"AR|chicot":0.0054,"AR|clark":0.0046,"AR|clay":0.0046,"AR|cleburne":0.0047,"AR|cleveland":0.0054,"AR|columbia":0.0046,"AR|conway":0.0054,"AR|craighead":0.0054,"AR|crawford":0.0053,"AR|crittenden":0.0067,"AR|cross":0.0057,"AR|dallas":0.0051,"AR|desha":0.0059,"AR|drew":0.0052,"AR|faulkner":0.0053,"AR|franklin":0.0054,"AR|fulton":0.0045,"AR|garland":0.0048,"AR|grant":0.0052,"AR|greene":0.0046,"AR|hempstead":0.0048,"AR|hot spring":0.0058,"AR|howard":0.0046,"AR|independence":0.0051,"AR|izard":0.0051,"AR|jackson":0.005,"AR|jefferson":0.0063,"AR|johnson":0.0051,"AR|lafayette":0.0039,"AR|lawrence":0.0032,"AR|lee":0.0024,"AR|lincoln":0.0052,"AR|little river":0.0047,"AR|logan":0.0048,"AR|lonoke":0.0057,"AR|madison":0.0032,"AR|marion":0.0049,"AR|miller":0.0057,"AR|mississippi":0.0047,"AR|monroe":0.0014,"AR|montgomery":0.0032,"AR|nevada":0.0045,"AR|newton":0.0046,"AR|ouachita":0.0033,"AR|perry":0.0041,"AR|phillips":0.0076,"AR|pike":0.006,"AR|poinsett":0.0053,"AR|polk":0.0035,"AR|pope":0.0052,"AR|prairie":0.0057,"AR|pulaski":0.0075,"AR|randolph":0.0042,"AR|st. francis":0.0048,"AR|saline":0.0059,"AR|scott":0.0037,"AR|searcy":0.0043,"AR|sebastian":0.0062,"AR|sevier":0.0045,"AR|sharp":0.005,"AR|stone":0.0035,"AR|union":0.0057,"AR|van buren":0.0045,"AR|washington":0.0055,"AR|white":0.0047,"AR|woodruff":0.0048,"AR|yell":0.0038,"CA|alameda":0.0076,"CA|alpine":0.0055,"CA|amador":0.007,"CA|butte":0.0071,"CA|calaveras":0.0071,"CA|colusa":0.0067,"CA|contra costa":0.0078,"CA|del norte":0.0049,"CA|el dorado":0.0072,"CA|fresno":0.0076,"CA|glenn":0.0061,"CA|humboldt":0.0062,"CA|imperial":0.0083,"CA|inyo":0.0059,"CA|kern":0.0089,"CA|kings":0.0075,"CA|lake":0.0072,"CA|lassen":0.008,"CA|los angeles":0.0067,"CA|madera":0.0069,"CA|marin":0.0077,"CA|mariposa":0.0058,"CA|mendocino":0.0067,"CA|merced":0.0067,"CA|modoc":0.0068,"CA|mono":0.007,"CA|monterey":0.0063,"CA|napa":0.006,"CA|nevada":0.0073,"CA|orange":0.0064,"CA|placer":0.0079,"CA|plumas":0.0069,"CA|riverside":0.0083,"CA|sacramento":0.0076,"CA|san benito":0.0079,"CA|san bernardino":0.0073,"CA|san diego":0.0067,"CA|san francisco":0.0072,"CA|san joaquin":0.0079,"CA|san luis obispo":0.0064,"CA|san mateo":0.0063,"CA|santa barbara":0.0059,"CA|santa clara":0.0068,"CA|santa cruz":0.006,"CA|shasta":0.007,"CA|sierra":0.0062,"CA|siskiyou":0.006,"CA|solano":0.0078,"CA|sonoma":0.0065,"CA|stanislaus":0.0073,"CA|sutter":0.0078,"CA|tehama":0.0065,"CA|trinity":0.0026,"CA|tulare":0.0069,"CA|tuolumne":0.0062,"CA|ventura":0.0069,"CA|yolo":0.0079,"CA|yuba":0.0077,"CO|adams":0.0066,"CO|alamosa":0.0045,"CO|arapahoe":0.0055,"CO|archuleta":0.0033,"CO|baca":0.004,"CO|bent":0.0041,"CO|boulder":0.0052,"CO|broomfield":0.0066,"CO|chaffee":0.0029,"CO|cheyenne":0.0041,"CO|clear creek":0.004,"CO|conejos":0.0044,"CO|costilla":0.0031,"CO|crowley":0.0032,"CO|custer":0.0035,"CO|delta":0.0034,"CO|denver":0.0047,"CO|dolores":0.0039,"CO|douglas":0.0057,"CO|eagle":0.0036,"CO|elbert":0.0047,"CO|el paso":0.0045,"CO|fremont":0.0036,"CO|garfield":0.0039,"CO|gilpin":0.0037,"CO|grand":0.003,"CO|gunnison":0.0031,"CO|hinsdale":0.0036,"CO|huerfano":0.0031,"CO|jackson":0.0022,"CO|jefferson":0.0053,"CO|kiowa":0.0063,"CO|kit carson":0.0048,"CO|lake":0.0064,"CO|la plata":0.0027,"CO|larimer":0.0052,"CO|las animas":0.0027,"CO|lincoln":0.0046,"CO|logan":0.0045,"CO|mesa":0.0038,"CO|mineral":0.0033,"CO|moffat":0.0052,"CO|montezuma":0.0029,"CO|montrose":0.0036,"CO|morgan":0.0052,"CO|otero":0.0037,"CO|ouray":0.0024,"CO|park":0.0039,"CO|phillips":0.005,"CO|pitkin":0.0034,"CO|prowers":0.0034,"CO|pueblo":0.0052,"CO|rio blanco":0.0033,"CO|rio grande":0.0044,"CO|routt":0.0028,"CO|saguache":0.0043,"CO|san juan":0.0029,"CO|san miguel":0.0027,"CO|sedgwick":0.0052,"CO|summit":0.0032,"CO|teller":0.0035,"CO|washington":0.0042,"CO|weld":0.0055,"CO|yuma":0.0053,"CT|capitol planning region":0.0191,"CT|greater bridgeport planning region":0.0165,"CT|lower connecticut river valley planning region":0.0151,"CT|naugatuck valley planning region":0.0171,"CT|northeastern connecticut planning region":0.0137,"CT|northwest hills planning region":0.0135,"CT|south central connecticut planning region":0.0182,"CT|southeastern connecticut planning region":0.0156,"CT|western connecticut planning region":0.0117,"DE|kent":0.0043,"DE|new castle":0.0072,"DE|sussex":0.0031,"DC|district of columbia":0.006,"FL|alachua":0.0099,"FL|baker":0.0088,"FL|bay":0.0059,"FL|bradford":0.0054,"FL|brevard":0.0068,"FL|broward":0.0096,"FL|calhoun":0.0059,"FL|charlotte":0.0084,"FL|citrus":0.0063,"FL|clay":0.0077,"FL|collier":0.0059,"FL|columbia":0.0073,"FL|desoto":0.0072,"FL|dixie":0.006,"FL|duval":0.0075,"FL|escambia":0.0063,"FL|flagler":0.0076,"FL|franklin":0.0055,"FL|gadsden":0.0053,"FL|gilchrist":0.0061,"FL|glades":0.0064,"FL|gulf":0.0047,"FL|hamilton":0.0048,"FL|hardee":0.0066,"FL|hendry":0.0086,"FL|hernando":0.0071,"FL|highlands":0.0069,"FL|hillsborough":0.0084,"FL|holmes":0.0044,"FL|indian river":0.0071,"FL|jackson":0.0049,"FL|jefferson":0.0065,"FL|lafayette":0.006,"FL|lake":0.0077,"FL|lee":0.0078,"FL|leon":0.0077,"FL|levy":0.0065,"FL|liberty":0.0061,"FL|madison":0.0064,"FL|manatee":0.0076,"FL|marion":0.0072,"FL|martin":0.0076,"FL|miami-dade":0.0081,"FL|monroe":0.0053,"FL|nassau":0.0073,"FL|okaloosa":0.0059,"FL|okeechobee":0.0073,"FL|orange":0.0082,"FL|osceola":0.0076,"FL|palm beach":0.0082,"FL|pasco":0.0082,"FL|pinellas":0.0074,"FL|polk":0.0073,"FL|putnam":0.0064,"FL|st. johns":0.0075,"FL|st. lucie":0.0095,"FL|santa rosa":0.006,"FL|sarasota":0.0072,"FL|seminole":0.007,"FL|sumter":0.0074,"FL|suwannee":0.0067,"FL|taylor":0.0065,"FL|union":0.0053,"FL|volusia":0.0078,"FL|wakulla":0.0069,"FL|walton":0.0049,"FL|washington":0.0046,"GA|appling":0.0065,"GA|atkinson":0.0078,"GA|bacon":0.0089,"GA|baker":0.008,"GA|baldwin":0.006,"GA|banks":0.006,"GA|barrow":0.008,"GA|bartow":0.0069,"GA|ben hill":0.009,"GA|berrien":0.0074,"GA|bibb":0.0098,"GA|bleckley":0.0096,"GA|brantley":0.0096,"GA|brooks":0.0088,"GA|bryan":0.0077,"GA|bulloch":0.0064,"GA|burke":0.0052,"GA|butts":0.0083,"GA|calhoun":0.0076,"GA|camden":0.0082,"GA|candler":0.0096,"GA|carroll":0.0063,"GA|catoosa":0.0062,"GA|charlton":0.0066,"GA|chatham":0.0081,"GA|chattahoochee":0.0067,"GA|chattooga":0.0071,"GA|cherokee":0.0069,"GA|clarke":0.0086,"GA|clay":0.01,"GA|clayton":0.0085,"GA|clinch":0.0107,"GA|cobb":0.0069,"GA|coffee":0.006,"GA|colquitt":0.0076,"GA|columbia":0.0082,"GA|cook":0.0074,"GA|coweta":0.007,"GA|crawford":0.0084,"GA|crisp":0.0094,"GA|dade":0.0056,"GA|dawson":0.0061,"GA|decatur":0.0094,"GA|dekalb":0.0093,"GA|dodge":0.0073,"GA|dooly":0.0095,"GA|dougherty":0.012,"GA|douglas":0.008,"GA|early":0.0077,"GA|echols":0.008,"GA|effingham":0.0089,"GA|elbert":0.0078,"GA|emanuel":0.0078,"GA|evans":0.0094,"GA|fannin":0.004,"GA|fayette":0.0078,"GA|floyd":0.0092,"GA|forsyth":0.0069,"GA|franklin":0.0065,"GA|fulton":0.0089,"GA|gilmer":0.0041,"GA|glascock":0.0081,"GA|glynn":0.0052,"GA|gordon":0.0066,"GA|grady":0.0092,"GA|greene":0.0055,"GA|gwinnett":0.0093,"GA|habersham":0.0057,"GA|hall":0.0069,"GA|hancock":0.0094,"GA|haralson":0.0069,"GA|harris":0.008,"GA|hart":0.0052,"GA|heard":0.0051,"GA|henry":0.0089,"GA|houston":0.0083,"GA|irwin":0.0076,"GA|jackson":0.0079,"GA|jasper":0.0081,"GA|jeff davis":0.0065,"GA|jefferson":0.0089,"GA|jenkins":0.0082,"GA|johnson":0.0081,"GA|jones":0.0096,"GA|lamar":0.0093,"GA|lanier":0.0087,"GA|laurens":0.0053,"GA|lee":0.0093,"GA|liberty":0.0093,"GA|lincoln":0.008,"GA|long":0.0071,"GA|lowndes":0.0076,"GA|lumpkin":0.0064,"GA|mcduffie":0.0077,"GA|mcintosh":0.0073,"GA|macon":0.0111,"GA|madison":0.0074,"GA|marion":0.0064,"GA|meriwether":0.0081,"GA|miller":0.0115,"GA|mitchell":0.0108,"GA|monroe":0.0073,"GA|montgomery":0.0081,"GA|morgan":0.0072,"GA|murray":0.0043,"GA|muscogee":0.0085,"GA|newton":0.0085,"GA|oconee":0.0067,"GA|oglethorpe":0.0068,"GA|paulding":0.0082,"GA|peach":0.0078,"GA|pickens":0.0058,"GA|pierce":0.0077,"GA|pike":0.0084,"GA|polk":0.0073,"GA|pulaski":0.0091,"GA|putnam":0.0063,"GA|quitman":0.0073,"GA|rabun":0.0049,"GA|randolph":0.0095,"GA|richmond":0.0085,"GA|rockdale":0.0071,"GA|schley":0.0091,"GA|screven":0.0094,"GA|seminole":0.0099,"GA|spalding":0.0089,"GA|stephens":0.0071,"GA|stewart":0.0093,"GA|sumter":0.0104,"GA|talbot":0.0083,"GA|taliaferro":0.008,"GA|tattnall":0.0067,"GA|taylor":0.0075,"GA|telfair":0.007,"GA|terrell":0.0097,"GA|thomas":0.0084,"GA|tift":0.0086,"GA|toombs":0.0082,"GA|towns":0.0035,"GA|treutlen":0.0066,"GA|troup":0.0087,"GA|turner":0.0092,"GA|twiggs":0.0035,"GA|union":0.0045,"GA|upson":0.0081,"GA|walker":0.0086,"GA|walton":0.0072,"GA|ware":0.0085,"GA|warren":0.0078,"GA|washington":0.0085,"GA|wayne":0.0075,"GA|webster":0.0077,"GA|wheeler":0.0084,"GA|white":0.0062,"GA|whitfield":0.0064,"GA|wilcox":0.0094,"GA|wilkes":0.0087,"GA|wilkinson":0.0087,"GA|worth":0.0098,"HI|hawaii":0.0035,"HI|honolulu":0.0031,"HI|kauai":0.0025,"HI|maui":0.0022,"ID|ada":0.0053,"ID|adams":0.0034,"ID|bannock":0.0067,"ID|bear lake":0.0041,"ID|benewah":0.0043,"ID|bingham":0.005,"ID|blaine":0.0038,"ID|boise":0.0038,"ID|bonner":0.004,"ID|bonneville":0.0053,"ID|boundary":0.0033,"ID|butte":0.0053,"ID|camas":0.0035,"ID|canyon":0.005,"ID|caribou":0.0053,"ID|cassia":0.004,"ID|clark":0.0031,"ID|clearwater":0.0051,"ID|custer":0.0042,"ID|elmore":0.006,"ID|franklin":0.0038,"ID|fremont":0.0039,"ID|gem":0.0032,"ID|gooding":0.0043,"ID|idaho":0.0032,"ID|jefferson":0.0047,"ID|jerome":0.0062,"ID|kootenai":0.0041,"ID|latah":0.0059,"ID|lemhi":0.0032,"ID|lewis":0.0055,"ID|lincoln":0.0042,"ID|madison":0.0054,"ID|minidoka":0.0051,"ID|nez perce":0.0075,"ID|oneida":0.0046,"ID|owyhee":0.0039,"ID|payette":0.0045,"ID|power":0.0062,"ID|shoshone":0.0054,"ID|teton":0.0035,"ID|twin falls":0.0061,"ID|valley":0.0034,"ID|washington":0.0047,"IL|adams":0.0152,"IL|alexander":0.0117,"IL|bond":0.0178,"IL|boone":0.0199,"IL|brown":0.0134,"IL|bureau":0.017,"IL|calhoun":0.0108,"IL|carroll":0.0175,"IL|cass":0.0155,"IL|champaign":0.0204,"IL|christian":0.0149,"IL|clark":0.0139,"IL|clay":0.0122,"IL|clinton":0.0164,"IL|coles":0.0172,"IL|cook":0.0173,"IL|crawford":0.0136,"IL|cumberland":0.0126,"IL|dekalb":0.0224,"IL|de witt":0.0165,"IL|douglas":0.0164,"IL|dupage":0.0189,"IL|edgar":0.0133,"IL|edwards":0.0126,"IL|effingham":0.0137,"IL|fayette":0.0127,"IL|ford":0.0183,"IL|franklin":0.0118,"IL|fulton":0.0171,"IL|gallatin":0.0139,"IL|greene":0.0093,"IL|grundy":0.0186,"IL|hamilton":0.0122,"IL|hancock":0.015,"IL|hardin":0.0083,"IL|henderson":0.0142,"IL|henry":0.0186,"IL|iroquois":0.015,"IL|jackson":0.0184,"IL|jasper":0.0156,"IL|jefferson":0.0158,"IL|jersey":0.0158,"IL|jo daviess":0.0149,"IL|johnson":0.0133,"IL|kane":0.0218,"IL|kankakee":0.0204,"IL|kendall":0.0228,"IL|knox":0.0181,"IL|lake":0.0226,"IL|lasalle":0.019,"IL|lawrence":0.009,"IL|lee":0.0177,"IL|livingston":0.0188,"IL|logan":0.0172,"IL|mcdonough":0.0182,"IL|mchenry":0.0226,"IL|mclean":0.0211,"IL|macon":0.0199,"IL|macoupin":0.0139,"IL|madison":0.0179,"IL|marion":0.0154,"IL|marshall":0.017,"IL|mason":0.018,"IL|massac":0.013,"IL|menard":0.0166,"IL|mercer":0.0177,"IL|monroe":0.0146,"IL|montgomery":0.0132,"IL|morgan":0.017,"IL|moultrie":0.0174,"IL|ogle":0.0181,"IL|peoria":0.0215,"IL|perry":0.0142,"IL|piatt":0.0166,"IL|pike":0.0142,"IL|pope":0.0099,"IL|pulaski":0.0103,"IL|putnam":0.0146,"IL|randolph":0.0129,"IL|richland":0.0116,"IL|rock island":0.0213,"IL|st. clair":0.0183,"IL|saline":0.0165,"IL|sangamon":0.0189,"IL|schuyler":0.0155,"IL|scott":0.0135,"IL|shelby":0.0134,"IL|stark":0.0162,"IL|stephenson":0.0209,"IL|tazewell":0.0198,"IL|union":0.0115,"IL|vermilion":0.0162,"IL|wabash":0.013,"IL|warren":0.0128,"IL|washington":0.0158,"IL|wayne":0.0142,"IL|white":0.0101,"IL|whiteside":0.0174,"IL|will":0.021,"IL|williamson":0.0157,"IL|winnebago":0.0228,"IL|woodford":0.019,"IN|adams":0.007,"IN|allen":0.0077,"IN|bartholomew":0.0071,"IN|benton":0.0071,"IN|blackford":0.0075,"IN|boone":0.0083,"IN|brown":0.0045,"IN|carroll":0.0057,"IN|cass":0.0069,"IN|clark":0.0071,"IN|clay":0.0048,"IN|clinton":0.0064,"IN|crawford":0.0063,"IN|daviess":0.0069,"IN|dearborn":0.0072,"IN|decatur":0.0057,"IN|dekalb":0.0061,"IN|delaware":0.0081,"IN|dubois":0.0071,"IN|elkhart":0.0082,"IN|fayette":0.0062,"IN|floyd":0.0066,"IN|fountain":0.0061,"IN|franklin":0.0055,"IN|fulton":0.0059,"IN|gibson":0.006,"IN|grant":0.0067,"IN|greene":0.0062,"IN|hamilton":0.0087,"IN|hancock":0.0068,"IN|harrison":0.0056,"IN|hendricks":0.0081,"IN|henry":0.0067,"IN|howard":0.0067,"IN|huntington":0.0068,"IN|jackson":0.0053,"IN|jasper":0.005,"IN|jay":0.006,"IN|jefferson":0.0064,"IN|jennings":0.0061,"IN|johnson":0.0073,"IN|knox":0.0074,"IN|kosciusko":0.0063,"IN|lagrange":0.0049,"IN|lake":0.0093,"IN|laporte":0.0079,"IN|lawrence":0.0069,"IN|madison":0.0073,"IN|marion":0.0089,"IN|marshall":0.0067,"IN|martin":0.0055,"IN|miami":0.0048,"IN|monroe":0.0074,"IN|montgomery":0.0064,"IN|morgan":0.0051,"IN|newton":0.0079,"IN|noble":0.0066,"IN|ohio":0.0068,"IN|orange":0.0073,"IN|owen":0.0064,"IN|parke":0.0046,"IN|perry":0.0063,"IN|pike":0.0077,"IN|porter":0.0081,"IN|posey":0.0052,"IN|pulaski":0.0056,"IN|putnam":0.0045,"IN|randolph":0.0076,"IN|ripley":0.0058,"IN|rush":0.006,"IN|st. joseph":0.0085,"IN|scott":0.0065,"IN|shelby":0.0067,"IN|spencer":0.006,"IN|starke":0.0065,"IN|steuben":0.0054,"IN|sullivan":0.0062,"IN|switzerland":0.0045,"IN|tippecanoe":0.0067,"IN|tipton":0.0063,"IN|union":0.0071,"IN|vanderburgh":0.0081,"IN|vermillion":0.0079,"IN|vigo":0.0082,"IN|wabash":0.0051,"IN|warren":0.0055,"IN|warrick":0.0068,"IN|washington":0.0059,"IN|wayne":0.0077,"IN|wells":0.0049,"IN|white":0.0056,"IN|whitley":0.0072,"IA|adair":0.0115,"IA|adams":0.0095,"IA|allamakee":0.0094,"IA|appanoose":0.0115,"IA|audubon":0.0086,"IA|benton":0.0123,"IA|black hawk":0.0133,"IA|boone":0.0129,"IA|bremer":0.0123,"IA|buchanan":0.0122,"IA|buena vista":0.0136,"IA|butler":0.0125,"IA|calhoun":0.0111,"IA|carroll":0.0122,"IA|cass":0.014,"IA|cedar":0.0108,"IA|cerro gordo":0.0127,"IA|cherokee":0.0096,"IA|chickasaw":0.01,"IA|clarke":0.0123,"IA|clay":0.0093,"IA|clayton":0.0098,"IA|clinton":0.0134,"IA|crawford":0.0128,"IA|dallas":0.0137,"IA|davis":0.0151,"IA|decatur":0.0133,"IA|delaware":0.0116,"IA|des moines":0.0136,"IA|dickinson":0.0078,"IA|dubuque":0.0115,"IA|emmet":0.0118,"IA|fayette":0.0129,"IA|floyd":0.0115,"IA|franklin":0.012,"IA|fremont":0.0101,"IA|greene":0.0123,"IA|grundy":0.0118,"IA|guthrie":0.0116,"IA|hamilton":0.0117,"IA|hancock":0.0118,"IA|hardin":0.0125,"IA|harrison":0.0119,"IA|henry":0.0143,"IA|howard":0.0117,"IA|humboldt":0.0134,"IA|ida":0.0095,"IA|iowa":0.0119,"IA|jackson":0.0094,"IA|jasper":0.0124,"IA|jefferson":0.0135,"IA|johnson":0.014,"IA|jones":0.0116,"IA|keokuk":0.0113,"IA|kossuth":0.0106,"IA|lee":0.0128,"IA|linn":0.0147,"IA|louisa":0.0108,"IA|lucas":0.01,"IA|lyon":0.0086,"IA|madison":0.0125,"IA|mahaska":0.0126,"IA|marion":0.0117,"IA|marshall":0.0129,"IA|mills":0.0113,"IA|mitchell":0.0099,"IA|monona":0.0106,"IA|monroe":0.0139,"IA|montgomery":0.0133,"IA|muscatine":0.0132,"IA|o'brien":0.0103,"IA|osceola":0.0095,"IA|page":0.012,"IA|palo alto":0.0106,"IA|plymouth":0.0099,"IA|pocahontas":0.0106,"IA|polk":0.0157,"IA|pottawattamie":0.0132,"IA|poweshiek":0.0111,"IA|ringgold":0.0115,"IA|sac":0.0093,"IA|scott":0.0144,"IA|shelby":0.0119,"IA|sioux":0.0108,"IA|story":0.0136,"IA|tama":0.012,"IA|taylor":0.0114,"IA|union":0.0148,"IA|van buren":0.0078,"IA|wapello":0.0137,"IA|warren":0.0139,"IA|washington":0.012,"IA|wayne":0.0114,"IA|webster":0.0139,"IA|winnebago":0.0135,"IA|winneshiek":0.0099,"IA|woodbury":0.0139,"IA|worth":0.0091,"IA|wright":0.0128,"KS|allen":0.013,"KS|anderson":0.0137,"KS|atchison":0.0131,"KS|barber":0.0136,"KS|barton":0.0157,"KS|bourbon":0.0135,"KS|brown":0.0106,"KS|butler":0.0147,"KS|chase":0.0126,"KS|chautauqua":0.01,"KS|cherokee":0.0106,"KS|cheyenne":0.0135,"KS|clark":0.0105,"KS|clay":0.0132,"KS|cloud":0.015,"KS|coffey":0.0091,"KS|comanche":0.0193,"KS|cowley":0.0115,"KS|crawford":0.0106,"KS|decatur":0.0151,"KS|dickinson":0.0138,"KS|doniphan":0.0091,"KS|douglas":0.0119,"KS|edwards":0.0118,"KS|elk":0.0166,"KS|ellis":0.0112,"KS|ellsworth":0.0146,"KS|finney":0.0136,"KS|ford":0.0134,"KS|franklin":0.0131,"KS|geary":0.0147,"KS|gove":0.0127,"KS|graham":0.0147,"KS|grant":0.0121,"KS|gray":0.0135,"KS|greeley":0.0179,"KS|greenwood":0.0122,"KS|hamilton":0.0158,"KS|harper":0.0156,"KS|harvey":0.014,"KS|haskell":0.0135,"KS|hodgeman":0.0135,"KS|jackson":0.011,"KS|jefferson":0.0111,"KS|jewell":0.0121,"KS|johnson":0.0112,"KS|kearny":0.0114,"KS|kingman":0.0138,"KS|kiowa":0.0121,"KS|labette":0.014,"KS|lane":0.0137,"KS|leavenworth":0.0103,"KS|lincoln":0.0154,"KS|linn":0.01,"KS|logan":0.0169,"KS|lyon":0.0136,"KS|mcpherson":0.0133,"KS|marion":0.0145,"KS|marshall":0.0114,"KS|meade":0.0112,"KS|miami":0.0119,"KS|mitchell":0.0149,"KS|montgomery":0.0156,"KS|morris":0.0144,"KS|morton":0.0184,"KS|nemaha":0.0091,"KS|neosho":0.0141,"KS|ness":0.0155,"KS|norton":0.011,"KS|osage":0.0132,"KS|osborne":0.0134,"KS|ottawa":0.0134,"KS|pawnee":0.0169,"KS|phillips":0.0119,"KS|pottawatomie":0.01,"KS|pratt":0.0155,"KS|rawlins":0.0143,"KS|reno":0.0148,"KS|republic":0.0143,"KS|rice":0.0135,"KS|riley":0.0141,"KS|rooks":0.0154,"KS|rush":0.0133,"KS|russell":0.0156,"KS|saline":0.0134,"KS|scott":0.0157,"KS|sedgwick":0.0118,"KS|seward":0.0156,"KS|shawnee":0.0134,"KS|sheridan":0.0121,"KS|sherman":0.0145,"KS|smith":0.0171,"KS|stafford":0.0126,"KS|stanton":0.0191,"KS|stevens":0.0178,"KS|sumner":0.0136,"KS|thomas":0.0134,"KS|trego":0.0139,"KS|wabaunsee":0.0106,"KS|wallace":0.0138,"KS|washington":0.009,"KS|wichita":0.0135,"KS|wilson":0.0127,"KS|woodson":0.0136,"KS|wyandotte":0.0139,"KY|adair":0.0056,"KY|allen":0.0057,"KY|anderson":0.0072,"KY|ballard":0.0066,"KY|barren":0.0059,"KY|bath":0.0056,"KY|bell":0.0057,"KY|boone":0.0084,"KY|bourbon":0.0057,"KY|boyd":0.0079,"KY|boyle":0.0076,"KY|bracken":0.0073,"KY|breathitt":0.0066,"KY|breckinridge":0.0054,"KY|bullitt":0.0084,"KY|butler":0.005,"KY|caldwell":0.0052,"KY|calloway":0.0061,"KY|campbell":0.0106,"KY|carlisle":0.0051,"KY|carroll":0.0062,"KY|carter":0.0045,"KY|casey":0.0054,"KY|christian":0.0059,"KY|clark":0.0075,"KY|clay":0.0049,"KY|clinton":0.0042,"KY|crittenden":0.0047,"KY|cumberland":0.0051,"KY|daviess":0.0081,"KY|edmonson":0.0051,"KY|elliott":0.005,"KY|estill":0.0063,"KY|fayette":0.0084,"KY|fleming":0.0057,"KY|floyd":0.0067,"KY|franklin":0.0073,"KY|fulton":0.0064,"KY|gallatin":0.0071,"KY|garrard":0.0059,"KY|grant":0.0066,"KY|graves":0.0058,"KY|grayson":0.005,"KY|green":0.0017,"KY|greenup":0.0094,"KY|hancock":0.0066,"KY|hardin":0.0063,"KY|harlan":0.0074,"KY|harrison":0.005,"KY|hart":0.0068,"KY|henderson":0.0086,"KY|henry":0.0073,"KY|hickman":0.0055,"KY|hopkins":0.0073,"KY|jackson":0.0047,"KY|jefferson":0.0085,"KY|jessamine":0.0073,"KY|johnson":0.0057,"KY|kenton":0.0096,"KY|knott":0.0051,"KY|knox":0.0054,"KY|larue":0.0058,"KY|laurel":0.0049,"KY|lawrence":0.0061,"KY|lee":0.0076,"KY|leslie":0.0067,"KY|letcher":0.0067,"KY|lewis":0.005,"KY|lincoln":0.0064,"KY|livingston":0.0054,"KY|logan":0.0065,"KY|lyon":0.0057,"KY|mccracken":0.0079,"KY|mccreary":0.0047,"KY|mclean":0.0066,"KY|madison":0.0071,"KY|magoffin":0.004,"KY|marion":0.006,"KY|marshall":0.0067,"KY|martin":0.0056,"KY|mason":0.0064,"KY|meade":0.0066,"KY|menifee":0.0045,"KY|mercer":0.0072,"KY|metcalfe":0.0051,"KY|monroe":0.0056,"KY|montgomery":0.0075,"KY|morgan":0.0054,"KY|muhlenberg":0.0059,"KY|nelson":0.0074,"KY|nicholas":0.0051,"KY|ohio":0.0058,"KY|oldham":0.0092,"KY|owen":0.0064,"KY|owsley":0.0058,"KY|pendleton":0.0065,"KY|perry":0.006,"KY|pike":0.0064,"KY|powell":0.005,"KY|pulaski":0.005,"KY|robertson":0.0039,"KY|rockcastle":0.0049,"KY|rowan":0.0056,"KY|russell":0.005,"KY|scott":0.0062,"KY|shelby":0.0073,"KY|simpson":0.0061,"KY|spencer":0.0065,"KY|taylor":0.0061,"KY|todd":0.0055,"KY|trigg":0.0063,"KY|trimble":0.0056,"KY|union":0.008,"KY|warren":0.0062,"KY|washington":0.0058,"KY|wayne":0.005,"KY|webster":0.0068,"KY|whitley":0.0057,"KY|wolfe":0.0037,"KY|woodford":0.0067,"LA|acadia":0.0036,"LA|allen":0.0034,"LA|ascension":0.0051,"LA|assumption":0.0037,"LA|avoyelles":0.0022,"LA|beauregard":0.0021,"LA|bienville":0.0024,"LA|bossier":0.0066,"LA|caddo":0.0068,"LA|calcasieu":0.0047,"LA|caldwell":0.0029,"LA|cameron":0.0043,"LA|catahoula":0.0025,"LA|claiborne":0.0026,"LA|concordia":0.0031,"LA|de soto":0.0031,"LA|east baton rouge":0.0063,"LA|east carroll":0.0032,"LA|east feliciana":0.002,"LA|evangeline":0.0031,"LA|franklin":0.0025,"LA|grant":0.0033,"LA|iberia":0.0036,"LA|iberville":0.0035,"LA|jackson":0.0024,"LA|jefferson":0.0057,"LA|jefferson davis":0.0045,"LA|lafayette":0.0057,"LA|lafourche":0.0042,"LA|lasalle":0.0028,"LA|lincoln":0.0046,"LA|livingston":0.0044,"LA|madison":0.0031,"LA|morehouse":0.0049,"LA|natchitoches":0.004,"LA|orleans":0.0085,"LA|ouachita":0.0052,"LA|plaquemines":0.0043,"LA|pointe coupee":0.0032,"LA|rapides":0.0048,"LA|red river":0.0021,"LA|richland":0.0023,"LA|sabine":0.0025,"LA|st. bernard":0.0034,"LA|st. charles":0.0054,"LA|st. helena":0.0013,"LA|st. james":0.0047,"LA|st. john the baptist":0.0042,"LA|st. landry":0.0025,"LA|st. martin":0.0035,"LA|st. mary":0.0038,"LA|st. tammany":0.0071,"LA|tangipahoa":0.0034,"LA|tensas":0.0033,"LA|terrebonne":0.004,"LA|union":0.0032,"LA|vermilion":0.0033,"LA|vernon":0.0027,"LA|washington":0.0027,"LA|webster":0.0029,"LA|west baton rouge":0.0047,"LA|west carroll":0.0013,"LA|west feliciana":0.0043,"LA|winn":0.0019,"ME|androscoggin":0.0119,"ME|aroostook":0.0106,"ME|cumberland":0.0101,"ME|franklin":0.0099,"ME|hancock":0.0084,"ME|kennebec":0.0104,"ME|knox":0.0108,"ME|lincoln":0.0085,"ME|oxford":0.0087,"ME|penobscot":0.0111,"ME|piscataquis":0.0078,"ME|sagadahoc":0.0099,"ME|somerset":0.0099,"ME|waldo":0.01,"ME|washington":0.0093,"ME|york":0.0089,"MD|allegany":0.0094,"MD|anne arundel":0.008,"MD|baltimore":0.0096,"MD|calvert":0.0083,"MD|caroline":0.0075,"MD|carroll":0.0087,"MD|cecil":0.0086,"MD|charles":0.0097,"MD|dorchester":0.0084,"MD|frederick":0.0094,"MD|garrett":0.0072,"MD|harford":0.0083,"MD|howard":0.0111,"MD|kent":0.0092,"MD|montgomery":0.0085,"MD|prince george's":0.0106,"MD|queen anne's":0.0074,"MD|st. mary's":0.0077,"MD|somerset":0.007,"MD|talbot":0.0056,"MD|washington":0.0081,"MD|wicomico":0.0077,"MD|worcester":0.0073,"MD|baltimore city":0.0137,"MA|barnstable":0.0065,"MA|berkshire":0.0113,"MA|bristol":0.0103,"MA|dukes":0.0046,"MA|essex":0.0102,"MA|franklin":0.0132,"MA|hampden":0.0141,"MA|hampshire":0.0136,"MA|middlesex":0.0101,"MA|nantucket":0.0027,"MA|norfolk":0.0102,"MA|plymouth":0.0106,"MA|suffolk":0.0069,"MA|worcester":0.0125,"MI|alcona":0.0081,"MI|alger":0.0089,"MI|allegan":0.01,"MI|alpena":0.0101,"MI|antrim":0.008,"MI|arenac":0.01,"MI|baraga":0.0086,"MI|barry":0.0096,"MI|bay":0.0131,"MI|benzie":0.0077,"MI|berrien":0.0102,"MI|branch":0.0101,"MI|calhoun":0.0134,"MI|cass":0.0093,"MI|charlevoix":0.0084,"MI|cheboygan":0.0087,"MI|chippewa":0.0112,"MI|clare":0.0099,"MI|clinton":0.0119,"MI|crawford":0.01,"MI|delta":0.0106,"MI|dickinson":0.0115,"MI|eaton":0.0134,"MI|emmet":0.0082,"MI|genesee":0.0125,"MI|gladwin":0.0101,"MI|gogebic":0.0122,"MI|grand traverse":0.0084,"MI|gratiot":0.011,"MI|hillsdale":0.0091,"MI|houghton":0.0113,"MI|huron":0.0107,"MI|ingham":0.0176,"MI|ionia":0.01,"MI|iosco":0.0088,"MI|iron":0.0105,"MI|isabella":0.0117,"MI|jackson":0.0111,"MI|kalamazoo":0.0135,"MI|kalkaska":0.0088,"MI|kent":0.0105,"MI|keweenaw":0.01,"MI|lake":0.0081,"MI|lapeer":0.0081,"MI|leelanau":0.0066,"MI|lenawee":0.0115,"MI|livingston":0.0095,"MI|luce":0.0077,"MI|mackinac":0.0086,"MI|macomb":0.0123,"MI|manistee":0.0091,"MI|marquette":0.0099,"MI|mason":0.0098,"MI|mecosta":0.0093,"MI|menominee":0.0093,"MI|midland":0.0139,"MI|missaukee":0.0083,"MI|monroe":0.0104,"MI|montcalm":0.0099,"MI|montmorency":0.0084,"MI|muskegon":0.011,"MI|newaygo":0.0098,"MI|oakland":0.0125,"MI|oceana":0.0082,"MI|ogemaw":0.0091,"MI|ontonagon":0.0113,"MI|osceola":0.0091,"MI|oscoda":0.0079,"MI|otsego":0.0077,"MI|ottawa":0.0103,"MI|presque isle":0.0085,"MI|roscommon":0.0089,"MI|saginaw":0.0134,"MI|st. clair":0.0104,"MI|st. joseph":0.0101,"MI|sanilac":0.008,"MI|schoolcraft":0.0089,"MI|shiawassee":0.0112,"MI|tuscola":0.0109,"MI|van buren":0.0111,"MI|washtenaw":0.0146,"MI|wayne":0.0147,"MI|wexford":0.0106,"MN|aitkin":0.0058,"MN|anoka":0.0094,"MN|becker":0.007,"MN|beltrami":0.008,"MN|benton":0.0092,"MN|big stone":0.0087,"MN|blue earth":0.0096,"MN|brown":0.01,"MN|carlton":0.0108,"MN|carver":0.0096,"MN|cass":0.0056,"MN|chippewa":0.0103,"MN|chisago":0.0102,"MN|clay":0.0111,"MN|clearwater":0.0069,"MN|cook":0.0069,"MN|cottonwood":0.0105,"MN|crow wing":0.0072,"MN|dakota":0.0096,"MN|dodge":0.0101,"MN|douglas":0.0084,"MN|faribault":0.009,"MN|fillmore":0.0081,"MN|freeborn":0.0108,"MN|goodhue":0.0098,"MN|grant":0.0086,"MN|hennepin":0.011,"MN|houston":0.0103,"MN|hubbard":0.0074,"MN|isanti":0.0097,"MN|itasca":0.0086,"MN|jackson":0.0084,"MN|kanabec":0.0108,"MN|kandiyohi":0.0091,"MN|kittson":0.0081,"MN|koochiching":0.0079,"MN|lac qui parle":0.009,"MN|lake":0.0061,"MN|lake of the woods":0.0082,"MN|le sueur":0.0098,"MN|lincoln":0.009,"MN|lyon":0.0098,"MN|mcleod":0.0109,"MN|mahnomen":0.0087,"MN|marshall":0.0082,"MN|martin":0.01,"MN|meeker":0.0083,"MN|mille lacs":0.0096,"MN|morrison":0.0081,"MN|mower":0.0098,"MN|murray":0.0075,"MN|nicollet":0.0104,"MN|nobles":0.0086,"MN|norman":0.0091,"MN|olmsted":0.0101,"MN|otter tail":0.0073,"MN|pennington":0.0108,"MN|pine":0.0083,"MN|pipestone":0.0083,"MN|polk":0.0101,"MN|pope":0.0069,"MN|ramsey":0.0119,"MN|red lake":0.0101,"MN|redwood":0.0082,"MN|renville":0.0101,"MN|rice":0.0101,"MN|rock":0.0073,"MN|roseau":0.0094,"MN|st. louis":0.0102,"MN|scott":0.0095,"MN|sherburne":0.0095,"MN|sibley":0.0095,"MN|stearns":0.0091,"MN|steele":0.0116,"MN|stevens":0.0082,"MN|swift":0.008,"MN|todd":0.0095,"MN|traverse":0.0092,"MN|wabasha":0.0095,"MN|wadena":0.0101,"MN|waseca":0.0113,"MN|washington":0.0094,"MN|watonwan":0.0102,"MN|wilkin":0.0091,"MN|winona":0.0086,"MN|wright":0.0095,"MN|yellow medicine":0.0096,"MS|adams":0.0051,"MS|alcorn":0.0046,"MS|amite":0.0033,"MS|attala":0.0054,"MS|benton":0.0039,"MS|bolivar":0.0055,"MS|calhoun":0.0055,"MS|carroll":0.0051,"MS|chickasaw":0.0042,"MS|choctaw":0.004,"MS|claiborne":0.0031,"MS|clarke":0.0041,"MS|clay":0.0057,"MS|coahoma":0.0075,"MS|copiah":0.0042,"MS|covington":0.0041,"MS|desoto":0.0053,"MS|forrest":0.007,"MS|franklin":0.0054,"MS|george":0.0053,"MS|greene":0.0052,"MS|grenada":0.0075,"MS|hancock":0.0066,"MS|harrison":0.0059,"MS|hinds":0.0072,"MS|holmes":0.0051,"MS|humphreys":0.0074,"MS|issaquena":0.0032,"MS|itawamba":0.0042,"MS|jackson":0.0067,"MS|jasper":0.0041,"MS|jefferson":0.0062,"MS|jefferson davis":0.0053,"MS|jones":0.007,"MS|kemper":0.0049,"MS|lafayette":0.0052,"MS|lamar":0.0063,"MS|lauderdale":0.0065,"MS|lawrence":0.0061,"MS|leake":0.0058,"MS|lee":0.007,"MS|leflore":0.0077,"MS|lincoln":0.0057,"MS|lowndes":0.0054,"MS|madison":0.0062,"MS|marion":0.0057,"MS|marshall":0.006,"MS|monroe":0.0048,"MS|montgomery":0.0081,"MS|neshoba":0.0053,"MS|newton":0.0049,"MS|noxubee":0.0039,"MS|oktibbeha":0.0069,"MS|panola":0.0056,"MS|pearl river":0.0058,"MS|perry":0.0044,"MS|pike":0.006,"MS|pontotoc":0.005,"MS|prentiss":0.0048,"MS|quitman":0.0072,"MS|rankin":0.0058,"MS|scott":0.0051,"MS|sharkey":0.0072,"MS|simpson":0.0044,"MS|smith":0.0038,"MS|stone":0.0049,"MS|sunflower":0.0065,"MS|tallahatchie":0.0045,"MS|tate":0.0063,"MS|tippah":0.0056,"MS|tishomingo":0.0034,"MS|tunica":0.0045,"MS|union":0.0042,"MS|walthall":0.0049,"MS|warren":0.0047,"MS|washington":0.0092,"MS|wayne":0.0047,"MS|webster":0.0044,"MS|wilkinson":0.0062,"MS|winston":0.0049,"MS|yalobusha":0.0047,"MS|yazoo":0.0053,"MO|adair":0.0067,"MO|andrew":0.0069,"MO|atchison":0.0106,"MO|audrain":0.0072,"MO|barry":0.0046,"MO|barton":0.0059,"MO|bates":0.0056,"MO|benton":0.0047,"MO|bollinger":0.0048,"MO|boone":0.0082,"MO|buchanan":0.0074,"MO|butler":0.0064,"MO|caldwell":0.0064,"MO|callaway":0.0066,"MO|camden":0.0046,"MO|cape girardeau":0.0063,"MO|carroll":0.0069,"MO|carter":0.0044,"MO|cass":0.0083,"MO|cedar":0.0059,"MO|chariton":0.0069,"MO|christian":0.0069,"MO|clark":0.0066,"MO|clay":0.0106,"MO|clinton":0.0072,"MO|cole":0.0073,"MO|cooper":0.0063,"MO|crawford":0.0051,"MO|dade":0.0057,"MO|dallas":0.0042,"MO|daviess":0.0049,"MO|dekalb":0.0059,"MO|dent":0.0035,"MO|douglas":0.0038,"MO|dunklin":0.0071,"MO|franklin":0.0073,"MO|gasconade":0.0063,"MO|gentry":0.0074,"MO|greene":0.0072,"MO|grundy":0.0077,"MO|harrison":0.008,"MO|henry":0.0062,"MO|hickory":0.004,"MO|holt":0.0079,"MO|howard":0.0053,"MO|howell":0.0044,"MO|iron":0.0049,"MO|jackson":0.0113,"MO|jasper":0.0068,"MO|jefferson":0.008,"MO|johnson":0.0069,"MO|knox":0.0065,"MO|laclede":0.0054,"MO|lafayette":0.0069,"MO|lawrence":0.0049,"MO|lewis":0.0064,"MO|lincoln":0.0069,"MO|linn":0.007,"MO|livingston":0.0075,"MO|mcdonald":0.0035,"MO|macon":0.0065,"MO|madison":0.0064,"MO|maries":0.0045,"MO|marion":0.0075,"MO|mercer":0.0069,"MO|miller":0.0055,"MO|mississippi":0.0077,"MO|moniteau":0.0061,"MO|monroe":0.0074,"MO|montgomery":0.0058,"MO|morgan":0.0048,"MO|new madrid":0.0067,"MO|newton":0.0062,"MO|nodaway":0.0078,"MO|oregon":0.0049,"MO|osage":0.0051,"MO|ozark":0.0043,"MO|pemiscot":0.0079,"MO|perry":0.0057,"MO|pettis":0.0065,"MO|phelps":0.0063,"MO|pike":0.0061,"MO|platte":0.0104,"MO|polk":0.0052,"MO|pulaski":0.006,"MO|putnam":0.0086,"MO|ralls":0.0064,"MO|randolph":0.0081,"MO|ray":0.0072,"MO|reynolds":0.0042,"MO|ripley":0.0048,"MO|st. charles":0.0106,"MO|st. clair":0.0051,"MO|ste. genevieve":0.0066,"MO|st. francois":0.0063,"MO|st. louis":0.0114,"MO|saline":0.0066,"MO|schuyler":0.0072,"MO|scotland":0.0065,"MO|scott":0.0058,"MO|shannon":0.0036,"MO|shelby":0.0081,"MO|stoddard":0.0067,"MO|stone":0.0044,"MO|sullivan":0.0056,"MO|taney":0.0054,"MO|texas":0.0044,"MO|vernon":0.0064,"MO|warren":0.0059,"MO|washington":0.0052,"MO|wayne":0.0054,"MO|webster":0.0049,"MO|worth":0.0088,"MO|wright":0.0034,"MO|st. louis city":0.0103,"MT|beaverhead":0.0051,"MT|big horn":0.0056,"MT|blaine":0.0068,"MT|broadwater":0.005,"MT|carbon":0.0042,"MT|carter":0.002,"MT|cascade":0.0077,"MT|chouteau":0.0064,"MT|custer":0.008,"MT|daniels":0.0104,"MT|dawson":0.01,"MT|deer lodge":0.0066,"MT|fallon":0.0043,"MT|fergus":0.0077,"MT|flathead":0.0054,"MT|gallatin":0.0055,"MT|garfield":0.0056,"MT|glacier":0.0049,"MT|golden valley":0.0036,"MT|granite":0.0042,"MT|hill":0.009,"MT|jefferson":0.0051,"MT|judith basin":0.005,"MT|lake":0.0048,"MT|lewis and clark":0.0073,"MT|liberty":0.0126,"MT|lincoln":0.005,"MT|mccone":0.0074,"MT|madison":0.0034,"MT|meagher":0.0042,"MT|mineral":0.005,"MT|missoula":0.0078,"MT|musselshell":0.0051,"MT|park":0.0038,"MT|petroleum":0.0057,"MT|phillips":0.0054,"MT|pondera":0.0073,"MT|powder river":0.0032,"MT|powell":0.0053,"MT|prairie":0.0049,"MT|ravalli":0.0041,"MT|richland":0.0072,"MT|roosevelt":0.0067,"MT|rosebud":0.0051,"MT|sanders":0.0046,"MT|sheridan":0.0101,"MT|silver bow":0.0084,"MT|stillwater":0.0055,"MT|sweet grass":0.0036,"MT|teton":0.0072,"MT|toole":0.0066,"MT|treasure":0.0048,"MT|valley":0.0092,"MT|wheatland":0.0048,"MT|wibaux":0.0059,"MT|yellowstone":0.0074,"NE|adams":0.0137,"NE|antelope":0.011,"NE|arthur":0.0117,"NE|banner":0.0111,"NE|blaine":0.0094,"NE|boone":0.0103,"NE|box butte":0.0137,"NE|boyd":0.0116,"NE|brown":0.0096,"NE|buffalo":0.0138,"NE|burt":0.0113,"NE|butler":0.0112,"NE|cass":0.0129,"NE|cedar":0.0103,"NE|chase":0.0102,"NE|cherry":0.0095,"NE|cheyenne":0.0154,"NE|clay":0.0118,"NE|colfax":0.0113,"NE|cuming":0.0113,"NE|custer":0.0103,"NE|dakota":0.0125,"NE|dawes":0.0121,"NE|dawson":0.0113,"NE|deuel":0.0133,"NE|dixon":0.0107,"NE|dodge":0.0132,"NE|douglas":0.0162,"NE|dundy":0.009,"NE|fillmore":0.012,"NE|franklin":0.0082,"NE|frontier":0.0141,"NE|furnas":0.0113,"NE|gage":0.0126,"NE|garden":0.0087,"NE|garfield":0.0111,"NE|gosper":0.0089,"NE|grant":0.0074,"NE|greeley":0.011,"NE|hall":0.0127,"NE|hamilton":0.0096,"NE|harlan":0.0104,"NE|hayes":0.0192,"NE|hitchcock":0.0111,"NE|holt":0.0106,"NE|hooker":0.009,"NE|howard":0.0106,"NE|jefferson":0.0132,"NE|johnson":0.0078,"NE|kearney":0.0097,"NE|keith":0.0119,"NE|keya paha":0.0114,"NE|kimball":0.0128,"NE|knox":0.0107,"NE|lancaster":0.0143,"NE|lincoln":0.0142,"NE|logan":0.0045,"NE|loup":0.0084,"NE|mcpherson":0.0077,"NE|madison":0.0132,"NE|merrick":0.0102,"NE|morrill":0.0108,"NE|nance":0.0119,"NE|nemaha":0.0127,"NE|nuckolls":0.0083,"NE|otoe":0.0129,"NE|pawnee":0.0129,"NE|perkins":0.0095,"NE|phelps":0.0126,"NE|pierce":0.0122,"NE|platte":0.0126,"NE|polk":0.0093,"NE|red willow":0.0116,"NE|richardson":0.0109,"NE|rock":0.0054,"NE|saline":0.0122,"NE|sarpy":0.0172,"NE|saunders":0.0121,"NE|scotts bluff":0.0139,"NE|seward":0.0118,"NE|sheridan":0.0114,"NE|sherman":0.0118,"NE|sioux":0.0078,"NE|stanton":0.0119,"NE|thayer":0.0095,"NE|thomas":0.0079,"NE|thurston":0.0112,"NE|valley":0.0105,"NE|washington":0.0137,"NE|wayne":0.012,"NE|webster":0.0132,"NE|wheeler":0.0098,"NE|york":0.011,"NV|churchill":0.0052,"NV|clark":0.0052,"NV|douglas":0.0045,"NV|elko":0.0056,"NV|esmeralda":0.0052,"NV|eureka":0.0034,"NV|humboldt":0.0056,"NV|lander":0.0073,"NV|lincoln":0.0054,"NV|lyon":0.005,"NV|mineral":0.0073,"NV|nye":0.0051,"NV|pershing":0.0068,"NV|storey":0.0042,"NV|washoe":0.0046,"NV|white pine":0.0055,"NV|carson city":0.0046,"NH|belknap":0.0121,"NH|carroll":0.0087,"NH|cheshire":0.0187,"NH|coos":0.0164,"NH|grafton":0.0152,"NH|hillsborough":0.0162,"NH|merrimack":0.018,"NH|rockingham":0.0134,"NH|strafford":0.0176,"NH|sullivan":0.0177,"NJ|atlantic":0.0186,"NJ|bergen":0.0189,"NJ|burlington":0.0207,"NJ|camden":0.0247,"NJ|cape may":0.0093,"NJ|cumberland":0.0202,"NJ|essex":0.021,"NJ|gloucester":0.024,"NJ|hudson":0.0156,"NJ|hunterdon":0.0204,"NJ|mercer":0.0215,"NJ|middlesex":0.0199,"NJ|monmouth":0.0153,"NJ|morris":0.0184,"NJ|ocean":0.0142,"NJ|passaic":0.0226,"NJ|salem":0.0219,"NJ|somerset":0.0184,"NJ|sussex":0.022,"NJ|union":0.0203,"NJ|warren":0.0226,"NM|bernalillo":0.0085,"NM|catron":0.0027,"NM|chaves":0.0061,"NM|cibola":0.0047,"NM|colfax":0.0051,"NM|curry":0.0064,"NM|de baca":0.0055,"NM|do\u00f1a ana":0.0064,"NM|eddy":0.0045,"NM|grant":0.0038,"NM|guadalupe":0.0055,"NM|harding":0.0027,"NM|hidalgo":0.0048,"NM|lea":0.0052,"NM|lincoln":0.0054,"NM|los alamos":0.0056,"NM|luna":0.0055,"NM|mckinley":0.0035,"NM|mora":0.005,"NM|otero":0.0056,"NM|quay":0.0054,"NM|rio arriba":0.0022,"NM|roosevelt":0.006,"NM|sandoval":0.0066,"NM|san juan":0.0052,"NM|san miguel":0.0047,"NM|santa fe":0.0045,"NM|sierra":0.0057,"NM|socorro":0.0058,"NM|taos":0.0034,"NM|torrance":0.0045,"NM|union":0.003,"NM|valencia":0.0057,"NY|albany":0.017,"NY|allegany":0.0237,"NY|bronx":0.0078,"NY|broome":0.0221,"NY|cattaraugus":0.0192,"NY|cayuga":0.0182,"NY|chautauqua":0.0199,"NY|chemung":0.02,"NY|chenango":0.0205,"NY|clinton":0.0179,"NY|columbia":0.0121,"NY|cortland":0.022,"NY|delaware":0.0139,"NY|dutchess":0.0172,"NY|erie":0.0172,"NY|essex":0.0135,"NY|franklin":0.0145,"NY|fulton":0.0162,"NY|genesee":0.0198,"NY|greene":0.0139,"NY|hamilton":0.0093,"NY|herkimer":0.0166,"NY|jefferson":0.0132,"NY|kings":0.0056,"NY|lewis":0.0139,"NY|livingston":0.0194,"NY|madison":0.0198,"NY|monroe":0.0241,"NY|montgomery":0.0215,"NY|nassau":0.0172,"NY|new york":0.0071,"NY|niagara":0.0173,"NY|oneida":0.0173,"NY|onondaga":0.0222,"NY|ontario":0.0189,"NY|orange":0.0202,"NY|orleans":0.0223,"NY|oswego":0.0195,"NY|otsego":0.0154,"NY|putnam":0.0212,"NY|queens":0.0075,"NY|rensselaer":0.0193,"NY|richmond":0.0088,"NY|rockland":0.0206,"NY|st. lawrence":0.0193,"NY|saratoga":0.0127,"NY|schenectady":0.0212,"NY|schoharie":0.0188,"NY|schuyler":0.0168,"NY|seneca":0.0189,"NY|steuben":0.0212,"NY|suffolk":0.0162,"NY|sullivan":0.0181,"NY|tioga":0.0206,"NY|tompkins":0.0211,"NY|ulster":0.0162,"NY|warren":0.0128,"NY|washington":0.0173,"NY|wayne":0.022,"NY|westchester":0.0184,"NY|wyoming":0.0189,"NY|yates":0.0142,"NC|alamance":0.0066,"NC|alexander":0.0059,"NC|alleghany":0.0057,"NC|anson":0.0068,"NC|ashe":0.0046,"NC|avery":0.0037,"NC|beaufort":0.0058,"NC|bertie":0.0062,"NC|bladen":0.0074,"NC|brunswick":0.0052,"NC|buncombe":0.0057,"NC|burke":0.0061,"NC|cabarrus":0.0074,"NC|caldwell":0.0061,"NC|camden":0.0051,"NC|carteret":0.0044,"NC|caswell":0.0067,"NC|catawba":0.0059,"NC|chatham":0.0062,"NC|cherokee":0.0045,"NC|chowan":0.0063,"NC|clay":0.0046,"NC|cleveland":0.0064,"NC|columbus":0.0073,"NC|craven":0.0065,"NC|cumberland":0.0087,"NC|currituck":0.0047,"NC|dare":0.0051,"NC|davidson":0.0055,"NC|davie":0.0061,"NC|duplin":0.0068,"NC|durham":0.0081,"NC|edgecombe":0.0088,"NC|forsyth":0.008,"NC|franklin":0.007,"NC|gaston":0.0077,"NC|gates":0.0058,"NC|graham":0.0049,"NC|granville":0.0061,"NC|greene":0.0078,"NC|guilford":0.0083,"NC|halifax":0.009,"NC|harnett":0.0068,"NC|haywood":0.0053,"NC|henderson":0.0049,"NC|hertford":0.0086,"NC|hoke":0.0057,"NC|hyde":0.0062,"NC|iredell":0.0058,"NC|jackson":0.0031,"NC|johnston":0.0064,"NC|jones":0.0069,"NC|lee":0.0076,"NC|lenoir":0.0074,"NC|lincoln":0.0061,"NC|mcdowell":0.0049,"NC|macon":0.0039,"NC|madison":0.0048,"NC|martin":0.0094,"NC|mecklenburg":0.0069,"NC|mitchell":0.0054,"NC|montgomery":0.0058,"NC|moore":0.0057,"NC|nash":0.0066,"NC|new hanover":0.0055,"NC|northampton":0.0078,"NC|onslow":0.0064,"NC|orange":0.0096,"NC|pamlico":0.0059,"NC|pasquotank":0.0064,"NC|pender":0.0055,"NC|perquimans":0.0059,"NC|person":0.0068,"NC|pitt":0.0081,"NC|polk":0.005,"NC|randolph":0.0067,"NC|richmond":0.0078,"NC|robeson":0.008,"NC|rockingham":0.0075,"NC|rowan":0.0067,"NC|rutherford":0.0062,"NC|sampson":0.0075,"NC|scotland":0.0067,"NC|stanly":0.0057,"NC|stokes":0.0059,"NC|surry":0.0059,"NC|swain":0.0022,"NC|transylvania":0.0046,"NC|tyrrell":0.0063,"NC|union":0.0057,"NC|vance":0.0065,"NC|wake":0.0069,"NC|warren":0.0066,"NC|washington":0.0093,"NC|watauga":0.0042,"NC|wayne":0.0073,"NC|wilkes":0.0057,"NC|wilson":0.008,"NC|yadkin":0.0059,"NC|yancey":0.0045,"ND|adams":0.0064,"ND|barnes":0.0086,"ND|benson":0.0056,"ND|billings":0.0047,"ND|bottineau":0.0059,"ND|bowman":0.0061,"ND|burke":0.0044,"ND|burleigh":0.0085,"ND|cass":0.0111,"ND|cavalier":0.0107,"ND|dickey":0.009,"ND|divide":0.0075,"ND|dunn":0.0043,"ND|eddy":0.0067,"ND|emmons":0.0072,"ND|foster":0.0072,"ND|golden valley":0.0064,"ND|grand forks":0.011,"ND|grant":0.006,"ND|griggs":0.0044,"ND|hettinger":0.0079,"ND|kidder":0.0057,"ND|lamoure":0.0071,"ND|logan":0.0078,"ND|mchenry":0.0071,"ND|mcintosh":0.0087,"ND|mckenzie":0.0043,"ND|mclean":0.0071,"ND|mercer":0.0086,"ND|morton":0.01,"ND|mountrail":0.0041,"ND|nelson":0.0061,"ND|oliver":0.005,"ND|pembina":0.0082,"ND|pierce":0.0095,"ND|ramsey":0.0089,"ND|ransom":0.0091,"ND|renville":0.0066,"ND|richland":0.0101,"ND|rolette":0.0033,"ND|sargent":0.011,"ND|sheridan":0.0057,"ND|sioux":0.0026,"ND|slope":0.004,"ND|stark":0.0082,"ND|steele":0.0086,"ND|stutsman":0.0102,"ND|towner":0.0071,"ND|traill":0.0091,"ND|walsh":0.0092,"ND|ward":0.0104,"ND|wells":0.0085,"ND|williams":0.0068,"OH|adams":0.0083,"OH|allen":0.0106,"OH|ashland":0.0086,"OH|ashtabula":0.0112,"OH|athens":0.0116,"OH|auglaize":0.0094,"OH|belmont":0.0101,"OH|brown":0.0082,"OH|butler":0.0116,"OH|carroll":0.0079,"OH|champaign":0.0107,"OH|clark":0.0115,"OH|clermont":0.0126,"OH|clinton":0.0092,"OH|columbiana":0.0097,"OH|coshocton":0.0089,"OH|crawford":0.0111,"OH|cuyahoga":0.0189,"OH|darke":0.0086,"OH|defiance":0.0109,"OH|delaware":0.016,"OH|erie":0.0116,"OH|fairfield":0.0115,"OH|fayette":0.0094,"OH|franklin":0.0153,"OH|fulton":0.0123,"OH|gallia":0.0093,"OH|geauga":0.0142,"OH|greene":0.0159,"OH|guernsey":0.0087,"OH|hamilton":0.0151,"OH|hancock":0.0096,"OH|hardin":0.0104,"OH|harrison":0.0092,"OH|henry":0.0111,"OH|highland":0.0078,"OH|hocking":0.0079,"OH|holmes":0.0089,"OH|huron":0.0092,"OH|jackson":0.009,"OH|jefferson":0.0093,"OH|knox":0.01,"OH|lake":0.015,"OH|lawrence":0.0087,"OH|licking":0.0117,"OH|logan":0.0099,"OH|lorain":0.0137,"OH|lucas":0.0166,"OH|madison":0.0098,"OH|mahoning":0.013,"OH|marion":0.0096,"OH|medina":0.0118,"OH|meigs":0.0086,"OH|mercer":0.0098,"OH|miami":0.0103,"OH|monroe":0.008,"OH|montgomery":0.0173,"OH|morgan":0.0081,"OH|morrow":0.0109,"OH|muskingum":0.0088,"OH|noble":0.0064,"OH|ottawa":0.0101,"OH|paulding":0.009,"OH|perry":0.0087,"OH|pickaway":0.0092,"OH|pike":0.0079,"OH|portage":0.0122,"OH|preble":0.0098,"OH|putnam":0.0092,"OH|richland":0.0119,"OH|ross":0.0097,"OH|sandusky":0.0106,"OH|scioto":0.0108,"OH|seneca":0.0096,"OH|shelby":0.0094,"OH|stark":0.0124,"OH|summit":0.0149,"OH|trumbull":0.0132,"OH|tuscarawas":0.0101,"OH|union":0.0133,"OH|van wert":0.0092,"OH|vinton":0.0064,"OH|warren":0.0122,"OH|washington":0.009,"OH|wayne":0.0107,"OH|williams":0.0113,"OH|wood":0.0136,"OH|wyandot":0.0085,"OK|adair":0.0051,"OK|alfalfa":0.0056,"OK|atoka":0.0037,"OK|beaver":0.0076,"OK|beckham":0.0082,"OK|blaine":0.0061,"OK|bryan":0.0058,"OK|caddo":0.0055,"OK|canadian":0.0081,"OK|carter":0.0066,"OK|cherokee":0.0049,"OK|choctaw":0.0039,"OK|cimarron":0.0051,"OK|cleveland":0.0092,"OK|coal":0.0042,"OK|comanche":0.0068,"OK|cotton":0.0077,"OK|craig":0.0042,"OK|creek":0.0067,"OK|custer":0.0076,"OK|delaware":0.0051,"OK|dewey":0.0065,"OK|ellis":0.0059,"OK|garfield":0.0087,"OK|garvin":0.0049,"OK|grady":0.007,"OK|grant":0.0057,"OK|greer":0.0046,"OK|harmon":0.007,"OK|harper":0.007,"OK|haskell":0.0041,"OK|hughes":0.0054,"OK|jackson":0.0064,"OK|jefferson":0.0056,"OK|johnston":0.0046,"OK|kay":0.0066,"OK|kingfisher":0.0066,"OK|kiowa":0.0061,"OK|latimer":0.0049,"OK|le flore":0.0059,"OK|lincoln":0.0038,"OK|logan":0.0072,"OK|love":0.0049,"OK|mcclain":0.0077,"OK|mccurtain":0.0035,"OK|mcintosh":0.0058,"OK|major":0.0066,"OK|marshall":0.0071,"OK|mayes":0.006,"OK|murray":0.0043,"OK|muskogee":0.0061,"OK|noble":0.0055,"OK|nowata":0.0053,"OK|okfuskee":0.0045,"OK|oklahoma":0.0092,"OK|okmulgee":0.0068,"OK|osage":0.0069,"OK|ottawa":0.006,"OK|pawnee":0.0059,"OK|payne":0.0077,"OK|pittsburg":0.0052,"OK|pontotoc":0.006,"OK|pottawatomie":0.0062,"OK|pushmataha":0.0034,"OK|roger mills":0.0039,"OK|rogers":0.0071,"OK|seminole":0.0057,"OK|sequoyah":0.0053,"OK|stephens":0.0068,"OK|texas":0.0091,"OK|tillman":0.0066,"OK|tulsa":0.0098,"OK|wagoner":0.007,"OK|washington":0.0087,"OK|washita":0.0051,"OK|woods":0.0063,"OK|woodward":0.006,"OR|baker":0.007,"OR|benton":0.0093,"OR|clackamas":0.0084,"OR|clatsop":0.0066,"OR|columbia":0.0072,"OR|coos":0.0067,"OR|crook":0.0062,"OR|curry":0.0051,"OR|deschutes":0.0059,"OR|douglas":0.0061,"OR|gilliam":0.0079,"OR|grant":0.0041,"OR|harney":0.0071,"OR|hood river":0.0051,"OR|jackson":0.0073,"OR|jefferson":0.0062,"OR|josephine":0.005,"OR|klamath":0.0063,"OR|lake":0.0058,"OR|lane":0.0078,"OR|lincoln":0.0075,"OR|linn":0.0073,"OR|malheur":0.0056,"OR|marion":0.0083,"OR|morrow":0.0072,"OR|multnomah":0.0102,"OR|polk":0.0076,"OR|sherman":0.0071,"OR|tillamook":0.0062,"OR|umatilla":0.0077,"OR|union":0.0068,"OR|wallowa":0.0049,"OR|wasco":0.0077,"OR|washington":0.0086,"OR|wheeler":0.0068,"OR|yamhill":0.0068,"PA|adams":0.0122,"PA|allegheny":0.0147,"PA|armstrong":0.0136,"PA|beaver":0.0133,"PA|bedford":0.0079,"PA|berks":0.016,"PA|blair":0.0105,"PA|bradford":0.0104,"PA|bucks":0.012,"PA|butler":0.0097,"PA|cambria":0.0119,"PA|cameron":0.0131,"PA|carbon":0.0144,"PA|centre":0.0104,"PA|chester":0.0122,"PA|clarion":0.0091,"PA|clearfield":0.0107,"PA|clinton":0.0108,"PA|columbia":0.0106,"PA|crawford":0.0124,"PA|cumberland":0.0111,"PA|dauphin":0.0128,"PA|delaware":0.0162,"PA|elk":0.0115,"PA|erie":0.0152,"PA|fayette":0.0108,"PA|forest":0.0083,"PA|franklin":0.0103,"PA|fulton":0.009,"PA|greene":0.0111,"PA|huntingdon":0.008,"PA|indiana":0.0133,"PA|jefferson":0.0085,"PA|juniata":0.0085,"PA|lackawanna":0.014,"PA|lancaster":0.012,"PA|lawrence":0.0125,"PA|lebanon":0.0123,"PA|lehigh":0.0142,"PA|luzerne":0.0135,"PA|lycoming":0.0124,"PA|mckean":0.0113,"PA|mercer":0.0106,"PA|mifflin":0.0122,"PA|monroe":0.0162,"PA|montgomery":0.0129,"PA|montour":0.0092,"PA|northampton":0.0144,"PA|northumberland":0.0112,"PA|perry":0.0107,"PA|philadelphia":0.0085,"PA|pike":0.0124,"PA|potter":0.0098,"PA|schuylkill":0.0129,"PA|snyder":0.0102,"PA|somerset":0.0099,"PA|sullivan":0.0095,"PA|susquehanna":0.0091,"PA|tioga":0.0101,"PA|union":0.0118,"PA|venango":0.0122,"PA|warren":0.0112,"PA|washington":0.011,"PA|wayne":0.011,"PA|westmoreland":0.012,"PA|wyoming":0.0124,"PA|york":0.0154,"RI|bristol":0.0114,"RI|kent":0.0137,"RI|newport":0.0086,"RI|providence":0.0119,"RI|washington":0.0091,"SC|abbeville":0.0042,"SC|aiken":0.0047,"SC|allendale":0.005,"SC|anderson":0.005,"SC|bamberg":0.0071,"SC|barnwell":0.006,"SC|beaufort":0.005,"SC|berkeley":0.0049,"SC|calhoun":0.0036,"SC|charleston":0.004,"SC|cherokee":0.005,"SC|chester":0.005,"SC|chesterfield":0.0041,"SC|clarendon":0.0052,"SC|colleton":0.0054,"SC|darlington":0.0046,"SC|dillon":0.0044,"SC|dorchester":0.006,"SC|edgefield":0.0047,"SC|fairfield":0.0044,"SC|florence":0.0047,"SC|georgetown":0.0041,"SC|greenville":0.0051,"SC|greenwood":0.0054,"SC|hampton":0.0063,"SC|horry":0.0038,"SC|jasper":0.0055,"SC|kershaw":0.0051,"SC|lancaster":0.0054,"SC|laurens":0.0043,"SC|lee":0.0049,"SC|lexington":0.0048,"SC|mccormick":0.0052,"SC|marion":0.0044,"SC|marlboro":0.0051,"SC|newberry":0.0053,"SC|oconee":0.0038,"SC|orangeburg":0.0058,"SC|pickens":0.0043,"SC|richland":0.0064,"SC|saluda":0.0043,"SC|spartanburg":0.0058,"SC|sumter":0.0054,"SC|union":0.0043,"SC|williamsburg":0.0062,"SC|york":0.0053,"SD|aurora":0.0097,"SD|beadle":0.0101,"SD|bennett":0.0092,"SD|bon homme":0.011,"SD|brookings":0.0111,"SD|brown":0.0107,"SD|brule":0.0082,"SD|buffalo":0.002,"SD|butte":0.0088,"SD|campbell":0.0103,"SD|charles mix":0.0097,"SD|clark":0.0076,"SD|clay":0.0113,"SD|codington":0.0096,"SD|corson":0.0118,"SD|custer":0.0071,"SD|davison":0.0114,"SD|day":0.0078,"SD|deuel":0.0076,"SD|dewey":0.0095,"SD|douglas":0.0084,"SD|edmunds":0.0081,"SD|fall river":0.0103,"SD|faulk":0.0075,"SD|grant":0.0092,"SD|gregory":0.0076,"SD|haakon":0.0074,"SD|hamlin":0.0102,"SD|hand":0.008,"SD|hanson":0.0082,"SD|harding":0.0098,"SD|hughes":0.0103,"SD|hutchinson":0.0091,"SD|hyde":0.0103,"SD|jackson":0.0069,"SD|jerauld":0.0083,"SD|jones":0.0099,"SD|kingsbury":0.0093,"SD|lake":0.0093,"SD|lawrence":0.0077,"SD|lincoln":0.0112,"SD|lyman":0.0096,"SD|mccook":0.0092,"SD|mcpherson":0.011,"SD|marshall":0.0067,"SD|meade":0.0091,"SD|mellette":0.0062,"SD|miner":0.007,"SD|minnehaha":0.0106,"SD|moody":0.0087,"SD|pennington":0.01,"SD|perkins":0.0097,"SD|potter":0.0123,"SD|roberts":0.0069,"SD|sanborn":0.0059,"SD|spink":0.0098,"SD|stanley":0.0111,"SD|sully":0.0086,"SD|todd":0.0074,"SD|tripp":0.0069,"SD|turner":0.0101,"SD|union":0.0112,"SD|walworth":0.0112,"SD|yankton":0.0099,"SD|ziebach":0.0062,"TN|anderson":0.0058,"TN|bedford":0.0054,"TN|benton":0.0042,"TN|bledsoe":0.0044,"TN|blount":0.0048,"TN|bradley":0.0044,"TN|campbell":0.0036,"TN|cannon":0.0041,"TN|carroll":0.005,"TN|carter":0.0049,"TN|cheatham":0.0048,"TN|chester":0.0051,"TN|claiborne":0.0043,"TN|clay":0.0042,"TN|cocke":0.0049,"TN|coffee":0.0055,"TN|crockett":0.0054,"TN|cumberland":0.0029,"TN|davidson":0.0057,"TN|decatur":0.0041,"TN|dekalb":0.0034,"TN|dickson":0.0044,"TN|dyer":0.0056,"TN|fayette":0.0033,"TN|fentress":0.0027,"TN|franklin":0.0048,"TN|gibson":0.0061,"TN|giles":0.0045,"TN|grainger":0.0041,"TN|greene":0.0042,"TN|grundy":0.0043,"TN|hamblen":0.0037,"TN|hamilton":0.0062,"TN|hancock":0.0042,"TN|hardeman":0.0058,"TN|hardin":0.0043,"TN|hawkins":0.0053,"TN|haywood":0.006,"TN|henderson":0.0037,"TN|henry":0.0038,"TN|hickman":0.0042,"TN|houston":0.0052,"TN|humphreys":0.0041,"TN|jackson":0.0038,"TN|jefferson":0.004,"TN|johnson":0.0034,"TN|knox":0.0044,"TN|lake":0.0072,"TN|lauderdale":0.0067,"TN|lawrence":0.0047,"TN|lewis":0.0032,"TN|lincoln":0.0041,"TN|loudon":0.0034,"TN|mcminn":0.0032,"TN|mcnairy":0.0038,"TN|macon":0.0025,"TN|madison":0.006,"TN|marion":0.0039,"TN|marshall":0.0043,"TN|maury":0.0043,"TN|meigs":0.0085,"TN|monroe":0.0039,"TN|montgomery":0.0061,"TN|moore":0.0042,"TN|morgan":0.0041,"TN|obion":0.0049,"TN|overton":0.0036,"TN|perry":0.005,"TN|pickett":0.0012,"TN|polk":0.0045,"TN|putnam":0.0048,"TN|rhea":0.0052,"TN|roane":0.0055,"TN|robertson":0.0044,"TN|rutherford":0.0048,"TN|scott":0.0041,"TN|sequatchie":0.0041,"TN|sevier":0.0031,"TN|shelby":0.0097,"TN|smith":0.0043,"TN|stewart":0.0043,"TN|sullivan":0.0059,"TN|sumner":0.0046,"TN|tipton":0.0056,"TN|trousdale":0.0038,"TN|unicoi":0.0049,"TN|union":0.0027,"TN|van buren":0.0044,"TN|warren":0.0043,"TN|washington":0.0056,"TN|wayne":0.0039,"TN|weakley":0.0044,"TN|white":0.0044,"TN|williamson":0.0037,"TN|wilson":0.0042,"TX|anderson":0.0091,"TX|andrews":0.0113,"TX|angelina":0.0113,"TX|aransas":0.0101,"TX|archer":0.0129,"TX|armstrong":0.0106,"TX|atascosa":0.0115,"TX|austin":0.01,"TX|bailey":0.0074,"TX|bandera":0.0081,"TX|bastrop":0.0117,"TX|baylor":0.0054,"TX|bee":0.0125,"TX|bell":0.0121,"TX|bexar":0.0155,"TX|blanco":0.0102,"TX|borden":0.0022,"TX|bosque":0.0086,"TX|bowie":0.0117,"TX|brazoria":0.0169,"TX|brazos":0.0138,"TX|brewster":0.0098,"TX|briscoe":0.0074,"TX|brooks":0.0115,"TX|brown":0.0113,"TX|burleson":0.0101,"TX|burnet":0.0094,"TX|caldwell":0.0105,"TX|calhoun":0.01,"TX|callahan":0.0078,"TX|cameron":0.0135,"TX|camp":0.0098,"TX|carson":0.0136,"TX|cass":0.0067,"TX|castro":0.012,"TX|chambers":0.0101,"TX|cherokee":0.0095,"TX|childress":0.014,"TX|clay":0.0101,"TX|cochran":0.0101,"TX|coke":0.0094,"TX|coleman":0.0094,"TX|collin":0.0148,"TX|collingsworth":0.0091,"TX|colorado":0.0077,"TX|comal":0.0104,"TX|comanche":0.0098,"TX|concho":0.0099,"TX|cooke":0.0106,"TX|coryell":0.01,"TX|cottle":0.0115,"TX|crane":0.0095,"TX|crockett":0.0124,"TX|crosby":0.0116,"TX|culberson":0.0114,"TX|dallam":0.012,"TX|dallas":0.0145,"TX|dawson":0.0146,"TX|deaf smith":0.0145,"TX|delta":0.0116,"TX|denton":0.0146,"TX|dewitt":0.0086,"TX|dickens":0.0092,"TX|dimmit":0.0082,"TX|donley":0.0076,"TX|duval":0.0099,"TX|eastland":0.0099,"TX|ector":0.0127,"TX|edwards":0.0066,"TX|ellis":0.0124,"TX|el paso":0.018,"TX|erath":0.0088,"TX|falls":0.0097,"TX|fannin":0.0086,"TX|fayette":0.0073,"TX|fisher":0.0101,"TX|floyd":0.0145,"TX|foard":0.0134,"TX|fort bend":0.0177,"TX|franklin":0.0081,"TX|freestone":0.0098,"TX|frio":0.0133,"TX|gaines":0.015,"TX|galveston":0.014,"TX|garza":0.0133,"TX|gillespie":0.0083,"TX|glasscock":0.006,"TX|goliad":0.0095,"TX|gonzales":0.0091,"TX|gray":0.0144,"TX|grayson":0.0123,"TX|gregg":0.0116,"TX|grimes":0.009,"TX|guadalupe":0.0119,"TX|hale":0.013,"TX|hall":0.0118,"TX|hamilton":0.0081,"TX|hansford":0.0143,"TX|hardeman":0.0086,"TX|hardin":0.0116,"TX|harris":0.015,"TX|harrison":0.0096,"TX|hartley":0.0108,"TX|haskell":0.0096,"TX|hays":0.014,"TX|hemphill":0.0124,"TX|henderson":0.0098,"TX|hidalgo":0.0163,"TX|hill":0.0105,"TX|hockley":0.0094,"TX|hood":0.0097,"TX|hopkins":0.0068,"TX|houston":0.0075,"TX|howard":0.0111,"TX|hudspeth":0.0095,"TX|hunt":0.0118,"TX|hutchinson":0.0145,"TX|irion":0.0117,"TX|jack":0.0084,"TX|jackson":0.0106,"TX|jasper":0.0089,"TX|jeff davis":0.0051,"TX|jefferson":0.015,"TX|jim hogg":0.0134,"TX|jim wells":0.0121,"TX|johnson":0.0119,"TX|jones":0.012,"TX|karnes":0.0061,"TX|kaufman":0.0149,"TX|kendall":0.01,"TX|kenedy":0.0081,"TX|kent":0.0052,"TX|kerr":0.0089,"TX|kimble":0.0088,"TX|kinney":0.0125,"TX|kleberg":0.0144,"TX|knox":0.0154,"TX|lamar":0.0088,"TX|lamb":0.0112,"TX|lampasas":0.0076,"TX|la salle":0.0126,"TX|lavaca":0.0076,"TX|lee":0.0088,"TX|leon":0.0062,"TX|liberty":0.012,"TX|limestone":0.0094,"TX|lipscomb":0.0135,"TX|live oak":0.0075,"TX|llano":0.0068,"TX|lubbock":0.015,"TX|lynn":0.0133,"TX|mcculloch":0.0105,"TX|mclennan":0.0136,"TX|mcmullen":0.0084,"TX|madison":0.0096,"TX|marion":0.009,"TX|martin":0.0072,"TX|mason":0.0064,"TX|matagorda":0.0122,"TX|maverick":0.0133,"TX|medina":0.0123,"TX|menard":0.0113,"TX|midland":0.0119,"TX|milam":0.0092,"TX|mills":0.0067,"TX|mitchell":0.0168,"TX|montague":0.0088,"TX|montgomery":0.0144,"TX|moore":0.0135,"TX|morris":0.0096,"TX|motley":0.0096,"TX|nacogdoches":0.0086,"TX|navarro":0.0105,"TX|newton":0.0087,"TX|nolan":0.014,"TX|nueces":0.014,"TX|ochiltree":0.0144,"TX|oldham":0.0114,"TX|orange":0.0123,"TX|palo pinto":0.0107,"TX|panola":0.0088,"TX|parker":0.0127,"TX|parmer":0.0124,"TX|pecos":0.008,"TX|polk":0.0092,"TX|potter":0.0141,"TX|presidio":0.0102,"TX|rains":0.0112,"TX|randall":0.0137,"TX|reagan":0.0086,"TX|real":0.0071,"TX|red river":0.0074,"TX|reeves":0.0097,"TX|refugio":0.0109,"TX|roberts":0.0093,"TX|robertson":0.0069,"TX|rockwall":0.0142,"TX|runnels":0.0138,"TX|rusk":0.0091,"TX|sabine":0.0079,"TX|san augustine":0.0052,"TX|san jacinto":0.0094,"TX|san patricio":0.0131,"TX|san saba":0.0058,"TX|schleicher":0.0106,"TX|scurry":0.0136,"TX|shackelford":0.012,"TX|shelby":0.0064,"TX|sherman":0.0159,"TX|smith":0.0115,"TX|somervell":0.0065,"TX|starr":0.0122,"TX|stephens":0.0114,"TX|sterling":0.0089,"TX|stonewall":0.0146,"TX|sutton":0.0159,"TX|swisher":0.0139,"TX|tarrant":0.0154,"TX|taylor":0.0125,"TX|terrell":0.0096,"TX|terry":0.0145,"TX|throckmorton":0.01,"TX|titus":0.011,"TX|tom green":0.0129,"TX|travis":0.0131,"TX|trinity":0.0098,"TX|tyler":0.0097,"TX|upshur":0.0109,"TX|upton":0.0107,"TX|uvalde":0.0116,"TX|val verde":0.0131,"TX|van zandt":0.0084,"TX|victoria":0.0142,"TX|walker":0.0106,"TX|waller":0.0127,"TX|ward":0.0033,"TX|washington":0.0079,"TX|webb":0.0158,"TX|wharton":0.0131,"TX|wheeler":0.0144,"TX|wichita":0.0155,"TX|wilbarger":0.0148,"TX|willacy":0.0146,"TX|williamson":0.015,"TX|wilson":0.012,"TX|winkler":0.0076,"TX|wise":0.0109,"TX|wood":0.0073,"TX|yoakum":0.0112,"TX|young":0.0118,"TX|zapata":0.0069,"TX|zavala":0.013,"UT|beaver":0.0036,"UT|box elder":0.0047,"UT|cache":0.0046,"UT|carbon":0.0062,"UT|daggett":0.0053,"UT|davis":0.0051,"UT|duchesne":0.0056,"UT|emery":0.0062,"UT|garfield":0.0027,"UT|grand":0.004,"UT|iron":0.0043,"UT|juab":0.0037,"UT|kane":0.0041,"UT|millard":0.005,"UT|morgan":0.0052,"UT|piute":0.0032,"UT|rich":0.0034,"UT|salt lake":0.005,"UT|san juan":0.0039,"UT|sanpete":0.0047,"UT|sevier":0.0049,"UT|summit":0.0032,"UT|tooele":0.0054,"UT|uintah":0.0049,"UT|utah":0.0043,"UT|wasatch":0.0049,"UT|washington":0.0041,"UT|wayne":0.0038,"UT|weber":0.0056,"VT|addison":0.0147,"VT|bennington":0.015,"VT|caledonia":0.0161,"VT|chittenden":0.0144,"VT|essex":0.0145,"VT|franklin":0.014,"VT|grand isle":0.0133,"VT|lamoille":0.0139,"VT|orange":0.0153,"VT|orleans":0.0143,"VT|rutland":0.0165,"VT|washington":0.0164,"VT|windham":0.016,"VT|windsor":0.0164,"VA|accomack":0.005,"VA|albemarle":0.0073,"VA|alleghany":0.0068,"VA|amelia":0.0043,"VA|amherst":0.0047,"VA|appomattox":0.0052,"VA|arlington":0.0085,"VA|augusta":0.0047,"VA|bath":0.0043,"VA|bedford":0.0043,"VA|bland":0.0055,"VA|botetourt":0.006,"VA|brunswick":0.004,"VA|buchanan":0.0048,"VA|buckingham":0.0048,"VA|campbell":0.0046,"VA|caroline":0.005,"VA|carroll":0.0054,"VA|charles city":0.0059,"VA|charlotte":0.005,"VA|chesterfield":0.0075,"VA|clarke":0.0059,"VA|craig":0.0058,"VA|culpeper":0.005,"VA|cumberland":0.0053,"VA|dickenson":0.0051,"VA|dinwiddie":0.0058,"VA|essex":0.0058,"VA|fairfax":0.0095,"VA|fauquier":0.0067,"VA|floyd":0.0046,"VA|fluvanna":0.0065,"VA|franklin":0.005,"VA|frederick":0.005,"VA|giles":0.0054,"VA|gloucester":0.0056,"VA|goochland":0.0052,"VA|grayson":0.0062,"VA|greene":0.0061,"VA|greensville":0.006,"VA|halifax":0.005,"VA|hanover":0.0066,"VA|henrico":0.0068,"VA|henry":0.0048,"VA|highland":0.0069,"VA|isle of wight":0.0072,"VA|james city":0.0061,"VA|king and queen":0.0045,"VA|king george":0.0055,"VA|king william":0.0061,"VA|lancaster":0.0049,"VA|lee":0.0061,"VA|loudoun":0.008,"VA|louisa":0.0063,"VA|lunenburg":0.004,"VA|madison":0.0049,"VA|mathews":0.0049,"VA|mecklenburg":0.005,"VA|middlesex":0.0051,"VA|montgomery":0.0082,"VA|nelson":0.0056,"VA|new kent":0.006,"VA|northampton":0.0066,"VA|northumberland":0.0046,"VA|nottoway":0.0043,"VA|orange":0.0059,"VA|page":0.0049,"VA|patrick":0.0058,"VA|pittsylvania":0.0057,"VA|powhatan":0.0059,"VA|prince edward":0.0052,"VA|prince george":0.0069,"VA|prince william":0.0085,"VA|pulaski":0.0063,"VA|rappahannock":0.0049,"VA|richmond":0.005,"VA|roanoke":0.0079,"VA|rockbridge":0.0059,"VA|rockingham":0.0055,"VA|russell":0.0048,"VA|scott":0.0068,"VA|shenandoah":0.0053,"VA|smyth":0.0054,"VA|southampton":0.0076,"VA|spotsylvania":0.0056,"VA|stafford":0.0067,"VA|surry":0.0067,"VA|sussex":0.0056,"VA|tazewell":0.0061,"VA|warren":0.0052,"VA|washington":0.005,"VA|westmoreland":0.0062,"VA|wise":0.0059,"VA|wythe":0.0052,"VA|york":0.0063,"VA|alexandria city":0.0092,"VA|bristol city":0.0072,"VA|buena vista city":0.0088,"VA|charlottesville city":0.0082,"VA|chesapeake city":0.0078,"VA|colonial heights city":0.0075,"VA|covington city":0.0086,"VA|danville city":0.0062,"VA|emporia city":0.007,"VA|fairfax city":0.0085,"VA|falls church city":0.0115,"VA|franklin city":0.0081,"VA|fredericksburg city":0.0065,"VA|galax city":0.0052,"VA|hampton city":0.0097,"VA|harrisonburg city":0.0074,"VA|hopewell city":0.0088,"VA|lexington city":0.0085,"VA|lynchburg city":0.0081,"VA|manassas city":0.0099,"VA|manassas park city":0.0108,"VA|martinsville city":0.0081,"VA|newport news city":0.0094,"VA|norfolk city":0.0091,"VA|norton city":0.0085,"VA|petersburg city":0.0087,"VA|poquoson city":0.009,"VA|portsmouth city":0.0095,"VA|radford city":0.007,"VA|richmond city":0.009,"VA|roanoke city":0.0095,"VA|salem city":0.0082,"VA|staunton city":0.006,"VA|suffolk city":0.0087,"VA|virginia beach city":0.0078,"VA|waynesboro city":0.0066,"VA|williamsburg city":0.0061,"VA|winchester city":0.0074,"WA|adams":0.0072,"WA|asotin":0.0072,"WA|benton":0.0076,"WA|chelan":0.0065,"WA|clallam":0.0068,"WA|clark":0.0077,"WA|columbia":0.0074,"WA|cowlitz":0.0081,"WA|douglas":0.0076,"WA|ferry":0.0057,"WA|franklin":0.0074,"WA|garfield":0.0096,"WA|grant":0.0074,"WA|grays harbor":0.0071,"WA|island":0.0066,"WA|jefferson":0.0065,"WA|king":0.0076,"WA|kitsap":0.0072,"WA|kittitas":0.0066,"WA|klickitat":0.0062,"WA|lewis":0.0068,"WA|lincoln":0.006,"WA|mason":0.0072,"WA|okanogan":0.0064,"WA|pacific":0.0071,"WA|pend oreille":0.0056,"WA|pierce":0.0085,"WA|san juan":0.0053,"WA|skagit":0.0075,"WA|skamania":0.0056,"WA|snohomish":0.0072,"WA|spokane":0.0078,"WA|stevens":0.0061,"WA|thurston":0.0082,"WA|wahkiakum":0.0059,"WA|walla walla":0.0085,"WA|whatcom":0.0068,"WA|whitman":0.0077,"WA|yakima":0.0079,"WV|barbour":0.0036,"WV|berkeley":0.0053,"WV|boone":0.0051,"WV|braxton":0.0039,"WV|brooke":0.0055,"WV|cabell":0.0062,"WV|calhoun":0.0029,"WV|clay":0.0059,"WV|doddridge":0.0048,"WV|fayette":0.0055,"WV|gilmer":0.0047,"WV|grant":0.0033,"WV|greenbrier":0.0044,"WV|hampshire":0.0029,"WV|hancock":0.0056,"WV|hardy":0.0029,"WV|harrison":0.0056,"WV|jackson":0.0052,"WV|jefferson":0.0052,"WV|kanawha":0.0063,"WV|lewis":0.0042,"WV|lincoln":0.0041,"WV|logan":0.0043,"WV|mcdowell":0.004,"WV|marion":0.0061,"WV|marshall":0.005,"WV|mason":0.0041,"WV|mercer":0.0048,"WV|mineral":0.0043,"WV|mingo":0.004,"WV|monongalia":0.0045,"WV|monroe":0.0053,"WV|morgan":0.004,"WV|nicholas":0.0041,"WV|ohio":0.0061,"WV|pendleton":0.0032,"WV|pleasants":0.0062,"WV|pocahontas":0.0035,"WV|preston":0.0046,"WV|putnam":0.0059,"WV|raleigh":0.0049,"WV|randolph":0.0039,"WV|ritchie":0.0048,"WV|roane":0.0031,"WV|summers":0.004,"WV|taylor":0.0044,"WV|tucker":0.0034,"WV|tyler":0.0052,"WV|upshur":0.0039,"WV|wayne":0.0048,"WV|webster":0.0031,"WV|wetzel":0.0057,"WV|wirt":0.0047,"WV|wood":0.0055,"WV|wyoming":0.0038,"WI|adams":0.0121,"WI|ashland":0.013,"WI|barron":0.0122,"WI|bayfield":0.0092,"WI|brown":0.013,"WI|buffalo":0.0104,"WI|burnett":0.0088,"WI|calumet":0.0135,"WI|chippewa":0.0098,"WI|clark":0.012,"WI|columbia":0.0127,"WI|crawford":0.0112,"WI|dane":0.0157,"WI|dodge":0.0122,"WI|door":0.0097,"WI|douglas":0.0113,"WI|dunn":0.0125,"WI|eau claire":0.0127,"WI|florence":0.0125,"WI|fond du lac":0.0135,"WI|forest":0.009,"WI|grant":0.012,"WI|green":0.0141,"WI|green lake":0.0108,"WI|iowa":0.0131,"WI|iron":0.0098,"WI|jackson":0.0116,"WI|jefferson":0.0122,"WI|juneau":0.0127,"WI|kenosha":0.0142,"WI|kewaunee":0.0127,"WI|la crosse":0.0146,"WI|lafayette":0.0124,"WI|langlade":0.0107,"WI|lincoln":0.0116,"WI|manitowoc":0.0131,"WI|marathon":0.0135,"WI|marinette":0.0111,"WI|marquette":0.0115,"WI|menominee":0.0107,"WI|milwaukee":0.0182,"WI|monroe":0.0125,"WI|oconto":0.0105,"WI|oneida":0.0084,"WI|outagamie":0.0134,"WI|ozaukee":0.0117,"WI|pepin":0.0117,"WI|pierce":0.013,"WI|polk":0.0107,"WI|portage":0.0128,"WI|price":0.0117,"WI|racine":0.0144,"WI|richland":0.0109,"WI|rock":0.0149,"WI|rusk":0.0103,"WI|st. croix":0.011,"WI|sauk":0.0123,"WI|sawyer":0.0077,"WI|shawano":0.0119,"WI|sheboygan":0.0123,"WI|taylor":0.013,"WI|trempealeau":0.0132,"WI|vernon":0.0114,"WI|vilas":0.0069,"WI|walworth":0.0117,"WI|washburn":0.0098,"WI|washington":0.0106,"WI|waukesha":0.0111,"WI|waupaca":0.0126,"WI|waushara":0.0111,"WI|winnebago":0.0143,"WI|wood":0.0136,"WY|albany":0.0058,"WY|big horn":0.0044,"WY|campbell":0.0051,"WY|carbon":0.0055,"WY|converse":0.0053,"WY|crook":0.0044,"WY|fremont":0.0053,"WY|goshen":0.0059,"WY|hot springs":0.0062,"WY|johnson":0.0053,"WY|laramie":0.0056,"WY|lincoln":0.0048,"WY|natrona":0.0057,"WY|niobrara":0.0026,"WY|park":0.006,"WY|platte":0.0045,"WY|sheridan":0.0056,"WY|sublette":0.0038,"WY|sweetwater":0.0063,"WY|teton":0.0045,"WY|uinta":0.0047,"WY|washakie":0.0072,"WY|weston":0.0063};

const STATE_MEDIAN_TAX = {"AL":0.0028,"AK":0.0046,"AZ":0.0047,"AR":0.005,"CA":0.0069,"CO":0.0039,"CT":0.0156,"DE":0.0043,"DC":0.006,"FL":0.007,"GA":0.008,"HI":0.0028,"ID":0.0044,"IL":0.0162,"IN":0.0066,"IA":0.0119,"KS":0.0135,"KY":0.006,"LA":0.0034,"ME":0.0099,"MD":0.0083,"MA":0.0103,"MI":0.01,"MN":0.0094,"MS":0.0053,"MO":0.0064,"MT":0.0054,"NE":0.0113,"NV":0.0052,"NH":0.0163,"NJ":0.0203,"NM":0.0052,"NY":0.0181,"NC":0.0062,"ND":0.0072,"OH":0.01,"OK":0.006,"OR":0.0069,"PA":0.0115,"RI":0.0114,"SC":0.005,"SD":0.0093,"TN":0.0043,"TX":0.0107,"UT":0.0047,"VT":0.0148,"VA":0.0061,"WA":0.0072,"WV":0.0046,"WI":0.012,"WY":0.0053};

// Major US cities → "ST|county" for addresses that omit the county.
// Covers high-volume metros; everything else falls back to state median.
const CITY_TO_COUNTY = {
  // Florida (primary coverage)
  'winter garden,fl':'FL|orange','orlando,fl':'FL|orange','ocoee,fl':'FL|orange','apopka,fl':'FL|orange','windermere,fl':'FL|orange','winter park,fl':'FL|orange','maitland,fl':'FL|orange',
  'kissimmee,fl':'FL|osceola','st. cloud,fl':'FL|osceola','saint cloud,fl':'FL|osceola','celebration,fl':'FL|osceola',
  'clermont,fl':'FL|lake','minneola,fl':'FL|lake','mount dora,fl':'FL|lake','leesburg,fl':'FL|lake','tavares,fl':'FL|lake',
  'sanford,fl':'FL|seminole','lake mary,fl':'FL|seminole','oviedo,fl':'FL|seminole','altamonte springs,fl':'FL|seminole','longwood,fl':'FL|seminole','casselberry,fl':'FL|seminole',
  'tampa,fl':'FL|hillsborough','brandon,fl':'FL|hillsborough','riverview,fl':'FL|hillsborough','plant city,fl':'FL|hillsborough',
  'st. petersburg,fl':'FL|pinellas','saint petersburg,fl':'FL|pinellas','clearwater,fl':'FL|pinellas','largo,fl':'FL|pinellas',
  'miami,fl':'FL|miami-dade','miami beach,fl':'FL|miami-dade','hialeah,fl':'FL|miami-dade','doral,fl':'FL|miami-dade','homestead,fl':'FL|miami-dade',
  'fort lauderdale,fl':'FL|broward','hollywood,fl':'FL|broward','pompano beach,fl':'FL|broward','coral springs,fl':'FL|broward','pembroke pines,fl':'FL|broward',
  'west palm beach,fl':'FL|palm beach','boca raton,fl':'FL|palm beach','delray beach,fl':'FL|palm beach','jupiter,fl':'FL|palm beach','boynton beach,fl':'FL|palm beach',
  'jacksonville,fl':'FL|duval','naples,fl':'FL|collier','fort myers,fl':'FL|lee','cape coral,fl':'FL|lee',
  'sarasota,fl':'FL|sarasota','bradenton,fl':'FL|manatee','port st. lucie,fl':'FL|st. lucie','port saint lucie,fl':'FL|st. lucie',
  'palm bay,fl':'FL|brevard','melbourne,fl':'FL|brevard','titusville,fl':'FL|brevard',
  'daytona beach,fl':'FL|volusia','deltona,fl':'FL|volusia','gainesville,fl':'FL|alachua',
  'tallahassee,fl':'FL|leon','pensacola,fl':'FL|escambia','ocala,fl':'FL|marion',
  'st. augustine,fl':'FL|st. johns','saint augustine,fl':'FL|st. johns','palm coast,fl':'FL|flagler',
  'the villages,fl':'FL|sumter','spring hill,fl':'FL|hernando','lakeland,fl':'FL|polk',
  // Major out-of-state metros
  'austin,tx':'TX|travis','houston,tx':'TX|harris','dallas,tx':'TX|dallas','san antonio,tx':'TX|bexar','fort worth,tx':'TX|tarrant','el paso,tx':'TX|el paso','plano,tx':'TX|collin',
  'los angeles,ca':'CA|los angeles','san diego,ca':'CA|san diego','san francisco,ca':'CA|san francisco','san jose,ca':'CA|santa clara','sacramento,ca':'CA|sacramento','oakland,ca':'CA|alameda','irvine,ca':'CA|orange','fresno,ca':'CA|fresno',
  'phoenix,az':'AZ|maricopa','scottsdale,az':'AZ|maricopa','mesa,az':'AZ|maricopa','tucson,az':'AZ|pima',
  'atlanta,ga':'GA|fulton','savannah,ga':'GA|chatham','augusta,ga':'GA|richmond',
  'charlotte,nc':'NC|mecklenburg','raleigh,nc':'NC|wake','durham,nc':'NC|durham','greensboro,nc':'NC|guilford',
  'denver,co':'CO|denver','colorado springs,co':'CO|el paso','aurora,co':'CO|arapahoe','boulder,co':'CO|boulder',
  'seattle,wa':'WA|king','tacoma,wa':'WA|pierce','bellevue,wa':'WA|king','spokane,wa':'WA|spokane',
  'las vegas,nv':'NV|clark','henderson,nv':'NV|clark','reno,nv':'NV|washoe',
  'nashville,tn':'TN|davidson','memphis,tn':'TN|shelby','knoxville,tn':'TN|knox',
  'chicago,il':'IL|cook','naperville,il':'IL|dupage','aurora,il':'IL|kane',
  'new york,ny':'NY|new york','brooklyn,ny':'NY|kings','bronx,ny':'NY|bronx','queens,ny':'NY|queens','buffalo,ny':'NY|erie',
  'boston,ma':'MA|suffolk','cambridge,ma':'MA|middlesex','worcester,ma':'MA|worcester',
  'portland,or':'OR|multnomah','salem,or':'OR|marion','eugene,or':'OR|lane',
  'nashville,tn':'TN|davidson','columbus,oh':'OH|franklin','cleveland,oh':'OH|cuyahoga','cincinnati,oh':'OH|hamilton',
  'salt lake city,ut':'UT|salt lake','provo,ut':'UT|utah',
  'richmond,va':'VA|richmond city','virginia beach,va':'VA|virginia beach city','arlington,va':'VA|arlington','alexandria,va':'VA|alexandria city',
  'minneapolis,mn':'MN|hennepin','st. paul,mn':'MN|ramsey','saint paul,mn':'MN|ramsey',
  'indianapolis,in':'IN|marion','detroit,mi':'MI|wayne','milwaukee,wi':'WI|milwaukee','kansas city,mo':'MO|jackson','st. louis,mo':'MO|st. louis city','saint louis,mo':'MO|st. louis city',
};

// Resolve a property's county tax rate from its address.
// Returns { rate, label, source }. Falls back to state median, then national.
function resolveCountyTaxRate(address, stateAbbr) {
  const NATIONAL_MEDIAN = 0.0090;
  if (!address) {
    const sm = STATE_MEDIAN_TAX[stateAbbr];
    return sm ? { rate: sm, label: `${stateAbbr} state median`, source: 'state median' }
              : { rate: NATIONAL_MEDIAN, label: 'national median', source: 'national median' };
  }
  const lower = address.toLowerCase();
  const st = stateAbbr || (address.match(/,\s*([A-Z]{2})\s+\d{5}/)?.[1]) || '';

  // 1) Explicit "X County/Parish/Borough" in the address
  const cM = lower.match(/([a-z.\s]+?)\s+(county|parish|borough)/);
  if (cM && st) {
    const key = st + '|' + cM[1].trim().replace(/^st\s/, 'st. ');
    if (COUNTY_TAX_RATES[key] != null) {
      const cty = cM[1].trim().replace(/\b\w/g, c => c.toUpperCase());
      return { rate: COUNTY_TAX_RATES[key], label: `${cty} County`, source: 'address county' };
    }
  }

  // 2) City,ST → county lookup
  const cityM = lower.match(/,\s*([a-z.\s]+?),\s*([a-z]{2})\b/);
  if (cityM) {
    const cityKey = cityM[1].trim() + ',' + cityM[2].trim();
    const mapped = CITY_TO_COUNTY[cityKey];
    if (mapped && COUNTY_TAX_RATES[mapped] != null) {
      const cty = mapped.split('|')[1].replace(/\b\w/g, c => c.toUpperCase());
      return { rate: COUNTY_TAX_RATES[mapped], label: `${cty} County`, source: 'city lookup' };
    }
  }

  // 3) State median fallback
  if (st && STATE_MEDIAN_TAX[st] != null) {
    return { rate: STATE_MEDIAN_TAX[st], label: `${st} state median`, source: 'state median' };
  }
  return { rate: NATIONAL_MEDIAN, label: 'national median', source: 'national median' };
}


function getStateLicenseLookupUrl(state, agentName) {
  const name = encodeURIComponent(agentName || '');
  const urls = {
    FL: `https://www.myfloridalicense.com/wl11.asp?lnm=${encodeURIComponent((agentName||'').split(' ').pop())}&lft=Real+Estate+Broker&nextButton=Search`,
    CA: 'https://www2.dre.ca.gov/PublicASP/pplinfo.asp',
    TX: 'https://www.trec.texas.gov/apps/license-holder-search/',
    NY: `https://dos.ny.gov/licensing/lookup/licopen.asp?p_field=Name&p_value=${name}&p_license_type=30`,
    GA: 'https://verify.sos.ga.gov/verification/Search.aspx',
    NC: 'https://www.ncrec.gov/AgentSearch',
    WA: 'https://secure.lni.wa.gov/verify/Results.aspx',
    IL: 'https://idfpr.illinois.gov/priv/default.asp',
    PA: 'https://www.pals.pa.gov/#/page/search',
    AZ: 'https://services.azre.gov/publicdatabase/AgentSearch.aspx',
    CO: 'https://apps2.colorado.gov/dre/licensing/Lookup/LicenseLookup.aspx',
    NV: 'https://red.nv.gov/Content/LicenseSearch/LicenseSearch.aspx',
    OR: 'https://licenseesearch.oregon.gov/',
  };
  return urls[state] || `https://www.arello.com/index.cfm?fm=search&lastName=${encodeURIComponent((agentName||'').split(' ').pop())}`;
}


// ── Real comparable sales — geocoordinate radius search ──────────────────────

// ── MLS verification — Stellar MLS public search ──────────────────────────────
// Stellar MLS (stellarmls.com) serves the Florida market including Orlando.
// Their public search portal allows MLS# lookup without authentication.
async function verifyMLS(listingData) {
  const { mlsId, mlsSource, originatingMls } = listingData;
  if (!mlsId) return null;

  // ── Attempt 1: Stellar MLS public listing page ───────────────────────────
  const stellarUrls = [
    `https://www.stellarmls.com/property/${mlsId}`,
    `https://www.stellarmls.com/listings/${mlsId}`,
  ];

  for (const url of stellarUrls) {
    try {
      const res = await fetch(url, {
        headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0' }
      });
      if (!res.ok) continue;
      const html = await res.text();

      const statusM   = html.match(/(Active|Pending|Sold|Closed|Expired|Withdrawn|Back On Market)/i);
      const listDateM = html.match(/(?:List Date|Date Listed|On Market)[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i);
      const agentIdM  = html.match(/(?:Agent MLS ID|Listing Agent ID)[:\s]+([A-Z0-9]{4,12})/i);
      const priceM    = html.match(/(?:List Price|Asking)[:\s$]+([0-9,]+)/i);

      if (statusM) {
        return {
          status:     statusM[1],
          listDate:   listDateM?.[1] || '',
          agentMlsId: agentIdM?.[1]  || '',
          listPrice:  priceM ? parseFloat(priceM[1].replace(/,/g,'')) : 0,
          verified:   true,
          source:     'Stellar MLS'
        };
      }
    } catch (e) {
      chDebug('[ClearHome] Stellar MLS fetch failed:', e.message);
    }
  }

  // ── Attempt 2: Florida Realtors public IDX search ────────────────────────
  try {
    const url = `https://www.floridarealtors.org/research-and-statistics/housing-data`;
    // No direct listing search — skip
  } catch(e) {}

  // ── Attempt 3: Realtor.com MLS# search ───────────────────────────────────
  try {
    const url = `https://www.realtor.com/realestateandhomes-search/Winter-Garden_FL?mlsid=${mlsId}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0' }
    });
    if (res.ok) {
      const html = await res.text();
      const ndMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]+?)<\/script>/);
      if (ndMatch) {
        const nd = JSON.parse(ndMatch[1]);
        const listing = nd?.props?.pageProps?.properties?.[0];
        if (listing) {
          return {
            status:   listing.status || 'Active',
            listDate: listing.list_date || '',
            listPrice: listing.list_price || 0,
            verified: true,
            source:   'Realtor.com'
          };
        }
      }
    }
  } catch(e) {}

  return {
    status:   'Unverified',
    verified: false,
    source:   'lookup_failed',
    note:     `Manual check: search MLS# ${mlsId} on your state MLS portal`
  };
}


// ── Insurance estimation engine ───────────────────────────────────────────────
// Estimates monthly homeowners insurance using:
// - State base rates (FL OIR CHOICES data, InsuranceOpedia, ValuePenguin 2025)
// - Property type modifier (townhouse/condo HO-6 vs full HO-3)
// - Year built discount (newer = lower)
// - Construction type modifier (block/masonry = lower in FL)
// - HOA presence (master policy covers exterior → HO-6 rates apply)
// - Coverage amount scaled to purchase price
// Returns { monthly, annual, basis, notes }
function estimateInsurance({ state, propertyType, price, yearBuilt, construction, hasHoa, zip, roofType, userOverride }) {
  // If user has manually set insurance in profile, use that
  if (userOverride && userOverride > 0) {
    return { monthly: userOverride, annual: userOverride * 12, basis: 'user-defined', notes: 'Using your saved insurance estimate.' };
  }

  // ── State base rates (annual, per $100K of dwelling coverage) ────────────
  // Source: Insurance.com 2025 state averages, NAIC data, FL OIR CHOICES
  const stateBaseRates = {
    // Annual cost per $100K dwelling coverage (HO-3 full home)
    FL: 1850,  // FL highest in nation; inland ~$2,500-3,500/yr on $300K
    TX:  900, CA:  600, NY:  700, GA:  650, NC:  600,
    SC:  700, VA:  550, MD:  550, PA:  500, NJ:  700,
    MA:  600, CO:  550, AZ:  500, NV:  450, WA:  500,
    OR:  500, IL:  550, MI:  550, OH:  500, IN:  480,
    MN:  600, WI:  500, MO:  700, KS:  900, OK: 1100,
    LA: 1200, MS:  850, AL:  750, TN:  650, KY:  550,
    AR:  700, IA:  650, NE:  850, SD:  700, ND:  750,
    MT:  550, WY:  550, ID:  500, UT:  500, NM:  550,
    AK:  650, HI:  250, VT:  450, NH:  550, ME:  500,
    CT:  650, RI:  700, DE:  550, DC:  550, WV:  600,
  };

  const stateCode = (state && state.length === 2 && stateBaseRates[state]) ? state : null;
  if (!stateCode) {
    // Can't reliably estimate without knowing the state
    return {
      monthly: 125, annual: 1500, basis: 'National avg estimate (state unknown)',
      notes: 'Add property state to address for accurate estimate', policyType: 'HO-3', coverageAmount: 0
    };
  }
  let baseRatePer100k = stateBaseRates[stateCode];

  // ── Coverage amount ───────────────────────────────────────────────────────
  // For townhouse/condo with HOA (HO-6): cover interior only = ~40-50% of price
  // For freehold (HO-3): cover full replacement = ~80% of price
  const isCondo    = /condo|townhouse|townhome|HO-6/i.test(propertyType);
  const hasHoaMaster = hasHoa; // HOA master covers exterior

  let coverageAmount;
  let policyType;
  if (isCondo || hasHoaMaster) {
    // HO-6: interior + personal property. Dwelling coverage ~20-30% of purchase price.
    // FL avg HO-6: $962/yr statewide; Orange County inland: ~$900-1,200/yr
    coverageAmount = price * 0.25;
    policyType     = 'HO-6 (townhouse/condo — interior only)';
    // FL HO-6 specific adjustment: statewide avg is $962/yr but Orange County
    // inland is lower than coastal. Use 65% of HO-3 rate for HO-6.
    baseRatePer100k = baseRatePer100k * 0.65;
  } else {
    coverageAmount = price * 0.80;
    policyType     = 'HO-3 (full replacement cost)';
  }

  // Base annual premium
  let annual = (baseRatePer100k / 100000) * coverageAmount;

  // ── Modifiers ─────────────────────────────────────────────────────────────
  const notes = [];

  // Year built — newer homes get discounts
  if (yearBuilt > 0) {
    const age = new Date().getFullYear() - yearBuilt;
    if (age <= 5)       { annual *= 0.82; notes.push('New construction discount (~18%)'); }
    else if (age <= 10) { annual *= 0.88; notes.push('Recent construction discount (~12%)'); }
    else if (age <= 15) { annual *= 0.93; notes.push('Modern construction discount (~7%)'); }
    else if (age > 30)  { annual *= 1.15; notes.push('Older construction surcharge (~15%)'); }
  }

  // Construction material — masonry/block rated lower in hurricane states
  const hurricaneState = new Set(['FL','TX','LA','SC','NC','GA','AL','MS']);
  if (/block|masonry|concrete|CBS/i.test(construction)) {
    if (hurricaneState.has(stateCode)) { annual *= 0.88; notes.push('Masonry construction discount in hurricane zone (~12%)'); }
    else { annual *= 0.93; notes.push('Masonry construction discount (~7%)'); }
  } else if (/frame|wood/i.test(construction)) {
    if (hurricaneState.has(stateCode)) { annual *= 1.08; notes.push('Wood frame surcharge in hurricane zone (+8%)'); }
  }

  // Roof type — impacts rating in wind-prone states
  if (hurricaneState.has(stateCode)) {
    if (/metal|tile|concrete/i.test(roofType))  { annual *= 0.90; notes.push('Wind-resistant roof discount (~10%)'); }
  }

  // Coastal risk adjustment — applies to hurricane/storm-surge exposed properties
  // FL is special-cased with ZIP ranges; other Gulf/Atlantic/Pacific coast states
  // get a flat coastal surcharge when the ZIP suggests a coastal county
  const coastalStates = new Set(['FL','TX','LA','MS','AL','GA','SC','NC','VA','MD','DE','NJ','NY','CT','RI','MA','ME','NH','WA','OR','CA','HI','AK']);
  const zipNum = parseInt(zip) || 0;

  if (stateCode === 'FL') {
    // FL ZIP-based inland vs coastal distinction (most accurate)
    const isCoastalFL = (zipNum >= 33004 && zipNum <= 33482) || // South FL coast (Miami–Palm Beach)
                        (zipNum >= 34201 && zipNum <= 34299) || // Sarasota/Bradenton
                        (zipNum >= 32080 && zipNum <= 32084) || // St Augustine
                        (zipNum >= 32250 && zipNum <= 32259) || // Jacksonville Beach
                        (zipNum >= 34420 && zipNum <= 34491) || // Ocala/Crystal River coast
                        (zipNum >= 32401 && zipNum <= 32417) || // Panama City
                        (zipNum >= 32501 && zipNum <= 32560);   // Pensacola coast
    if (!isCoastalFL) {
      annual *= 0.72;
      notes.push('Inland FL discount vs. statewide average (~28%)');
    } else {
      annual *= 1.05;
      notes.push('Coastal FL — hurricane risk premium');
    }
  } else if (coastalStates.has(stateCode)) {
    // For other coastal states, use a ZIP-prefix heuristic
    // Coastal county ZIPs tend to cluster at the low end of state ZIP ranges
    // This is imprecise but better than ignoring it — flag it in notes
    const coastalZipPrefixes = {
      TX:  [[77500,77599],[77600,77650],[78336,78340],[78373,78374]], // Galveston, Corpus Christi
      LA:  [[70301,70400],[70460,70470]],   // Gulf coast parishes
      SC:  [[29400,29500],[29576,29579]],   // Charleston, Myrtle Beach
      NC:  [[28400,28500],[27954,27966]],   // Wilmington, Outer Banks
      VA:  [[23300,23350]],                 // Virginia Beach
      NJ:  [[08200,08260],[07700,07760]],   // Jersey Shore
      NY:  [[11900,11980],[11690,11698]],   // Long Island coast
      MA:  [[02540,02560],[02630,02670]],   // Cape Cod
      ME:  [[04600,04650]],                 // Maine coast
      WA:  [[98200,98280],[98300,98370]],   // Puget Sound/coast
      CA:  [[90200,90280],[93400,93450],[94500,94570]], // LA/SB/Bay Area coast
      HI:  [[96700,96999]],                 // All HI is coastal
    };
    const ranges = coastalZipPrefixes[stateCode] || [];
    const isCoastal = ranges.some(([lo, hi]) => zipNum >= lo && zipNum <= hi);
    if (isCoastal) {
      annual *= 1.12;
      notes.push(`Coastal ${stateCode} location — wind/storm surcharge (~12%)`);
    }
  }

  annual = Math.round(annual);

  // Sanity bounds by state tier
  const highRiskStates = new Set(['FL','TX','LA','OK','KS','MO','MS','AL']);
  const lowCostStates  = new Set(['HI','ID','UT','AZ','NV','CO','WA','OR']);
  const minAnnual = highRiskStates.has(stateCode) ? 700  : lowCostStates.has(stateCode) ? 300 : 400;
  const maxAnnual = highRiskStates.has(stateCode) ? 9000 : lowCostStates.has(stateCode) ? 3000 : 6000;
  const clampedAnnual  = Math.min(Math.max(annual, minAnnual), maxAnnual);
  const clampedMonthly = Math.round(clampedAnnual / 12);

  return {
    monthly:  clampedMonthly,
    annual:   clampedAnnual,
    basis:    `${policyType} · ${stateCode} estimate`,
    notes:    notes.join('; ') || 'Standard rate applied',
    policyType,
    coverageAmount: Math.round(coverageAmount)
  };
}

// ── CSV line parser — handles quoted fields with commas ───────────────────────
function parseCSVLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ── Macro appreciation interpretation ────────────────────────────────────────
function buildMacroInterpretation(actualPct, expectedPct, excessPct, zestGapPct, origYear) {
  if (actualPct === null || expectedPct === null) {
    return 'Insufficient price history for appreciation analysis.';
  }
  const parts = [];
  if (excessPct > 10) {
    parts.push(`List price is ${excessPct}% above the FHFA benchmark from ${origYear} — significantly above market-driven appreciation.`);
    parts.push('Likely reflects renovations, upgrades, or seller overpricing.');
  } else if (excessPct > 3) {
    parts.push(`List price is ${excessPct}% above the FHFA benchmark from ${origYear} — modestly above market rate.`);
    parts.push('Minor improvements or seller optimism may account for the premium.');
  } else if (excessPct >= -3) {
    parts.push(`List price is consistent with FHFA appreciation benchmarks from ${origYear}.`);
    parts.push('Pricing appears market-driven with no significant premium.');
  } else {
    parts.push(`List price is ${Math.abs(excessPct)}% BELOW the FHFA benchmark — potentially underpriced.`);
    parts.push('Seller may be motivated or property has undisclosed issues.');
  }
  if (zestGapPct !== null) {
    if (zestGapPct > 5) {
      parts.push(`Zestimate is ${zestGapPct}% below list price — Zillow's AVM signals overpricing.`);
    } else if (zestGapPct < -5) {
      parts.push(`Zestimate is ${Math.abs(zestGapPct)}% above list price — strong value signal.`);
    } else {
      parts.push(`Zestimate aligns closely with list price (${zestGapPct > 0 ? '+' : ''}${zestGapPct}% gap).`);
    }
  }
  return parts.join(' ');
}

