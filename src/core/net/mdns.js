'use strict';

/**
 * A small multicast DNS (RFC 6762) / DNS-SD (RFC 6763) browser in plain
 * Node. It asks "who offers these services?" on the local network and
 * groups the answers into service instances.
 *
 * Everything that arrives from the network is untrusted: the decoder checks
 * every length and offset, follows compression pointers only backwards with
 * a hop limit, and returns null instead of throwing on a bad packet.
 */

const dgram = require('node:dgram');

const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;

const TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, ANY: 255 };
const CLASS_IN = 1;

/** Service types Plug Doctor looks for. */
const SERVICE_TYPES = [
  '_ipp._tcp',
  '_ipps._tcp',
  '_printer._tcp',
  '_pdl-datastream._tcp',
  '_uscan._tcp',
  '_uscans._tcp',
  '_airplay._tcp',
  '_raop._tcp',
  '_googlecast._tcp',
  '_spotify-connect._tcp',
  '_hap._tcp',
];

const MAX_PACKET = 9000; // RFC 6762 section 17
const MAX_NAME = 255;
const MAX_HOPS = 32;
const MAX_TXT_KEYS = 64;
const MAX_INSTANCES = 256;

// ---------------------------------------------------------------- encoder

function encodeName(name) {
  const parts = [];
  for (const label of String(name).replace(/\.$/, '').split('.')) {
    if (!label) continue;
    const bytes = Buffer.from(label, 'utf8');
    if (bytes.length > 63) throw new RangeError(`DNS label too long: ${label}`);
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  const out = Buffer.concat(parts);
  if (out.length > MAX_NAME) throw new RangeError('DNS name too long');
  return out;
}

/**
 * A standard query for each name (PTR by default).
 * @param {string[]} names  e.g. ['_ipp._tcp.local']
 * @param {{ id?: number, type?: number, qu?: boolean }} [opts]
 */
function encodeQuery(names, { id = 0, type = TYPE.PTR, qu = false } = {}) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id & 0xffff, 0);
  header.writeUInt16BE(0, 2); // standard query
  header.writeUInt16BE(names.length, 4);
  const questions = names.map((n) => {
    const q = Buffer.alloc(4);
    q.writeUInt16BE(typeof n === 'object' ? n.type : type, 0);
    q.writeUInt16BE(CLASS_IN | (qu ? 0x8000 : 0), 2);
    return Buffer.concat([encodeName(typeof n === 'object' ? n.name : n), q]);
  });
  return Buffer.concat([header, ...questions]);
}

// ---------------------------------------------------------------- decoder

class Malformed extends Error {}

function need(buf, offset, len) {
  if (offset < 0 || offset + len > buf.length) throw new Malformed('truncated');
}

/**
 * Read a (possibly compressed) name. Pointers must point strictly backwards
 * and are followed at most MAX_HOPS times, so loops cannot hang us.
 * @returns {{ name: string, next: number }}
 */
function decodeName(buf, offset) {
  const labels = [];
  let pos = offset;
  let next = -1;
  let hops = 0;
  let length = 0;
  for (;;) {
    need(buf, pos, 1);
    const len = buf[pos];
    if (len === 0) {
      if (next < 0) next = pos + 1;
      break;
    }
    const kind = len & 0xc0;
    if (kind === 0xc0) {
      need(buf, pos, 2);
      const target = ((len & 0x3f) << 8) | buf[pos + 1];
      if (next < 0) next = pos + 2;
      if (target >= pos || ++hops > MAX_HOPS) throw new Malformed('bad compression pointer');
      pos = target;
      continue;
    }
    if (kind !== 0) throw new Malformed('unknown label type');
    need(buf, pos + 1, len);
    length += len + 1;
    if (length > MAX_NAME) throw new Malformed('name too long');
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += len + 1;
  }
  return { name: labels.join('.'), next };
}

/** TXT strings -> { key: value }. Keys are case-insensitive (RFC 6763 6.4); the first one wins. */
function decodeTxt(buf, start, end) {
  const txt = {};
  let pos = start;
  let count = 0;
  while (pos < end) {
    const len = buf[pos];
    if (pos + 1 + len > end) throw new Malformed('bad TXT string');
    const s = buf.toString('utf8', pos + 1, pos + 1 + len);
    pos += 1 + len;
    if (!s || s.startsWith('=')) continue;
    if (++count > MAX_TXT_KEYS) break;
    const eq = s.indexOf('=');
    const key = (eq < 0 ? s : s.slice(0, eq)).toLowerCase();
    if (key === '__proto__' || Object.prototype.hasOwnProperty.call(txt, key)) continue;
    txt[key] = eq < 0 ? true : s.slice(eq + 1);
  }
  return txt;
}

function decodeIPv6(buf, pos) {
  const groups = [];
  for (let i = 0; i < 8; i++) groups.push(buf.readUInt16BE(pos + i * 2).toString(16));
  // Compress the longest run of zero groups.
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > bestLen && j - i > 1) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (best < 0) return groups.join(':');
  return `${groups.slice(0, best).join(':')}::${groups.slice(best + bestLen).join(':')}`;
}

function decodeRecord(buf, offset) {
  const { name, next } = decodeName(buf, offset);
  need(buf, next, 10);
  const type = buf.readUInt16BE(next);
  const klass = buf.readUInt16BE(next + 2);
  const ttl = buf.readUInt32BE(next + 4);
  const rdlength = buf.readUInt16BE(next + 8);
  const start = next + 10;
  const end = start + rdlength;
  need(buf, start, rdlength);
  let data = null;
  switch (type) {
    case TYPE.PTR:
      data = decodeName(buf, start).name;
      break;
    case TYPE.SRV: {
      if (rdlength < 7) throw new Malformed('short SRV');
      data = {
        priority: buf.readUInt16BE(start),
        weight: buf.readUInt16BE(start + 2),
        port: buf.readUInt16BE(start + 4),
        target: decodeName(buf, start + 6).name,
      };
      break;
    }
    case TYPE.TXT:
      data = decodeTxt(buf, start, end);
      break;
    case TYPE.A:
      if (rdlength !== 4) throw new Malformed('bad A record');
      data = `${buf[start]}.${buf[start + 1]}.${buf[start + 2]}.${buf[start + 3]}`;
      break;
    case TYPE.AAAA:
      if (rdlength !== 16) throw new Malformed('bad AAAA record');
      data = decodeIPv6(buf, start);
      break;
    default:
      data = null; // a type we do not use; skipped
  }
  return {
    record: { name, type, class: klass & 0x7fff, cacheFlush: Boolean(klass & 0x8000), ttl, data },
    next: end,
  };
}

/**
 * Decode one DNS message. Returns null for anything malformed.
 * @param {Buffer} buf
 */
function decodePacket(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.length > MAX_PACKET) return null;
    const id = buf.readUInt16BE(0);
    const flags = buf.readUInt16BE(2);
    const counts = [4, 6, 8, 10].map((o) => buf.readUInt16BE(o));
    // Every question takes at least 5 bytes and every record 11.
    if (counts[0] * 5 + (counts[1] + counts[2] + counts[3]) * 11 > buf.length - 12) return null;
    let pos = 12;
    const questions = [];
    for (let i = 0; i < counts[0]; i++) {
      const { name, next } = decodeName(buf, pos);
      need(buf, next, 4);
      const klass = buf.readUInt16BE(next + 2);
      questions.push({ name, type: buf.readUInt16BE(next), class: klass & 0x7fff, qu: Boolean(klass & 0x8000) });
      pos = next + 4;
    }
    const sections = [[], [], []];
    for (let s = 0; s < 3; s++) {
      for (let i = 0; i < counts[s + 1]; i++) {
        const { record, next } = decodeRecord(buf, pos);
        sections[s].push(record);
        pos = next;
      }
    }
    return {
      id,
      response: Boolean(flags & 0x8000),
      flags,
      questions,
      answers: sections[0],
      authorities: sections[1],
      additionals: sections[2],
    };
  } catch {
    return null; // Malformed, or a read past the end
  }
}

// ---------------------------------------------------------------- collector

const lower = (s) => String(s).toLowerCase().replace(/\.$/, '');

/**
 * Collects records from many packets and groups them into service
 * instances. Kept separate from the socket so tests can feed it directly.
 */
function createCollector(services = SERVICE_TYPES) {
  const types = new Map(services.map((t) => [lower(`${t}.local`), t]));
  const ptr = new Map(); // instance full name (lower) -> { type, fullName }
  const srv = new Map(); // instance full name (lower) -> { target, port }
  const txt = new Map(); // instance full name (lower) -> {}
  const addrs = new Map(); // host (lower) -> Set(ip)
  const seenFrom = new Map(); // instance full name (lower) -> sender ip

  const typeOf = (fullName) => {
    const l = lower(fullName);
    for (const [suffix, t] of types) if (l.endsWith(`.${suffix}`)) return t;
    return null;
  };

  function add(packet, from) {
    if (!packet || !packet.response) return;
    for (const r of [...packet.answers, ...packet.authorities, ...packet.additionals]) {
      if (r.class !== CLASS_IN || r.data === null) continue;
      const key = lower(r.name);
      if (r.type === TYPE.PTR) {
        const t = types.get(key);
        if (!t || typeOf(r.data) !== t) continue;
        const inst = lower(r.data);
        if (r.ttl === 0) {
          ptr.delete(inst); // goodbye
        } else if (ptr.has(inst) || ptr.size < MAX_INSTANCES) {
          ptr.set(inst, { type: t, fullName: r.data.replace(/\.$/, '') });
          if (from && !seenFrom.has(inst)) seenFrom.set(inst, from);
        }
      } else if (r.type === TYPE.SRV) {
        if (!typeOf(r.name) || (!srv.has(key) && srv.size >= MAX_INSTANCES)) continue;
        srv.set(key, { target: r.data.target.replace(/\.$/, ''), port: r.data.port });
        if (from && !seenFrom.has(key)) seenFrom.set(key, from);
      } else if (r.type === TYPE.TXT) {
        if (!typeOf(r.name) || (!txt.has(key) && txt.size >= MAX_INSTANCES)) continue;
        txt.set(key, r.data);
      } else if (r.type === TYPE.A || r.type === TYPE.AAAA) {
        if (!addrs.has(key)) {
          if (addrs.size >= MAX_INSTANCES) continue;
          addrs.set(key, new Set());
        }
        const set = addrs.get(key);
        if (set.size < 16) set.add(r.data);
      }
    }
  }

  /** Instances that have a name but no SRV/TXT yet, and hosts without an address. */
  function missing() {
    const names = new Set([...ptr.keys(), ...srv.keys()]);
    const out = [];
    for (const n of names) {
      const full = ptr.get(n)?.fullName ?? n;
      if (!srv.has(n)) out.push({ name: full, type: TYPE.SRV });
      if (!txt.has(n)) out.push({ name: full, type: TYPE.TXT });
    }
    for (const { target } of srv.values()) {
      if (!addrs.has(lower(target))) out.push({ name: target, type: TYPE.A });
    }
    return out;
  }

  /** @returns {Array<{ type, name, fullName, host, port, addresses, txt }>} */
  function instances() {
    const names = new Set([...ptr.keys(), ...srv.keys()]);
    const out = [];
    for (const n of names) {
      const type = ptr.get(n)?.type ?? typeOf(n);
      if (!type) continue;
      const fullName = ptr.get(n)?.fullName ?? n;
      const s = srv.get(n);
      const host = s?.target || null;
      const addresses = [...(host ? addrs.get(lower(host)) ?? [] : [])];
      if (addresses.length === 0 && seenFrom.has(n)) addresses.push(seenFrom.get(n));
      out.push({
        type,
        name: fullName.slice(0, fullName.length - `.${type}.local`.length),
        fullName,
        host,
        port: s?.port ?? null,
        addresses: addresses.sort((a, b) => (a.includes(':') ? 1 : 0) - (b.includes(':') ? 1 : 0) || a.localeCompare(b)),
        txt: txt.get(n) ?? {},
      });
    }
    return out.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  }

  return { add, missing, instances };
}

// ---------------------------------------------------------------- socket

function defaultCreateSocket() {
  return dgram.createSocket({ type: 'udp4', reuseAddr: true });
}

function bindSocket(socket, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      socket.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      socket.removeListener('error', onError);
      resolve();
    };
    socket.once('error', onError);
    socket.once('listening', onListening);
    socket.bind(port);
  });
}

const quiet = (fn) => {
  try {
    fn();
  } catch {
    // optional socket tuning; not every platform allows it
  }
};

/**
 * Browse for services for `timeoutMs` and return the instances found.
 * Binds port 5353 (shared with the system responder); when that is not
 * possible, an ephemeral port still works: responders answer it directly
 * (RFC 6762 6.7, "legacy unicast").
 *
 * @param {{ services?: string[], timeoutMs?: number, createSocket?: () => any }} [opts]
 */
async function browse({ services = SERVICE_TYPES, timeoutMs = 2500, createSocket = defaultCreateSocket } = {}) {
  const collector = createCollector(services);
  let socket = createSocket();
  socket.on('error', () => {});
  try {
    await bindSocket(socket, MDNS_PORT);
  } catch {
    quiet(() => socket.close());
    socket = createSocket();
    socket.on('error', () => {});
    await bindSocket(socket, 0);
  }
  quiet(() => socket.addMembership(MDNS_GROUP));
  quiet(() => socket.setMulticastTTL(255));
  quiet(() => socket.setMulticastLoopback(true));

  socket.on('message', (msg, rinfo) => {
    try {
      collector.add(decodePacket(msg), rinfo?.address);
    } catch {
      // never let a bad packet escape the handler
    }
  });

  const send = (questions) => {
    for (let i = 0; i < questions.length; i += 24) {
      quiet(() => socket.send(encodeQuery(questions.slice(i, i + 24)), MDNS_PORT, MDNS_GROUP, () => {}));
    }
  };

  const timers = [];
  const ptrQuestions = services.map((t) => ({ name: `${t}.local`, type: TYPE.PTR }));
  send(ptrQuestions);
  if (timeoutMs >= 1500) timers.push(setTimeout(() => send(ptrQuestions), 1000));
  // Ask once more for whatever the first answers left out (SRV, TXT, addresses).
  timers.push(setTimeout(() => send(collector.missing().slice(0, 96)), Math.round(timeoutMs * 0.6)));

  await new Promise((resolve) => timers.push(setTimeout(resolve, timeoutMs)));
  timers.forEach(clearTimeout);
  quiet(() => socket.close());
  return collector.instances();
}

module.exports = {
  browse,
  encodeName,
  encodeQuery,
  decodeName,
  decodePacket,
  createCollector,
  SERVICE_TYPES,
  TYPE,
  MDNS_GROUP,
  MDNS_PORT,
};
