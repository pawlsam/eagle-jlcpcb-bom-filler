# Eagle JLCPCB ULP — BOM Filler

JLCPCB nabízí službu **SMT Assembly** — osazení SMD součástek přímo při výrobě DPS.  
Aby ji bylo možné použít, je potřeba odevzdat BOM seznam, kde každá součástka má vyplněné **číslo dílu LCSC** (identifikátor ze skladu JLCPCB/LCSC).

Tenhle nástroj to dělá automaticky — spustíš ULP v Eagle, a do otevřeného schématu se doplní atribut `LCSC_PART` ke každé rozpoznané součástce. Z takového schématu pak Eagle přímo vygeneruje kompletní BOM připravený k nahrání na JLCPCB.

Vyhledávání probíhá offline proti [databázi Basic + Preferred dílů od JLCPCB](https://github.com/bouni/kicad-jlcpcb-tools) — bez přihlášení, bez API klíče.  
Pouze **Basic** a **Preferred** díly (bez příplatku za assembly).

---

## Požadavky

- **Eagle** (otestováno na Eagle 9.x)
- **Node.js 22+** — stáhni z [nodejs.org](https://nodejs.org/en/download)

Databáze dílů (~347 KB) se stáhne automaticky při prvním spuštění a uloží do `%USERPROFILE%\.jlcpcb\`.

---

## Instalace

Zkopíruj oba soubory do libovolné složky (např. do složky Eagle projektu):

```
jlcpcb-bom-filler.ulp
lookup.js
```

---

## Použití

1. Otevři schéma v Eagle
2. Spusť `jlcpcb-bom-filler.ulp` přes **File → Execute ULP…**
3. Klikni **Run**

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
