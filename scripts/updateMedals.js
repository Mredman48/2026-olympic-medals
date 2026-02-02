import fs from "node:fs";
import path from "node:path";
import cheerio from "cheerio";

const GAME_PAGE = process.env.GAME_PAGE || "2024_Summer_Olympics_medal_table";
// Example: "2026_Winter_Olympics_medal_table" once that page exists.

const OUT_FILE = path.join("public", "medals.json");
const MAP_FILE = path.join("scripts", "noc_to_iso2.json");

function num(x) {
  const n = parseInt(String(x).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

function flagUrlFromNoc(noc, nocToIso2) {
  const iso2 = nocToIso2[noc];
  if (!iso2) return null;

  // FlagCDN example (SVG). You can swap to another CDN if you prefer.
  return `https://flagcdn.com/${iso2.toLowerCase()}.svg`;
}

async function main() {
  const nocToIso2 = JSON.parse(fs.readFileSync(MAP_FILE, "utf8"));

  const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(GAME_PAGE)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "olympics-medals-widget/1.0 (GitHub Actions)" }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  // Find the medal table (usually a wikitable sortable with "Gold" header)
  const tables = $("table.wikitable.sortable");
  let medalTable = null;

  tables.each((_, t) => {
    const headerText = $(t).find("tr").first().text().toLowerCase();
    if (headerText.includes("gold") && headerText.includes("silver") && headerText.includes("bronze")) {
      medalTable = t;
      return false;
    }
  });

  if (!medalTable) {
    throw new Error("Could not locate medal table on the page (markup may have changed).");
  }

  const rows = [];
  $(medalTable)
    .find("tr")
    .slice(1)
    .each((_, tr) => {
      const cells = $(tr).find("th, td");
      if (cells.length < 6) return;

      // Typical columns: Rank | NOC (with code) | Gold | Silver | Bronze | Total
      const rank = num($(cells[0]).text());

      // NOC cell often includes a 3-letter code in parentheses or separate span
      const nocCellText = $(cells[1]).text().replace(/\s+/g, " ").trim();

      // Try to extract NOC code like "United States (USA)"
      let noc = null;
      const m = nocCellText.match(/\(([A-Z]{3})\)\s*$/);
      if (m) noc = m[1];

      // Fallback: sometimes code appears in a <span class="flagicon"> area; or not at all
      if (!noc) {
        // Try last 3-letter uppercase token
        const tokens = nocCellText.split(" ");
        const last = tokens[tokens.length - 1];
        if (/^[A-Z]{3}$/.test(last)) noc = last;
      }

      // Name: remove trailing "(NOC)"
      const name = noc ? nocCellText.replace(new RegExp(`\\s*\$begin:math:text$\$\{noc\}\\$end:math:text$\\s*$`), "").trim() : nocCellText;

      const gold = num($(cells[2]).text());
      const silver = num($(cells[3]).text());
      const bronze = num($(cells[4]).text());
      const total = num($(cells[5]).text());

      // Skip weird totals/footer rows
      if (!noc || !name || (gold + silver + bronze === 0 && total === 0)) return;

      rows.push({
        rank,
        noc,
        name,
        gold,
        silver,
        bronze,
        total,
        flag: flagUrlFromNoc(noc, nocToIso2)
      });
    });

  // Sort in case rank parsing fails for some rows
  rows.sort((a, b) => (a.rank || 999) - (b.rank || 999));

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "Wikipedia",
    game: GAME_PAGE,
    rows
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), "utf8");

  console.log(`Wrote ${OUT_FILE} with ${rows.length} rows from ${url}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
