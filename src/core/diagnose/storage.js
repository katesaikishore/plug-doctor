'use strict';

const { check, plan } = require('./helpers');

/** Filesystems each OS can read and write out of the box. */
const NATIVE_RW = {
  linux: ['vfat', 'exfat', 'ext2', 'ext3', 'ext4', 'btrfs', 'xfs', 'ntfs3', 'ntfs', 'f2fs'],
  darwin: ['msdos', 'exfat', 'apfs', 'hfs'],
  win32: ['FAT', 'FAT32', 'exFAT', 'NTFS', 'ReFS'],
};

function flatten(nodes, out = []) {
  for (const n of nodes ?? []) {
    out.push(n);
    flatten(n.children, out);
  }
  return out;
}

/** `lsblk -J -o NAME,TRAN,FSTYPE,MOUNTPOINT,SIZE,MODEL,SERIAL,LABEL` for this device. */
function linuxDisksFor(device, lsblkJson) {
  let data;
  try {
    data = JSON.parse(lsblkJson);
  } catch {
    return [];
  }
  const disks = (data.blockdevices ?? []).filter((d) => d.tran === 'usb');
  const serial = (device.serial ?? '').toLowerCase();
  const mine = disks.filter((d) => serial && (d.serial ?? '').toLowerCase().includes(serial.slice(-8)));
  return mine.length ? mine : disks.length === 1 ? disks : [];
}

async function linuxStorage(device, ctx) {
  const checks = [];
  const plans = [];
  const res = await ctx.run('lsblk', ['-J', '-o', 'NAME,TRAN,FSTYPE,MOUNTPOINT,SIZE,MODEL,SERIAL,LABEL']);
  const disks = linuxDisksFor(device, res.stdout);
  if (disks.length === 0) {
    checks.push(check('disk', 'Disk detected', device.driver.bound ? 'warn' : 'fail', device.driver.bound ? 'The storage driver is loaded but no disk appeared yet.' : 'No storage driver claimed the device.'));
    return { status: 'broken', headline: 'The drive is connected but no disk appeared.', checks, plans, facts: {} };
  }
  const parts = flatten(disks).filter((p) => p.fstype);
  const facts = { disks: disks.map((d) => `/dev/${d.name} (${d.size})`), partitions: parts.map((p) => ({ dev: `/dev/${p.name}`, fs: p.fstype, mount: p.mountpoint, label: p.label })) };
  checks.push(check('disk', 'Disk detected', 'pass', facts.disks.join(', ')));
  if (parts.length === 0) {
    checks.push(check('fs', 'Readable filesystem', 'warn', 'The disk has no filesystem this computer recognizes. It may be blank, encrypted, or from a camera/console.'));
    return { status: 'needs-fix', headline: 'The disk has no filesystem Linux recognizes.', checks, plans, facts };
  }
  for (const p of parts) {
    if (p.fstype === 'crypto_LUKS' || p.fstype === 'swap') continue;
    if (!NATIVE_RW.linux.includes(p.fstype)) {
      checks.push(check(`fs-${p.name}`, `Filesystem on /dev/${p.name}`, 'warn', `${p.fstype} is not supported out of the box.`));
    }
    if (!p.mountpoint) {
      plans.push(
        plan({
          id: `mount-${p.name}`,
          title: `Open ${p.label || '/dev/' + p.name}`,
          why: 'The partition is fine but not mounted. This mounts it for your user, like clicking it in the file manager.',
          confidence: 0.9,
          auto: true,
          steps: [{ kind: 'command', title: 'Mount', explain: `Mounts /dev/${p.name} (${p.fstype}).`, cmd: 'udisksctl', args: ['mount', '-b', `/dev/${p.name}`], admin: false, safe: true }],
        }),
      );
    }
  }
  const mounted = parts.filter((p) => p.mountpoint);
  checks.push(check('mounted', 'Mounted', mounted.length ? 'pass' : 'warn', mounted.map((p) => p.mountpoint).join(', ') || 'Not mounted yet.'));
  return {
    status: plans.length ? 'needs-fix' : 'ok',
    headline: plans.length ? 'The drive works; it just needs to be opened.' : `Ready at ${mounted.map((p) => p.mountpoint).join(', ')}.`,
    checks,
    plans,
    facts,
  };
}

async function macStorage(device, ctx) {
  const checks = [];
  const mounts = (await ctx.run('mount', [])).stdout.split('\n').filter((l) => l.includes('/Volumes/'));
  const facts = { volumes: mounts.map((l) => l.replace(/^\S+ on (.+?) \((.*)\)$/, '$1 [$2]')) };
  const ntfs = mounts.filter((l) => /\(ntfs,/.test(l));
  if (ntfs.length) {
    checks.push(check('ntfs', 'Writable', 'warn', 'This drive is formatted NTFS (Windows). macOS can read it but cannot write to it. Copy files off, or reformat it as exFAT to use it on both Mac and Windows.'));
  }
  checks.push(check('volumes', 'Mounted volumes', mounts.length ? 'pass' : 'warn', facts.volumes.join('; ') || 'No external volume is mounted. Open Disk Utility to check the drive.'));
  return { status: mounts.length ? (ntfs.length ? 'needs-fix' : 'ok') : 'unknown', headline: ntfs.length ? 'Readable, but macOS cannot write to NTFS drives.' : mounts.length ? 'The drive is mounted.' : 'No volume is mounted from this drive.', checks, plans: [], facts };
}

async function diagnoseStorage(device, ctx) {
  if (ctx.platform === 'linux') return linuxStorage(device, ctx);
  if (ctx.platform === 'darwin') return macStorage(device, ctx);
  return {
    status: device.problem ? 'broken' : 'ok',
    headline: device.problem ? device.problem.message : 'Windows has a driver for this drive.',
    checks: [check('driver', 'Windows has a driver', device.problem ? 'fail' : 'pass', device.problem?.message ?? device.driver.names.join(', '))],
    plans: [],
    facts: {},
  };
}

module.exports = { diagnoseStorage, linuxDisksFor };
