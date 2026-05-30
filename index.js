#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const AdmZip = require('adm-zip');
const { DatabaseSync } = require('node:sqlite');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_URL  = 'https://bouni.github.io/kicad-jlcpcb-tools/basic-parts-fts5.db.zip.001';
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH  = path.join(DATA_DIR, 'basic-parts-fts5.db');

// Component types we handle (by reference-designator prefix)
const COMPONENT_TYPES = {
  R:  'resistor',
  C:  'capacitor',
  D:  'diode',
  L:  'inductor',
  FL: 'filter',
  FB: 'ferrite',
};

// ---------------------------------------------------------------------------
// Component type detection
// ---------------------------------------------------------------------------

function getComponentType(ref) {
  ref = ref.trim().toUpperCase();
  if (/^FL\d/.test(ref)) return COMPONENT_TYPES.FL;
  if (/^FB\d/.test(ref)) return COMPONENT_TYPES.FB;
  if (/^R\d/.test(ref))  return COMPONENT_TYPES.R;
  if (/^C\d/.test(ref))  return COMPONENT_TYPES.C;
  if (/^D\d/.test(ref))  return COMPONENT_TYPES.D;
  if (/^L\d/.test(ref))  return COMPONENT_TYPES.L;
  return null;
}

// ---------------------------------------------------------------------------
// Package normalisation — strip Eagle device prefixes, keep the footprint code
// ---------------------------------------------------------------------------

function normalizePackage(pkg) {
  if (!pkg) return '';
  return pkg
    .replace(/^R-EU_?/i, '')   // R-EU_0402/2 → 0402/2
    .replace(/^C-EU/i,   '')   // C-EUC0402K  → C0402K
    .replace(/^C(?=\d)/i, '')  // C0402       → 0402
    .replace(/\/\d+$/,   '')   // 0402/2      → 0402
    .replace(/^[RM](?=\d)/i, '') // R1206, M1206 → 1206 (Eagle <part device=> shorthand)
    .trim()
    .toUpperCase();
}

// ---------------------------------------------------------------------------
// Value normalisation — convert Eagle notation to JLCPCB description substrings
// The DB uses a trigram tokenizer: any ≥3-char substring works as a search term.
// ---------------------------------------------------------------------------

const OHM = '\u03A9'; // Ω

/**
 * Convert Eagle resistor value notation to a JLCPCB-compatible search term.
 *   4k7   → 4.7k    (Eagle code notation without decimal)
 *   2r2   → 2.2Ω
 *   22R   → 22Ω     (trailing R = ohms)
 *   0R    → 0Ω      (zero-ohm jumper)
 *   1k    → 1kΩ     ("1k" is 2 chars, below trigram min; add Ω → 3 chars)
 *   10k   → 10k     (already ≥3 chars, trigram finds "10k" in "10kΩ")
 */
function normalizeResistorValue(v) {
  // XkY / XrY / XmY etc. (Eagle split notation)
  const code = v.match(/^(\d+)([kKrRmMuU])(\d+)$/i);
  if (code) {
    const [, pre, mult, post] = code;
    const unit = mult.toLowerCase() === 'r' ? OHM : mult.toLowerCase();
    return `${pre}.${post}${unit}`;
  }
  // Trailing R (ohms): 22R → 22Ω, 0R → 0Ω
  if (/^\d+[rR]$/.test(v)) return v.slice(0, -1) + OHM;
  // Short values ≤2 chars like "1k": add Ω to reach 3-char trigram minimum
  if (v.length <= 2 && /^[\d.]+[kKmMuU]$/i.test(v)) return v + OHM;
  // Pure integer (no unit): 100 → 100Ω
  if (/^\d+$/.test(v)) return v + OHM;
  return v;
}

/**
 * Add explicit unit suffix for capacitor/inductor Eagle values that may be
 * too short or lack the unit (e.g. "1n" → "1nF", "1u" → "1uF").
 */
function normalizeCapacitorValue(v) {
  // "1n" → "1nF", "1p" → "1pF", "1u" → "1uF"
  if (/^\d+[nNpPuU]$/.test(v)) return v + 'F';
  return v;
}

function normalizeInductorValue(v) {
  // "10n" → "10nH", "1u" → "1uH" (Eagle sometimes omits H)
  if (/^\d+[nNuUmM]$/.test(v)) return v + 'H';
  return v;
}

function normalizeValue(value, componentType) {
  if (!value) return value;
  if (componentType === 'resistor') return normalizeResistorValue(value);
  if (componentType === 'capacitor') return normalizeCapacitorValue(value);
  if (componentType === 'inductor' || componentType === 'filter' || componentType === 'ferrite')
    return normalizeInductorValue(value);
  return value;
}

// ---------------------------------------------------------------------------
// FTS5 helpers (trigram tokenizer — terms are plain substrings, ≥3 chars)
// ---------------------------------------------------------------------------

function escapeFts(term) {
  return '"' + term.replace(/"/g, '""') + '"';
}

function buildFtsQuery(terms) {
  // Flatten: split each term on whitespace so "1N4007 M7" → ["1N4007","M7"]
  const all = terms.flatMap(t => t ? t.split(/\s+/) : []);
  const valid = all.filter(t => t && t.length >= 3);
  if (valid.length === 0) return null;
  return valid.map(escapeFts).join(' AND ');
}

// ---------------------------------------------------------------------------
// Database download + extraction
// ---------------------------------------------------------------------------

function download(url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const get = (targetUrl) => {
      https.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
        }
        res.on('data', chunk => chunks.push(chunk));
        res.on('end',  () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    };
    get(url);
  });
}

async function ensureDatabase() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    return; // already present
  }

  console.log('Downloading JLCPCB Basic+Preferred parts database…');
  const buf = await download(DB_URL);
  console.log(`  Downloaded ${(buf.length / 1024).toFixed(1)} KB`);

  const zip = new AdmZip(buf);
  const entry = zip.getEntries().find(e => e.entryName.endsWith('.db'));
  if (!entry) {
    throw new Error('No .db entry in zip: ' + zip.getEntries().map(e => e.entryName).join(', '));
  }

  fs.writeFileSync(DB_PATH, entry.getData());
  const sizeMB = (fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(1);
  console.log(`  Extracted to ${DB_PATH} (${sizeMB} MB)`);
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

  // If the normalised value is too short for the trigram index (< 3 chars),
  // we cannot search reliably — skip rather than returning a package-only match.
  if (!normValue || normValue.length < 3) return null;

  // Try normalised value + package first, then value only as fallback
  const queries = [
    buildFtsQuery([normValue, normalPkg]),
    buildFtsQuery([normValue]),
  ];

  for (const ftsQuery of queries) {
    if (!ftsQuery) continue;
    try {
      const rows = db.prepare(SQL_SEARCH).all(ftsQuery);
      if (rows.length > 0) return rows[0];
    } catch (err) {
      process.stderr.write(`  FTS error (${ftsQuery}): ${err.message}\n`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

/** Auto-detect the delimiter of a CSV file (tries ';' then ','). */
function detectDelimiter(raw) {
  const firstLine = raw.split('\n')[0] || '';
  const semiCount  = (firstLine.match(/;/g)  || []).length;
  const commaCount = (firstLine.match(/,/g)  || []).length;
  return semiCount > commaCount ? ';' : ',';
}

/**
 * Try several candidate names and return the first one present in the columns array.
 * Returns the explicit override if supplied.
 */
function pickColumn(columns, candidates, override) {
  if (override) return override;
  for (const c of candidates) {
    if (columns.includes(c)) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main processing
// ---------------------------------------------------------------------------

async function processBOM(inputFile, outputFile, options = {}) {
  const {
    colPart    = null,
    colValue   = null,
    colPackage = null,
    colLcsc    = null,
    skipFilled = true,
  } = options;

  // ---- read & parse -------------------------------------------------------
  const raw = fs.readFileSync(inputFile, 'utf8');
  const delimiter = detectDelimiter(raw);

  const records = parse(raw, {
    columns:          true,
    delimiter,
    skip_empty_lines: true,
    trim:             true,
    bom:              true,
  });

  if (records.length === 0) {
    console.log('No records in file.');
    return;
  }

  const columns = Object.keys(records[0]);
  console.log(`Read ${records.length} rows, delimiter='${delimiter}', columns: ${columns.join(', ')}`);

  // ---- resolve column names -----------------------------------------------
  const partCol    = pickColumn(columns, ['Part','Designator','Ref','Reference'],      colPart);
  const valueCol   = pickColumn(columns, ['Value','Val','Component'],                  colValue);
  const packageCol = pickColumn(columns, ['Package','Footprint','Pkg','Device'],        colPackage);
  const lcscColIn  = pickColumn(columns, ['LCSC','LCSC Part','OrderNo','SupplierPN'],  colLcsc);
  const lcscCol    = lcscColIn || (colLcsc || 'LCSC');

  if (!partCol)    { console.error('ERROR: cannot find Part/Designator column. Use --part=<name>');    process.exit(1); }
  if (!valueCol)   { console.error('ERROR: cannot find Value column. Use --value=<name>');             process.exit(1); }
  if (!packageCol) { console.error('ERROR: cannot find Package/Device column. Use --package=<name>');  process.exit(1); }

  console.log(`  Part="${partCol}"  Value="${valueCol}"  Package="${packageCol}"  LCSC="${lcscCol}"`);

  // add LCSC column if absent
  if (!columns.includes(lcscCol)) {
    records.forEach(r => r[lcscCol] = '');
    columns.push(lcscCol);
  }

  // ---- open database -------------------------------------------------------
  await ensureDatabase();
  const db = new DatabaseSync(DB_PATH, { readonly: true });

  let processed = 0, found = 0, skipped = 0;
  const cache = new Map();

  for (const rec of records) {
    const ref   = (rec[partCol]    || '').trim();
    const value = (rec[valueCol]   || '').trim();
    const pkg   = (rec[packageCol] || '').trim();
    const existing = (rec[lcscCol] || '').trim();

    const type = getComponentType(ref);
    if (!type) continue;

    if (skipFilled && existing) {
      console.log(`  ${ref}: already set to ${existing} — skipping`);
      skipped++;
      continue;
    }

    const cacheKey = `${value}|${pkg}`;
    let hit;

    if (cache.has(cacheKey)) {
      hit = cache.get(cacheKey);
      process.stdout.write(`  ${ref} (${type}): "${value}/${pkg}" [cached] `);
    } else {
      const normV = normalizeValue(value, type);
      process.stdout.write(`  ${ref} (${type}): "${normV}" "${normalizePackage(pkg)}"… `);
      hit = searchPart(db, value, pkg, type);
      cache.set(cacheKey, hit);
    }

    if (hit) {
      rec[lcscCol] = hit.lcsc;
      console.log(`→ ${hit.lcsc}  ${hit.mfr}  ${hit.package}  [${hit.type}] stock=${hit.stock}`);
      found++;
    } else {
      console.log('→ not found');
    }

    processed++;
  }

  db.close();

  console.log(`\nSummary: ${processed} processed, ${found} matched, ${skipped} skipped (already had LCSC)`);

  // ---- write output -------------------------------------------------------
  const output = stringify(records, { header: true, columns, delimiter });
  fs.writeFileSync(outputFile, output, 'utf8');
  console.log(`Output: ${outputFile}`);
}

// ---------------------------------------------------------------------------
// Schematic processing (.sch)
// ---------------------------------------------------------------------------

async function processSchematic(inputFile, outputFile, options = {}) {
  const { skipFilled = true } = options;

  let text = fs.readFileSync(inputFile, 'utf8');

  // Scope to <parts>…</parts> to avoid matching <instance part="…"> in <sheets>
  const partsMatch = text.match(/(<parts>)([\s\S]*?)(<\/parts>)/);
  if (!partsMatch) {
    console.error('ERROR: No <parts> section found in schematic.');
    process.exit(1);
  }
  const [, openTag, , closeTag] = partsMatch;
  let partsBody = partsMatch[2];

  await ensureDatabase();
  const db = new DatabaseSync(DB_PATH, { readonly: true });

  const cache = new Map();
  let processed = 0, found = 0, skipped = 0;

  // Match each <part …> — self-closing or with children
  const partRe = /<part\b([^>]*)(?:\/>|>([\s\S]*?)<\/part>)/g;

  partsBody = partsBody.replace(partRe, (match, attrs, children) => {
    children = children || '';

    const nameM  = attrs.match(/\bname="([^"]+)"/);
    const valueM = attrs.match(/\bvalue="([^"]+)"/);
    const devM   = attrs.match(/\bdevice="([^"]+)"/);

    if (!nameM) return match;
    const ref    = nameM[1];
    const value  = valueM ? valueM[1] : '';
    const device = devM   ? devM[1]   : '';

    const type = getComponentType(ref);
    if (!type) return match; // not R/C/D/L/FL/FB

    if (!value) {
      console.log(`  ${ref}: no value — skipping`);
      return match;
    }

    // Skip if already has LCSC_PART
    if (children.includes('name="LCSC_PART"')) {
      if (skipFilled) {
        const existM = children.match(/name="LCSC_PART"\s+value="([^"]*)"/);
        const existing = existM ? existM[1] : '?';
        console.log(`  ${ref}: already ${existing} — skipping`);
        skipped++;
        return match;
      }
      // --no-skip: strip existing LCSC_PART before re-searching
      children = children.replace(/<attribute\s+name="LCSC_PART"[^/]*\/>[\n]?/g, '');
    }

    const cacheKey = `${value}|${device}`;
    let hit;

    if (cache.has(cacheKey)) {
      hit = cache.get(cacheKey);
      process.stdout.write(`  ${ref} (${type}): "${value}/${device}" [cached] `);
    } else {
      const normV   = normalizeValue(value, type);
      const normPkg = normalizePackage(device);
      process.stdout.write(`  ${ref} (${type}): "${normV}" "${normPkg}"… `);
      hit = searchPart(db, value, device, type);
      cache.set(cacheKey, hit);
    }

    processed++;

    if (hit) {
      console.log(`→ ${hit.lcsc}  ${hit.mfr}  ${hit.package}  [${hit.type}]`);
      found++;
      const attrLine = `<attribute name="LCSC_PART" value="${hit.lcsc}" constant="no"/>`;
      const trimmed = children.trimEnd();
      const newChildren = trimmed
        ? trimmed + '\n' + attrLine + '\n'
        : attrLine + '\n';
      return `<part${attrs}>\n${newChildren}</part>`;
    } else {
      console.log('→ not found');
      return children ? `<part${attrs}>${children}</part>` : `<part${attrs}/>`;
    }
  });

  db.close();

  // Replace the original <parts> section with the modified one
  const partsIdx = text.indexOf(partsMatch[0]);
  text = text.slice(0, partsIdx) + openTag + partsBody + closeTag + text.slice(partsIdx + partsMatch[0].length);

  fs.writeFileSync(outputFile, text, 'utf8');
  console.log(`\nSummary: ${processed} processed, ${found} matched, ${skipped} skipped (already had LCSC_PART)`);
  console.log(`Output: ${outputFile}`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes('--update-db')) {
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
    console.log('Removed cached database.');
  }
  ensureDatabase()
    .then(() => console.log('Database updated.'))
    .catch(e => { console.error(e.message); process.exit(1); });

} else if (args.length === 0 || args.includes('--help')) {
  console.log(`
JLCPCB BOM filler  —  adds LCSC part numbers to Eagle BOM CSV

Usage:
  node index.js <input.csv> [output.csv] [options]

Options:
  --part=<col>     Column for reference designators  (default: auto-detect Part/Designator)
  --value=<col>    Column for component values        (default: auto-detect Value)
  --package=<col>  Column for package/footprint       (default: auto-detect Package/Device)
  --lcsc=<col>     Column for LCSC output             (default: LCSC)
  --no-skip        Re-search components that already have an LCSC number
  --update-db      Delete cached database and re-download

Only R, C, D, L, FL, FB components are processed.
Source: JLCPCB Basic+Preferred offline database (~347 KB, auto-downloaded on first run).
`.trim());

} else {
  const inputFile  = args[0];
  const isSch = /\.sch$/i.test(inputFile);
  const outputFile = (args[1] && !args[1].startsWith('--'))
    ? args[1]
    : isSch
      ? inputFile.replace(/\.sch$/i, '_lcsc.sch')
      : inputFile.replace(/\.csv$/i, '') + '_lcsc.csv';

  if (!fs.existsSync(inputFile)) {
    console.error(`File not found: ${inputFile}`);
    process.exit(1);
  }

  const opts = { skipFilled: !args.includes('--no-skip') };
  for (const a of args) {
    if (a.startsWith('--part='))    opts.colPart    = a.slice(7);
    if (a.startsWith('--value='))   opts.colValue   = a.slice(8);
    if (a.startsWith('--package=')) opts.colPackage = a.slice(10);
    if (a.startsWith('--lcsc='))    opts.colLcsc    = a.slice(7);
  }

  const run = isSch ? processSchematic : processBOM;
  run(inputFile, outputFile, opts).catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}
