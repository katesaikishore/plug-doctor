'use strict';

/**
 * EDID: the 128-byte block (plus extension blocks) a screen sends over the
 * cable to say who made it, what it is called and which picture modes it
 * prefers. VESA E-EDID 1.3/1.4 base block and the CTA-861 extension that
 * HDMI TVs and monitors add.
 *
 * Every function here survives short, truncated or garbage input: a broken
 * screen or a cheap adapter can send anything.
 */

const HEADER = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];

/** IEEE OUIs inside CTA vendor-specific data blocks (byte order as stored). */
const OUI_HDMI = 0x000c03; // HDMI Licensing (HDMI 1.x VSDB)
const OUI_HDMI_FORUM = 0xc45dd8; // HDMI Forum (HDMI 2.x HF-VSDB)

/**
 * CTA-861 Video Identification Codes that point at a TV: interlaced
 * standard-definition broadcast modes and 24 Hz cinema modes.
 */
const VIC_SD_INTERLACED = new Set([6, 7, 21, 22]); // 480i, 576i
const VIC_24HZ = new Set([32, 93, 98]); // 1080p24, 2160p24, 4096x2160p24

/** Common VICs, for showing the modes a screen lists. */
const VIC_MODES = {
  1: [640, 480, 60], 2: [720, 480, 60], 3: [720, 480, 60], 4: [1280, 720, 60], 5: [1920, 1080, 60, true],
  16: [1920, 1080, 60], 17: [720, 576, 50], 18: [720, 576, 50], 19: [1280, 720, 50], 20: [1920, 1080, 50, true],
  31: [1920, 1080, 50], 32: [1920, 1080, 24], 33: [1920, 1080, 25], 34: [1920, 1080, 30],
  93: [3840, 2160, 24], 94: [3840, 2160, 25], 95: [3840, 2160, 30], 96: [3840, 2160, 50], 97: [3840, 2160, 60],
  98: [4096, 2160, 24], 99: [4096, 2160, 25], 100: [4096, 2160, 30], 101: [4096, 2160, 50], 102: [4096, 2160, 60],
};

/** Accept a Buffer, Uint8Array, byte array or hex string ("00ffff..." or "<00ffff...>"). */
function toBytes(input) {
  if (input == null) return null;
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (Array.isArray(input)) return Buffer.from(input.map((n) => Number(n) & 0xff));
  if (typeof input === 'string') {
    const hex = input.replace(/0x/gi, '').replace(/[\s:<>]/g, '');
    if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) return null;
    return Buffer.from(hex, 'hex');
  }
  return null;
}

/**
 * Three-letter PNP manufacturer ID from its 16-bit code (big-endian, three
 * 5-bit letters, 1 = A). 0x4c2d is "SAM".
 * @param {number} code
 * @returns {string|null}
 */
function pnpFromCode(code) {
  if (!Number.isInteger(code) || code <= 0 || code > 0x7fff) return null;
  const letters = [(code >> 10) & 0x1f, (code >> 5) & 0x1f, code & 0x1f];
  if (letters.some((l) => l < 1 || l > 26)) return null;
  return String.fromCharCode(...letters.map((l) => 64 + l));
}

/** Text from a display descriptor: ASCII, ends at a line feed, padded with spaces. */
function descriptorText(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b === 0x0a || b === 0x00) break;
    s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '';
  }
  return s.trim() || null;
}

/**
 * One 18-byte Detailed Timing Descriptor.
 * @returns {{ pixelClockMHz: number, width: number, height: number, refresh: number|null, interlaced: boolean, imageWidthMm: number, imageHeightMm: number }|null}
 */
function parseDtd(b) {
  if (!b || b.length < 18) return null;
  const clock10k = b[0] | (b[1] << 8);
  if (clock10k === 0) return null;
  const width = b[2] | ((b[4] & 0xf0) << 4);
  const hblank = b[3] | ((b[4] & 0x0f) << 8);
  const height = b[5] | ((b[7] & 0xf0) << 4);
  const vblank = b[6] | ((b[7] & 0x0f) << 8);
  if (!width || !height) return null;
  const total = (width + hblank) * (height + vblank);
  const refresh = total ? Math.round(((clock10k * 10000) / total) * 100) / 100 : null;
  const interlaced = Boolean(b[17] & 0x80);
  return {
    pixelClockMHz: clock10k / 100,
    width,
    // An interlaced timing describes one field; the picture is twice as tall.
    height: interlaced ? height * 2 : height,
    refresh,
    interlaced,
    imageWidthMm: b[12] | ((b[14] & 0xf0) << 4),
    imageHeightMm: b[13] | ((b[14] & 0x0f) << 8),
  };
}

/**
 * CTA-861 extension block (tag 0x02): HDMI, HDR, listed video modes.
 * @param {Buffer} block 128 bytes
 */
function parseCta(block) {
  if (!block || block.length < 128 || block[0] !== 0x02) return null;
  const revision = block[1];
  const dtdStart = block[2];
  const flags = block[3];
  const out = {
    revision,
    underscan: revision >= 2 ? Boolean(flags & 0x80) : null,
    basicAudio: revision >= 2 ? Boolean(flags & 0x40) : null,
    hdmi: false,
    hdmiForum: false,
    maxTmdsMhz: null,
    physicalAddress: null,
    vics: [],
    hdr: null,
    dtds: [],
  };
  // Data blocks sit between byte 4 and the first detailed timing (revision 3+).
  const end = Math.min(dtdStart, 127);
  let i = 4;
  while (revision >= 3 && dtdStart > 4 && i < end) {
    const tag = block[i] >> 5;
    const len = block[i] & 0x1f;
    if (i + 1 + len > end) break;
    const p = block.subarray(i + 1, i + 1 + len);
    if (tag === 2) {
      for (const v of p) {
        // VICs 1-64 may carry a "native" flag in bit 7 (byte values 129-192).
        if (v >= 129 && v <= 192) out.vics.push({ vic: v & 0x7f, native: true });
        else if (v !== 0 && v !== 128) out.vics.push({ vic: v, native: false });
      }
    } else if (tag === 3 && len >= 3) {
      const oui = p[0] | (p[1] << 8) | (p[2] << 16);
      if (oui === OUI_HDMI) {
        out.hdmi = true;
        if (len >= 5) out.physicalAddress = `${p[3] >> 4}.${p[3] & 15}.${p[4] >> 4}.${p[4] & 15}`;
        if (len >= 7 && p[6]) out.maxTmdsMhz = Math.max(out.maxTmdsMhz ?? 0, p[6] * 5);
      } else if (oui === OUI_HDMI_FORUM) {
        out.hdmiForum = true;
        if (len >= 5 && p[4]) out.maxTmdsMhz = Math.max(out.maxTmdsMhz ?? 0, p[4] * 5);
      }
    } else if (tag === 7 && len >= 2 && p[0] === 0x06) {
      // HDR Static Metadata: EOTF bits. Bit 2 = SMPTE ST 2084 (HDR10), bit 3 = HLG.
      out.hdr = { pq: Boolean(p[1] & 0x04), hlg: Boolean(p[1] & 0x08) };
    }
    i += 1 + len;
  }
  if (dtdStart >= 4) {
    for (let off = dtdStart; off + 18 <= 127; off += 18) {
      const t = parseDtd(block.subarray(off, off + 18));
      if (!t) break;
      out.dtds.push(t);
    }
  }
  return out;
}

/**
 * Parse an EDID blob.
 * @param {Buffer|Uint8Array|number[]|string} input
 * @returns {null | {
 *   manufacturer: string|null, productCode: number, serialNumber: number|null, week: number|null, year: number|null,
 *   version: string, digital: boolean, sizeCm: { width: number, height: number }|null, name: string|null,
 *   serialString: string|null, text: string|null, rangeLimits: object|null, preferred: object|null,
 *   timings: object[], extensions: number, checksumOk: boolean, cta: object|null, hdmi: boolean, tvLike: boolean
 * }}  null when this is not an EDID at all
 */
function parseEdid(input) {
  let b;
  try {
    b = toBytes(input);
  } catch {
    return null;
  }
  if (!b || b.length < 128) return null;
  if (!HEADER.every((v, i) => b[i] === v)) return null;

  let sum = 0;
  for (let i = 0; i < 128; i++) sum += b[i];

  const week = b[16];
  const out = {
    manufacturer: pnpFromCode((b[8] << 8) | b[9]),
    productCode: b[10] | (b[11] << 8),
    serialNumber: (b[12] | (b[13] << 8) | (b[14] << 16) | (b[15] << 24)) >>> 0 || null,
    week: week >= 1 && week <= 54 ? week : null,
    year: b[17] ? 1990 + b[17] : null,
    modelYear: week === 0xff,
    version: `${b[18]}.${b[19]}`,
    digital: Boolean(b[20] & 0x80),
    sizeCm: b[21] && b[22] ? { width: b[21], height: b[22] } : null,
    name: null,
    serialString: null,
    text: null,
    rangeLimits: null,
    preferred: null,
    timings: [],
    extensions: b[126],
    checksumOk: sum % 256 === 0,
    cta: null,
    hdmi: false,
    tvLike: false,
  };

  for (let d = 0; d < 4; d++) {
    const s = b.subarray(54 + d * 18, 72 + d * 18);
    const t = parseDtd(s);
    if (t) {
      out.timings.push(t);
      continue;
    }
    if (s[0] !== 0 || s[1] !== 0) continue;
    const tag = s[3];
    if (tag === 0xfc) out.name = descriptorText(s.subarray(5));
    else if (tag === 0xff) out.serialString = descriptorText(s.subarray(5));
    else if (tag === 0xfe) out.text = descriptorText(s.subarray(5));
    else if (tag === 0xfd) out.rangeLimits = { minVHz: s[5], maxVHz: s[6], minHKHz: s[7], maxHKHz: s[8], maxPixelClockMHz: s[9] * 10 };
  }
  // The first detailed timing is the preferred (usually native) mode.
  out.preferred = out.timings[0] ?? null;

  for (let k = 1; k <= out.extensions && b.length >= 128 * (k + 1); k++) {
    const block = b.subarray(128 * k, 128 * (k + 1));
    if (block[0] === 0x02 && !out.cta) out.cta = parseCta(block);
  }
  if (out.cta) {
    out.hdmi = out.cta.hdmi || out.cta.hdmiForum;
    out.tvLike = ctaTvLike(out.cta);
    if (!out.preferred && out.cta.dtds[0]) out.preferred = out.cta.dtds[0];
  }
  return out;
}

/**
 * A guess, not a fact: HDMI screens that list interlaced SD broadcast modes
 * and a 24 Hz cinema mode are almost always TVs.
 */
function ctaTvLike(cta) {
  if (!cta?.hdmi && !cta?.hdmiForum) return false;
  const vics = new Set((cta.vics ?? []).map((v) => v.vic));
  return [...VIC_SD_INTERLACED].some((v) => vics.has(v)) && [...VIC_24HZ].some((v) => vics.has(v));
}

/** Largest mode a CTA block lists, using the VICs this module knows. */
function largestCtaMode(cta) {
  let best = null;
  for (const { vic } of cta?.vics ?? []) {
    const m = VIC_MODES[vic];
    if (!m || m[3]) continue;
    if (!best || m[0] * m[1] > best.width * best.height || (m[0] * m[1] === best.width * best.height && m[2] > best.refresh)) {
      best = { width: m[0], height: m[1], refresh: m[2] };
    }
  }
  return best;
}

module.exports = { parseEdid, parseCta, parseDtd, pnpFromCode, toBytes, ctaTvLike, largestCtaMode, VIC_MODES };
