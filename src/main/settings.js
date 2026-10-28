'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

/**
 * Settings live in a JSON file in the app's user-data folder. The API key is
 * encrypted with the OS keychain (Keychain / DPAPI / libsecret) through
 * Electron's safeStorage and never leaves the main process.
 */
const DEFAULTS = {
  autoFix: true,
  assistantEnabled: true,
  webResearch: true,
  apiKeyEncrypted: null,
};

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(next) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2), { mode: 0o600 });
}

/** Settings as the renderer may see them: never the key itself. */
function publicView(s = load()) {
  const { apiKeyEncrypted, ...rest } = s;
  return { ...rest, hasApiKey: Boolean(apiKeyEncrypted) || Boolean(process.env.ANTHROPIC_API_KEY) };
}

function update(patch) {
  const s = load();
  for (const key of ['autoFix', 'assistantEnabled', 'webResearch']) {
    if (typeof patch[key] === 'boolean') s[key] = patch[key];
  }
  if (typeof patch.apiKey === 'string') {
    const key = patch.apiKey.trim();
    if (!key) s.apiKeyEncrypted = null;
    else if (safeStorage.isEncryptionAvailable()) s.apiKeyEncrypted = safeStorage.encryptString(key).toString('base64');
    else throw new Error('This computer has no secure key storage, so the key cannot be saved. Set the ANTHROPIC_API_KEY environment variable instead.');
  }
  save(s);
  return publicView(s);
}

function apiKey() {
  const s = load();
  if (s.apiKeyEncrypted && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(s.apiKeyEncrypted, 'base64'));
    } catch {
      return null;
    }
  }
  return process.env.ANTHROPIC_API_KEY ?? null;
}

module.exports = { load, update, publicView, apiKey };
