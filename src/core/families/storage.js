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

// ---------------------------------------------------------------- macOS

/**
 * A tiny reader for the XML property lists `diskutil -plist` prints: dict,
 * array, string, integer, real, true, false (data and date stay strings).
 * Returns null for anything it cannot read.
 */
function parsePlist(xml) {
  const text = String(xml ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const tokens = [];
  const re = /<(\/?)([A-Za-z]+)\b[^>]*?(\/?)>/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) tokens.push({ text: text.slice(last, m.index) });
    tokens.push({ tag: m[2], close: m[1] === '/', empty: m[3] === '/' });
    last = re.lastIndex;
  }
  let pos = 0;
  const fail = () => {
    throw new Error('bad plist');
  };
  const skipText = () => {
    while (pos < tokens.length && tokens[pos].text != null) pos++;
  };
  const textUntil = (tag) => {
    let s = '';
    while (pos < tokens.length && !(tokens[pos].tag === tag && tokens[pos].close)) {
      if (tokens[pos].text == null) fail();
      s += tokens[pos++].text;
    }
    if (pos >= tokens.length) fail();
    pos++;
    return decodeEntities(s);
  };
  const value = (depth) => {
    if (depth > 64) fail();
    skipText();
    const t = tokens[pos++];
    if (!t || t.close) fail();
    if (t.empty) return { true: true, false: false, string: '', dict: {}, array: [] }[t.tag] ?? null;
    switch (t.tag) {
      case 'plist':
        return value(depth + 1);
      case 'dict': {
        const out = {};
        for (;;) {
          skipText();
          const k = tokens[pos];
          if (!k) fail();
          if (k.close && k.tag === 'dict') {
            pos++;
            return out;
          }
          if (k.tag !== 'key' || k.close) fail();
          pos++;
          const key = k.empty ? '' : textUntil('key');
          out[key] = value(depth + 1);
        }
      }
      case 'array': {
        const out = [];
        for (;;) {
          skipText();
          const k = tokens[pos];
          if (!k) fail();
          if (k.close && k.tag === 'array') {
            pos++;
            return out;
          }
          out.push(value(depth + 1));
        }
      }
      case 'string':
      case 'date':
        return textUntil(t.tag);
      case 'data':
        return textUntil('data').replace(/\s+/g, '');
      case 'integer':
      case 'real': {
        const n = Number(textUntil(t.tag).trim());
        return Number.isFinite(n) ? n : null;
      }
      case 'true':
      case 'false':
        textUntil(t.tag);
        return t.tag === 'true';
      default: {
        // Unknown element: skip it whole.
        let open = 1;
        while (pos < tokens.length && open > 0) {
          const x = tokens[pos++];
          if (x.tag === t.tag && !x.empty) open += x.close ? -1 : 1;
        }
        return null;
      }
    }
  };
  try {
    return value(0);
  } catch {
    return null;
  }
}

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (all, e) => {
    const named = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()];
    if (named) return named;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}

const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const asList = (x) => (Array.isArray(x) ? x : []);
const normName = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Bytes as macOS shows them (decimal units): "32.0 GB". */
function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

/** Partitions that are plumbing, not places for files. */
const MAC_HIDDEN_CONTENT = /^(EFI|Apple_Boot|Apple_APFS_Recovery|Apple_APFS_ISC|Apple_partition_map|Apple_Free|Apple_Driver.*|Microsoft Reserved|Linux_Swap|Linux Swap)$/i;
/** System volumes on an external macOS startup disk; not meant to be mounted. */
const APFS_SYSTEM_VOLUMES = /^(Preboot|Recovery|VM|Update|xART|Hardware|iSCPreboot)$/;

/** Which of the external physical disks belong to this USB device. */
function macDisksFor(device, disks) {
  const fromRegistry = new Set((device.nodes ?? []).filter((n) => /^disk\d+$/.test(n)));
  const byNode = disks.filter((d) => fromRegistry.has(d.id));
  if (byNode.length) return byNode;
  const product = normName(device.productName);
  const byName = product.length >= 3 ? disks.filter((d) => normName(d.info.MediaName ?? d.info.IORegistryEntryName).includes(product)) : [];
  if (byName.length) return byName;
  return disks.length === 1 ? disks : [];
}

/** One volume as reported to the person, from its `diskutil list` entry and `diskutil info`. */
function describeVolume(id, entry, info) {
  const str = (x) => (typeof x === 'string' && x ? x : null);
  const mountPoint = str(info.MountPoint) ?? str(entry.MountPoint);
  const type = str(info.FilesystemType)?.toLowerCase() ?? null;
  return {
    id,
    name: str(info.VolumeName) ?? str(entry.VolumeName),
    type,
    filesystem: str(info.FilesystemName) ?? str(info.FilesystemUserVisibleName) ?? type,
    content: str(info.Content) ?? str(entry.Content) ?? '',
    mounted: Boolean(mountPoint),
    mountPoint,
    writable: mountPoint && typeof info.WritableVolume === 'boolean' ? info.WritableVolume : null,
    size: formatSize(info.Size ?? info.TotalSize ?? entry.Size),
  };
}

/** A partition macOS cannot read because it holds a Linux filesystem (ext4 and friends). */
const isLinuxFs = (v) => !v.type && /^linux/i.test(v.content) && !/swap|lvm|raid/i.test(v.content);

const openDiskUtility = { kind: 'command', title: 'Open Disk Utility', explain: "Opens macOS's built-in Disk Utility app.", cmd: 'open', args: ['-a', 'Disk Utility'], admin: false, safe: true };

/**
 * macOS drives: every volume on this device's disk, its filesystem, whether
 * it is mounted and writable. Nothing here changes a disk: mounting and
 * erasing are left to Disk Utility, with the person in control.
 */
async function macStorage(device, ctx) {
  const listRes = await ctx.run('diskutil', ['list', '-plist', 'external', 'physical']);
  const list = listRes.ok ? parsePlist(listRes.stdout) : null;
  if (!isObj(list)) return macStorageFromMount(device, ctx);

  const info = async (id) => {
    const r = await ctx.run('diskutil', ['info', '-plist', id]);
    const p = r.ok ? parsePlist(r.stdout) : null;
    return isObj(p) ? p : {};
  };
  const entries = asList(list.AllDisksAndPartitions).filter((e) => isObj(e) && typeof e.DeviceIdentifier === 'string');
  const disks = [];
  for (const entry of entries) disks.push({ id: entry.DeviceIdentifier, entry, info: await info(entry.DeviceIdentifier) });
  const mine = macDisksFor(device, disks);

  const checks = [];
  const plans = [];
  if (mine.length === 0) {
    checks.push(check('disk', 'Disk detected', 'fail', disks.length ? 'macOS lists external disks, but none could be matched to this device.' : 'macOS shows no external disk for this device.'));
    plans.push(
      plan({
        id: 'disk-utility',
        title: 'Look for the drive in Disk Utility',
        why: 'Disk Utility shows drives macOS can see even when they have no usable volume.',
        confidence: 0.4,
        steps: [openDiskUtility, { kind: 'manual', title: 'Look for the drive in the sidebar', explain: 'Choose View > Show All Devices. If the drive is not listed at all, try another cable or port, then press "Check again".' }],
      }),
    );
    return { status: disks.length ? 'unknown' : 'broken', headline: disks.length ? 'Plug Doctor could not tell which disk is this drive.' : 'The drive is connected but macOS shows no disk.', checks, plans, facts: {} };
  }

  const volumes = [];
  const apfsStores = [];
  for (const d of mine) {
    const parts = asList(d.entry.Partitions).filter((p) => isObj(p) && typeof p.DeviceIdentifier === 'string');
    if (parts.length === 0 && (d.info.FilesystemType || d.entry.VolumeName || d.entry.MountPoint)) {
      // Formatted without a partition table: the whole disk is the volume.
      volumes.push(describeVolume(d.id, d.entry, d.info));
    }
    for (const p of parts) {
      if (MAC_HIDDEN_CONTENT.test(p.Content ?? '')) continue;
      if (p.Content === 'Apple_APFS') {
        apfsStores.push(p.DeviceIdentifier);
        continue;
      }
      volumes.push(describeVolume(p.DeviceIdentifier, p, await info(p.DeviceIdentifier)));
    }
  }
  if (apfsStores.length) {
    // APFS volumes live on a synthesized container disk, listed without "physical".
    const all = parsePlist((await ctx.run('diskutil', ['list', '-plist', 'external'])).stdout);
    let found = 0;
    for (const c of asList(isObj(all) ? all.AllDisksAndPartitions : null).filter(isObj)) {
      const stores = asList(c.APFSPhysicalStores).map((s) => (isObj(s) ? s.DeviceIdentifier : null));
      if (!stores.some((s) => apfsStores.includes(s))) continue;
      for (const v of asList(c.APFSVolumes).filter((x) => isObj(x) && typeof x.DeviceIdentifier === 'string')) {
        found++;
        if (APFS_SYSTEM_VOLUMES.test(v.VolumeName ?? '')) continue;
        volumes.push(describeVolume(v.DeviceIdentifier, v, await info(v.DeviceIdentifier)));
      }
    }
    if (!found) for (const s of apfsStores) checks.push(check(`fs-${s}`, `APFS container on ${s}`, 'info', 'Could not list the volumes inside it.'));
  }

  const facts = {
    disks: mine.map((d) => {
      const size = formatSize(d.info.Size ?? d.info.TotalSize ?? d.entry.Size);
      return size ? `${d.id} (${size})` : d.id;
    }),
    volumes,
  };
  checks.push(check('disk', 'Disk detected', 'pass', facts.disks.join(', ')));

  if (volumes.length === 0 && apfsStores.length === 0) {
    checks.push(check('fs', 'Readable filesystem', 'warn', 'The drive has no volume macOS recognizes. It may be blank or never formatted.'));
    plans.push(
      plan({
        id: 'format',
        title: 'Format the drive in Disk Utility',
        why: 'A blank drive needs to be formatted before you can store files on it.',
        confidence: 0.5,
        steps: [
          openDiskUtility,
          {
            kind: 'manual',
            title: 'Erase the drive (this erases everything on it)',
            explain: 'Warning: erasing deletes everything on the drive. Only do this if the drive is new or holds nothing you need. Select the drive in the sidebar, click Erase and choose "ExFAT" to use it with Mac and Windows, or "APFS" for Macs only.',
          },
        ],
      }),
    );
    return { status: 'needs-fix', headline: 'The drive is blank or not formatted.', checks, plans, facts };
  }

  const label = (v) => (v.name ? `"${v.name}"` : v.id);
  const ntfsReadOnly = volumes.filter((v) => v.type === 'ntfs' && v.mounted && v.writable === false);
  const linuxVols = volumes.filter(isLinuxFs);
  const unmounted = volumes.filter((v) => v.type && !v.mounted);
  const unknownFs = volumes.filter((v) => !v.type && !isLinuxFs(v));
  for (const v of volumes) {
    const what = [v.filesystem, v.size].filter(Boolean).join(', ');
    let status = 'pass';
    let detail;
    if (isLinuxFs(v)) {
      status = 'warn';
      detail = `${v.size ? v.size + ', ' : ''}Linux filesystem (such as ext4). macOS cannot read Linux filesystems by itself.`;
    } else if (!v.type) {
      status = 'warn';
      detail = `macOS does not recognize this filesystem${v.content ? ` (${v.content})` : ''}. It may be encrypted (for example with BitLocker) or come from a camera, game console or another system.`;
    } else if (!v.mounted) {
      status = 'warn';
      detail = `${what}. Not mounted, so it does not show in Finder yet.`;
    } else if (v.writable === false) {
      status = 'warn';
      detail = v.type === 'ntfs' ? `${what}. Mounted at ${v.mountPoint}, read-only: macOS can read NTFS (Windows) drives but cannot write to them.` : `${what}. Mounted at ${v.mountPoint}, read-only.`;
    } else {
      detail = `${what}. Mounted at ${v.mountPoint}${v.writable ? ', read and write' : ''}.`;
    }
    checks.push(check(`fs-${v.id}`, `Volume ${label(v)}`, status, detail));
  }

  if (unmounted.length) {
    const names = unmounted.map(label).join(', ');
    plans.push(
      plan({
        id: 'mount',
        title: `Mount ${names}`,
        why: 'The volume is fine but not mounted. Mounting it makes it appear in Finder, like plugging the drive in again.',
        confidence: 0.8,
        steps: [openDiskUtility, { kind: 'manual', title: 'Select the volume and click Mount', explain: `Select ${names} in the sidebar (choose View > Show All Devices if you do not see it), then click Mount in the toolbar.` }],
      }),
    );
  }
  if (ntfsReadOnly.length) {
    plans.push(
      plan({
        id: 'ntfs',
        title: 'Make the drive writable on both Mac and Windows',
        why: 'macOS cannot write to NTFS, the Windows format. ExFAT works on both, but switching format means erasing the drive, so copy your files off first.',
        confidence: 0.5,
        steps: [
          { kind: 'manual', title: 'Copy your files off the drive', explain: 'macOS can read the drive, so drag everything you want to keep onto your Mac first. If you only need to read files, you can stop here.' },
          { ...openDiskUtility, optional: true },
          {
            kind: 'manual',
            title: 'Erase it as ExFAT (this erases everything on the drive)',
            explain: 'Warning: erasing deletes everything on the drive. Only do this after copying your files off. Select the drive in the sidebar, click Erase and choose "ExFAT". Plug Doctor never erases a drive for you.',
          },
        ],
      }),
    );
  }

  const mounted = volumes.filter((v) => v.mounted);
  let headline;
  let support = null;
  if (ntfsReadOnly.length) headline = 'Readable, but macOS cannot write to NTFS drives.';
  else if (linuxVols.length && linuxVols.length === volumes.length) {
    headline = 'macOS cannot read Linux-formatted drives by itself.';
    support = { level: 'app', note: 'macOS cannot read Linux filesystems such as ext4 on its own. Third-party apps can, or copy the files using a Linux computer.' };
  } else if (unmounted.length) headline = 'The drive works; it just needs to be mounted.';
  else if (!mounted.length) headline = 'macOS does not recognize the filesystem on this drive.';
  else headline = `Ready at ${mounted.map((v) => v.mountPoint).join(', ')}.`;
  const needsFix = plans.length > 0 || linuxVols.length > 0 || unknownFs.length > 0;
  return { status: needsFix ? 'needs-fix' : 'ok', headline, checks, plans, facts, ...(support ? { support } : {}) };
}

/** Fallback when diskutil cannot be read: what `mount` shows under /Volumes. */
async function macStorageFromMount(device, ctx) {
  const checks = [];
  const mounts = (await ctx.run('mount', [])).stdout.split(/\r?\n/).filter((l) => l.includes('/Volumes/'));
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

/** @type {import('./index').Family} */
const family = {
  id: 'storage',
  label: 'Drive',
  icon: 'storage',
  sources: ['usb'],
  match: (d) => (d.categories.includes('storage') ? 80 : 0),
  diagnose: diagnoseStorage,
};

module.exports = { family, diagnoseStorage, linuxDisksFor, parsePlist, macDisksFor };
