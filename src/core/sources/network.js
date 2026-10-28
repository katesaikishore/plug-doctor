'use strict';

/**
 * Devices on the home network: smart TVs, AirPlay and Chromecast receivers,
 * network printers and scanners. Found with multicast DNS (Bonjour) and SSDP
 * (UPnP), merged per device by address and host name.
 *
 * Note: on macOS 15 and later, the first scan makes macOS ask the person to
 * allow Plug Doctor to "find devices on local networks". That is expected;
 * if they decline, this source simply finds nothing.
 *
 * `ctx.mdns` / `ctx.ssdp` replace the real scans (tests and demo mode):
 * either an array of results or a function returning them.
 */

const mdns = require('../net/mdns');
const ssdp = require('../net/ssdp');

const PRINT_TYPES = ['_ipp._tcp', '_ipps._tcp', '_printer._tcp', '_pdl-datastream._tcp'];
const SCAN_TYPES = ['_uscan._tcp', '_uscans._tcp'];
const CATEGORY_ORDER = ['printer', 'scanner', 'tv', 'speaker', 'cast', 'airplay', 'smart-home', 'dlna'];

const TV_BRANDS = /\b(samsung|lg electronics|lge|sony|panasonic|philips|tcl|hisense|vizio|sharp|toshiba|roku|grundig|metz)\b/i;
const SPEAKER_BRANDS = /\b(sonos|bose|denon|marantz|yamaha|harman|bang & olufsen|heos|bluesound|libratone)\b/i;

/** Display-safe text from the network: no control characters, capped. */
function clean(s, max = 80) {
  if (s === null || s === undefined || s === true) return null;
  const v = String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return v || null;
}

/** Host names and addresses that are safe to put in an id. */
function idPart(s) {
  return String(s).toLowerCase().replace(/\.$/, '').replace(/[^a-z0-9._:-]/g, '-').slice(0, 128);
}

/** AirPlay `features` bit 7 means the receiver accepts screen mirroring (a screen, not a speaker). */
function airplayMirroring(txt) {
  const low = String(txt?.features ?? '').split(',')[0].trim();
  if (!/^0x[0-9a-f]{1,8}$/i.test(low)) return false;
  return (parseInt(low, 16) & 0x80) !== 0;
}

/** RAOP instance names start with the receiver's MAC address: "AABBCCDDEEFF@Kitchen". */
const raopName = (name) => String(name).replace(/^[0-9a-f]{12}@/i, '');

const has = (list, x) => list.includes(x);

/** Categories for one merged device. */
function categorize(services, ssdpInfo) {
  const cats = new Set();
  const types = services.map((s) => s.type);
  const txtOf = (t) => services.find((s) => s.type === t)?.txt ?? {};
  if (types.some((t) => PRINT_TYPES.includes(t))) cats.add('printer');
  if (types.some((t) => SCAN_TYPES.includes(t))) cats.add('scanner');

  if (has(types, '_airplay._tcp')) {
    cats.add('airplay');
    const txt = txtOf('_airplay._tcp');
    const model = String(txt.model ?? '');
    if (/^(Mac|iMac)/.test(model)) cats.add('computer');
    else if (/^AppleTV/i.test(model) || airplayMirroring(txt)) cats.add('tv');
    else if (/^(AudioAccessory|AirPort)/i.test(model)) cats.add('speaker');
  }
  if (has(types, '_raop._tcp')) cats.add('airplay');
  if (has(types, '_googlecast._tcp')) {
    cats.add('cast');
    const md = String(txtOf('_googlecast._tcp').md ?? '');
    if (/chromecast|google tv|\btv\b|bravia|shield/i.test(md)) cats.add('tv');
    else if (/google home|nest mini|nest audio|home mini|home max|speaker|audio/i.test(md)) cats.add('speaker');
  }
  if (has(types, '_spotify-connect._tcp')) cats.add('speaker');
  if (has(types, '_hap._tcp')) cats.add('smart-home');

  if (ssdpInfo) {
    const st = ssdpInfo.st.join(' ');
    const words = [ssdpInfo.friendlyName, ssdpInfo.manufacturer, ssdpInfo.modelName, ssdpInfo.server].filter(Boolean).join(' ');
    const renderer = /:device:MediaRenderer:/i.test(`${st} ${ssdpInfo.deviceType ?? ''}`);
    const tvHint =
      /roku:ecp|dial-multiscreen-org|samsung\.com:device:RemoteControlReceiver|lge-com:service:webos-second-screen/i.test(st) ||
      /^\[TV\]/.test(ssdpInfo.friendlyName ?? '') ||
      /\broku\b|\bwebos\b|\btizen\b|\bbravia\b/i.test(words);
    if (tvHint) cats.add('tv');
    if (renderer) {
      cats.add('dlna');
      if (!tvHint && SPEAKER_BRANDS.test(words)) cats.add('speaker');
      else if (!tvHint && TV_BRANDS.test(words) && !cats.has('speaker')) cats.add('tv');
    }
    if (/:device:Printer:/i.test(`${st} ${ssdpInfo.deviceType ?? ''}`)) cats.add('printer');
  }
  // A receiver that is a TV is not also called a speaker.
  if (cats.has('tv')) cats.delete('speaker');
  if (cats.has('airplay') && !cats.has('tv') && !cats.has('printer') && !cats.has('computer')) cats.add('speaker');
  cats.delete('computer'); // a Mac that accepts AirPlay: just "airplay"
  return CATEGORY_ORDER.filter((c) => cats.has(c));
}

/** Merge several SSDP root devices that share one address (TVs often announce three or four). */
function mergeSsdp(entries) {
  if (entries.length === 0) return null;
  const pick = (k) => entries.map((e) => e.description?.[k]).find(Boolean) ?? null;
  const renderer = entries.find((e) => /MediaRenderer/i.test(e.description?.deviceType ?? '')) ?? entries.find((e) => e.description);
  return {
    location: (renderer ?? entries[0]).location ?? null,
    server: clean(entries.map((e) => e.server).find(Boolean), 200),
    usn: entries.map((e) => e.usn).filter(Boolean),
    st: [...new Set(entries.flatMap((e) => e.st ?? []))].slice(0, 32),
    friendlyName: clean(renderer?.description?.friendlyName ?? pick('friendlyName')),
    manufacturer: clean(pick('manufacturer')),
    modelName: clean(pick('modelName')),
    deviceType: clean(renderer?.description?.deviceType ?? pick('deviceType'), 200),
  };
}

function bestName(services, ssdpInfo) {
  const by = (t) => services.find((s) => s.type === t);
  const candidates = [
    by('_googlecast._tcp')?.txt?.fn,
    by('_airplay._tcp')?.name,
    ssdpInfo?.friendlyName,
    by('_ipp._tcp')?.name,
    by('_ipps._tcp')?.name,
    by('_uscan._tcp')?.name,
    by('_raop._tcp') && raopName(by('_raop._tcp').name),
    ...services.map((s) => s.name),
    ...services.map((s) => s.txt?.ty),
  ];
  return candidates.map((c) => clean(c)).find(Boolean) ?? null;
}

function makerAndModel(services, ssdpInfo) {
  const txt = (t) => services.find((s) => s.type === t)?.txt ?? {};
  const air = txt('_airplay._tcp');
  const cast = txt('_googlecast._tcp');
  const ipp = { ...txt('_printer._tcp'), ...txt('_ipps._tcp'), ...txt('_ipp._tcp') };
  const scan = { ...txt('_uscans._tcp'), ...txt('_uscan._tcp') };
  const hap = txt('_hap._tcp');
  let manufacturer =
    clean(air.manufacturer) ?? clean(ipp.usb_mfg) ?? clean(ssdpInfo?.manufacturer) ?? clean(scan.mfg) ?? null;
  if (!manufacturer && /^(AppleTV|AudioAccessory|AirPort)/i.test(String(air.model ?? ''))) manufacturer = 'Apple';
  if (!manufacturer && /^(chromecast|google )/i.test(String(cast.md ?? ''))) manufacturer = 'Google';
  const model = clean(cast.md) ?? clean(ipp.ty) ?? clean(scan.ty) ?? clean(ssdpInfo?.modelName) ?? clean(air.model) ?? clean(hap.md) ?? null;
  return { manufacturer, model };
}

/**
 * Merge mDNS instances and SSDP devices into Plug Doctor devices.
 * @param {any[]} instances  from mdns.browse
 * @param {any[]} ssdpDevices from ssdp.search
 */
function mergeDevices(instances = [], ssdpDevices = []) {
  const groups = [];
  const groupFor = (host, ips) => {
    const hits = groups.filter((g) => (host && g.hosts.has(host)) || ips.some((ip) => g.ips.has(ip)));
    if (hits.length === 0) {
      const g = { hosts: new Set(), ips: new Set(), services: [], ssdp: [] };
      groups.push(g);
      return g;
    }
    const [g, ...rest] = hits;
    for (const r of rest) {
      r.hosts.forEach((h) => g.hosts.add(h));
      r.ips.forEach((ip) => g.ips.add(ip));
      g.services.push(...r.services);
      g.ssdp.push(...r.ssdp);
      groups.splice(groups.indexOf(r), 1);
    }
    return g;
  };

  for (const inst of instances) {
    if (!inst || !inst.type) continue;
    // Speaker groups share an address with one of the speakers; they are not devices.
    if (inst.type === '_googlecast._tcp' && /cast group/i.test(String(inst.txt?.md ?? ''))) continue;
    const host = inst.host ? String(inst.host).toLowerCase().replace(/\.$/, '') : null;
    const ips = (inst.addresses ?? []).map(String);
    if (!host && ips.length === 0) continue;
    const g = groupFor(host, ips);
    if (host) g.hosts.add(host);
    ips.forEach((ip) => g.ips.add(ip));
    g.services.push(inst);
  }
  for (const d of ssdpDevices) {
    if (!d || !d.address) continue;
    const g = groupFor(null, [String(d.address)]);
    g.ips.add(String(d.address));
    g.ssdp.push(d);
  }

  const devices = [];
  for (const g of groups) {
    const ssdpInfo = mergeSsdp(g.ssdp);
    const categories = categorize(g.services, ssdpInfo);
    // SSDP alone also finds routers, file servers and computers; keep only what we can help with.
    if (g.services.length === 0 && categories.length === 0) continue;
    const hosts = [...g.hosts].sort();
    const addresses = [...g.ips].sort((a, b) => (a.includes(':') ? 1 : 0) - (b.includes(':') ? 1 : 0) || a.localeCompare(b, 'en', { numeric: true }));
    const host = hosts[0] ?? null;
    const { manufacturer, model } = makerAndModel(g.services, ssdpInfo);
    const name = bestName(g.services, ssdpInfo) ?? host?.replace(/\.local$/, '') ?? addresses[0];
    const services = g.services
      .map((s) => ({ type: s.type, name: clean(s.name, 120), host: s.host ?? null, port: s.port ?? null, txt: s.txt ?? {} }))
      .sort((a, b) => a.type.localeCompare(b.type));
    devices.push({
      id: `network:${idPart(host ?? addresses[0])}`,
      source: 'network',
      vendorName: manufacturer,
      productName: model,
      displayName: name,
      serial: null,
      categories,
      icon: categories[0] ?? 'network',
      interfaces: [],
      nodes: [],
      driver: null,
      problem: null,
      details: { addresses, host, services, ssdp: ssdpInfo, manufacturer, model },
      raw: { mdns: g.services, ssdp: g.ssdp },
    });
  }
  return devices.sort((a, b) => a.id.localeCompare(b.id));
}

async function gather(override, real) {
  if (Array.isArray(override)) return override;
  if (typeof override === 'function') return override();
  return real();
}

/** @type {import('./index').Source} */
const source = {
  id: 'network',
  label: 'On your network',
  intervalMs: 60000,
  background: true,
  list: async (ctx = {}) => {
    const [m, s] = await Promise.allSettled([
      gather(ctx.mdns, () => mdns.browse({ timeoutMs: 2500 })),
      gather(ctx.ssdp, () => ssdp.search({ timeoutMs: 2500 })),
    ]);
    if (m.status === 'rejected' && s.status === 'rejected') throw m.reason;
    return mergeDevices(m.status === 'fulfilled' ? m.value : [], s.status === 'fulfilled' ? s.value : []);
  },
};

module.exports = { source, mergeDevices, categorize, airplayMirroring, PRINT_TYPES, SCAN_TYPES };
