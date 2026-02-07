import fs from "node:fs";
import path from "node:path";
import { load } from "cheerio";

const PAGE = process.env.GAME_PAGE || "2026_Winter_Olympics_medal_table";
const GAMES_NAME = process.env.GAMES_NAME || "Milano Cortina 2026";
const PLACEHOLDER_COUNT = parseInt(process.env.PLACEHOLDER_COUNT || "10", 10);

const OUT_FILE = path.join("public", "medals.json");
const MAP_FILE = path.join("scripts", "noc_to_iso2.json");

function num(x) {
  const n = parseInt(String(x).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

function safeReadJson(filepath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf8"));
  } catch {
    return fallback;
  }
}

function flagUrlFromNoc(noc, nocToIso2) {
  const iso2 = nocToIso2[noc];
  if (!iso2) return null;
  return `https://flagcdn.com/w40/${iso2.toLowerCase()}.png`;
}

function buildPlaceholders(nocToIso2, count) {
  const defaults = [
    { noc: "ITA", name: "Italy" },
    { noc: "SUI", name: "Switzerland" },
    { noc: "USA", name: "United States" },
    { noc: "CAN", name: "Canada" },
    { noc: "GER", name: "Germany" },
    { noc: "NOR", name: "Norway" },
    { noc: "SWE", name: "Sweden" },
    { noc: "FRA", name: "France" },
    { noc: "AUT", name: "Austria" },
    { noc: "NED", name: "Netherlands" }
  ];

  return Array.from({ length: count }, (_, i) => {
    const base = defaults[i % defaults.length];
    return {
      rank: i + 1,
      noc: base.noc,
      name: base.name,
      gold: 0,
      silver: 0,
      bronze: 0,
      total: 0,
      flag: flagUrlFromNoc(base.noc, nocToIso2),
      placeholder: true
    };
  });
}

/**
 * Fetches parsed HTML via MediaWiki API (more consistent than scraping the page HTML)
 */
async function fetchParsedHtml(pageTitle) {
  const apiUrl =
    "https://en.wikipedia.org/w/api.php" +
    `?action=parse&format=json&prop=text&formatversion=2&redirects=1&origin=*` +
    `&page=${encodeURIComponent(pageTitle)}`;

  const res = await fetch(apiUrl, {
    headers: { "User-Agent": "olympics-medals-widget/1.0 (GitHub Actions)" }
  });
  if (!res.ok) throw new Error(`Failed to fetch MediaWiki API: ${res.status} ${res.statusText}`);

  const data = await res.json();
  const html = data?.parse?.text;
  if (!html) throw new Error("MediaWiki API parse response missing HTML content");

  return {
    sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(pageTitle)}`,
    apiUrl,
    html
  };
}

/**
 * Finds medal table and parses:
 * Rank | NOC | Gold | Silver | Bronze | Total
 */
function parseMedalTableFromHtml(html, nocToIso2) {
  const $ = load(html);

  // Wikipedia often uses class="wikitable sortable plainrowheaders"
  const tables = $("table.wikitable");
  let medalTable = null;

  tables.each((_, t) => {
    const header = $(t).find("tr").first().text().toLowerCase();
    if (header.includes("gold") && header.includes("silver") && header.includes("bronze") && header.includes("total")) {
      medalTable = t;
      return false;
    }
  });

  if (!medalTable) return [];

  const rows = [];

  $(medalTable).find("tr").slice(1).each((_, tr) => {
    const cells = $(tr).find("th, td");
    if (cells.length < 6) return;

    const rank = num($(cells[0]).text()) || (rows.length + 1);

    // NOC cell usually contains the country page link + (sometimes) IOC code in small text.
    const nocCellText = $(cells[1]).text().replace(/\s+/g, " ").trim();

    // Try to extract IOC/NOC code if present like "(ITA)" or trailing "ITA"
    let noc = null;
    const m = nocCellText.match(/\(([A-Z]{3})\)\s*$/);
    if (m) noc = m[1];

    if (!noc) {
      const last = nocCellText.split(" ").pop();
      if (/^[A-Z]{3}$/.test(last)) noc = last;
    }

    // If the page omits codes, fall back to known special cases (and you can extend this)
    // Example: Italy row often has a host star; name is still "Italy"
    const name = noc
      ? nocCellText.replace(new RegExp(`\\s*\$begin:math:text$\$\{noc\}\\$end:math:text$\\s*$`), "").trim()
      : nocCellText;

    const gold = num($(cells[2]).text());
    const silver = num($(cells[3]).text());
    const bronze = num($(cells[4]).text());
    const total = num($(cells[5]).text());

    // Ignore totals/footer rows
    if (name.toLowerCase().startsWith("totals")) return;
    if (!name) return;

    rows.push({
      rank,
      noc: noc || null,
      name,
      gold,
      silver,
      bronze,
      total,
      flag: noc ? flagUrlFromNoc(noc, nocToIso2) : null,
      placeholder: false
    });
  });

  // If we found rows, keep them; if medals are still all zeros, caller may choose placeholders.
  rows.sort((a, b) => a.rank - b.rank);
  return rows;
}

async function main() {
  const nocToIso2 = safeReadJson(MAP_FILE, {});

  const { sourceUrl, apiUrl, html } = await fetchParsedHtml(PAGE);
  const parsedRows = parseMedalTableFromHtml(html, nocToIso2);

  // “Live” if any medal exists
  const hasAnyMedals = parsedRows.some(r => (r.gold + r.silver + r.bronze) > 0);

  const finalRows = hasAnyMedals
    ? parsedRows.slice(0, 10)
    : buildPlaceholders(nocToIso2, PLACEHOLDER_COUNT);

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "Wikipedia (MediaWiki API parse)",
    sourceUrl,
    apiUrl,
    games: GAMES_NAME,
    page: PAGE,
    isLiveData: hasAnyMedals,
    rows: finalRows
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), "utf8");

  console.log(
    `Wrote ${OUT_FILE} with ${finalRows.length} rows (${payload.isLiveData ? "live" : "placeholder"})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});