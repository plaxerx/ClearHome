# Clear Home 1.4.6 release notes

## Fixed

- **Analyses survive now.** Printing to PDF and closing the tab used to throw away the analysis you paid for: switching away from the listing tab told the panel there was no listing, and it cleared the results. Finished analyses are saved and restored, so they survive a tab switch, closing the panel, and a browser restart. The last eight are kept, keyed by listing.
- **"Show more" on comparable sales works.** The button used an inline `onclick`, which an extension page's content security policy blocks. It is wired up in the panel now. It also said "Show N more" with the count one too low.

---

# Clear Home 1.4.5 release notes

## Fixed

- **The listing card could show a different home's address.** 1.4.4 read the first `streetAddress` it found in Zillow's page data, which also contains nearby homes, comps, and recommendations — on the 9560 Bolero Rd listing it showed a neighbouring property. The address now comes from the `/homedetails/` URL, which is the only source guaranteed to describe the home you are looking at. The page title is still preferred for its formatting, but only when it agrees with that URL.

---

# Clear Home 1.4.4 release notes

Version 1.4.4 fixes three things reported against the 1.4.3 side panel.

## Fixed

- **Nothing in the analysis was clickable.** Print, Download Logs, and the section expanders rendered but ignored clicks. The analysis stylesheet holds the panel at `pointer-events: none` until it gets the `visible` class, which used to be added by the popup's entry animation; the side panel now sets it, and the panel's own stylesheet guarantees interactivity regardless.
- **The panel chrome stayed light while the analysis went dark.** The analysis follows the system colour scheme on its own, so the header, listing card, and progress feed disagreed with it. The shell now carries the same ink/slate palette, and an explicit Light or Dark choice in Settings applies to both.
- **The listing card sometimes showed the search headline** ("Winter Garden FL Real Estate — …") instead of the address. The page title is only used when it reads like a street address; otherwise the card says "Detecting address…" and keeps looking as the page settles.

---

# Clear Home 1.4.3 release notes

Version 1.4.3 moves Clear Home out of the web page. Everything now lives in the Chrome side panel.

## The panel moved

- **The floating card on the listing is gone.** Nothing is mounted in the Zillow page any more. Click the Clear Home icon to open the side panel; click it again to close it.
- The side panel names the home you have open and holds the Analyze button, the progress feed, the finished analysis, Print, Download Logs, and the Mortgage Rate Lab.
- The analysis reads the same as before. The content script still does the scraping, the provider call, and every number; it renders the panel and hands it to the side panel to display.
- Settings opens inside the side panel instead of a new tab.

## Settings

- **The AI Model dropdown is gone.** Picking a provider picks the model: Anthropic runs Sonnet 5, OpenAI runs GPT-5.6 Terra.

## Price cuts

- The Price Cuts Only bar and the All Cuts panel use the same light blue-and-slate scheme as the side panel. They were still dark against Zillow's white chrome.
- The price-cut tools now appear on searches for hyphenated cities. `isSearchPage()` only matched single-word city names, so `/Winter-Garden-FL/` and `/Haines-City-FL/` silently had no bar.

---

# Clear Home 1.4.2 release notes

Version 1.4.2 trims the panel to what actually works and takes the machine out of the copy.

## Removed

- **Floor plan estimator.** Held for the 2.0 release. The 80-photo vision call was the slowest and most expensive thing in the extension and returned a rough first pass.
- **Referral buttons** (Find Inspector, Title Quote, Talk to Lender, FSBO Help). They opened a "coming soon" modal and were never wired to a provider. Held for 2.0, when there are real partners behind them.
- The Referrals counter in Settings, which only ever counted clicks on those buttons.

## Copy

- The progress feed no longer narrates the model. "AI is writing the analysis" and the running character count are gone; it names the work instead.
- Failure messages dropped the token jargon. They say what happened and what to do next.
- The trigger card no longer advertises which AI provider is selected, and the no-key prompt no longer names one provider now that two are supported.

## Fixed

- `showErrorState()` stacked three message assignments in one branch, so every network error displayed the truncation message instead. Network, timeout, and truncation are now distinct.

---

# Clear Home 1.4.1 release notes

Version 1.4.1 is a focused latency release. It shortens the critical path without changing the selected AI model, lowering the configured reasoning effort, or weakening listing capture.

## Faster analysis

- OpenAI Fast Mode is enabled by default and requests the `fast` service tier. It keeps the same model and output quality, uses premium token pricing, and falls back to standard service if unavailable.
- OpenAI and Anthropic calls use SSE streaming. Clear Home shows real generation progress as text arrives and retains the same finalized JSON contract.
- Public-record, agent-license, and MLS lookups begin from an early scrape while Zillow's full page expansion is still running. The final scrape remains authoritative.
- Lookup promises use exact identifiers and a short in-memory cache, so the prompt builder reuses only matching work.
- Deterministic offer, motivation, comparable-median, and price-per-square-foot values are no longer requested from the model. Clear Home continues to inject those locally from its existing calculations, reducing generation time and eliminating redundant AI work.

## Quality safeguards

- The page scroll and expansion strategy is unchanged.
- The selected provider, model, and reasoning-effort setting are unchanged.
- All valuation narrative, risk analysis, negotiation reasoning, price-history interpretation, and buyer actions remain model-generated.
- Stream reading is covered by the existing end-to-end timeout and transient-error retry behavior.

## Compatibility

- OpenAI uses the Chat Completions API with Bearer authentication, JSON mode, streaming, and optional Fast Mode.
- Anthropic remains fully supported with streaming Messages API responses.
- Versions 1.4.0 and 1.3.0 were retired from the working tree when the repository flattened to a single loadable extension at its root. Git history and the owner's separate archive are the reference if an older build is needed.
