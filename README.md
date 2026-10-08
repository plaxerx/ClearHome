# Clear Home

Dive Zillow listings and get the recommended offer price to bring to the table. Receive information on the home that may not necessarily be in the listing and provide meaningful questions to the seller and actionable follow-ups following a potential bid.

**Pre-Alpha.** Not present on the Chrome Web Store. Load it unpacked manually and bring your own API key.

Everything happens in the Chrome side panel. Click the Clear Home icon to open it, click it again to close it. Nothing is drawn on top of the Zillow page.

| Modes | Where | What you get |
|---|---|---|
| **For Sale** | Any for-sale Zillow listing | A price verdict against comps, an offer price with a seller credit to ask for, the property-tax reset, full PITI, and the risks worth asking about |
| **Sold** | A sold listing | Price history, what it actually went for, and FHFA appreciation since |
| **For Rent** | A rental listing | Rent Zestimate check, landlord, and owner-of-record cross-check |
| **Search page** | Zillow search results | Filter the map and home listings down to the ones with price cuts only |

Offer price, seller credit, tax reset, PITI, DTI, and the price-per-square-foot verdict are all calculated using public data and county tax tables.

## The offer price

Fair value is weighted from FHFA appreciation on the last sale, comparable sales, and the Zestimate. Aggressiveness of bid comes from seller motivation signals: days on market, price cuts, whether it's vacant, estate, or relocation language in the description.

Comparables attempt to best match beds and baths first then a square-footage band.

## The property tax estimate

Your taxes are not the seller's taxes. Clear Home uses the actual recorded millage rate when it can find one, otherwise it estimates the county median with a new-owner multiplier, and shows you the assessed value and monthly payment at the Clear Home offer price, alongside provided exemption numbers from the settings.

## Your analyses are kept

A finished analysis is saved to your browser and comes back when you reopen the panel. It survives printing, switching tabs, closing the side panel, and restarting Chrome. The last eight are kept, one per listing. They never leave your machine.

## Requirements

A key from one of these providers. The provider you pick sets the model:

- **Anthropic** — Sonnet 5
- **OpenAI** — GPT-5.6 Terra

## Installation

1. Download or clone this repo
2. Open `chrome://extensions`
3. Turn on **Developer mode**, top right
4. **Load unpacked**, select the folder
5. Click the Clear Home icon, open Settings, pick your provider, and paste the key

There is no build step. The repository is the extension.

## What it costs you

Nothing currently, but you pay for the API calls. Nothing is sent until you click Analyze, and no private data outside of the ones provided in the settings are collected. Runs cost roughly 5 to 20 cents per analysis.

## How it's put together

| File | Role |
|---|---|
| `manifest.json` | The extension manifest, at the repository root |
| `sidepanel.html`, `sidepanel.js` | The side panel: every piece of interface you see and click |
| `content.js` | Reads the Zillow page, calls your provider, and computes every number |
| `background.js` | Builds the prompt, runs the offer, tax, and affordability engines, and fetches public records |
| `search.js` | The price-cut tools on Zillow search results |
| `settings.html`, `settings.js` | Settings, shown inside the side panel |
| `data/` | County property-tax rates |
| `tests/smoke.js` | Regression checks, run with `node tests/smoke.js` |

The page is read and the numbers are computed locally. The language model is given those numbers and asked for the wording, never for the arithmetic.

## Known limits

It's a language model interpreting a sales listing. This is not an appraisal, a loan approval, an inspection, or legal advice.

- Zillow only for the full analysis. Redfin and Realtor are currently not finished.
- The extension does a thorough manual capture of the Zillow listing utilizing the pop-up and html text alongside the underlying code. This causes the screen to scroll down automatically briefly to load the necessary text and then runs for about a minute or so to complete the analysis.
- Agent license verification is Florida only right now, and it matches on name alone, so a common name can return the wrong licensee. Treat it as a prompt to check, not as proof.
- When too few similar homes are found, the comparison falls back to whatever nearby homes exist, and the offer price is only as good as those.
- The county tax table is a 2026 snapshot.
- Comps come from Zillow's nearby homes.

## Coming in 2.0

Ability to use on other websites, enhanced map filtering, cash-to-close, paid referrals, and a floor plan estimator.

## Credits

Made by [plaxerx](https://github.com/plaxerx), with development assistance from an AI.

## License

GPL-3.0, see [LICENSE](LICENSE).
