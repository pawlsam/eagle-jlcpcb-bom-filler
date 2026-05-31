#!/usr/bin/env node
'use strict';

/**
 * lookup.js — batch JLCPCB part lookup, called by jlcpcb-bom-filler.ulp
 *
 * Input:  TSV file (--input <file>), one line per component:
 *           ref TAB value TAB package TAB type
 * Output: TSV to stdout, one line per found component:
 *           ref TAB lcsc_part_number
 *
 * Exit 0 = success (some parts may still be not found — that is not an error)
 * Exit 1 = fatal error (bad args, DB failure, etc.)
 */

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const https  = require('https');
const zlib   = require('zlib');
const { promisify } = require('util');
const inflateRaw = promisify(zlib.inflateRaw);
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_URL   = 'https://bouni.github.io/kicad-jlcpcb-tools/basic-parts-fts5.db.zip.001';
const DATA_DIR = path.join(os.homedir(), '.jlcpcb');
const DB_PATH  = path.join(DATA_DIR, 'basic-parts-fts5.db');

// ---------------------------------------------------------------------------
// Package normalisation
// ---------------------------------------------------------------------------

function normalizePackage(pkg) {
  if (!pkg) return '';
  return pkg
    .replace(/^R-EU_?/i, '')
    .replace(/^C-EU/i,   '')
    .replace(/^C(?=\d)/i, '')
    .replace(/\/\d+$/,   '')
    .replace(/^[RM](?=\d)/i, '')
    .trim()
    .toUpperCase();
}

// ---------------------------------------------------------------------------
// Value normalisation
// ---------------------------------------------------------------------------

const OHM = '\u03A9';

function normalizeResistorValue(v) {
  const code = v.match(/^(\d+)([kKrRmMuU])(\d+)$/i);
  if (code) {
    const [, pre, mult, post] = code;
    const unit = mult.toLowerCase() === 'r' ? OHM : mult.toLowerCase();
    return `${pre}.${post}${unit}`;
  }
  if (/^\d+[rR]$/.test(v)) return v.slice(0, -1) + OHM;
  if (v.length <= 2 && /^[\d.]+[kKmMuU]$/i.test(v)) return v + OHM;
  if (/^\d+$/.test(v)) return v + OHM;
  return v;
}

function normalizeCapacitorValue(v) {
  if (/^\d+[nNpPuU]$/.test(v)) return v + 'F';
  return v;
}

function normalizeInductorValue(v) {
  if (/^\d+[nNuUmM]$/.test(v)) return v + 'H';
  return v;
}

function normalizeValue(value, componentType) {
  if (!value) return value;
  if (componentType === 'resistor')  return normalizeResistorValue(value);
  if (componentType === 'capacitor') return normalizeCapacitorValue(value);
  if (componentType === 'inductor' || componentType === 'filter' || componentType === 'ferrite')
    return normalizeInductorValue(value);
  return value;
}

// ---------------------------------------------------------------------------
// FTS5 helpers
// ---------------------------------------------------------------------------

function escapeFts(term) {
  return '"' + term.replace(/"/g, '""') + '"';
}

function buildFtsQuery(terms) {
  const all   = terms.flatMap(t => t ? t.split(/\s+/) : []);
  const valid = all.filter(t => t && t.length >= 3);
  if (valid.length === 0) return null;
  return valid.map(escapeFts).join(' AND ');
}

// ---------------------------------------------------------------------------
// Database download
// ---------------------------------------------------------------------------

function download(url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const get = (targetUrl) => {
      https.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) return get(res.headers.location);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        res.on('data', c => chunks.push(c));
        res.on('end',  () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    };
    get(url);
  });
}

async function ensureDatabase() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_PATH)) return;
  process.stderr.write('Downloading JLCPCB parts database…\n');
  const buf = await download(DB_URL);
  const data = await extractFromZip(buf);
  fs.writeFileSync(DB_PATH, data);
  process.stderr.write(`Database saved to ${DB_PATH}\n`);
}

// Extract the first (and only) .db file from a zip buffer using built-in zlib.
// Reads sizes from the central directory (reliable even when local header has
// compressedSize=0 due to general-purpose-bit-flag bit 3 / data descriptor).
async function extractFromZip(buf) {
  // Find End of Central Directory record by scanning backwards for PK\x05\x06
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i+1] === 0x4b && buf[i+2] === 0x05 && buf[i+3] === 0x06) {
      eocd = i; break;
    }
  }
  if (eocd < 0) throw new Error('Downloaded file is not a valid zip (no EOCD)');

  const cdOffset = buf.readUInt32LE(eocd + 16); // offset of central directory

  // Read first central directory file header (PK\x01\x02)
  if (buf[cdOffset] !== 0x50 || buf[cdOffset+1] !== 0x4b ||
      buf[cdOffset+2] !== 0x01 || buf[cdOffset+3] !== 0x02)
    throw new Error('Bad central directory signature');

  const method         = buf.readUInt16LE(cdOffset + 10);
  const compressedSize = buf.readUInt32LE(cdOffset + 20); // always correct here
  const localOffset    = buf.readUInt32LE(cdOffset + 42); // offset of local header

  // Skip local file header to get to data
  const filenameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen    = buf.readUInt16LE(localOffset + 28);
  const dataStart   = localOffset + 30 + filenameLen + extraLen;

  const compressed = buf.slice(dataStart, dataStart + compressedSize);
  if (method === 0) return compressed;             // stored
  if (method === 8) return inflateRaw(compressed); // deflate
  throw new Error(`Unsupported zip compression method: ${method}`);
}

// ---------------------------------------------------------------------------
// Part search
// ---------------------------------------------------------------------------

const SQL_SEARCH = `
  SELECT "LCSC Part"    AS lcsc,
         "MFR.Part"     AS mfr,
         "Package"      AS package,
         "Library Type" AS type,
         "Stock"        AS stock,
         "Description"  AS description
  FROM   parts
  WHERE  parts MATCH ?
  ORDER  BY CAST(REPLACE("Stock", ',', '') AS INTEGER) DESC
  LIMIT  10
`;

function searchPart(db, value, pkg, componentType) {
  const normValue = normalizeValue(value, componentType);
  const normalPkg = normalizePackage(pkg);
  if (!normValue || normValue.length < 3) return null;

  const queries = [
    buildFtsQuery([normValue, normalPkg]),
    buildFtsQuery([normValue]),
  ];
  for (const q of queries) {
    if (!q) continue;
    try {
      const rows = db.prepare(SQL_SEARCH).all(q);
      if (rows.length > 0) return rows[0];
    } catch (err) {
      process.stderr.write(`FTS error (${q}): ${err.message}\n`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args      = process.argv.slice(2);
const inputIdx  = args.indexOf('--input');
const inputFile = inputIdx >= 0 ? args[inputIdx + 1] : null;

if (!inputFile || !fs.existsSync(inputFile)) {
  process.stderr.write('Usage: node lookup.js --input <tsv_file>\n');
  process.exit(1);
}

async function main() {
  await ensureDatabase();
  const db    = new DatabaseSync(DB_PATH, { readonly: true });
  const cache = new Map();

  const lines = fs.readFileSync(inputFile, 'utf8').split('\n').filter(l => l.trim());

  for (const line of lines) {
    const cols = line.split('\t');
    if (cols.length < 4) continue;
    const [ref, value, pkg, type] = cols;
    if (!ref || !value || !type) continue;

    const key = `${value}|${pkg}|${type}`;
    let hit = cache.has(key) ? cache.get(key) : searchPart(db, value, pkg, type);
    cache.set(key, hit);

    if (hit) process.stdout.write(`${ref}\t${hit.lcsc}\n`);
  }

  db.close();
}

main().catch(e => {
  process.stderr.write(e.message + '\n');
  process.exit(1);
});
