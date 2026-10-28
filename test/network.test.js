'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const mdns = require('../src/core/net/mdns');
const ssdp = require('../src/core/net/ssdp');
const { source, mergeDevices } = require('../src/core/sources/network');
const { family, findQueue } = require('../src/core/families/network-device');
const { diagnose } = require('../src/core/diagnose');
const { fixture, fakeRun } = require('./helpers');

const apt = { id: 'apt', bin: 'apt-get', install: (p) => ['apt-get', ['install', '-y', ...p]] };
const PLAN_PROGRAMS = new Set([
  'lpadmin', 'lpoptions', 'lp', 'cupsenable', 'cupsaccept', 'apt-get', 'dnf', 'pacman', 'zypper', 'brew', 'usermod',
  'systemctl', 'modprobe', 'udevadm', 'udisksctl', 'rfkill', 'bluetoothctl', 'xrandr', 'pactl', 'pnputil', 'powershell.exe', 'explorer.exe', 'open',
]);

// ---------------------------------------------------------------- a tiny DNS response builder (test only)

const { TYPE } = mdns;
const u16 = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const u32 = (n) => Buffer.from([(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);

function rdata(type, data) {
  if (type === TYPE.PTR) return mdns.encodeName(data);
  if (type === TYPE.SRV) return Buffer.concat([u16(0), u16(0), u16(data.port), mdns.encodeName(data.target)]);
  if (type === TYPE.A) return Buffer.from(data.split('.').map(Number));
  if (type === TYPE.TXT) {
    return Buffer.concat(Object.entries(data).map(([k, v]) => {
      const s = Buffer.from(v === true ? k : `${k}=${v}`);
      return Buffer.concat([Buffer.from([s.length]), s]);
    }));
  }
  throw new Error('unsupported');
}

/** records: [{ name, type, data, ttl? }]; the first `answers` go to the answer section, the rest to additionals. */
function response(records, answers = 1) {
  const head = Buffer.concat([u16(0), u16(0x8400), u16(0), u16(answers), u16(0), u16(records.length - answers)]);
  const body = records.map((r) => {
    const rd = rdata(r.type, r.data);
    return Buffer.concat([mdns.encodeName(r.name), u16(r.type), u16(0x8001), u32(r.ttl ?? 120), u16(rd.length), rd]);
  });
  return Buffer.concat([head, ...body]);
}

const printerRecords = (over = {}) => [
  { name: '_ipp._tcp.local', type: TYPE.PTR, data: 'HP LaserJet Pro M404n._ipp._tcp.local' },
  { name: 'HP LaserJet Pro M404n._ipp._tcp.local', type: TYPE.SRV, data: { port: 631, target: 'HP-LaserJet-M404n.local' } },
  {
    name: 'HP LaserJet Pro M404n._ipp._tcp.local',
    type: TYPE.TXT,
    data: { txtvers: '1', ty: 'HP LaserJet Pro M404n', rp: 'ipp/print', pdl: 'application/pdf,image/urf,image/pwg-raster', URF: 'W8,SRGB24,CP1,RS600', Color: 'F', usb_MFG: 'HP', ...over },
  },
  { name: 'HP-LaserJet-M404n.local', type: TYPE.A, data: '192.168.1.30' },
];

// ---------------------------------------------------------------- mDNS

test('mdns: a PTR query round-trips through the decoder', () => {
  const q = mdns.encodeQuery(['_ipp._tcp.local', '_googlecast._tcp.local']);
  const p = mdns.decodePacket(q);
  assert.equal(p.response, false);
  assert.deepEqual(p.questions.map((x) => [x.name, x.type, x.qu]), [['_ipp._tcp.local', 12, false], ['_googlecast._tcp.local', 12, false]]);
  assert.equal(mdns.decodePacket(mdns.encodeQuery(['_hap._tcp.local'], { qu: true })).questions[0].qu, true);
  assert.throws(() => mdns.encodeName(`${'a'.repeat(64)}.local`), RangeError);
});

test('mdns: decodes PTR, SRV, TXT and A records into one instance', () => {
  const p = mdns.decodePacket(response(printerRecords()));
  assert.equal(p.response, true);
  assert.equal(p.answers[0].data, 'HP LaserJet Pro M404n._ipp._tcp.local');
  assert.equal(p.additionals[0].data.port, 631);
  assert.equal(p.additionals[1].data.ty, 'HP LaserJet Pro M404n');
  assert.equal(p.additionals[1].data.urf, 'W8,SRGB24,CP1,RS600', 'TXT keys are case-insensitive');
  assert.equal(p.additionals[2].cacheFlush, true);

  const c = mdns.createCollector();
  c.add(p, '192.168.1.30');
  const [inst] = c.instances();
  assert.deepEqual(
    { type: inst.type, name: inst.name, host: inst.host, port: inst.port, addresses: inst.addresses },
    { type: '_ipp._tcp', name: 'HP LaserJet Pro M404n', host: 'HP-LaserJet-M404n.local', port: 631, addresses: ['192.168.1.30'] },
  );
  assert.equal(inst.txt.pdl, 'application/pdf,image/urf,image/pwg-raster');
});

test('mdns: follows a compression pointer (hand-written packet)', () => {
  // Header: response, 1 answer.
  const bytes = [0x00, 0x00, 0x84, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00];
  // Answer name at offset 12: _googlecast._tcp.local
  const nameAt = bytes.length;
  for (const l of ['_googlecast', '_tcp', 'local']) bytes.push(l.length, ...Buffer.from(l));
  bytes.push(0);
  const data = [];
  data.push(18, ...Buffer.from('Living Room speaker'.slice(0, 18)));
  data.push(0xc0, nameAt); // "...._googlecast._tcp.local" by pointer
  bytes.push(0x00, 0x0c, 0x00, 0x01, 0x00, 0x00, 0x11, 0x94, 0x00, data.length, ...data);
  const p = mdns.decodePacket(Buffer.from(bytes));
  assert.equal(p.answers[0].data, 'Living Room speake._googlecast._tcp.local');
  assert.equal(p.answers[0].ttl, 4500);
});

test('mdns: malformed packets return null and never throw', () => {
  const good = response(printerRecords());
  assert.equal(mdns.decodePacket(Buffer.alloc(3)), null);
  assert.equal(mdns.decodePacket(good.subarray(0, good.length - 5)), null, 'truncated');
  assert.equal(mdns.decodePacket('not a buffer'), null);

  // A pointer to itself, and a forward pointer.
  const loop = Buffer.from([0, 0, 0x84, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 12, 0, 12, 0, 1]);
  assert.equal(mdns.decodePacket(loop), null);
  const forward = Buffer.from([0, 0, 0x84, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 16, 0, 12, 0, 1, 0]);
  assert.equal(mdns.decodePacket(forward), null);
  // Counts far larger than the packet.
  assert.equal(mdns.decodePacket(Buffer.from([0, 0, 0x84, 0, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0])), null);
  // A TXT string longer than its record.
  const txt = Buffer.concat([Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]), mdns.encodeName('x._ipp._tcp.local'), u16(16), u16(1), u32(120), u16(2), Buffer.from([40, 0x41])]);
  assert.equal(mdns.decodePacket(txt), null);
  // A bad A record length.
  const a = Buffer.concat([Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]), mdns.encodeName('h.local'), u16(1), u16(1), u32(120), u16(3), Buffer.from([1, 2, 3])]);
  assert.equal(mdns.decodePacket(a), null);

  // Random junk and random corruption of a good packet.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 2000; i++) {
    const buf = i % 2 ? Buffer.from(good) : Buffer.alloc(12 + Math.floor(rnd() * 200));
    for (let j = 0; j < (i % 2 ? 3 : buf.length); j++) buf[Math.floor(rnd() * buf.length)] = Math.floor(rnd() * 256);
    assert.doesNotThrow(() => mdns.createCollector().add(mdns.decodePacket(buf), '10.0.0.1'));
  }
});

test('mdns: goodbye packets remove an instance; sender address is a fallback', () => {
  const c = mdns.createCollector();
  c.add(mdns.decodePacket(response(printerRecords().slice(0, 3))), '192.168.1.30');
  assert.deepEqual(c.instances()[0].addresses, ['192.168.1.30'], 'no A record yet: use the sender');
  assert.deepEqual(c.missing().map((m) => [m.name, m.type]), [['HP-LaserJet-M404n.local', TYPE.A]]);
  c.add(mdns.decodePacket(response([{ ...printerRecords()[0], ttl: 0 }])), '192.168.1.30');
  assert.equal(c.instances().filter((i) => i.type === '_ipp._tcp' && i.port === null).length, 0);
});

class FakeSocket extends EventEmitter {
  constructor({ failBind = false, reply = () => [] } = {}) {
    super();
    this.failBind = failBind;
    this.reply = reply;
    this.sent = [];
    this.memberships = [];
    this.closed = false;
  }
  bind(port) {
    this.port = port;
    setImmediate(() => (this.failBind && port !== 0 ? this.emit('error', Object.assign(new Error('busy'), { code: 'EADDRINUSE' })) : this.emit('listening')));
  }
  addMembership(group) {
    this.memberships.push(group);
  }
  setMulticastTTL() {}
  setMulticastLoopback() {}
  send(buf, port, address, cb) {
    this.sent.push({ buf, port, address });
    for (const [msg, from] of this.reply(buf)) setImmediate(() => this.emit('message', msg, { address: from, port }));
    cb?.();
  }
  close() {
    this.closed = true;
  }
}

test('mdns: browse() falls back to an ephemeral port and survives junk', async () => {
  const sockets = [];
  const createSocket = () => {
    const s = new FakeSocket({
      failBind: sockets.length === 0,
      reply: (q) => {
        const asked = mdns.decodePacket(q).questions.map((x) => x.name);
        if (!asked.includes('_ipp._tcp.local')) return [];
        return [[Buffer.from([1, 2, 3]), '192.168.1.99'], [response(printerRecords(), 1), '192.168.1.30']];
      },
    });
    sockets.push(s);
    return s;
  };
  const found = await mdns.browse({ timeoutMs: 60, createSocket });
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].closed, true);
  assert.equal(sockets[1].port, 0);
  assert.equal(sockets[1].sent[0].address, '224.0.0.251');
  assert.equal(sockets[1].sent[0].port, 5353);
  assert.deepEqual(sockets[1].memberships, ['224.0.0.251']);
  const asked = mdns.decodePacket(sockets[1].sent[0].buf).questions.map((x) => x.name);
  assert.ok(asked.includes('_uscan._tcp.local') && asked.includes('_hap._tcp.local'));
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'HP LaserJet Pro M404n');
  assert.equal(sockets[1].closed, true);
});

// ---------------------------------------------------------------- SSDP

test('ssdp: M-SEARCH and response parsing', () => {
  const req = ssdp.buildSearch('ssdp:all', 2);
  assert.match(req, /^M-SEARCH \* HTTP\/1\.1\r\n/);
  assert.match(req, /\r\nMAN: "ssdp:discover"\r\n/);
  assert.match(req, /\r\nST: ssdp:all\r\n\r\n$/);

  const lg = ssdp.parseResponse(fixture('network-ssdp-lg.txt'));
  assert.equal(lg.location, 'http://192.168.1.40:1468/');
  assert.equal(lg.st, 'urn:schemas-upnp-org:device:MediaRenderer:1');
  assert.equal(lg.server, 'WebOS/4.1.0 UPnP/1.0');
  assert.equal(ssdp.usnRoot(lg.usn), 'uuid:7f3c1a52-48d0-4b8e-9f5d-0a1b2c3d4e5f');
  const roku = ssdp.parseResponse(fixture('network-ssdp-roku.txt'));
  assert.equal(roku.st, 'roku:ecp');
  assert.equal(ssdp.parseResponse('NOTIFY * HTTP/1.1\r\nUSN: x\r\n\r\n'), null);
  assert.equal(ssdp.parseResponse('garbage'), null);
  assert.equal(ssdp.parseResponse(undefined), null);
});

test('ssdp: device description extraction', () => {
  const d = ssdp.parseDescription(fixture('network-lg-description.xml'));
  assert.deepEqual(d, {
    friendlyName: '[LG] webOS TV OLED55C1PUB',
    manufacturer: 'LG Electronics',
    modelName: 'LG TV',
    deviceType: 'urn:schemas-upnp-org:device:MediaRenderer:1',
  });
  const odd = ssdp.parseDescription('<root><device><friendlyName>Kate&apos;s &amp; TV&#33;\u0007</friendlyName></device></root>');
  assert.equal(odd.friendlyName, "Kate's & TV!");
  assert.equal(ssdp.parseDescription('<html>nope</html>'), null);
  assert.equal(ssdp.parseDescription(null), null);
});

test('ssdp: only private, same-host http locations are fetched', () => {
  for (const ip of ['10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.3.4']) assert.ok(ssdp.isPrivateIPv4(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '192.169.0.1', '127.0.0.1', 'example.com', '999.1.1.1']) assert.ok(!ssdp.isPrivateIPv4(ip), ip);
  assert.equal(ssdp.safeLocation('http://192.168.1.40:1468/', '192.168.1.40'), 'http://192.168.1.40:1468/');
  assert.equal(ssdp.safeLocation('http://192.168.1.1/', '192.168.1.40'), null, 'must be the device that answered');
  assert.equal(ssdp.safeLocation('http://203.0.113.9/desc.xml', '203.0.113.9'), null);
  assert.equal(ssdp.safeLocation('file:///etc/passwd', null), null);
  assert.equal(ssdp.safeLocation('http://router.local/', null), null);
});

test('ssdp: search() dedupes by USN root and fetches descriptions', async () => {
  const socket = new FakeSocket({
    reply: (buf) => {
      const st = /\r\nST: (\S+)/.exec(buf.toString())[1];
      if (st === 'roku:ecp') return [[Buffer.from(fixture('network-ssdp-roku.txt')), '192.168.1.52']];
      const lg = fixture('network-ssdp-lg.txt');
      return [
        [Buffer.from(lg), '192.168.1.40'],
        [Buffer.from(lg.replace(/device:MediaRenderer:1/g, 'service:ConnectionManager:1')), '192.168.1.40'],
        [Buffer.from(lg.replace('192.168.1.40', '8.8.8.8').replace('7f3c1a52', 'aaaaaaaa')), '8.8.8.8'],
        [Buffer.from('junk'), '192.168.1.77'],
      ];
    },
  });
  const fetched = [];
  const devices = await ssdp.search({
    timeoutMs: 40,
    createSocket: () => socket,
    fetch: async (url) => {
      fetched.push(url);
      return url.includes('1468') ? fixture('network-lg-description.xml') : '<root><device><friendlyName>Bedroom Roku</friendlyName></device></root>';
    },
  });
  assert.equal(socket.sent[0].address, '239.255.255.250');
  assert.equal(socket.sent[0].port, 1900);
  assert.deepEqual(fetched.sort(), ['http://192.168.1.40:1468/', 'http://192.168.1.52:8060/']);
  const lg = devices.find((d) => d.address === '192.168.1.40');
  assert.deepEqual(lg.st, ['urn:schemas-upnp-org:device:MediaRenderer:1', 'urn:schemas-upnp-org:service:ConnectionManager:1']);
  assert.equal(lg.description.manufacturer, 'LG Electronics');
  assert.equal(devices.find((d) => d.address === '8.8.8.8').description, null);
});

// ---------------------------------------------------------------- merging

const lgSsdp = () => [{ address: '192.168.1.40', usn: 'uuid:7f3c', location: 'http://192.168.1.40:1468/', server: 'WebOS/4.1.0 UPnP/1.0', st: ['urn:schemas-upnp-org:device:MediaRenderer:1'], description: ssdp.parseDescription(fixture('network-lg-description.xml')) }];
const printerInstances = () => {
  const c = mdns.createCollector();
  c.add(mdns.decodePacket(response(printerRecords())), '192.168.1.30');
  return c.instances();
};
const chromecast = () => ({
  type: '_googlecast._tcp',
  name: 'Chromecast-4d6a2f1c9e8b',
  host: '4d6a2f1c-9e8b-1111-2222-333344445555.local',
  port: 8009,
  addresses: ['192.168.1.45'],
  txt: { id: '4d6a2f1c9e8b', md: 'Chromecast', fn: 'Living Room TV', ca: '201221', st: '0', rs: '' },
});

test('merge: services on one host become one device; SSDP joins by address', () => {
  const mfp = [
    ...printerInstances(),
    { type: '_uscan._tcp', name: 'HP LaserJet Pro M404n', host: 'HP-LaserJet-M404n.local', port: 8080, addresses: ['192.168.1.30'], txt: { ty: 'HP LaserJet Pro M404n', rs: 'eSCL' } },
  ];
  const appleTv = [
    { type: '_airplay._tcp', name: 'Living Room', host: 'Living-Room.local', port: 7000, addresses: ['192.168.1.20', 'fe80::1'], txt: { model: 'AppleTV11,1', features: '0x5A7FFFF7,0x1E' } },
    { type: '_raop._tcp', name: 'AABBCCDDEEFF@Living Room', host: 'Living-Room.local', port: 7000, addresses: ['192.168.1.20'], txt: { am: 'AppleTV11,1' } },
  ];
  const group = { type: '_googlecast._tcp', name: 'Group', host: 'x.local', port: 32187, addresses: ['192.168.1.45'], txt: { md: 'Google Cast Group', fn: 'Everywhere' } };
  const routerSsdp = { address: '192.168.1.1', usn: 'uuid:r', st: ['urn:schemas-upnp-org:device:InternetGatewayDevice:1'], description: { friendlyName: 'Router', deviceType: 'urn:schemas-upnp-org:device:InternetGatewayDevice:1' } };
  const devices = mergeDevices([...mfp, ...appleTv, chromecast(), group], [...lgSsdp(), routerSsdp]);

  assert.deepEqual(devices.map((d) => d.id), ['network:192.168.1.40', 'network:4d6a2f1c-9e8b-1111-2222-333344445555.local', 'network:hp-laserjet-m404n.local', 'network:living-room.local']);
  const printer = devices.find((d) => d.id === 'network:hp-laserjet-m404n.local');
  assert.deepEqual(printer.categories, ['printer', 'scanner']);
  assert.equal(printer.displayName, 'HP LaserJet Pro M404n');
  assert.equal(printer.vendorName, 'HP');
  assert.equal(printer.details.services.length, 2);
  assert.equal(printer.driver, null);

  const tv = devices.find((d) => d.id === 'network:living-room.local');
  assert.deepEqual(tv.categories, ['tv', 'airplay']);
  assert.equal(tv.displayName, 'Living Room');
  assert.equal(tv.vendorName, 'Apple');

  const cast = devices.find((d) => d.id.includes('4d6a2f1c'));
  assert.deepEqual(cast.categories, ['tv', 'cast']);
  assert.equal(cast.displayName, 'Living Room TV', 'the cast group is not a device and does not rename it');
  assert.equal(cast.vendorName, 'Google');

  const lg = devices.find((d) => d.id === 'network:192.168.1.40');
  assert.deepEqual(lg.categories, ['tv', 'dlna']);
  assert.equal(lg.displayName, '[LG] webOS TV OLED55C1PUB');
  assert.equal(lg.details.manufacturer, 'LG Electronics');
});

test('merge: speakers, HomeKit and hostile names', () => {
  const devices = mergeDevices([
    { type: '_airplay._tcp', name: 'Kitchen', host: 'Kitchen.local', port: 7000, addresses: ['192.168.1.60'], txt: { model: 'AudioAccessory5,1', features: '0x4A7FCA00,0xBC354BD0' } },
    { type: '_spotify-connect._tcp', name: 'Kitchen', host: 'Kitchen.local', port: 4070, addresses: ['192.168.1.60'], txt: {} },
    { type: '_hap._tcp', name: 'Eve Energy 1A2B', host: 'Eve.local', port: 80, addresses: ['192.168.1.70'], txt: { md: 'Eve Energy', sf: '1', ci: '7' } },
    { type: '_ipp._tcp', name: 'Evil\u0000\u001b[31m printer', host: 'bad host;rm -rf.local', port: 631, addresses: ['192.168.1.80'], txt: {} },
  ]);
  assert.deepEqual(devices.find((d) => d.details.host === 'kitchen.local').categories, ['speaker', 'airplay']);
  assert.deepEqual(devices.find((d) => d.details.host === 'eve.local').categories, ['smart-home']);
  const evil = devices.find((d) => d.details.addresses[0] === '192.168.1.80');
  assert.equal(evil.displayName, 'Evil [31m printer');
  assert.match(evil.id, /^network:[a-z0-9._:-]+$/);
});

test('source: runs both scans (overridable) and survives one failing', async () => {
  assert.equal(source.id, 'network');
  assert.equal(source.background, true);
  const devices = await source.list({ mdns: [chromecast()], ssdp: async () => { throw new Error('no network'); } });
  assert.equal(devices.length, 1);
  assert.equal(devices[0].source, 'network');
  await assert.rejects(source.list({ mdns: async () => { throw new Error('a'); }, ssdp: async () => { throw new Error('b'); } }));
});

// ---------------------------------------------------------------- family

const printerDevice = () => mergeDevices(printerInstances())[0];
const allSafe = (r) => r.plans.flatMap((p) => p.steps).filter((s) => s.kind === 'command').every((s) => PLAN_PROGRAMS.has(s.cmd));

test('family: claims network devices only', () => {
  assert.equal(family.match(printerDevice()), 80);
  assert.equal(family.match({ source: 'usb', categories: ['printer'] }), 0);
});

test('IPP printer, not set up yet (Linux): add it driverless in one click', async () => {
  const run = fakeRun([['lpstat -v', 'device for HP_LaserJet_1020: usb://HP/LaserJet%201020?serial=FN16VR6\n']]);
  const r = await diagnose(printerDevice(), { platform: 'linux', run, manager: apt });
  assert.equal(r.category, 'network-device');
  assert.equal(r.status, 'needs-fix');
  assert.equal(r.support.level, 'app');
  const p = r.plans.find((x) => x.id === 'add-network-printer');
  assert.equal(p.auto, true);
  assert.deepEqual(p.steps[0].args, ['-p', 'HP_LaserJet_Pro_M404n', '-E', '-v', 'ipp://HP-LaserJet-M404n.local:631/ipp/print', '-m', 'everywhere']);
  assert.equal(p.steps[0].admin, true);
  assert.deepEqual(p.steps.map((s) => s.cmd), ['lpadmin', 'lpoptions', 'lp']);
  assert.deepEqual(p.steps.map((s) => Boolean(s.optional)), [false, true, true]);
  assert.ok(allSafe(r));
});

test('IPP printer, already added: ready to print, no lpadmin', async () => {
  const run = fakeRun([
    ['lpstat -v', fixture('network-lpstat-v.txt')],
    ['lpstat -p HP_LaserJet_Pro_M404n', 'printer HP_LaserJet_Pro_M404n is idle.  enabled since Tue\n'],
  ]);
  const r = await diagnose(printerDevice(), { platform: 'darwin', run, manager: null });
  assert.equal(r.status, 'ok');
  assert.equal(r.facts.queue, 'HP_LaserJet_Pro_M404n');
  assert.ok(r.checks.some((c) => c.id === 'airprint'));
  assert.ok(!r.plans.some((p) => p.steps.some((s) => s.cmd === 'lpadmin')));
});

test('IPP printer: matches queues by address or Bonjour name, never overwrites a queue', async () => {
  const d = printerDevice();
  assert.ok(findQueue(d, [{ queue: 'x', uri: 'ipp://192.168.1.30/ipp/print' }]));
  assert.ok(findQueue(d, [{ queue: 'y', uri: 'dnssd://HP%20LaserJet%20Pro%20M404n._ipp._tcp.local./?uuid=1' }]));
  assert.equal(findQueue(d, [{ queue: 'HP_LaserJet_Pro_M404n', uri: 'usb://HP/LaserJet%20Pro%20M404n?serial=1' }]), null);
  const run = fakeRun([['lpstat -v', 'device for HP_LaserJet_Pro_M404n: usb://HP/LaserJet%20Pro%20M404n?serial=1\n']]);
  const r = await diagnose(d, { platform: 'linux', run, manager: apt });
  const add = r.plans.find((p) => p.id === 'add-network-printer').steps[0];
  assert.equal(add.args[1], 'HP_LaserJet_Pro_M404n_network');
});

test('IPP printer on Windows: open Printers & scanners', async () => {
  const r = await diagnose(printerDevice(), { platform: 'win32', run: fakeRun([]), manager: null });
  const step = r.plans[0].steps[0];
  assert.deepEqual([step.cmd, ...step.args], ['explorer.exe', 'ms-settings:printers']);
  assert.equal(r.support.level, 'native');
});

const scannerDevice = () =>
  mergeDevices([{ type: '_uscan._tcp', name: 'HP LaserJet MFP M28w', host: 'HPM28w.local', port: 8080, addresses: ['192.168.1.31'], txt: { ty: 'HP LaserJet MFP M28w', rs: 'eSCL', pdl: 'image/jpeg,application/pdf' } }])[0];

test('eSCL scanner on Linux: install sane-airscan, then it is ready', async () => {
  const r = await diagnose(scannerDevice(), { platform: 'linux', run: fakeRun([['scanimage -L', 'No scanners were identified.\n']]), manager: apt });
  assert.equal(r.status, 'needs-fix');
  assert.deepEqual(r.plans[0].steps[0].args, ['install', '-y', 'sane-airscan']);
  assert.equal(r.plans[0].auto, true);

  const ok = await diagnose(scannerDevice(), { platform: 'linux', run: fakeRun([['scanimage -L', fixture('network-scanimage-L.txt')]]), manager: apt });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.facts.scanBackend, 'airscan');

  const mac = await diagnose(scannerDevice(), { platform: 'darwin', run: fakeRun([]), manager: null });
  assert.equal(mac.status, 'ok');
  assert.equal(mac.support.level, 'native');
  assert.deepEqual(mac.plans[0].steps[0].args, ['-a', 'Image Capture']);
});

test('Chromecast: ready to cast from Chrome', async () => {
  const d = mergeDevices([chromecast()])[0];
  const r = await diagnose(d, { platform: 'linux', run: fakeRun([]), manager: apt });
  assert.equal(r.status, 'ok');
  assert.equal(r.support.level, 'app');
  assert.match(r.headline, /Living Room TV/);
  assert.ok(r.checks.some((c) => c.id === 'cast' && /Cast…/.test(c.detail)));
});

test('LG DLNA TV: what works on a Mac and on Windows', async () => {
  const d = mergeDevices([], lgSsdp())[0];
  const mac = await diagnose(d, { platform: 'darwin', run: fakeRun([]), manager: null });
  assert.equal(mac.status, 'ok');
  assert.ok(mac.checks.some((c) => c.id === 'dlna' && c.status === 'pass'));
  assert.ok(mac.checks.some((c) => c.id === 'mirror-mac' && /third-party/.test(c.detail)));
  const win = await diagnose(d, { platform: 'win32', run: fakeRun([]), manager: null });
  assert.ok(win.checks.some((c) => c.id === 'miracast' && /Windows\+K/.test(c.detail)));
  assert.ok(allSafe(win));
});

test('Apple TV on a Mac: Screen Mirroring; on Windows: needs an app', async () => {
  const d = mergeDevices([{ type: '_airplay._tcp', name: 'Living Room', host: 'Living-Room.local', port: 7000, addresses: ['192.168.1.20'], txt: { model: 'AppleTV11,1', features: '0x5A7FFFF7,0x1E' } }])[0];
  const mac = await diagnose(d, { platform: 'darwin', run: fakeRun([]), manager: null });
  assert.equal(mac.status, 'ok');
  assert.equal(mac.support.level, 'native');
  assert.match(mac.checks.find((c) => c.id === 'airplay').detail, /Screen Mirroring/);
  const win = await diagnose(d, { platform: 'win32', run: fakeRun([]), manager: null });
  assert.equal(win.support.level, 'app');
});
