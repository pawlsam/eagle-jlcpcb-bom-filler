#!/usr/bin/env node
'use strict';

/**
 * test.js — verifies that lookup.js finds known JLCPCB Basic/Preferred parts.
 * Run: node test.js
 */

const { execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const LOOKUP = path.join(__dirname, 'lookup.js');
const TMP    = path.join(os.tmpdir(), 'jlcpcb_test.tsv');

// ---------------------------------------------------------------------------
// Test cases: [ref, value, package, type]
// These are all common Basic/Preferred parts that should always be found.
// ---------------------------------------------------------------------------
const CASES = [
  // Resistors
  { ref: 'R1',  value: '10k',       pkg: 'R0402',    type: 'resistor'  },
  { ref: 'R2',  value: '100',       pkg: 'R0402',    type: 'resistor'  },
  { ref: 'R3',  value: '4k7',       pkg: 'M1206',    type: 'resistor'  },
  // Capacitors
  { ref: 'C1',  value: '100n',      pkg: 'C0402',    type: 'capacitor' },
  { ref: 'C2',  value: '10u',       pkg: 'C0805',    type: 'capacitor' },
  { ref: 'C3',  value: '1u',        pkg: 'C0402',    type: 'capacitor' },
  // Diodes
  { ref: 'D1',  value: '1N4007 M7', pkg: 'DO-214AC', type: 'diode'     },
  // Inductors
  { ref: 'L1',  value: '10u',       pkg: 'L0805',    type: 'inductor'  },
];

// ---------------------------------------------------------------------------

function run() {
  // Write TSV input
  const tsv = CASES.map(c => `${c.ref}\t${c.value}\t${c.pkg}\t${c.type}`).join('\n') + '\n';
  fs.writeFileSync(TMP, tsv, 'utf8');

  let stdout;
  try {
    stdout = execFileSync(process.execPath, [LOOKUP, '--input', TMP], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit'], // inherit stderr so download progress shows
    });
  } finally {
    fs.rmSync(TMP, { force: true });
  }

  // Parse results: ref -> lcsc
  const found = new Map();
  for (const line of stdout.split('\n')) {
    const [ref, lcsc] = line.split('\t');
    if (ref && lcsc) found.set(ref.trim(), lcsc.trim());
  }

  // Report
  let pass = 0;
  let fail = 0;
  console.log('\n  ref   value            package      type         LCSC');
  console.log('  ' + '-'.repeat(65));
  for (const c of CASES) {
    const lcsc = found.get(c.ref);
    const ok   = !!lcsc;
    const mark = ok ? 'PASS' : 'FAIL';
    console.log(
      `  [${mark}] ${c.ref.padEnd(4)} ${c.value.padEnd(16)} ${c.pkg.padEnd(12)} ${c.type.padEnd(12)} ${lcsc || '(not found)'}`
    );
    ok ? pass++ : fail++;
  }
  console.log('  ' + '-'.repeat(65));
  console.log(`  ${pass} passed, ${fail} failed\n`);

  if (fail > 0) process.exit(1);
}

run();
