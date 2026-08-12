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

assert.equal(manifest.version, '1.4.2');
assert(manifest.host_permissions.includes('https://api.openai.com/*'));
assert(manifest.host_permissions.includes('https://api.anthropic.com/*'));

assert(settingsHtml.includes('id="ai-provider-select"'));
assert(settingsHtml.includes('id="ai-fast-mode-toggle"'));
assert(settings.includes("['gpt-5.6-terra', 'GPT-5.6 Terra']"));
assert(settings.includes('ch_api_keys'));
assert(background.includes("const provider = syn.ch_prefs?.aiProvider === 'openai' ? 'openai' : 'anthropic'"));

assert(content.includes("https://api.openai.com/v1/chat/completions"));
assert(content.includes("'Authorization': `Bearer ${apiKey}`"));
assert(content.includes("response_format: { type: 'json_object' }"));
assert(content.includes("service_tier: 'fast'"));
assert(content.includes('readProviderStream'));
assert(content.includes("type: 'PREFETCH_ANALYSIS_LOOKUPS'"));
assert(content.includes("id=\"ch-rate-lab\""));
assert(content.includes('calcPITIBreakdown(barPrice, rate)'));

assert(background.includes('insurancePct:         profile.insurancePct || 0'));
assert(background.includes('Keep tax badges, numbers, and prose on the Clear Home offer basis.'));
assert(background.includes("msg.type === 'PREFETCH_ANALYSIS_LOOKUPS'"));
assert(background.includes('getAnalysisLookupPromises(listingData)'));
assert(background.includes('JS-OWNED OUTPUT FIELDS'));
assert(search.includes('if (!filterActive) restoreMapPins();'));
assert(search.includes("if (c.img) img.src = c.img;"));

// 1.4.2 — features pulled and held for 2.0. These stay out of the shipping
// build until they are real; see the roadmap section in CLAUDE.md.
assert(!content.includes('ch-floorplan-btn'), 'floor plan button must stay removed');
assert(!content.includes('showFloorPlanResult'), 'floor plan renderer must stay removed');
assert(!content.includes('scrapeAllListingPhotos'), 'floor plan photo scraper must stay removed');
assert(!background.includes('ESTIMATE_FLOORPLAN'), 'floor plan message handler must stay removed');
assert(!content.includes('data-referral'), 'referral buttons must stay removed');
assert(!content.includes('showReferralModal'), 'referral modal must stay removed');
assert(!settingsHtml.includes('stat-referrals'), 'referral stat card must stay removed');

// 1.4.2 — the panel talks about the house, not the machine.
assert(!content.includes('AI is writing'), 'no AI narration in the activity feed');
assert(!/Analysis draft: \$\{/.test(content), 'no generated-character counter in the activity feed');
assert(!/token limit/i.test(content), 'no token jargon in user-facing copy');
assert(!content.includes('Uses your selected AI provider'), 'no provider name on the trigger card');
// The legal disclaimer must still disclose AI involvement.
assert(content.includes('generated with the assistance of AI'), 'AI disclosure must remain');

console.log('Clear Home 1.4.2 smoke checks passed.');
