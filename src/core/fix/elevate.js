'use strict';

/**
 * Wrap a command so it runs with administrator rights, using the operating
 * system's own password prompt: pkexec (polkit) on Linux, the standard
 * "wants to make changes" dialog on macOS, UAC on Windows.
 * We never see or store the password.
 */

/** POSIX single-quote a word for /bin/sh. */
function shQuote(s) {
  const str = String(s);
  if (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(str)) return str;
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

/** Escape a string for an AppleScript "..." literal. */
function appleScriptString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Quote one argument the way Windows' CommandLineToArgvW reads it back. */
function winQuote(arg) {
  const s = String(arg);
  if (s.length && !/[\s"]/.test(s)) return s;
  let out = '"';
  let backslashes = 0;
  for (const ch of s) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') out += '\\'.repeat(backslashes * 2 + 1) + '"';
    else out += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  return out + '\\'.repeat(backslashes * 2) + '"';
}

/** Escape for a PowerShell single-quoted string. */
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {NodeJS.Platform} platform
 * @returns {{ cmd: string, args: string[] }}
 */
function elevate(cmd, args, platform = process.platform) {
  if (platform === 'linux') return { cmd: 'pkexec', args: [cmd, ...args] };
  if (platform === 'darwin') {
    const line = [cmd, ...args].map(shQuote).join(' ');
    return { cmd: 'osascript', args: ['-e', `do shell script ${appleScriptString(line)} with administrator privileges`] };
  }
  if (platform === 'win32') {
    const argLine = args.map(winQuote).join(' ');
    const script =
      `$p = Start-Process -FilePath ${psQuote(cmd)} -Verb RunAs -Wait -PassThru -WindowStyle Hidden` +
      (argLine ? ` -ArgumentList ${psQuote(argLine)}` : '') +
      '; exit $p.ExitCode';
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] };
  }
  throw new Error(`Cannot elevate on ${platform}`);
}

module.exports = { elevate, shQuote, appleScriptString, winQuote, psQuote };
