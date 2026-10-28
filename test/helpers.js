'use strict';

const fs = require('node:fs');
const path = require('node:path');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

/**
 * Fake `run` for tests: maps "cmd arg1 arg2" (or a RegExp) to output.
 * Unknown commands behave like a missing binary. Every call is recorded.
 */
function fakeRun(table) {
  const calls = [];
  const fn = async (cmd, args = []) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    for (const [key, value] of table) {
      const hit = key instanceof RegExp ? key.test(line) : key === line;
      if (!hit) continue;
      const v = typeof value === 'function' ? value(line) : value;
      if (typeof v === 'string') return { ok: true, code: 0, stdout: v, stderr: '', missing: false };
      return { ok: true, code: 0, stdout: '', stderr: '', missing: false, ...v };
    }
    return { ok: false, code: null, stdout: '', stderr: `${cmd}: not found`, missing: true };
  };
  fn.calls = calls;
  return fn;
}

/** Build a throwaway sysfs tree: { '1-1': { idVendor: '03f0', ... }, '1-1:1.0': { ..., driver: 'usblp', nodes: ['usbmisc/lp0'] } } */
function makeSysfs(tmp, layout) {
  const root = path.join(tmp, 'devices');
  const drivers = path.join(tmp, 'drivers');
  fs.mkdirSync(root, { recursive: true });
  for (const [name, attrs] of Object.entries(layout)) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'driver') {
        fs.mkdirSync(path.join(drivers, v), { recursive: true });
        fs.symlinkSync(path.join(drivers, v), path.join(dir, 'driver'), 'junction');
      } else if (k === 'nodes') {
        for (const n of v) fs.mkdirSync(path.join(dir, n), { recursive: true });
      } else {
        fs.writeFileSync(path.join(dir, k), `${v}\n`);
      }
    }
  }
  return root;
}

module.exports = { fixture, fakeRun, makeSysfs };
