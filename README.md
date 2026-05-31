# Eagle JLCPCB ULP — BOM Filler

Eagle ULP that automatically fills **LCSC part numbers** directly into the open schematic.  
Works on the live schematic — no file export needed.

Searches the offline [JLCPCB Basic + Preferred parts database](https://github.com/bouni/kicad-jlcpcb-tools) — no login, no API key required.  
Only **Basic** and **Preferred** parts are matched (no extra assembly fee at JLCPCB).

---

## Requirements

- **Eagle** (tested with Eagle 9.x)
- **Node.js 22+** (uses the built-in `node:sqlite` module — no native build tools needed)

The parts database (~347 KB) is downloaded automatically on first run from  
`https://bouni.github.io/kicad-jlcpcb-tools/basic-parts-fts5.db.zip.001`  
and cached in `%USERPROFILE%\.jlcpcb\basic-parts-fts5.db`.

---

## Installation

Copy both files into your Eagle project folder (or any folder):

```
jlcpcb-bom-filler.ulp
lookup.js
```

`lookup.js` has **no npm dependencies** — just copy, no `npm install` needed.

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
