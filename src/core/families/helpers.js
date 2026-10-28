'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Shapes shared by every diagnosis module. */
const check = (id, label, status, detail = '') => ({ id, label, status, detail });

/**
 * A fix plan. `auto: true` means it is safe to apply without a click when
 * the person has "Fix automatically" switched on: it only adds things
 * (a printer queue, a package), never removes or overwrites.
 */
const plan = ({ id, title, why, confidence, steps, auto = false }) => ({ id, title, why, confidence, steps, auto, source: 'builtin' });

let testPage = null;

/** Plain text test page, written once per run into a folder only this user can open. */
function testPagePath() {
  if (testPage) return testPage;
  // A fixed name in the shared temp folder could be a link someone else planted, so use a fresh private folder.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-doctor-'));
  testPage = path.join(dir, 'test-page.txt');
  fs.writeFileSync(
    testPage,
    [
      'Plug Doctor test page',
      '=====================',
      '',
      'If you can read this, your printer works.',
      '',
      `Printed: ${new Date().toISOString()}`,
      '',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789',
      '',
      'Plug Doctor is free and open source. If it helped you, consider',
      'sharing your printer recipe so it helps the next person too.',
    ].join('\n'),
    { mode: 0o600 },
  );
  return testPage;
}

module.exports = { check, plan, testPagePath };
