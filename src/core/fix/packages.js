'use strict';

const { which } = require('../exec');

/** Package managers we know how to drive, in the order we look for them. */
const MANAGERS = [
  { id: 'apt', bin: 'apt-get', install: (pkgs) => ['apt-get', ['install', '-y', ...pkgs]] },
  { id: 'dnf', bin: 'dnf', install: (pkgs) => ['dnf', ['install', '-y', ...pkgs]] },
  { id: 'pacman', bin: 'pacman', install: (pkgs) => ['pacman', ['-S', '--needed', '--noconfirm', ...pkgs]] },
  { id: 'zypper', bin: 'zypper', install: (pkgs) => ['zypper', ['--non-interactive', 'install', ...pkgs]] },
  { id: 'brew', bin: 'brew', install: (pkgs) => ['brew', ['install', ...pkgs]], noAdmin: true },
];

async function detectManager(platform, runner) {
  for (const m of MANAGERS) {
    if (platform === 'darwin' && m.id !== 'brew') continue;
    if (platform === 'linux' && m.id === 'brew') continue;
    if (await which(m.bin, runner)) return m;
  }
  return null;
}

/**
 * Turn a `{ apt: [...], dnf: [...] }` package map into an install step for
 * this machine, or a manual step when no supported manager is present.
 */
function installStep(packages, manager) {
  const names = manager ? packages?.[manager.id] : null;
  if (!names || names.length === 0) {
    const any = Object.entries(packages ?? {})
      .map(([k, v]) => `${k}: ${v.join(' ')}`)
      .join('; ');
    return {
      kind: 'manual',
      title: 'Install the driver package',
      explain: `Install these packages with your system's software installer (${any || 'see the recipe notes'}), then press "Check again".`,
    };
  }
  const [cmd, args] = manager.install(names);
  return {
    kind: 'command',
    title: `Install ${names.join(', ')}`,
    explain: `Downloads and installs ${names.join(', ')} from your system's official software repository.`,
    cmd,
    args,
    admin: !manager.noAdmin,
    safe: true,
  };
}

module.exports = { MANAGERS, detectManager, installStep };
