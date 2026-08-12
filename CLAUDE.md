# CLAUDE.md — Clear Home (Zillow Buyer Toolkit)

Chrome extension (Manifest V3) that overlays AI buyer intelligence on Zillow listings: valuation reality check, deterministic offer price + seller credit, PITI/affordability, nationwide property-tax reset estimate, comps, agent license verification, risks, printable one-page report, and search-page price-cut tools.

**Version:** 1.4.1 (dual-provider + streaming latency release).
**Origin:** Built across ~12 extended Claude sessions, Apr–Aug 2026. The raw build transcripts were removed from the working tree on 2026-08-11; they remain in git history at commit `9fa4586` (`git show 9fa4586 -- clear-home-transcripts/`).

## Repository layout (as of 2026-08-11)

**The repo root IS the extension.** `manifest.json` sits at the root, so `chrome://extensions` → Developer mode → **Load unpacked** → select the `ClearHome` folder itself. Nothing to build, nothing to copy, nothing to zip. Edit a file, press reload on the Clear Home card, and the change is live.

```
ClearHome/            ← select THIS in Load unpacked
  manifest.json
  content.js  background.js  search.js  scroll.js
  settings.html  settings.js
  data/  icons/  tests/
  README.md  RELEASE_NOTES.md  CLAUDE.md
```

Rules that follow from this:

- **No versioned source folders, ever.** The old `clear-home-vX.Y.Z/` copies and the `extension/` subfolder are gone. Releases are git tags/commits, not folder copies. The version string lives in `manifest.json`, `README.md`, `RELEASE_NOTES.md`, and the `tests/smoke.js` assertion — bump all four together.
- **No zip step in the dev loop.** A zip is only ever produced when uploading to the Chrome Web Store, from a clean checkout. Nothing in this repo depends on one.
- **Anything added to the root ships inside the extension.** Keep the root to extension files plus the few docs. Scratch files, exports, and transcripts do not belong here — that is why the transcript bundle and session export were removed on 2026-08-11 (recoverable from git history, commit `9fa4586`).
- Chrome holds file handles on the loaded unpacked folder, so renaming or deleting files while Chrome has the extension loaded can fail with a lock error. Same for leaving a PowerShell `Set-Location` inside the folder.

Git: repo initialized 2026-08-11 (`main`), no remote yet. `.gitignore` excludes `*.zip` and `.claude/settings.local.json`; `.gitattributes` normalizes line endings to LF.

---

## File map

| File | Lines | Role |
|---|---|---|
| `content.js` | ~7,130 | Zillow detail-page scraper, scroll/expand engine, panel UI (Shadow DOM), **direct provider API call + SSE streaming**, Mortgage Rate Lab, print view, diagnostics log |
| `background.js` | ~3,820 | Service worker: prompt builder (`analyzeProperty`), deterministic engines (offer, tax, affordability, market temp), finalize/parse + JS-value injection, prefetched lookups, FL DBPR license fetch |
| `search.js` | ~820 | Zillow search-page tools: price-cut card filter, data-driven All Cuts panel, map pin filter |
| `scroll.js` | 79 | MAIN-world scroll driver (`.layout-container-desktop` → bottom), event `_ch_scroll_smart_done` |
| `settings.js` / `settings.html` | ~300/~660 | Options page (LexiSwap blue/slate), provider + per-provider keys, profile, model/effort/Fast Mode selectors |
| `tests/smoke.js` | 35 | Node assertion harness — pins version, provider wiring, and the 1.4.x fixes so they can't silently regress |
| `data/county_property_tax_2026_nationwide.csv` | — | County tax rates for the tax engine |

## Architecture / data flow

1. User clicks Analyze → `expandPriceHistory()` scrolls to true bottom, expands all "show more", **captures lazy-loaded content while mounted** (Zillow unmounts bottom sections on scroll-up — this is the root cause behind most historical scrape bugs).
2. **Early-scrape prefetch (1.4.1):** while expansion is still running, content fires `PREFETCH_ANALYSIS_LOOKUPS` (content.js:3961) with a partial scrape; background `getAnalysisLookupPromises()` (background.js:1549) starts county/license/MLS lookups and caches them by exact identifier. The prompt builder reuses a cached promise **only if the identifiers match**. The final scrape stays authoritative.
3. `scrapeListing()` → `scrapeZillow()` reads NEXT_DATA + captured snapshots (`_chRenderedText`, `_chDeepText`, `_chNearbyHomes`, `_chDescription`, agent bank).
4. Content sends `BUILD_PROMPT` → background `analyzeProperty()` computes ALL numbers in JS (offer, seller credit, tax, PITI, market temp, conditional flags) and builds the prompt.
5. **Content.js calls the provider API directly and streams it** (MV3 service workers die ~30s; never move the API call to background). `readProviderStream()` (content.js:4225) parses SSE from either provider and drives live progress.
6. Content sends `FINALIZE_RESULT` → background parses (fence-strip, brace-slice, per-key recovery) and **injects/overrides every JS-owned number** into the result.
7. Panel renders; some display values (tax reset, PITI bar, Rate Lab) recompute client-side **at the Clear Home offer price**.

## Core principles (do not violate)

- **JS owns the numbers, AI owns the words.** Any figure the AI writes that JS can compute gets swept/overridden in finalize (PITI, seller credit, verdict, tax notes).
- **Capture during scroll.** Anything near the page bottom must be grabbed while mounted, into module globals or the sessionStorage bank.
- **Bank + stamp for fragile fields.** Agent name/phone: banked to `sessionStorage` (`chAgent_{zpid}`) the instant seen (600ms watcher + every capture path), stamped as the literal last step of `scrapeListing()`. Immune to resets/re-runs.
- **Type-based API response extraction.** Never `content[0].text` — filter blocks by `type === 'text'` (Sonnet 5 adaptive thinking prepends `thinking` blocks).
- **JS-owned fields are not requested from the model at all (1.4.1).** The prompt's `JS-OWNED OUTPUT FIELDS` rule (background.js:2444) forbids emitting `pricePerSqft` and the `buyerOpportunity` numeric/motivation keys; finalize injects `pricePerSqft`, `fairValue`, `suggestedOffer`, `aggressivenessPct`, `offerStrategy`, `motivationSignals`. Saves output tokens and removes a whole class of drift. The finalize sweeps stay as the backstop — do not delete them.
- **Provider-neutral call path.** One request builder branches on `aiProvider`; both providers stream through `readProviderStream()`. Anything provider-specific (auth header, JSON mode, token param name, service tier) belongs in that branch, not scattered through the panel code.
- **Sampling-param allowlist.** `temperature` sent ONLY to known-old models (`opus-4-6|opus-4-5|opus-4-1|opus-4-0|sonnet-4-6|sonnet-4-5|sonnet-4-0|sonnet-3|haiku-4|haiku-3|claude-3|claude-2`). New-gen models (Sonnet 5, Opus 4.7+, Fable, Mythos) 400 on it. A 400 mentioning sampling params auto-strips and retries once.
- **Critical JSON fields first.** `oneLineSummary` + `keyHighlights` lead the schema so truncation can never drop them.
- **No-repeat rule** in prompt: each fact develops in at most one of {risks, points, actions, flags}; section ownership defined in schema.

## Provider + model configuration (1.4.0/1.4.1)

- **Two providers.** `aiProvider` pref = `anthropic` (default) or `openai`. Keys are stored per provider under `ch_api_keys` in `chrome.storage.local`; a pre-1.4.0 Anthropic key migrates into the Anthropic slot. Keys never leave the device except to the selected provider.
- **Model lists** live in `PROVIDER_MODELS` (settings.js:37): Anthropic `claude-sonnet-5` (default) / `claude-opus-4-6` / `claude-opus-4-8`; OpenAI `gpt-5.6-terra` (default) / `gpt-5.6-sol` / `gpt-5.6-luna`. Content re-validates the pair and falls back to the provider default if a model/provider mismatch is stored (content.js:4141–4155). Prefs migrate `claude-sonnet-4-6` → `claude-sonnet-5` at every read site.
- **OpenAI contract:** `POST /v1/chat/completions`, `Authorization: Bearer`, `response_format: { type: 'json_object' }`, streaming. **Fast Mode** (default on, OpenAI only) sends `service_tier: 'fast'` — same model and effort, premium token pricing, auto-falls back to standard on a 400 mentioning service tier (content.js:4367).
- Effort: `analysisEffort` pref, default `low` (sent to Sonnet 5 / Opus 4.7+ / Fable / Mythos, and as the OpenAI reasoning effort). Settings has Low/Medium/High.
- `max_tokens`: buy = 14,000 (sonnet-5) / 8,000 (opus) / 6,000 else; sell = 6,000 (sonnet-5) / 3,000 else. Sonnet 5's tokenizer is ~30% denser and thinking spends from the same budget.
- Timeouts: `REQUEST_TIMEOUT_MS` = 150s for `opus` or `sol` / 120s else. Streaming reads sit inside the same end-to-end timeout and transient-error retry.

## Key subsystems

- **Agent capture:** testid element `[data-testid="attribution-LISTING_AGENT"]` → text parses (`parseListedByFromText`, `parseAgentByBrokerageAnchor`, `chParseAgentDirect`) → deep harvest (open shadow roots + same-origin iframes) → sessionStorage bank → final stamp. Feeds FL DBPR license verification (`fetchAgentLicense`, live statewide CSV).
- **Offer engine:** `computeOfferPrice` — FHFA/comp/Zestimate-weighted fair value, motivation-based aggressiveness, regional `MARKET_TEMP`, seller credit = price × pct tier (aggressiveness ≥15→3.0%, ≥12→2.5%, ≥8→2.0%, ≥5→1.5%, else 1.0%; −0.5% hot market), rounded $500.
- **Tax engine:** actual record rate else county median × 2.0 new-owner multiplier; FL 90% assessment + $50K homestead. Client recomputes After-Reset/Est. Assessed/monthly **at offer price** via `taxEstimate.rateUsed`/`exemptionTotal`.
- **Verdict (JS-owned):** `pricePerSqft.verdict` computed in finalize from LISTED $/sqft vs comp median (>15% Well Overpriced, >5% Above, ±5% At, <−5% Below). Never from the offer.
- **PITI sweep:** finalize computes PITI at offer (P&I amortized + tax + insurance recomputed at offer) and force-replaces any $ adjacent to "PITI" in prose. The affordability meta now carries `insurancePct` (background.js: `insurancePct: profile.insurancePct || 0`), so sweep and UI share one insurance basis.
- **Mortgage Rate Lab (1.4.0):** slider `#ch-rate-lab` (content.js:5389) moves the rate in 0.125 steps and re-renders PITI and monthly cash remaining instantly via `calcPITIBreakdown(barPrice, rate)`. Pure client-side, no API call.
- **Search page:** 3-layer results parser — `__NEXT_DATA__` → `mobileSearchPageStore` script (strip `<!-- -->`) → balanced-bracket extraction of `"listResults"`/`"mapResults"` from raw HTML. Cut detection: `variableData.type === 'PRICE_REDUCTION'` OR `homeInfo.priceChange < 0` (synthesized badge). Panel = dark theme (`#1a1a2e`, `#a5b4fc` accents), sorted by cut size, copy export. Map pins matched numerically with tolerance (labels are K/M-rounded). Debug counts in `_chCutsDebug` + console `[ClearHome cuts]`.
- **Print:** one page when possible — everything after Property Info flows 2-column, 8.75px, truncation at sentence boundary (~180 chars), lists cap 4, then **scale-to-fit**: measures `scrollHeight`, zooms body to one page if ≤140% of 1005px, else prints front/back.
- **Diagnostics (📥):** SCRAPED FIELDS AUDIT with [x] coverage + RED FLAGS, AGENT CAPTURE DEBUG (bank, stamp, sources), raw API response (full only on parse failure, else 2KB), model header.

## Build / verify

Run from the repo root (PowerShell):

```bash
node --check content.js; node --check background.js; node --check search.js; node --check settings.js; node tests/smoke.js
```

`tests/smoke.js` is the regression gate: it pins the manifest version, both providers' host permissions, the provider/model/Fast Mode wiring, streaming, prefetch, the Rate Lab, and the specific 1.4.0 bug fixes. **Bump the version assertion when you bump the manifest, and add an assertion for every bug you fix** — that is how the old bug log stopped rotting.

Release: bump `manifest.json` + `README.md` + `RELEASE_NOTES.md` + the smoke assertion, run the checks above, commit, and tag. There is no packaging step in the dev loop — Chrome runs the working tree directly. Only a Web Store submission needs a zip, built from a clean checkout at that moment.

No build step, no deps. Unit-test parse helpers with inline `node -e` harnesses (pattern used throughout transcripts).

Environment (verified 2026-08-11): `node` (C:\Program Files\nodejs) and `git` (C:\Program Files\Git) are both on PATH in PowerShell. Repo is git-initialized on `main` with no remote. The July 2026 note claiming node was missing is obsolete.

Primary test listings: a set of Winter Garden and Kissimmee FL listings the owner keeps for regression runs, including the agent-capture proving ground that surfaced every capture bug. Keep real agent names, phone numbers, and addresses out of this repo — it is public. Use placeholders (`Jane Agent`, `EXAMPLE REALTY LLC`, `555-555-0101`) in comments and docs.

## Locked features — do not regress

**v1.2.0:** mode detection (buy/sold/rent); regional market temp; affordability single-bar + exact-dollar PITI; ONE of premium.explanation OR val.rationale renders; PARSE_ERROR recovery; search price-cut filter; nationwide tax engine; Download Logs; tiered comp matching (beds+baths→beds→sqft-band→all); LexiSwap blue/slate restyle; keep-alive + `sendWithTimeout`; per-model timeouts.

**v1.4.x:** dual-provider (OpenAI + Anthropic) with per-provider key storage; SSE streaming with live progress on both providers; Fast Mode with graceful fallback; early-scrape lookup prefetch with identifier-matched cache; Mortgage Rate Lab; JS-owned fields excluded from the prompt and injected locally. The thorough post-expansion scrape stays authoritative — **latency work must never trade away scrape coverage.**

## User-facing copy rules (1.4.2)

The panel talks about **the house, not the machine**. No mention of tokens, characters generated, models, providers, effort levels, or "the AI is thinking" in any user-visible string. The activity feed names the work being done ("Fetching tax records…", "Writing up the findings…"). Failures state what happened in plain words and what to do next ("The analysis was cut off before it finished. Click Analyze to run it again."), never the provider's internal reason. The one exception is the legal disclaimer, which must keep saying the analysis is AI-generated. Model and provider details belong in Settings and the diagnostics log, where someone has gone looking for them.

---

## BUG LOG

Bugs 1, 2, 3, 4, 5, 7 and 10 from the 1.3.0 audit were **fixed in 1.4.0** and are pinned by assertions in `tests/smoke.js` (insurancePct in meta, offer-basis tax badges, badge-explaining Price Reality copy, `if (!filterActive) restoreMapPins();`, guarded `img.src`). Do not reopen them without a failing smoke run. Bug 7 (floor-plan effort) is moot — the feature was pulled in 1.4.2.

**Fixed in 1.4.2:** `showErrorState()` had three `errEl.textContent` assignments stacked in the same `else if` branch, so every network error rendered the last one ("Complex listings occasionally hit token limits"). Split into distinct network / timeout / truncation branches.

### Open (re-verified against source 2026-08-11)

1. **LOW — Stale cuts.** The `priceChange < 0` fallback (search.js:388–397) still admits old/pre-relist cuts alongside authoritative `variableData.type === 'PRICE_REDUCTION'`. Unchanged in 1.4.x. Still a recall-vs-precision product decision, not a defect — decide, then encode it.
2. **INFO — `taxRateBasis` computed but never displayed.** Set on the result (background.js:380) and in the prompt (background.js:1742), but no render site in content.js; the UI recomputes from `tax.rateUsed` (content.js:4964). It only reaches users through `_diag`. Either surface it in the tax section or accept it as diagnostics-only.
3. **INFO — print Property Info strip alignment.** `.ch-prop-meta-strip` is `text-align: right` (content.js:6727) while `.section:first-child .section-body` is `text-align: left` (content.js:6728) — the override may or may not apply in the print flow. Needs an actual print to confirm; do not "fix" it blind.

Verified false alarms (keep them closed): log's `scraped` var is defined; the `keyHighlights` PITI sweep is load-bearing, not dead code (the prompt still asks for PITI there) — **do not delete it**; `effort` param name is docs-verified. Older audit FLAG 2 (mlsId/daysOnMarket/price NEXT_DATA-vs-DOM precedence) remains open by choice.

## v2.0.0 ROADMAP

Shipped since the roadmap was written: **streaming** (1.4.1) and the **Rate Sensitivity Slider**, which shipped as the Mortgage Rate Lab (1.4.0). Still coming-soon and excluded below: prompt caching, MAIN-world GraphQL interceptor, JS-localized tax/affordability notes.

### Pulled in 1.4.2 and reserved for the 2.0 launch

Both were cut from the shipping build on 2026-08-12 to keep the panel to things that work today. **These are deliberate holds, not abandoned code — they are the headline features to advertise at 2.0.** Recover the implementations from git history at commit `c88a9ff` (the commit before the removal).

- **Floor Plan Estimator** — photo-based room-by-room estimate with an SVG plan, built on up to 80 hash-deduped listing photos and grounded against scraped bed/bath/sqft facts. Worked, but slow and expensive on an 80-image vision call, and the output quality was a rough first pass. Bring it back when it earns its runtime: fewer, better-chosen photos and a tighter grounding pass. The `fp/{hash}` dedupe trick (Zillow serves ~6 size variants per photo; prefer ~1024px) is the non-obvious part worth keeping.
- **Provider referrals** — Find Inspector, Title Quote, Talk to Lender, FSBO Help. The buttons and the "matching you with a verified provider" modal were UI-only; nothing was ever wired to a provider network. This is the **advertising/monetization surface** for 2.0, so it needs real partners behind it before it goes back in. The `referral_clicked` event was already being logged, and the Settings stats card for it was removed with the buttons.

1. **Compare Tray** — pin 2–4 analyzed homes; side-by-side verdict/offer/PITI/tax/risks; one-page comparison print.
2. **Offer Package Generator** — LOI/email to listing agent (name+phone now captured) pre-filled with offer, credit, contingencies, comp justification.
3. **Watchlist + re-analysis diffs** — persist analyses; re-scrape on revisit/alarm; "Δ since your analysis: new $10K cut, offer now $X".
4. **Cash-to-Close Calculator** — FL doc stamps, title, lender fees, prepaids + down + inspection est. keyed to found red flags → one liquid-needed figure.
5. **Comps You Control** — include/exclude checkboxes, instant JS re-run of valuation/offer (no API call).
6. **Search-Page Mini-Verdict** — price-vs-comp-median badge on cards from search JSON, zero AI calls.
7. **Insurance Risk Module (FL-first)** — FEMA flood zone + roof age → insurability flag + premium range feeding the PITI insurance line.
8. **Cross-Site Parity** — full analyzer on Redfin/Realtor (stubs exist), address-level dedupe.
9. **Shareable Report** — one-pager as PDF/share link (print pipeline done).

**Recommended v2.0.0 spine:** Compare Tray + Watchlist Diffs + Cash-to-Close — converts "analyze a listing" into "run my home search here."

## Working conventions (owner preferences)

- Plain, short, direct copy — no AI-sounding verbiage, no marketing tone, no tricolons, minimal em-dashes.
- On any failure, state the specific reason, never a generic message.
- Stage new builds single-file HTML first where applicable; client-side-first; BYOK; no build steps.
- Validate with headless Node before delivery; unit-test parse helpers against exact real-world strings from diagnostic logs.
- Diagnostic-log-driven debugging: reproduce → instrument → log → fix (never guess blind; the agent-capture saga is the case study).
- Work in the repo root and commit. No version-copy folders, no zip in the loop; git history is the archive now.
- **This repo is public.** No real agent names, phone numbers, addresses, or zpids in code comments, docs, or commit messages. Use `Jane Agent`, `EXAMPLE REALTY LLC`, `555-555-0101`. Do not ask whether to scrub real data found here — scrub it.
- README voice: plain and short, aimed at someone deciding whether to use it. No internals (weighting formulas, tier fallbacks, token budgets, sweep mechanics). Oxford comma throughout.
- Every bug fix gets a `tests/smoke.js` assertion so the fix can't silently regress and the bug log stays honest.
