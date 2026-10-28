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

/** Plain text test page written once to the temp folder. */
function testPagePath() {
  const file = path.join(os.tmpdir(), 'plug-doctor-test-page.txt');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
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
    );
  }
  return file;
}

module.exports = { check, plan, testPagePath };
