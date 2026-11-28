// IP -> country (ISO 3166-1 alpha-2) of a connection, for the flag the lobby paints at the right of a Waiting List row.
// Offline: the IP2Location LITE DB1 (country only) BIN is read into memory once (2.8 MB, no request, no rate limit, no
// player IP leaving the server). File: server/geoip/IP2LOCATION-LITE-DB1.BIN (download.ip2location.com/lite, CC BY-SA 4.0,
// licence next to it). A missing / unreadable file just means "unknown country" for every lookup.
//
// BIN layout (same reader as the ip2location-nodejs package): a 64-byte header (dbType, dbColumn, dates, dbCount at +5,
// baseAddress at +9, indexBaseAddress at +21, all u32 little-endian and 1-based), then a 65536-entry index of
// [low, high] record numbers (8 bytes each) keyed by the first two IP octets, then the records themselves
// (dbColumn * 4 bytes: [ipFrom u32][countryPos u32]), the strings after them ([len][bytes]: the2-letter code, then the
// long name). Lookups binary-search the index slice for the record whose [ipFrom, next ipFrom) holds the address.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DB_FILE = path.resolve(fileURLToPath(new URL("../../geoip/IP2LOCATION-LITE-DB1.BIN", import.meta.url)));
const HEADER = 64;
const INDEX_ENTRIES = 65536;
/** resolved answers kept per IP: the room list is polled every 1.5 s by every client */
const CACHE_MAX = 2048;
/**
 * An address the database cannot place (loopback / private / CGNAT / v6) is *unknown* on purpose — a local player gets
 * the gray "?" flag of the UI (src/lobby/screensCross/nationFlag.ts), never a guessed country.
 */
let db: Buffer | null = null;
/** record bytes, first record's file offset, record count, index file offset */
let column = 0, base = 0, count = 0, indexAt = HEADER;
const cache = new Map<string, string>();

function load(file = DB_FILE): boolean {
  if (db) return true;
  try {
    const buf = readFileSync(file);
    column = buf[1] << 2; // dbColumn columns of 4 bytes (DB1 = ipFrom + country)
    count = buf.readUInt32LE(5);
    base = buf.readUInt32LE(9) - 1; // the header addresses are 1-based
    indexAt = buf.readUInt32LE(21) - 1;
    if (buf.length <= HEADER || !column || !count || base < HEADER || indexAt < HEADER) return false;
    db = buf;
    return true;
  } catch {
    return false;
  }
}

/** the dotted quad as uint32, or null for anything that is not a public IPv4 address (loopback / private / CGNAT / v6) */
function ipv4(raw: string): number | null {
  const s = raw.replace(/^::ffff:/i, "").trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return null;
  const b = s.split(".").map(Number);
  if (b.some((x) => x > 255)) return null;
  if (b[0] === 0 || b[0] === 10 || b[0] === 127) return null;
  if (b[0] === 192 && b[1] === 168) return null;
  if (b[0] === 172 && b[1] >= 16 && b[1] <= 31) return null;
  if (b[0] === 100 && b[1] >= 64 && b[1] <= 127) return null;
  return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
}

/** "BR" / "ID" ... of a peer address, "" when it resolves to nothing (private IP, no database, outside every range) */
export function countryOf(ip: string): string {
  const n = ipv4(ip);
  const key = n === null ? `local:${ip}` : String(n);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  // no address the database can place (loopback / private / v6 / outside every range) falls back to the local stand-in
  const code = n === null ? "" : lookup(n);
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, code);
  return code;
}

function lookup(n: number): string {
  if (!load()) return "";
  const d = db!;
  const at = indexAt + (n >>> 16) * 8;
  if (at + 8 > d.length) return "";
  let low = d.readUInt32LE(at), high = d.readUInt32LE(at + 4);
  if (low > high || low >= count) { low = 0; high = count - 1; } // a stale index falls back to the full scan
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const off = base + mid * column;
    if (off + column > d.length) { high = mid - 1; continue; }
    if (n < d.readUInt32LE(off)) { high = mid - 1; continue; }
    const to = mid + 1 < count && off + 2 * column <= d.length ? d.readUInt32LE(off + column) : 0xffffffff;
    if (n < to) return codeAt(d.readUInt32LE(off + 4));
    low = mid + 1;
  }
  return "";
}

/** the short country string at a BIN position ([len][bytes]) */
function codeAt(pos: number): string {
  const d = db!;
  if (!pos || pos >= d.length) return "";
  const len = d[pos];
  if (!len || pos + 1 + len > d.length) return "";
  const s = d.toString("latin1", pos + 1, pos + 1 + len);
  return /^[A-Z]{2}$/.test(s) ? s : "";
}
