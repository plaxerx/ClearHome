# Clear Home

Dive Zillow listings and get the recommended offer price to bring to the table. Receive information on the home that may not necessarily be in the listing and provide meaningful questions to the seller and actionable follow-ups following a potential bid.

**Pre-Alpha.** Not present on the Chrome Web Store. Load it unpacked manually and bring your own API key.

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

## Requirements

A key from one of these providers:

- **Anthropic** — `claude-sonnet-5`, with Opus 4.6 and 4.8 selectable
- **OpenAI** — `gpt-5.6-terra` by default, with `gpt-5.6-sol` and `gpt-5.6-luna` selectable

## Installation

1. Download or clone this repo
2. Open `chrome://extensions`
3. Turn on **Developer mode**, top right
4. **Load unpacked**, select the folder
5. Click the Clear Home icon, pick your provider, paste the key

## What it costs you

Nothing currently, but you pay for the API calls. Nothing is sent until you click Analyze, and no private data outside of the ones provided in the settings are collected. Runs cost roughly 5 to 20 cents per analysis.

## Known limits

It's a language model interpreting a sales listing. This is not an appraisal, a loan approval, an inspection, or legal advice.

- Zillow only for the full analysis. Redfin and Realtor are currently not finished.
- The extension does a thorough manual capture of the Zillow listing utilizing the pop-up and html text alongside the underlying code. This causes the screen to scroll down automatically briefly to load the necessary text and then runs for about a minute or so to complete the analysis.
- Agent license verification is Florida only right now.
- The county tax table is a 2026 snapshot.
- Comps come from Zillow's nearby homes.

## Coming in 2.0

Ability to use on other websites, enhanced map filtering, cash-to-close, paid referrals, and a floor plan estimator.

## Credits

Made by [plaxerx](https://github.com/plaxerx), with development assistance from an AI.

## License

GPL-3.0, see [LICENSE](LICENSE).
