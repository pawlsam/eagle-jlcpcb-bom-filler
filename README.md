# eagle-jlcpcb-bom-filler

Automatically fills **LCSC part numbers** into Eagle PCB project files for JLCPCB SMT assembly.  
Works with both **Eagle BOM CSV** exports and **Eagle schematic `.sch`** files directly.

Searches the offline [JLCPCB Basic + Preferred parts database](https://github.com/bouni/kicad-jlcpcb-tools) — no login, no API key required.  
Only **Basic** and **Preferred** parts are matched (no extra assembly fee at JLCPCB).

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

Connectors (`J`, `X`), ICs (`U`), MOSFETs (`Q`), and mechanical parts are intentionally skipped.

---

## Requirements

- **Node.js 22+** (uses the built-in `node:sqlite` module — no native build tools needed)

```
npm install
```

The parts database (~347 KB) is downloaded automatically on first run from  
`https://bouni.github.io/kicad-jlcpcb-tools/basic-parts-fts5.db.zip.001`

---

## Usage

### Eagle schematic (`.sch`)

```bash
node index.js schematic.sch
```

Writes `schematic_lcsc.sch` with `<attribute name="LCSC_PART" value="C12345" constant="no"/>` added to each matched `<part>` element.

### Eagle BOM CSV

Export the BOM from Eagle (**File → Export → BOM**), then:

```bash
node index.js bom.csv
```

Writes `bom_lcsc.csv` with the `LCSC` column filled in.

### Options

```
node index.js <input> [output] [options]

Options:
  --no-skip        Re-search components that already have an LCSC number
  --update-db      Delete the cached database and re-download a fresh copy

CSV-only options:
  --part=<col>     Column name for reference designators  (default: auto-detect)
  --value=<col>    Column name for component values       (default: auto-detect)
  --package=<col>  Column name for package/footprint      (default: auto-detect)
  --lcsc=<col>     Column name for LCSC output            (default: LCSC)
```

---

## How it works

1. **Value normalisation** — Eagle notation is converted to JLCPCB search terms:
   - `4k7` → `4.7k`, `22R` → `22Ω`, `1k` → `1kΩ`, `100nF`, `10uH`, …
2. **Package normalisation** — Eagle device prefixes are stripped:
   - `R-EU_0402/2` → `0402`, `R1206` → `1206`, `M1206` → `1206`
3. **Full-text search** — Uses the FTS5 trigram index in the offline SQLite database.  
   Tries `value AND package` first, falls back to `value` only.
4. **Highest stock wins** — The matched part with the most stock is chosen.
5. **Skip if filled** — Already-assigned LCSC numbers are preserved by default.

---

## Example

Input (`example.sch` excerpt):
```xml
<part name="R1" deviceset="R-EU_" device="M1206" value="4k7"/>
<part name="R4" deviceset="R-EU_" device="R1206" value="10k"/>
<part name="D1" deviceset="DIODE-" device="DO-214AC" value="1N4007 M7"/>
```

Output (`example_lcsc.sch` excerpt):
```xml
<part name="R1" deviceset="R-EU_" device="M1206" value="4k7">
<attribute name="LCSC_PART" value="C17936" constant="no"/>
</part>
<part name="R4" deviceset="R-EU_" device="R1206" value="10k">
<attribute name="LCSC_PART" value="C17902" constant="no"/>
</part>
<part name="D1" deviceset="DIODE-" device="DO-214AC" value="1N4007 M7">
<attribute name="LCSC_PART" value="C18199088" constant="no"/>
</part>
```

---

## Limitations

- Only **SMD** passive components are matched. Through-hole parts are generally not in the Basic/Preferred list.
- **0-ohm jumpers** (`0R`) are skipped — they are not searchable by value.
- Non-standard value strings (e.g. exotic ferrite bead impedance codes) may not match.
- The database is a snapshot; re-run `--update-db` periodically to get the latest parts.

---

## Database source

Parts database by [bouni/kicad-jlcpcb-tools](https://github.com/bouni/kicad-jlcpcb-tools),  
published at `https://bouni.github.io/kicad-jlcpcb-tools/basic-parts-fts5.db.zip.001`.

---

## License

MIT
