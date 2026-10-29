'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');
const { PROVIDERS, providerById, validBaseUrl } = require('./providers');

/**
 * Settings live in a JSON file in the app's user-data folder. API keys are
 * encrypted with the OS keychain (Keychain / DPAPI / libsecret) through
 * Electron's safeStorage, one per AI provider, and never leave the main process.
 */
const DEFAULTS = {
  autoFix: true,
  assistantEnabled: true,
  webResearch: true,
  scanNetwork: true,
  theme: 'system', // 'system', 'light' or 'dark'
  assistantProvider: 'anthropic',
  assistantModel: '', // empty: the provider's own default model
  assistantBaseUrl: '', // for servers on this computer and other OpenAI-compatible servers
  apiKeys: {}, // provider id -> key, encrypted
  apiKeyEncrypted: null, // the Claude key as older versions saved it
};

const THEMES = ['system', 'light', 'dark'];

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  let s;
  try {
    s = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Keep the damaged file for a person to look at, rather than letting the
      // next save silently replace it.
      try {
        fs.renameSync(file(), `${file()}.damaged`);
      } catch {
        // Nothing more can be done; the defaults below still let the app start.
      }
      process.emitWarning(`Plug Doctor's settings file was damaged and has been reset. It was kept as settings.json.damaged.`);
    }
    s = { ...DEFAULTS };
  }
  if (!s.apiKeys || typeof s.apiKeys !== 'object' || Array.isArray(s.apiKeys)) s.apiKeys = {};
  return s;
}

function save(next) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2), { mode: 0o600 });
}

/** Settings as the renderer may see them: never a key itself, only whether one is saved. */
function publicView(s = load()) {
  const rest = { ...s };
  delete rest.apiKeyEncrypted;
  delete rest.apiKeys;
  // Report a key only when the assistant can actually read it back.
  const savedKeys = Object.fromEntries(PROVIDERS.map((p) => [p.id, Boolean(apiKey(p.id, s))]));
  const provider = providerById(s.assistantProvider);
  return { ...rest, savedKeys, hasApiKey: provider.needsKey === false || savedKeys[provider.id] };
}

function update(patch) {
  const s = load();
  for (const key of ['autoFix', 'assistantEnabled', 'webResearch', 'scanNetwork']) {
    if (typeof patch[key] === 'boolean') s[key] = patch[key];
  }
  if (THEMES.includes(patch.theme)) s.theme = patch.theme;
  if (PROVIDERS.some((p) => p.id === patch.assistantProvider)) s.assistantProvider = patch.assistantProvider;
  if (typeof patch.assistantModel === 'string') {
    const model = patch.assistantModel.trim();
    if (model.length > 200 || !/^[\w.:/@+-]*$/.test(model)) throw new Error('That model name has characters a model name cannot have.');
    s.assistantModel = model;
  }
  if (typeof patch.assistantBaseUrl === 'string') {
    const text = patch.assistantBaseUrl.trim();
    const url = text ? validBaseUrl(text) : '';
    if (url === null) throw new Error('The server address must start with https://, or with http://localhost for a server on this computer.');
    s.assistantBaseUrl = url;
  }
  if (typeof patch.apiKey === 'string') {
    // The key belongs to the provider picked in the same save.
    const provider = providerById(s.assistantProvider);
    const key = patch.apiKey.trim();
    if (!key) {
      delete s.apiKeys[provider.id];
      if (provider.id === 'anthropic') s.apiKeyEncrypted = null;
    } else if (safeStorage.isEncryptionAvailable()) {
      s.apiKeys[provider.id] = safeStorage.encryptString(key).toString('base64');
      if (provider.id === 'anthropic') s.apiKeyEncrypted = null;
    } else {
      const env = provider.envKey ? ` Set the ${provider.envKey} environment variable instead.` : '';
      throw new Error(`This computer has no secure key storage, so the key cannot be saved.${env}`);
    }
  }
  save(s);
  return publicView(s);
}

/** The key for a provider: the saved one, or its environment variable. */
function apiKey(providerId, s = load()) {
  const id = providerId ?? s.assistantProvider;
  const encrypted = s.apiKeys?.[id] ?? (id === 'anthropic' ? s.apiKeyEncrypted : null);
  if (encrypted && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      return null;
    }
  }
  const env = PROVIDERS.find((p) => p.id === id)?.envKey;
  return env ? process.env[env] ?? null : null;
}

module.exports = { load, update, publicView, apiKey };
