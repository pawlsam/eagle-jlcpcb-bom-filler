# Eagle JLCPCB ULP — BOM Filler

JLCPCB offers an **SMT Assembly** service — having your SMD components soldered during PCB manufacturing.  
To use it, you need to submit a BOM with an **LCSC part number** filled in for every component.

This tool does that automatically. Run the ULP in Eagle and it fills the `LCSC_PART` attribute on every recognised component in the open schematic. Eagle can then generate a complete, ready-to-upload BOM directly from the schematic.

Lookup runs offline against the [JLCPCB Basic + Preferred parts database](https://github.com/bouni/kicad-jlcpcb-tools) — no login, no API key required.  
Only **Basic** and **Preferred** parts are matched (no extra assembly fee at JLCPCB).

---

## Requirements

- **Eagle** (tested with Eagle 9.x)
- **Node.js 22+** — download from [nodejs.org](https://nodejs.org/en/download)

The parts database (~347 KB) is downloaded automatically on first run and cached in `%USERPROFILE%\.jlcpcb\`.

---

## Installation

Copy both files into any folder (e.g. your Eagle project folder):

```
jlcpcb-bom-filler.ulp
lookup.js
```

`lookup.js` uses only Node.js built-in modules (`fs`, `https`, `zlib`, `node:sqlite`) — no `npm install` needed, no `node_modules` required.

---

## Usage

1. Open your schematic in Eagle
2. Run `jlcpcb-bom-filler.ulp` via **File → Execute ULP…**
3. Click **Run**

The ULP adds `LCSC_PART` attributes directly to matching components.  
Parts that already have an `LCSC_PART` value are skipped by default — use the **Re-process** checkbox to update them.

---

## Supported components

| Prefix | Type |
|--------|------|
| `R` | Resistor |
| `C` | Capacitor |
| `D` | Diode |
| `L` | Inductor |
| `FL` | Filter / ferrite bead |
| `FB` | Ferrite bead |

Connectors (`J`, `X`), ICs (`U`), MOSFETs (`Q`), and power symbols are intentionally skipped.

---

## How it works

1. **Collect parts** — The ULP iterates over all parts in the open schematic via Eagle's object model.
2. **Value normalisation** — Eagle notation is converted to JLCPCB search terms:
   - `4k7` → `4.7kΩ`, `22R` → `22Ω`, `100n` → `100nF`, `10u` → `10uH`, …
3. **Package normalisation** — Eagle device prefixes are stripped:
   - `R-EU_0402/2` → `0402`, `R1206` → `1206`, `M1206` → `1206`
4. **Full-text search** — Uses the FTS5 trigram index in the offline SQLite database.  
   Tries `value AND package` first, falls back to `value` only.
5. **Highest stock wins** — The matched part with the most stock is chosen.
6. **Apply** — Attributes are written to the schematic via Eagle's `ATTRIBUTE` command.

---

## Limitations

- Only **SMD** passive components are matched. Through-hole parts are generally not in the Basic/Preferred list.
- **0-ohm jumpers** (`0R`) are skipped — not searchable by value.
- Non-standard value strings (e.g. exotic ferrite bead impedance codes) may not match.
- The database is a snapshot; delete `%USERPROFILE%\.jlcpcb\basic-parts-fts5.db` to force a fresh download.

---

## Testing lookup.js

```bash
node test.js
```

Runs a set of known components through `lookup.js` and verifies LCSC part numbers are returned.

---

## Database source

Parts database by [bouni/kicad-jlcpcb-tools](https://github.com/bouni/kicad-jlcpcb-tools),  
published at `https://bouni.github.io/kicad-jlcpcb-tools/basic-parts-fts5.db.zip.001`.

---

## License

MIT
