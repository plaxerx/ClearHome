// Clear Home — Settings Script v1.4.1

const toggleEnabled  = document.getElementById('toggle-enabled');
const apiKeyInput    = document.getElementById('api-key-input');
const apiKeyLabel    = document.getElementById('api-key-label');
const aiProviderSelect = document.getElementById('ai-provider-select');
const keyEyeBtn      = document.getElementById('key-eye-btn');
const keyStatus      = document.getElementById('key-status');
const themeBtns      = document.querySelectorAll('[data-theme]');
const clearStatsBtn  = document.getElementById('clear-stats-btn');
const profileStatus  = document.getElementById('profile-status');
const priorityGrid   = document.getElementById('priority-grid');

// Profile fields
const annualIncome    = document.getElementById('annual-income');
const monthlyTakehome = document.getElementById('monthly-takehome');
const monthlyHousing  = document.getElementById('monthly-housing');
const monthlyUtil     = document.getElementById('monthly-utilities');
const monthlyDebts    = document.getElementById('monthly-debts');
const monthlyDisc     = document.getElementById('monthly-discretionary');
const downPaymentPct  = document.getElementById('down-payment-pct');
const mortgageRate    = document.getElementById('mortgage-rate');
const insurancePct    = document.getElementById('insurance-pct');
const monthlyIns      = document.getElementById('monthly-insurance');
const homesteadExempt = document.getElementById('homestead-exemption');
const transferExempt  = document.getElementById('transfer-exemption');
const priceCheckMode  = document.getElementById('price-check-mode');
const offerStrategy   = document.getElementById('offer-strategy');
const aiModelSelect   = document.getElementById('ai-model-select');
const aiFastToggle    = document.getElementById('ai-fast-mode-toggle');
const aiFastModeRow   = document.getElementById('ai-fast-mode-row');
const floodToggle     = document.getElementById('flood-insurance-toggle');
const commuteStatus   = document.getElementById('commute-status');
let activeProvider = 'anthropic';
let apiKeys = { anthropic: '', openai: '' };

const PROVIDER_MODELS = {
  openai: [
    ['gpt-5.6-terra', 'GPT-5.6 Terra'],
    ['gpt-5.6-sol', 'GPT-5.6 Sol'],
    ['gpt-5.6-luna', 'GPT-5.6 Luna']
  ],
  anthropic: [
    ['claude-sonnet-5', 'Sonnet 5'],
    ['claude-opus-4-6', 'Opus 4.6'],
    ['claude-opus-4-8', 'Opus 4.8']
  ]
};

function renderProviderSettings(preferredModel) {
  activeProvider = aiProviderSelect?.value === 'openai' ? 'openai' : 'anthropic';
  if (apiKeyLabel) apiKeyLabel.textContent = activeProvider === 'openai' ? 'OpenAI API Key' : 'Anthropic API Key';
  apiKeyInput.placeholder = activeProvider === 'openai' ? 'sk-…' : 'sk-ant-api03-…';
  apiKeyInput.value = apiKeys[activeProvider] || '';
  keyStatus.textContent = apiKeyInput.value ? 'API key saved ✓' : 'Enter your API key to enable AI analysis.';
  keyStatus.className = apiKeyInput.value ? 'key-status saved' : 'key-status';
  if (aiModelSelect) {
    aiModelSelect.innerHTML = PROVIDER_MODELS[activeProvider]
      .map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
    const allowed = PROVIDER_MODELS[activeProvider].some(([value]) => value === preferredModel);
    aiModelSelect.value = allowed ? preferredModel : (activeProvider === 'openai' ? 'gpt-5.6-terra' : 'claude-sonnet-5');
  }
  if (aiFastToggle) aiFastToggle.disabled = activeProvider !== 'openai';
  if (aiFastModeRow) aiFastModeRow.style.opacity = activeProvider === 'openai' ? '1' : '0.55';
}

// ── Load saved settings ───────────────────────────────────────────────────────
chrome.storage.sync.get(['ch_enabled', 'ch_theme', 'ch_api_key', 'ch_profile', 'ch_priorities', 'ch_commute', 'ch_prefs'], (res) => {
  toggleEnabled.checked = res.ch_enabled !== false;

  const theme = res.ch_theme || 'system';
  themeBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.theme === theme));

  const prefs = res.ch_prefs || {};
  activeProvider = prefs.aiProvider === 'openai' ? 'openai' : 'anthropic';
  if (aiProviderSelect) aiProviderSelect.value = activeProvider;

  // Provider keys live in storage.local (device-only, not synced across machines).
  // Migrate the legacy key into the Anthropic slot.
  chrome.storage.local.get(['ch_api_key', 'ch_api_keys'], (loc) => {
    apiKeys = { anthropic: loc.ch_api_keys?.anthropic || loc.ch_api_key || res.ch_api_key || '', openai: loc.ch_api_keys?.openai || '' };
    if (!loc.ch_api_keys || res.ch_api_key) {
      chrome.storage.local.set({ ch_api_keys: apiKeys, ch_api_key: apiKeys.anthropic });
      chrome.storage.sync.remove('ch_api_key'); // remove synced copy of the secret
    }
    renderProviderSettings(prefs.aiModel);
  });

  const p = res.ch_profile || {};
  if (p.annualIncome)     annualIncome.value     = p.annualIncome;
  if (p.monthlyTakehome)  monthlyTakehome.value  = p.monthlyTakehome;
  if (p.monthlyHousing)   monthlyHousing.value   = p.monthlyHousing;
  if (p.monthlyUtilities) monthlyUtil.value      = p.monthlyUtilities;
  if (p.monthlyDebts)     monthlyDebts.value     = p.monthlyDebts;
  if (p.monthlyDiscretionary) monthlyDisc.value = p.monthlyDiscretionary;
  if (p.downPaymentPct)   downPaymentPct.value   = p.downPaymentPct;
  if (p.mortgageRatePct)  mortgageRate.value     = p.mortgageRatePct;
  if (p.insurancePct)     insurancePct.value     = p.insurancePct;
  if (p.monthlyInsurance) monthlyIns.value       = p.monthlyInsurance;
  if (p.homesteadExemption != null) homesteadExempt.value = p.homesteadExemption;
  if (p.transferExemption != null)  transferExempt.value  = p.transferExemption;

  if (Object.keys(p).length > 0) {
    profileStatus.textContent = 'Profile saved ✓';
    profileStatus.className   = 'profile-status saved';
    updateAffordabilityPreview(p);
  }

  // Load prefs
  if (priceCheckMode) priceCheckMode.value = prefs.priceCheckMode || 'fair_value';
  if (offerStrategy) offerStrategy.value = prefs.offerStrategy || 'competitive';
  const migratedModel = prefs.aiModel === 'claude-sonnet-4-6' ? 'claude-sonnet-5' : prefs.aiModel;
  renderProviderSettings(migratedModel);
  const aiEffortSelect = document.getElementById('ai-effort-select');
  if (aiEffortSelect) aiEffortSelect.value = prefs.analysisEffort || 'low';
  if (aiFastToggle)   aiFastToggle.checked = prefs.fastMode !== false;
  if (floodToggle)    floodToggle.checked  = prefs.floodInsurance || false;

  // Load commute addresses
  const commute = res.ch_commute || {};
  const commuteFields = ['work1','work2','flex1','flex2','flex3'];
  commuteFields.forEach(key => {
    const lbl = document.getElementById(`commute-${key}-label`);
    const adr = document.getElementById(`commute-${key}-addr`);
    if (lbl && commute[key]?.label) lbl.value = commute[key].label;
    if (adr && commute[key]?.addr)  adr.value  = commute[key].addr;
  });
  if (Object.keys(commute).length > 0 && commuteStatus) {
    commuteStatus.textContent = 'Addresses saved ✓';
    commuteStatus.className   = 'profile-status saved';
  }

  // Load priorities
  const saved = res.ch_priorities || [];
  priorityGrid?.querySelectorAll('.priority-chip').forEach(chip => {
    if (saved.includes(chip.dataset.priority)) chip.classList.add('active');
  });
});

// ── Load stats ────────────────────────────────────────────────────────────────
chrome.storage.local.get(['ch_events'], (res) => {
  const events = res.ch_events || [];
  document.getElementById('stat-listings').textContent  = events.filter(e => e.event === 'listing_viewed').length;
  document.getElementById('stat-analyses').textContent  = events.filter(e => e.event === 'analysis_generated').length;
});

// ── Toggle enabled ────────────────────────────────────────────────────────────
toggleEnabled.addEventListener('change', () => {
  const enabled = toggleEnabled.checked;
  chrome.storage.sync.set({ ch_enabled: enabled });
  notifyTabs({ type: 'SETTINGS_CHANGED', enabled });
});

// ── API key ───────────────────────────────────────────────────────────────────
let keyTimeout;
apiKeyInput.addEventListener('input', () => {
  clearTimeout(keyTimeout);
  keyStatus.textContent = 'Saving…';
  keyStatus.className = 'key-status';
  keyTimeout = setTimeout(() => {
    const key = apiKeyInput.value.trim();
    if (key && activeProvider === 'anthropic' && !key.startsWith('sk-ant-')) {
      keyStatus.textContent = 'Looks like an invalid key format.';
      keyStatus.className = 'key-status error';
      return;
    }
    if (key && activeProvider === 'openai' && !key.startsWith('sk-')) {
      keyStatus.textContent = 'Looks like an invalid key format.';
      keyStatus.className = 'key-status error';
      return;
    }
    apiKeys[activeProvider] = key;
    chrome.storage.local.set({ ch_api_keys: apiKeys, ch_api_key: apiKeys.anthropic || '' }, () => {
      keyStatus.textContent = key ? 'API key saved ✓' : 'API key cleared.';
      keyStatus.className   = key ? 'key-status saved' : 'key-status';
    });
  }, 600);
});

keyEyeBtn.addEventListener('click', () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
});

// ── Profile fields — auto-save on change ─────────────────────────────────────
const profileFields = [annualIncome, monthlyTakehome, monthlyHousing, monthlyUtil, monthlyDebts, monthlyDisc, downPaymentPct, mortgageRate, insurancePct, monthlyIns, homesteadExempt, transferExempt];
let profileTimeout;
profileFields.forEach(field => {
  if (!field) return;
  field.addEventListener('input', () => {
    clearTimeout(profileTimeout);
    profileStatus.textContent = 'Saving…';
    profileStatus.className   = 'profile-status';
    profileTimeout = setTimeout(saveProfile, 700);
  });
});

// ── Prefs fields — save on change ────────────────────────────────────────────
priceCheckMode?.addEventListener('change', savePrefs);
offerStrategy?.addEventListener('change', savePrefs);
aiModelSelect?.addEventListener('change', savePrefs);
document.getElementById('ai-effort-select')?.addEventListener('change', savePrefs);
aiFastToggle?.addEventListener('change', savePrefs);
floodToggle?.addEventListener('change', savePrefs);
aiProviderSelect?.addEventListener('change', () => {
  renderProviderSettings();
  savePrefs();
});

// ── Commute fields — auto-save on change ─────────────────────────────────────
let commuteTimeout;
['work1','work2','flex1','flex2','flex3'].forEach(key => {
  ['label','addr'].forEach(part => {
    document.getElementById(`commute-${key}-${part}`)?.addEventListener('input', () => {
      clearTimeout(commuteTimeout);
      if (commuteStatus) { commuteStatus.textContent = 'Saving…'; commuteStatus.className = 'profile-status'; }
      commuteTimeout = setTimeout(saveCommute, 700);
    });
  });
});

function saveProfile() {
  const profile = {
    annualIncome:         parseFloat(annualIncome?.value)     || 0,
    monthlyTakehome:      parseFloat(monthlyTakehome?.value)  || 0,
    monthlyHousing:       parseFloat(monthlyHousing?.value)   || 0,
    monthlyUtilities:     parseFloat(monthlyUtil?.value)      || 0,
    monthlyDebts:         parseFloat(monthlyDebts?.value)     || 0,
    monthlyDiscretionary: parseFloat(monthlyDisc?.value)      || 0,
    downPaymentPct:       parseFloat(downPaymentPct?.value)   || 20,
    mortgageRatePct:      parseFloat(mortgageRate?.value)     || 7.0,
    insurancePct:         parseFloat(insurancePct?.value)     || 0,
    monthlyInsurance:     parseFloat(monthlyIns?.value)       || 0,
    homesteadExemption:   parseFloat(homesteadExempt?.value)  || 0,
    transferExemption:    parseFloat(transferExempt?.value)   || 0,
    loanTermYears:        30
  };
  chrome.storage.sync.set({ ch_profile: profile }, () => {
    profileStatus.textContent = 'Profile saved ✓';
    profileStatus.className   = 'profile-status saved';
    updateAffordabilityPreview(profile);
    notifyTabs({ type: 'PROFILE_CHANGED', profile });
  });
}

function savePrefs() {
  const prefs = {
    priceCheckMode:  priceCheckMode?.value  || 'fair_value',
    offerStrategy:   offerStrategy?.value   || 'competitive',
    aiProvider:      activeProvider,
    aiModel:         aiModelSelect?.value   || (activeProvider === 'openai' ? 'gpt-5.6-terra' : 'claude-sonnet-5'),
    analysisEffort:  document.getElementById('ai-effort-select')?.value || 'low',
    fastMode:        aiFastToggle?.checked !== false,
    floodInsurance:  floodToggle?.checked   || false,
  };
  chrome.storage.sync.set({ ch_prefs: prefs }, () => {
    notifyTabs({ type: 'PREFS_CHANGED', prefs });
  });
}

function saveCommute() {
  const keys = ['work1','work2','flex1','flex2','flex3'];
  const commute = {};
  keys.forEach(key => {
    const lbl = document.getElementById(`commute-${key}-label`)?.value?.trim();
    const adr = document.getElementById(`commute-${key}-addr`)?.value?.trim();
    if (lbl || adr) commute[key] = { label: lbl || key, addr: adr || '' };
  });
  chrome.storage.sync.set({ ch_commute: commute }, () => {
    if (commuteStatus) {
      commuteStatus.textContent = 'Addresses saved ✓';
      commuteStatus.className   = 'profile-status saved';
    }
    notifyTabs({ type: 'COMMUTE_CHANGED', commute });
  });
}

function updateAffordabilityPreview(p) {
  if (!p.annualIncome || !p.mortgageRatePct) return;
  const samplePrice = 475000;
  const down        = samplePrice * (p.downPaymentPct || 20) / 100;
  const loan        = samplePrice - down;
  const mRate       = (p.mortgageRatePct / 100) / 12;
  const n           = 360;
  const pi          = Math.round(loan * (mRate * Math.pow(1+mRate,n)) / (Math.pow(1+mRate,n)-1));
  const totalPITI   = pi + 333 + (p.monthlyInsurance || 100) + 292;
  const dti         = Math.round((totalPITI / (p.annualIncome/12)) * 100);
  if (profileStatus) {
    profileStatus.textContent = `Profile saved ✓ — $475K sample: $${totalPITI.toLocaleString()}/mo PITI · ${dti}% housing DTI`;
  }
}

// ── Housing Priorities ────────────────────────────────────────────────────────
priorityGrid?.querySelectorAll('.priority-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    chip.classList.toggle('active');
    const active = [...priorityGrid.querySelectorAll('.priority-chip.active')]
      .map(c => c.dataset.priority);
    chrome.storage.sync.set({ ch_priorities: active }, () => {
      notifyTabs({ type: 'PRIORITIES_CHANGED', priorities: active });
    });
  });
});

// ── Theme ─────────────────────────────────────────────────────────────────────
themeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const theme = btn.dataset.theme;
    themeBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    chrome.storage.sync.set({ ch_theme: theme });
    notifyTabs({ type: 'SETTINGS_CHANGED', theme });
  });
});

// ── Clear stats ───────────────────────────────────────────────────────────────
clearStatsBtn?.addEventListener('click', () => {
  chrome.storage.local.set({ ch_events: [] }, () => {
    document.getElementById('stat-listings').textContent  = '0';
    document.getElementById('stat-analyses').textContent  = '0';
  });
});

// ── Notify active tabs ────────────────────────────────────────────────────────
function notifyTabs(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, msg).catch(() => {}));
  });
}
