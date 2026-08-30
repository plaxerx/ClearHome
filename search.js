
(function () {
  'use strict';

  if (!location.hostname.includes('zillow.com')) return;

  function isSearchPage() {
    const path = location.pathname;
    const search = location.search;
    const hasSearchState = search.includes('searchQueryState');
    const isSearchPath = /\/(homes|for_sale|for_rent|sold|recently_sold)(\/|$)/i.test(path)
                      || /\/[A-Z][a-z]+(?:-[A-Z][a-z]+)*-[A-Z]{2}(?:\/|$)/.test(path)
                      || hasSearchState;
    const isBareHome = /^\/(homes\/?)?$/.test(path) && !hasSearchState;
    return isSearchPath && !isBareHome;
  }


  let filterActive = false;
  let hiddenCount  = 0;
  let totalCount   = 0;
  let cutListings  = [];

  function cardHasPriceCut(card) {
    const text = (card.textContent || '').toLowerCase();
    if (/price\s*(cut|drop|reduc)/i.test(text)) return true;
    if (/\$[\d,.]+k?\s*(cut|drop|off|less|reduc)/i.test(text)) return true;
    if (/↓\s*\$[\d,.]+/i.test(text)) return true;
    if (/reduced/i.test(text) && /\$/.test(text)) return true;
    const badges = card.querySelectorAll('[class*="PriceCut"], [class*="priceCut"], [class*="price-cut"], [class*="priceReduction"]');
    if (badges.length > 0) return true;
    const statusEls = card.querySelectorAll('[class*="StyledPropertyCardBadge"], [class*="list-card-statusText"], [class*="PropertyCardBadge"]');
    for (const el of statusEls) {
      if (/cut|drop|reduc|↓/.test((el.textContent || '').toLowerCase())) return true;
    }
    return false;
  }

  function getListingCards() {
    const selectors = [
      'article[data-test="property-card"]',
      '[data-testid="property-card"]',
      '[class*="StyledPropertyCard"]',
      '[class*="list-card"]',
      'li[class*="ListItem"]',
    ];
    for (const sel of selectors) {
      const cards = document.querySelectorAll(sel);
      if (cards.length >= 2) return Array.from(cards);
    }
    const lis = document.querySelectorAll('#grid-search-results li, [id*="search-result"] li');
    const priceCards = Array.from(lis).filter(li => /\$[\d,]{4,}/.test(li.textContent || ''));
    if (priceCards.length >= 2) return priceCards;
    return [];
  }

  function reapplyToNewCards() {
    if (!filterActive) return;
    const cards = getListingCards();
    const seenAddrs = new Set();
    for (var k = 0; k < cutListings.length; k++) {
      seenAddrs.add(cutListings[k].addr.toLowerCase().replace(/[^a-z0-9]/g, ''));
    }
    for (const card of cards) {
      if (card.dataset.chPriceCut === 'yes' || card.dataset.chPriceCut === 'no') continue;
      if (cardHasPriceCut(card)) {
        card.style.display = '';
        card.dataset.chPriceCut = 'yes';
        const parentLi = card.closest('li');
        if (parentLi) parentLi.style.display = '';
        const addr = (card.querySelector('address, [data-test="property-card-addr"], [class*="address"]')?.textContent || '').trim();
        const addrKey = addr.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (addrKey && !seenAddrs.has(addrKey)) {
          seenAddrs.add(addrKey);
          const priceEl = card.querySelector('[data-testid="data-price-row"], [class*="price"], [class*="Price"]');
          const price = (priceEl?.textContent || '').trim();
          const cutText = (card.textContent || '').match(/\$[\d,.]+k?\s*(price\s*)?cut|\$[\d,.]+\s*(?:drop|off|less|reduc)|↓\s*\$[\d,.]+/i)?.[0] || '';
          cutListings.push({ addr, price, cut: cutText });
        }
      } else {
        card.style.display = 'none';
        card.dataset.chPriceCut = 'no';
        const parentLi = card.closest('li');
        if (parentLi) parentLi.style.display = 'none';
        hiddenCount++;
        totalCount++;
      }
    }
    suppressMapPins();
    updateCounter();
  }

  function applyFilter() {
    filterActive = true;
    chLoadAllCuts(function () { if (filterActive) suppressMapPins(); });
    const cards = getListingCards();
    totalCount = cards.length;
    hiddenCount = 0;
    cutListings = [];
    const seenAddrs = new Set();

    for (const card of cards) {
      if (cardHasPriceCut(card)) {
        card.style.display = '';
        card.dataset.chPriceCut = 'yes';
        const parentLi = card.closest('li');
        if (parentLi) parentLi.style.display = '';
        const addr = (card.querySelector('address, [data-test="property-card-addr"], [class*="address"]')?.textContent || '').trim();
        const addrKey = addr.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (addrKey && !seenAddrs.has(addrKey)) {
          seenAddrs.add(addrKey);
          const priceEl = card.querySelector('[data-testid="data-price-row"], [class*="price"], [class*="Price"]');
          const price = (priceEl?.textContent || '').trim();
          const cutText = (card.textContent || '').match(/\$[\d,.]+k?\s*(price\s*)?cut|\$[\d,.]+\s*(?:drop|off|less|reduc)|↓\s*\$[\d,.]+/i)?.[0] || '';
          cutListings.push({ addr, price, cut: cutText });
        }
      } else {
        card.style.display = 'none';
        card.dataset.chPriceCut = 'no';
        const parentLi = card.closest('li');
        if (parentLi) parentLi.style.display = 'none';
        hiddenCount++;
      }
    }

    injectCollapseCSS();
    suppressMapPins();
    updateCounter();

    loadedPages = new Set();
    autoLoadNextPages();
  }

  function removeFilter() {
    filterActive = false;
    cutListings = [];
    const cards = getListingCards();
    for (const card of cards) {
      card.style.display = '';
      delete card.dataset.chPriceCut;
      const parentLi = card.closest('li');
      if (parentLi) parentLi.style.display = '';
    }
    document.querySelectorAll('[data-ch-page-loaded="true"]').forEach(function(el) { el.remove(); });
    removeCollapseCSS();
    restoreMapPins();
    hiddenCount = 0;
    totalCount = 0;
    loadedPages = new Set();
    updateCounter();
  }

  function injectCollapseCSS() {
    if (document.getElementById('ch-collapse-css')) return;
    const style = document.createElement('style');
    style.id = 'ch-collapse-css';
    style.textContent = `
      li[style*="display: none"],
      article[style*="display: none"] {
        position: absolute !important;
        width: 0 !important;
        height: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
        border: none !important;
        pointer-events: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  function removeCollapseCSS() {
    const el = document.getElementById('ch-collapse-css');
    if (el) el.remove();
  }

  let paginationRunning = false;
  let loadedPages = new Set();
  const MAX_CUT_LISTINGS = 100;

  function autoLoadNextPages() {
    if (paginationRunning) return;
    if (cutListings.length >= MAX_CUT_LISTINGS) {
      updateCounter();
      return;
    }
    paginationRunning = true;

    const nextBtn = document.querySelector(
      'a[title="Next page"], a[rel="next"], ' +
      '[class*="PaginationButton"]:last-child a, ' +
      'nav[aria-label*="pagination"] a:last-child, ' +
      'button[aria-label="Next page"]'
    );

    if (!nextBtn) {
      paginationRunning = false;
      updateCounter();
      return;
    }

    const nextUrl = nextBtn.href || nextBtn.getAttribute('href');
    if (!nextUrl || loadedPages.has(nextUrl)) {
      paginationRunning = false;
      return;
    }
    loadedPages.add(nextUrl);

    const counter = document.getElementById('ch-cutCounter');
    if (counter) counter.textContent = 'Loading more... (' + cutListings.length + ' cuts found)';

    fetch(nextUrl, { credentials: 'include' })
      .then(function(r) { return r.text(); })
      .then(function(html) {
        const resultsList = document.querySelector(
          '#grid-search-results ul, [id*="search-result"] ul, ' +
          '[class*="StyledPropertyCardList"], [class*="search-result-list"]'
        );
        if (resultsList) processPageHTML(html, resultsList);
        paginationRunning = false;
      })
      .catch(function() { paginationRunning = false; updateCounter(); });
  }

  function processPageHTML(html, resultsList) {
    try {
      if (cutListings.length >= MAX_CUT_LISTINGS) { updateCounter(); return; }
      var parser = new DOMParser();
      var doc = parser.parseFromString(html, 'text/html');
      var selectors = ['article[data-test="property-card"]', '[data-testid="property-card"]', '[class*="StyledPropertyCard"]'];
      var fetchedCards = [];
      for (var i = 0; i < selectors.length; i++) {
        fetchedCards = doc.querySelectorAll(selectors[i]);
        if (fetchedCards.length >= 2) break;
      }
      var seenAddrs = new Set();
      for (var k = 0; k < cutListings.length; k++) {
        seenAddrs.add(cutListings[k].addr.toLowerCase().replace(/[^a-z0-9]/g, ''));
      }
      var addedCuts = 0;
      for (var j = 0; j < fetchedCards.length; j++) {
        if (cutListings.length >= MAX_CUT_LISTINGS) break;
        var card = fetchedCards[j];
        if (cardHasPriceCut(card)) {
          var addr = (card.querySelector('address, [data-test="property-card-addr"], [class*="address"]')?.textContent || '').trim();
          var addrKey = addr.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (!addrKey || seenAddrs.has(addrKey)) continue;
          seenAddrs.add(addrKey);
          var wrapper = card.closest('li');
          var toAppend = wrapper ? wrapper.cloneNode(true) : card.cloneNode(true);
          toAppend.dataset.chPriceCut = 'yes';
          toAppend.dataset.chPageLoaded = 'true';
          resultsList.appendChild(toAppend);
          addedCuts++;
          var priceEl = card.querySelector('[data-testid="data-price-row"], [class*="price"]');
          var price = (priceEl?.textContent || '').trim();
          var cutM = (card.textContent || '').match(/\$[\d,.]+k?\s*(price\s*)?cut|\$[\d,.]+\s*(?:drop|off|less|reduc)|↓\s*\$[\d,.]+/i);
          cutListings.push({ addr: addr, price: price, cut: cutM ? cutM[0] : '' });
        }
      }
      totalCount += fetchedCards.length;
      hiddenCount += (fetchedCards.length - addedCuts);
      updateCounter();

      if (cutListings.length < MAX_CUT_LISTINGS && addedCuts > 0) {
        var nextBtn = doc.querySelector('a[title="Next page"], a[rel="next"]');
        var nextUrl = nextBtn ? (nextBtn.href || nextBtn.getAttribute('href')) : '';
        if (nextUrl && !nextUrl.startsWith('http')) nextUrl = location.origin + nextUrl;
        if (nextUrl && !loadedPages.has(nextUrl)) {
          loadedPages.add(nextUrl);
          setTimeout(function() {
            fetch(nextUrl, { credentials: 'include' })
              .then(function(r) { return r.text(); })
              .then(function(h) { processPageHTML(h, resultsList); })
              .catch(function() {});
          }, 500);
        }
      }
    } catch(e) {}
  }

  let mapObserver = null;

  let dataCuts = [];
  let dataCutsLoading = false;

  var _chCutsDebug = { nextData: 0, storeScript: 0, bracket: 0, pages: 0 };

  function extractJsonArray(text, key) {
    try {
      var idx = text.indexOf('"' + key + '":[');
      if (idx < 0) return [];
      var start = text.indexOf('[', idx);
      var depth = 0, inStr = false, esc = false;
      for (var i = start; i < text.length && i < start + 3000000; i++) {
        var ch = text[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '[') depth++;
        else if (ch === ']') { depth--; if (depth === 0) return JSON.parse(text.slice(start, i + 1)); }
      }
    } catch (e) {}
    return [];
  }

  function parseSearchResultsFromDoc(doc, rawText) {
    var out = [];
    try {
      var el = doc.querySelector('#__NEXT_DATA__');
      if (el) {
        var j = JSON.parse(el.textContent);
        var sps = j && j.props && j.props.pageProps && j.props.pageProps.searchPageState;
        var sr = (sps && ((sps.cat1 && sps.cat1.searchResults) || (sps.cat2 && sps.cat2.searchResults))) || {};
        var a = [].concat(sr.listResults || [], sr.mapResults || []);
        _chCutsDebug.nextData += a.length;
        out = out.concat(a);
      }
    } catch (e) {}
    try {
      var scripts = doc.querySelectorAll('script[data-zrr-shared-data-key], script[type="application/json"]');
      for (var k = 0; k < scripts.length; k++) {
        var txt = (scripts[k].textContent || '').trim();
        if (txt.indexOf('listResults') < 0) continue;
        txt = txt.replace(/^<!--/, '').replace(/-->$/, '').trim();
        try {
          var j2 = JSON.parse(txt);
          var sr2 = (j2.cat1 && j2.cat1.searchResults) || (j2.cat2 && j2.cat2.searchResults)
                 || (j2.searchResults) || {};
          var b = [].concat(sr2.listResults || [], sr2.mapResults || []);
          _chCutsDebug.storeScript += b.length;
          out = out.concat(b);
        } catch (e2) {
          var c1 = extractJsonArray(txt, 'listResults');
          var c2 = extractJsonArray(txt, 'mapResults');
          _chCutsDebug.bracket += c1.length + c2.length;
          out = out.concat(c1, c2);
        }
      }
    } catch (e) {}
    if (!out.length && rawText) {
      var d1 = extractJsonArray(rawText, 'listResults');
      var d2 = extractJsonArray(rawText, 'mapResults');
      _chCutsDebug.bracket += d1.length + d2.length;
      out = out.concat(d1, d2);
    }
    return out;
  }

  function normalizeCutItem(r) {
    var vd = r.variableData || {};
    var hi0 = (r.hdpData && r.hdpData.homeInfo) || {};
    var isCut = vd.type === 'PRICE_REDUCTION' || /price cut|reduc/i.test(vd.text || '')
             || (typeof hi0.priceChange === 'number' && hi0.priceChange < 0)
             || !!hi0.priceReduction || !!r.priceReduction;
    if (!isCut) return null;
    if (!vd.text && typeof hi0.priceChange === 'number' && hi0.priceChange < 0) {
      var when = '';
      if (hi0.datePriceChanged) {
        try { when = ' (' + new Date(hi0.datePriceChanged).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ')'; } catch (e) {}
      }
      vd = { text: '$' + Math.abs(hi0.priceChange).toLocaleString() + when };
    }
    var priceNum = r.unformattedPrice || parseInt(String(r.price || '').replace(/[^\d]/g, ''), 10) || 0;
    var cutText = vd.text || '';
    var cutNum = parseInt(((cutText.match(/\$([\d,]+)/) || [])[1] || '0').replace(/,/g, ''), 10);
    var url = r.detailUrl || '';
    if (url && url.indexOf('http') !== 0) url = 'https://www.zillow.com' + url;
    var hi = (r.hdpData && r.hdpData.homeInfo) || {};
    return {
      zpid: r.zpid || hi.zpid || '',
      addr: r.address || [r.addressStreet, r.addressCity].filter(Boolean).join(', ') || '',
      priceNum: priceNum,
      priceStr: r.price || ('$' + priceNum.toLocaleString()),
      cutText: cutText, cutNum: cutNum,
      beds: r.beds || hi.bedrooms || '', baths: r.baths || hi.bathrooms || '',
      area: r.area || hi.livingArea || '',
      url: url, img: r.imgSrc || '',
      dom: (hi.daysOnZillow != null ? hi.daysOnZillow : '')
    };
  }

  function chLoadAllCuts(cb) {
    if (dataCutsLoading) { if (cb) cb(dataCuts); return; }
    dataCutsLoading = true;
    _chCutsDebug = { nextData: 0, storeScript: 0, bracket: 0, pages: 0 };
    var seen = new Set();
    var out = [];
    var absorb = function (items) {
      for (var i = 0; i < items.length; i++) {
        var n = normalizeCutItem(items[i]);
        if (n && n.zpid && !seen.has(n.zpid)) { seen.add(n.zpid); out.push(n); }
      }
    };
    var followNext = function (doc, hops) {
      var nb = doc.querySelector('a[rel="next"], a[title="Next page"], a[aria-label="Next page"]');
      var href = nb ? (nb.getAttribute('href') || '') : '';
      if (!href || hops >= 4) return Promise.resolve();
      if (href.indexOf('http') !== 0) href = location.origin + href;
      return fetch(href, { credentials: 'include' })
        .then(function (r) { return r.text(); })
        .then(function (h) {
          var d2 = new DOMParser().parseFromString(h, 'text/html');
          _chCutsDebug.pages++;
          absorb(parseSearchResultsFromDoc(d2, h));
          return followNext(d2, hops + 1);
        })
        .catch(function () {});
    };
    try { absorb(parseSearchResultsFromDoc(document, document.documentElement.outerHTML)); } catch (e) {}
    fetch(location.href, { credentials: 'include' })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        _chCutsDebug.pages++;
        absorb(parseSearchResultsFromDoc(doc, html));
        return followNext(doc, 0);
      })
      .catch(function () {})
      .then(function () {
        out.sort(function (a, b) { return (b.cutNum || 0) - (a.cutNum || 0); });
        dataCuts = out;
        dataCutsLoading = false;
        try { console.log('[ClearHome cuts]', dataCuts.length, 'price cuts', _chCutsDebug); } catch (e) {}
        if (cb) cb(dataCuts);
      });
  }

  function openCutsPanel() {
    var old = document.getElementById('ch-cutsPanel');
    if (old) { old.remove(); }
    var panel = document.createElement('div');
    panel.id = 'ch-cutsPanel';
    panel.style.cssText = 'position:fixed;top:70px;right:16px;width:392px;max-height:78vh;overflow-y:auto;background:#ffffff;color:#141821;border:0.5px solid rgba(20,28,52,0.16);border-radius:12px;box-shadow:0 8px 40px rgba(20,28,52,0.16),0 1px 3px rgba(20,28,52,0.08);z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
    var head = document.createElement('div');
    head.style.cssText = 'position:sticky;top:0;background:#ffffff;color:#141821;padding:10px 14px;border-radius:12px 12px 0 0;display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:0.5px solid rgba(20,28,52,0.16);';
    var title = document.createElement('div');
    title.style.cssText = 'font-size:13px;font-weight:700;';
    title.textContent = '✂ Price Cuts — ' + dataCuts.length + ' found';
    var headBtns = document.createElement('div');
    headBtns.style.cssText = 'display:flex;gap:6px;align-items:center;';
    var copyBtn = document.createElement('button');
    copyBtn.textContent = '📋';
    copyBtn.title = 'Copy list';
    copyBtn.style.cssText = 'border:none;background:transparent;color:#4F6BFF;cursor:pointer;font-size:14px;';
    copyBtn.addEventListener('click', function () {
      var lines = ['Address\tPrice\tCut\tBeds\tBaths\tSqft\tDOM\tLink'];
      dataCuts.forEach(function (c) {
        lines.push([c.addr, c.priceStr, c.cutText, c.beds, c.baths, c.area, c.dom, c.url].join('\t'));
      });
      navigator.clipboard.writeText(lines.join('\n')).then(function () {
        copyBtn.textContent = '✓'; setTimeout(function () { copyBtn.textContent = '📋'; }, 1400);
      });
    });
    var closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'border:none;background:transparent;color:#6b7488;cursor:pointer;font-size:14px;';
    closeBtn.addEventListener('click', function () {
      panel.remove();
      if (!filterActive) restoreMapPins();
    });
    headBtns.appendChild(copyBtn); headBtns.appendChild(closeBtn);
    head.appendChild(title); head.appendChild(headBtns);
    panel.appendChild(head);

    if (!dataCuts.length) {
      var empty = document.createElement('div');
      empty.style.cssText = 'padding:18px 14px;font-size:12px;color:#6b7488;';
      empty.textContent = 'No price-cut listings found in the current search results.';
      var dbgLine = document.createElement('div');
      dbgLine.style.cssText = 'padding:0 14px 14px;font-size:10px;color:#a8b0c2;';
      dbgLine.textContent = 'sources — nextData: ' + _chCutsDebug.nextData + ', storeScript: ' + _chCutsDebug.storeScript
        + ', raw: ' + _chCutsDebug.bracket + ', pages fetched: ' + _chCutsDebug.pages;
      panel.appendChild(dbgLine);
      panel.appendChild(empty);
    }
    dataCuts.forEach(function (c) {
      var row = document.createElement('a');
      row.href = c.url || '#';
      row.target = '_blank';
      row.rel = 'noopener';
      row.style.cssText = 'display:flex;gap:10px;padding:9px 12px;border-bottom:0.5px solid rgba(20,28,52,0.10);text-decoration:none;color:inherit;align-items:center;';
      row.addEventListener('mouseenter', function () { row.style.background = '#f4f6fb'; });
      row.addEventListener('mouseleave', function () { row.style.background = ''; });
      var img = document.createElement('img');
      if (c.img) img.src = c.img;
      else img.style.display = 'none';
      img.loading = 'lazy';
      img.style.cssText = 'width:60px;height:44px;object-fit:cover;border-radius:6px;background:#e8edf9;flex-shrink:0;';
      img.onerror = function () { img.style.visibility = 'hidden'; };
      var mid = document.createElement('div');
      mid.style.cssText = 'flex:1;min-width:0;';
      var a1 = document.createElement('div');
      a1.style.cssText = 'font-size:12px;font-weight:600;color:#141821;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      a1.textContent = c.addr;
      var a2 = document.createElement('div');
      a2.style.cssText = 'font-size:11px;color:#6b7488;margin-top:1px;';
      a2.textContent = c.priceStr
        + (c.beds ? ' · ' + c.beds + 'bd' : '') + (c.baths ? ' ' + c.baths + 'ba' : '')
        + (c.area ? ' · ' + Number(c.area).toLocaleString() + ' sqft' : '')
        + (c.dom !== '' ? ' · ' + c.dom + ' DOM' : '');
      mid.appendChild(a1); mid.appendChild(a2);
      var badge = document.createElement('div');
      badge.style.cssText = 'font-size:10.5px;font-weight:700;color:#b13731;background:#fdeceb;padding:3px 7px;border-radius:5px;white-space:nowrap;flex-shrink:0;';
      badge.textContent = c.cutText ? ('−' + c.cutText.replace(/^[-−]?\s*/, '')) : 'Cut';
      row.appendChild(img); row.appendChild(mid); row.appendChild(badge);
      panel.appendChild(row);
    });
    document.body.appendChild(panel);
  }


  function suppressMapPins() {
    try {
      var cutNums = [];
      for (var d = 0; d < dataCuts.length; d++) if (dataCuts[d].priceNum) cutNums.push(dataCuts[d].priceNum);
      for (var i = 0; i < cutListings.length; i++) {
        var p = (cutListings[i].price || '').replace(/[^\d]/g, '');
        if (p) cutNums.push(parseInt(p, 10));
      }
      if (!cutNums.length) return;   
      var pinMatches = function (n) {
        for (var k = 0; k < cutNums.length; k++) {
          var tol = Math.max(2500, cutNums[k] * 0.006);   
          if (Math.abs(cutNums[k] - n) <= tol) return true;
        }
        return false;
      };

      const mapContainer = document.querySelector('[class*="map-container"], [id*="map"], [class*="MapContainer"], #search-page-map');
      const pinEls = mapContainer
        ? mapContainer.querySelectorAll('button, [role="button"], [class*="marker"], [class*="Marker"]')
        : document.querySelectorAll('button[aria-label*="$"], [class*="MapMarker"] button, [class*="map-marker"]');

      for (var j = 0; j < pinEls.length; j++) {
        var pin = pinEls[j];
        var label = (pin.getAttribute('aria-label') || pin.textContent || '').trim();
        var priceMatch = label.match(/\$\s*([\d.,]+)\s*([KM])?/i);
        if (!priceMatch) continue;
        var num = parseFloat(priceMatch[1].replace(/,/g, ''));
        var suf = (priceMatch[2] || '').toUpperCase();
        if (suf === 'K') num *= 1e3;
        else if (suf === 'M') num *= 1e6;
        if (!num || num < 10000) continue;   

        if (pinMatches(num)) {
          pin.style.opacity = '1';
          pin.style.filter = '';
          pin.style.pointerEvents = '';
          pin.dataset.chCutPin = 'yes';
        } else {
          pin.style.opacity = '0.12';
          pin.style.filter = 'grayscale(1)';
          pin.style.pointerEvents = 'none';
          pin.dataset.chCutPin = 'no';
        }
      }

      if (!mapObserver && mapContainer) {
        mapObserver = new MutationObserver(function() {
          if (filterActive) {
            clearTimeout(mapObserver._timer);
            mapObserver._timer = setTimeout(suppressMapPins, 300);
          }
        });
        mapObserver.observe(mapContainer, { childList: true, subtree: true });
      }
    } catch(e) {}
  }

  function restoreMapPins() {
    try {
      if (mapObserver) { mapObserver.disconnect(); mapObserver = null; }
      var pins = document.querySelectorAll('[data-ch-cut-pin]');
      for (var i = 0; i < pins.length; i++) {
        pins[i].style.opacity = '';
        pins[i].style.filter = '';
        pins[i].style.pointerEvents = '';
        delete pins[i].dataset.chCutPin;
      }
    } catch(e) {}
  }

  function updateCounter() {
    const counter = document.getElementById('ch-cutCounter');
    if (!counter) return;
    if (filterActive) {
      counter.textContent = cutListings.length + ' price cuts found';
      counter.style.display = '';
    } else {
      counter.style.display = 'none';
    }
    const exportBtn = document.getElementById('ch-cutExport');
    if (exportBtn) {
      exportBtn.style.display = (filterActive && cutListings.length > 0) ? '' : 'none';
    }
  }

  function buildWidget() {
    const wrap = document.createElement('div');
    wrap.id = 'ch-priceCutBar';
    wrap.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'gap:6px',
      'padding:4px 10px',
      'height:36px',
      'background:#ffffff',
      'border:0.5px solid rgba(20,28,52,0.16)',
      'border-radius:8px',
      'box-shadow:0 1px 4px rgba(20,28,52,0.10)',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'flex-shrink:0',
      'z-index:9999',
      'user-select:none',
    ].join(';');

    const btn = document.createElement('button');
    btn.id = 'ch-cutToggle';
    btn.textContent = '✂ Price Cuts Only';
    btn.style.cssText = [
      'border:none',
      'border-radius:5px',
      'padding:4px 10px',
      'font-size:11px',
      'font-weight:600',
      'cursor:pointer',
      'white-space:nowrap',
      'background:transparent',
      'color:#3d465c',
      'transition:background .15s,color .15s',
    ].join(';');
    btn.addEventListener('mouseenter', function() {
      if (!filterActive) { btn.style.background = '#e7ebff'; btn.style.color = '#4F6BFF'; }
    });
    btn.addEventListener('mouseleave', function() {
      if (!filterActive) { btn.style.background = 'transparent'; btn.style.color = '#3d465c'; }
    });
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (filterActive) {
        removeFilter();
        btn.style.background = 'transparent';
        btn.style.color = '#3d465c';
        btn.textContent = '✂ Price Cuts Only';
      } else {
        applyFilter();
        btn.style.background = '#4F6BFF';
        btn.style.color = '#fff';
        btn.textContent = '✂ Showing Cuts';
      }
    });
    wrap.appendChild(btn);

    var allBtn = document.createElement('button');
    allBtn.id = 'ch-cutAll';
    allBtn.textContent = '▤ All Cuts';
    allBtn.title = 'List every price-cut property on one page';
    allBtn.style.cssText = [
      'border:none',
      'border-radius:5px',
      'padding:4px 8px',
      'font-size:11px',
      'font-weight:600',
      'cursor:pointer',
      'white-space:nowrap',
      'background:transparent',
      'color:#6b7488',
      'transition:background .15s,color .15s',
    ].join(';');
    allBtn.addEventListener('mouseenter', function () { allBtn.style.background = '#e7ebff'; allBtn.style.color = '#4F6BFF'; });
    allBtn.addEventListener('mouseleave', function () { allBtn.style.background = 'transparent'; allBtn.style.color = '#6b7488'; });
    allBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      allBtn.textContent = '… Loading';
      chLoadAllCuts(function () {
        allBtn.textContent = '▤ All Cuts';
        openCutsPanel();
        suppressMapPins();   
      });
    });
    wrap.appendChild(allBtn);

    var counter = document.createElement('span');
    counter.id = 'ch-cutCounter';
    counter.style.cssText = 'font-size:10px;color:#4F6BFF;font-weight:600;display:none;white-space:nowrap;';
    wrap.appendChild(counter);

    var exportBtn = document.createElement('button');
    exportBtn.id = 'ch-cutExport';
    exportBtn.textContent = '📋';
    exportBtn.title = 'Copy price cut listings to clipboard';
    exportBtn.style.cssText = [
      'border:none',
      'background:transparent',
      'color:#6b7488',
      'cursor:pointer',
      'font-size:13px',
      'padding:2px 4px',
      'display:none',
    ].join(';');
    exportBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (cutListings.length === 0) return;
      var lines = ['Address\tPrice\tCut'];
      for (var i = 0; i < cutListings.length; i++) {
        lines.push(cutListings[i].addr + '\t' + cutListings[i].price + '\t' + cutListings[i].cut);
      }
      navigator.clipboard.writeText(lines.join('\n')).then(function() {
        exportBtn.textContent = '✓';
        setTimeout(function() { exportBtn.textContent = '📋'; }, 1500);
      });
    });
    wrap.appendChild(exportBtn);

    return wrap;
  }

  var FILTER_BAR_SELECTORS = [
    '[class*="search-bar"] [class*="filters"]',
    '[data-testid="search-bar-container"]',
    '[class*="FilterBar"]',
    '[class*="filter-bar"]',
    '[class*="searchControls"]',
    '[class*="ListHeader"]',
    '[class*="search-page-list-header"]',
    '[class*="StyledSearchFilterBar"]',
    '[class*="HomeListHeader"]',
  ];

  function findFilterBar() {
    for (var i = 0; i < FILTER_BAR_SELECTORS.length; i++) {
      var el = document.querySelector(FILTER_BAR_SELECTORS[i]);
      if (el) return el;
    }
    var allBtns = document.querySelectorAll('button');
    var pillBtns = [];
    for (var j = 0; j < allBtns.length; j++) {
      var txt = (allBtns[j].textContent || '').trim();
      if (/^(For Sale|For Rent|Price|Beds|Home Type|More|All filters|Baths)$/i.test(txt)) {
        pillBtns.push(allBtns[j]);
      }
    }
    if (pillBtns.length >= 2) return pillBtns[0].parentElement;
    return null;
  }

  function inject() {
    if (location.pathname.indexOf('/homedetails/') !== -1 || !isSearchPage()) return;
    if (document.getElementById('ch-priceCutBar')) return;
    var bar = findFilterBar();
    var widget = buildWidget();
    if (bar) {
      bar.appendChild(widget);
    } else {
      widget.style.cssText += ';position:fixed;top:60px;right:12px;z-index:99999;box-shadow:0 2px 8px rgba(0,0,0,.25);';
      document.body.appendChild(widget);
    }
  }

  function onUrlChange() {
    if (location.pathname.indexOf('/homedetails/') !== -1 || !isSearchPage()) {
      disarmDomWatch();
      var stale = document.getElementById('ch-priceCutBar');
      if (stale) stale.remove();
      return;
    }
    armDomWatch();
    var pnl = document.getElementById('ch-cutsPanel');
    if (pnl) pnl.remove();
    dataCuts = [];   
    if (filterActive) {
      removeFilter();
      var btn = document.getElementById('ch-cutToggle');
      if (btn) {
        btn.style.background = 'transparent';
        btn.style.color = '#3d465c';
        btn.textContent = '✂ Price Cuts Only';
      }
    }
    setTimeout(function() { inject(); }, 800);
  }

  var _push    = history.pushState.bind(history);
  var _replace = history.replaceState.bind(history);
  history.pushState    = function() { _push.apply(history, arguments);    setTimeout(onUrlChange, 100); };
  history.replaceState = function() { _replace.apply(history, arguments); setTimeout(onUrlChange, 100); };
  window.addEventListener('popstate', function() { setTimeout(onUrlChange, 100); });

  var attempts = 0;
  var tryInject = setInterval(function() {
    inject();
    attempts++;
    if (document.getElementById('ch-priceCutBar') || attempts > 20) {
      clearInterval(tryInject);
    }
  }, 500);

  var reapplyTimer = null;
  var domWatch = new MutationObserver(function(mutations) {
    if (/\/homedetails\//.test(location.pathname) || !isSearchPage()) return;
    if (!document.getElementById('ch-priceCutBar')) inject();
    if (filterActive) {
      var hasNewCards = false;
      for (var i = 0; i < mutations.length && !hasNewCards; i++) {
        for (var j = 0; j < mutations[i].addedNodes.length; j++) {
          var node = mutations[i].addedNodes[j];
          if (node.nodeType === 1 && (node.matches?.('article, [data-testid="property-card"], li') || node.querySelector?.('[data-testid="property-card"]'))) {
            hasNewCards = true;
            break;
          }
        }
      }
      if (hasNewCards) {
        clearTimeout(reapplyTimer);
        reapplyTimer = setTimeout(reapplyToNewCards, 300);
      }
    }
  });
  var domWatchArmed = false;
  function armDomWatch() {
    if (domWatchArmed) return;
    if (location.pathname.indexOf('/homedetails/') !== -1 || !isSearchPage()) return;
    domWatch.observe(document.body, { childList: true, subtree: true });
    domWatchArmed = true;
  }
  function disarmDomWatch() {
    if (!domWatchArmed) return;
    domWatch.disconnect();
    domWatchArmed = false;
  }
  armDomWatch();

})();
