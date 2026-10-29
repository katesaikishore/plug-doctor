'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PROVIDERS, providerById, publicProviders, validBaseUrl } = require('../src/main/providers');

test('every provider has an id, a label and a known kind, and ids are unique', () => {
  assert.equal(new Set(PROVIDERS.map((p) => p.id)).size, PROVIDERS.length);
  for (const p of PROVIDERS) {
    assert.ok(p.id && p.label, p.id);
    assert.ok(['anthropic', 'openai'].includes(p.kind), p.id);
  }
  assert.equal(PROVIDERS[0].id, 'anthropic', 'Claude stays the default');
});

test('hosted providers use https; only servers on this computer use plain http', () => {
  for (const p of PROVIDERS.filter((x) => x.kind === 'openai' && !x.custom)) {
    const url = new URL(p.baseURL);
    if (p.local) assert.equal(url.hostname, 'localhost', p.id);
    else assert.equal(url.protocol, 'https:', p.id);
    assert.ok(p.model, `${p.id} has a default model`);
    assert.equal(p.needsKey, !p.local, `${p.id}: hosted providers need a key, local ones do not`);
  }
});

test('the page sees no headers or other internals', () => {
  for (const p of publicProviders()) assert.equal(p.headers, undefined);
  assert.equal(providerById('nope').id, 'anthropic');
});

test('server addresses: https anywhere, http only on this computer', () => {
  assert.equal(validBaseUrl('https://example.com/v1/'), 'https://example.com/v1');
  assert.equal(validBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1');
  assert.equal(validBaseUrl('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1');
  assert.equal(validBaseUrl('http://example.com/v1'), null);
  assert.equal(validBaseUrl('file:///etc/passwd'), null);
  assert.equal(validBaseUrl('not a url'), null);
});
