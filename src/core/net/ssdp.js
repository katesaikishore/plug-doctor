'use strict';

/**
 * SSDP (UPnP) discovery: smart TVs, DLNA media players, Roku and other
 * devices that answer an M-SEARCH. For each device we also read its UPnP
 * description (friendly name, maker, model), but only from private IPv4
 * addresses, only from the address that answered, with a short timeout and
 * a size cap. Nothing received is ever executed.
 */

const dgram = require('node:dgram');
const http = require('node:http');

const SSDP_GROUP = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = ['ssdp:all', 'roku:ecp'];

const MAX_RESPONSE = 4096;
const MAX_DESCRIPTION = 64 * 1024;
const FETCH_TIMEOUT_MS = 2000;
const MAX_DEVICES = 64;

/** The M-SEARCH request for one search target. */
function buildSearch(st = 'ssdp:all', mx = 2) {
  return [
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_GROUP}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    `MX: ${mx}`,
    `ST: ${st}`,
    '',
    '',
  ].join('\r\n');
}

/**
 * Parse one HTTP-like search response.
 * @returns {{ location, st, usn, server, headers } | null}
 */
function parseResponse(text) {
  const s = String(text ?? '').slice(0, MAX_RESPONSE);
  const lines = s.split(/\r?\n/);
  if (!/^HTTP\/1\.[01] 200\b/i.test(lines[0] ?? '')) return null;
  const headers = {};
  for (const line of lines.slice(1)) {
    const m = line.match(/^([A-Za-z0-9._-]{1,64})\s*:\s*(.*)$/);
    if (m && !(m[1].toLowerCase() in headers)) headers[m[1].toLowerCase()] = m[2].trim().slice(0, 512);
  }
  if (!headers.usn && !headers.location) return null;
  return {
    location: headers.location ?? null,
    st: headers.st ?? null,
    usn: headers.usn ?? null,
    server: headers.server ?? null,
    headers,
  };
}

/** "uuid:abc::urn:schemas-upnp-org:device:MediaRenderer:1" -> "uuid:abc" */
function usnRoot(usn) {
  return String(usn ?? '').split('::')[0].trim().toLowerCase() || null;
}

/** 10/8, 172.16/12, 192.168/16 and link-local 169.254/16. */
function isPrivateIPv4(host) {
  const m = String(host ?? '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** Only plain http:// URLs whose host is a private IPv4 literal (and, when known, the address that answered). */
function safeLocation(location, from) {
  let url;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || url.username || url.password) return null;
  if (!isPrivateIPv4(url.hostname)) return null;
  if (from && url.hostname !== from) return null;
  return url.href;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/gi, (whole, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}

/** Text of the first <tag> (any namespace prefix), cleaned and capped. */
function tag(xml, name) {
  const m = xml.match(new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}(?:\\s[^>]*)?>([^<]{0,1024})</(?:[A-Za-z0-9_-]+:)?${name}>`, 'i'));
  if (!m) return null;
  const v = decodeEntities(m[1]).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 128);
  return v || null;
}

/**
 * Pull the root device's facts from a UPnP device description. The root
 * <device> comes before any embedded ones, so the first match is the root.
 */
function parseDescription(xml) {
  const s = String(xml ?? '').slice(0, MAX_DESCRIPTION);
  const start = s.search(/<(?:[A-Za-z0-9_-]+:)?device[\s>]/i);
  const body = start >= 0 ? s.slice(start) : s;
  const out = {
    friendlyName: tag(body, 'friendlyName'),
    manufacturer: tag(body, 'manufacturer'),
    modelName: tag(body, 'modelName'),
    deviceType: tag(body, 'deviceType'),
  };
  return Object.values(out).some(Boolean) ? out : null;
}

/** GET with a hard deadline and a size cap. Resolves the body or null; never rejects. */
function httpGet(url, { timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_DESCRIPTION } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    let req;
    const timer = setTimeout(() => {
      req?.destroy();
      finish(null);
    }, timeoutMs);
    try {
      req = http.get(url, { agent: false, headers: { 'User-Agent': 'PlugDoctor UPnP/1.0' } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          req.destroy();
          return finish(null);
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            return finish(null);
          }
          chunks.push(c);
        });
        res.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
        res.on('error', () => finish(null));
      });
      req.on('error', () => finish(null));
    } catch {
      finish(null);
    }
  });
}

function defaultCreateSocket() {
  return dgram.createSocket({ type: 'udp4', reuseAddr: true });
}

const quiet = (fn) => {
  try {
    fn();
  } catch {
    // optional socket tuning
  }
};

/**
 * Collect search responses, one entry per device (USN root).
 * @returns {Map<string, { address, usn, location, server, st: string[] }>}
 */
function createCollector() {
  const devices = new Map();
  function add(text, from) {
    const r = parseResponse(text);
    if (!r) return;
    const key = usnRoot(r.usn) ?? `${from}|${r.location}`;
    let d = devices.get(key);
    if (!d) {
      if (devices.size >= MAX_DEVICES) return;
      d = { address: from ?? null, usn: usnRoot(r.usn), location: null, server: r.server, st: [] };
      devices.set(key, d);
    }
    if (!d.location && r.location) d.location = r.location;
    if (!d.server && r.server) d.server = r.server;
    if (r.st && !d.st.includes(r.st) && d.st.length < 32) d.st.push(r.st);
  }
  return { add, devices };
}

/**
 * Search the network and read each device's description.
 * @param {{ timeoutMs?: number, mx?: number, targets?: string[], createSocket?: () => any, fetch?: (url: string) => Promise<string|null> }} [opts]
 */
async function search({ timeoutMs = 2500, mx = 2, targets = SEARCH_TARGETS, createSocket = defaultCreateSocket, fetch = httpGet } = {}) {
  const collector = createCollector();
  const socket = createSocket();
  socket.on('error', () => {});
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('listening', () => {
      socket.removeListener('error', reject);
      resolve();
    });
    socket.bind(0);
  });
  quiet(() => socket.setMulticastTTL(2));
  socket.on('message', (msg, rinfo) => {
    try {
      if (msg.length <= MAX_RESPONSE) collector.add(msg.toString('utf8'), rinfo?.address);
    } catch {
      // ignore junk
    }
  });
  const sendAll = () => {
    for (const st of targets) quiet(() => socket.send(Buffer.from(buildSearch(st, mx)), SSDP_PORT, SSDP_GROUP, () => {}));
  };
  sendAll();
  const again = timeoutMs >= 1500 ? setTimeout(sendAll, 800) : null; // UDP can drop the first one
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  clearTimeout(again);
  quiet(() => socket.close());

  const devices = [...collector.devices.values()];
  await Promise.all(
    devices.map(async (d) => {
      const url = d.location ? safeLocation(d.location, d.address) : null;
      d.description = null;
      if (!url) return;
      try {
        const xml = await fetch(url);
        d.description = xml ? parseDescription(xml) : null;
      } catch {
        d.description = null;
      }
    }),
  );
  return devices;
}

module.exports = {
  search,
  buildSearch,
  parseResponse,
  parseDescription,
  usnRoot,
  isPrivateIPv4,
  safeLocation,
  httpGet,
  createCollector,
  SSDP_GROUP,
  SSDP_PORT,
};
