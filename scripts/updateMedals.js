import fs from "node:fs";
import path from "node:path";
import { load } from "cheerio";

const GAME_PAGE = process.env.GAME_PAGE || "2026_Winter_Olympics_medal_table";
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

  // 40px wide PNG, @2x for retina (good balance of quality + size)
  return `https://flagcdn.com/w40/${iso2.toLowerCase()}.png`;
}

/**
 * 10 placeholders until medals exist.
 * You can customize these countries however you want.
 */
function buildPlaceholders(nocToIso2, count) {
  const defaults = [
    { noc: "ITA", name: "Italy" },
    { noc: "USA", name: "United States" },
    { noc: "CAN", name: "Canada" },
    { noc: "GER", name: "Germany" },
    { noc: "NOR", name: "Norway" },
    { noc: "SWE", name: "Sweden" },
    { noc: "FRA", name: "France" },
    { noc: "SUI", name: "Switzerland" },
    { noc: "AUT", name: "Austria" },
    { noc: "NED", name: "Netherlands" }
  ];

  const rows = [];
  for (let i = 0; i < count; i++) {
    const base = defaults[i % defaults.length];
    rows.push({
      rank: i + 1,
      noc: base.noc,
      name: base.name,
      gold: 0,
      silver: 0,
      bronze: 0,
      total: 0,
      flag: flagUrlFromNoc(base.noc, nocToIso2),
      placeholder: true
    });
  }
  return rows;
}

async function fetchWikipediaHtml(pageSlug) {
  const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(pageSlug)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "olympics-medals-widget/1.0 (GitHub Actions)" }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  return { url, html };
}

function parseMedalTable(html, nocToIso2) {
  const $ = load(html);

  // Find the medal table (usually a wikitable sortable with Gold/Silver/Bronze in header)
  const tables = $("table.wikitable.sortable");
  let medalTable = null;

  tables.each((_, t) => {
    const headerText = $(t).find("tr").first().text().toLowerCase();
    if (headerText.includes("gold") && headerText.includes("silver") && headerText.includes("bronze")) {
      medalTable = t;
      return false;
    }
  });

  if (!medalTable) return [];

  const rows = [];
  $(medalTable)
    .find("tr")
    .slice(1)
    .each((_, tr) => {
      const cells = $(tr).find("th, td");
      if (cells.length < 6) return;

      const rank = num($(cells[0]).text());

      // NOC cell often looks like: "Italy (ITA)"
      const nocCellText = $(cells[1]).text().replace(/\s+/g, " ").trim();

      let noc = null;
      const m = nocCellText.match(/\(([A-Z]{3})\)\s*$/);
      if (m) noc = m[1];

      if (!noc) {
        const tokens = nocCellText.split(" ");
        const last = tokens[tokens.length - 1];
        if (/^[A-Z]{3}$/.test(last)) noc = last;
      }

      const name = noc
        ? nocCellText.replace(new RegExp(`\\s*\$begin:math:text$\$\{noc\}\\$end:math:text$\\s*$`), "").trim()
        : nocCellText;

      const gold = num($(cells[2]).text());
      const silver = num($(cells[3]).text());
      const bronze = num($(cells[4]).text());
      const total = num($(cells[5]).text());

      // Ignore footer/weird rows
      if (!noc || !name) return;

      rows.push({
        rank: rank || rows.length + 1,
        noc,
        name,
        gold,
        silver,
        bronze,
        total,
        flag: flagUrlFromNoc(noc, nocToIso2),
        placeholder: false
      });
    });

  // Keep only meaningful medal rows (once games start)
  const hasAnyMedals = rows.some(r => (r.gold + r.silver + r.bronze) > 0);
  if (!hasAnyMedals) return [];

  rows.sort((a, b) => a.rank - b.rank);
  return rows;
}

async function main() {
  const nocToIso2 = safeReadJson(MAP_FILE, {});

  // Fetch & parse. If medal data not present yet, we will fall back to placeholders.
  const { url, html } = await fetchWikipediaHtml(GAME_PAGE);
  const parsedRows = parseMedalTable(html, nocToIso2);

  const finalRows =
    parsedRows.length > 0
      ? parsedRows.slice(0, 10) // top 10 for your widget
      : buildPlaceholders(nocToIso2, PLACEHOLDER_COUNT);

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "Wikipedia",
    sourceUrl: url,
    games: GAMES_NAME,
    gamePage: GAME_PAGE,
    isLiveData: parsedRows.length > 0,
    rows: finalRows
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), "utf8");

  console.log(
    `Wrote ${OUT_FILE} with ${finalRows.length} rows (${payload.isLiveData ? "live" : "placeholder"}) from ${url}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});