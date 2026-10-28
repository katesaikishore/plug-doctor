'use strict';

const { execFile } = require('node:child_process');

/**
 * Run a program without a shell and collect its output. Never throws: a
 * missing binary or a non-zero exit comes back as a result with `ok: false`,
 * because "lpinfo is not installed" is itself a diagnostic finding.
 *
 * @param {string} cmd
 * @param {string[]} [args]
 * @param {{ timeout?: number, env?: NodeJS.ProcessEnv, input?: string }} [opts]
 * @returns {Promise<{ ok: boolean, code: number|null, stdout: string, stderr: string, missing: boolean }>}
 */
function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        timeout: opts.timeout ?? 15000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        // Tool output is parsed, so pin it to English.
        env: { ...process.env, LANG: 'C', LC_ALL: 'C', ...opts.env },
      },
      (err, stdout, stderr) => {
        const missing = Boolean(err && err.code === 'ENOENT');
        const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
        resolve({ ok: !err, code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), missing });
      },
    );
    if (opts.input != null) child.stdin?.end(opts.input);
  });
}

/** Resolve to true when `cmd` can be found on PATH. */
async function which(cmd, runner = run) {
  const probe = process.platform === 'win32' ? ['where', [cmd]] : ['sh', ['-c', 'command -v "$1"', 'sh', cmd]];
  const res = await runner(probe[0], probe[1], { timeout: 5000 });
  return res.ok && res.stdout.trim().length > 0;
}

module.exports = { run, which };
