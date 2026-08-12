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
