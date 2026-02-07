// scripts/updateMedals.js
import fs from "node:fs";
import path from "node:path";
import { load } from "cheerio";

// ---- Config ----
const GAME_PAGE = process.env.GAME_PAGE || "2026_Winter_Olympics_medal_table";
const GAMES_NAME = process.env.GAMES_NAME || "Milano Cortina 2026";
const PLACEHOLDER_COUNT = parseInt(process.env.PLACEHOLDER_COUNT || "10", 10);

const OUT_FILE = path.join("public", "medals.json");

// ---- Helper functions ----
function num(x) {
  const n = parseInt(String(x).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

// FlagCDN PNG (Widgy-friendly)
function flagPngFromIso2(iso2) {
  if (!iso2) return null;
  return `https://flagcdn.com/w40/${String(iso2).toLowerCase()}.png`;
}

// ---- Maps (self-contained; no extra JSON files needed) ----
// Expand these as needed. This set covers common Winter powers + your placeholders.
const NOC_TO_ISO2 = {
  ITA: "it",
  SUI: "ch",
  FRA: "fr",
  GER: "de",
  USA: "us",
  CAN: "ca",
  AUT: "at",
  NED: "nl",
  NOR: "no",
  SWE: "se",
  FIN: "fi",
  CZE: "cz",
  SVK: "sk",
  SLO: "si",
  POL: "pl",
  HUN: "hu",
  LAT: "lv",
  LTU: "lt",
  EST: "ee",
  GBR: "gb",
  JPN: "jp",
  KOR: "kr",
  CHN: "cn",
  ESP: "es",
  BRA: "br",
  NZL: "nz",
  AUS: "au",
  DEN: "dk",
  BEL: "be",
  LIE: "li"
};

// Country name → NOC (this is the key fix)
const NAME_TO_NOC = {
  "Italy": "ITA",
  "Switzerland": "SUI",
  "France": "FRA",
  "Germany": "GER",
  "United States": "USA",
  "Canada": "CAN",
  "Austria": "AUT",
  "Netherlands": "NED",
  "Norway": "NOR",
  "Sweden": "SWE",
  "Finland": "FIN",
  "Czech Republic": "CZE",
  "Czechia": "CZE",
  "Slovakia": "SVK",
  "Slovenia": "SLO",
  "Poland": "POL",
  "Hungary": "HUN",
  "Latvia": "LAT",
  "Lithuania": "LTU",
  "Estonia": "EST",
  "Great Britain": "GBR",
  "United Kingdom": "GBR",
  "Japan": "JPN",
  "South Korea": "KOR",
  "Korea": "KOR",
  "China": "CHN",
  "Spain": "ESP",
  "Brazil": "BRA",
  "New Zealand": "NZL",
  "Australia": "AUS",
  "Denmark": "DEN",
  "Belgium": "BEL",
  "Liechtenstein": "LIE"
};

function inferNoc(countryName, cellText) {
  // Try to grab "(ABC)" or trailing ABC from visible text if present
  const t = String(cellText || "").replace(/\s+/g, " ").trim();

  const m = t.match(/\(([A-Z]{3})\)\s*$/);
  if (m) return m[1];

  const last = t.split(" ").pop();
  if (/^[A-Z]{3}$/.test(last)) return last;

  // Fall back to our name mapping
  return NAME_TO_NOC[countryName] || null;
}

function inferFlagPng(noc) {
  const iso2 = NOC_TO_ISO2[noc];
  return flagPngFromIso2(iso2);
}

function buildPlaceholders(count) {
  const defaults = [
    { name: "Italy", noc: "ITA" },
    { name: "Switzerland", noc: "SUI" },
    { name: "United States", noc: "USA" },
    { name: "Canada", noc: "CAN" },
    { name: "Germany", noc: "GER" },
    { name: "Norway", noc: "NOR" },
    { name: "Sweden", noc: "SWE" },
    { name: "France", noc: "FRA" },
    { name: "Austria", noc: "AUT" },
    { name: "Netherlands", noc: "NED" }
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
      flag: inferFlagPng(base.noc),
      placeholder: true
    };
  });
}

// ---- Wikipedia via MediaWiki API (parse) ----
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

// ---- Parsing medal table ----
function parseMedalTable(html) {
  const $ = load(html);

  // Find medal table by header content
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

    const countryCell = $(cells[1]);

    // DOM-first country name extraction (more reliable than raw text)
    let name =
      countryCell
        .find('a[href^="/wiki/"]')
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim() || countryCell.text().replace(/\s+/g, " ").trim();

    // Strip host markers like "Italy*"
    name = name.replace(/\*+$/g, "").trim();
    if (!name) return;
    if (name.toLowerCase().startsWith("totals")) return;

    const cellText = countryCell.text();
    const noc = inferNoc(name, cellText);

    const gold = num($(cells[2]).text());
    const silver = num($(cells[3]).text());
    const bronze = num($(cells[4]).text());
    const total = num($(cells[5]).text());

    // If we cannot infer NOC, still emit row but leave flag null
    const flag = noc ? inferFlagPng(noc) : null;

    rows.push({
      rank,
      noc: noc || name, // keep non-empty so Widgy bindings don't break
      name,
      gold,
      silver,
      bronze,
      total,
      flag,
      placeholder: false
    });
  });

  rows.sort((a, b) => a.rank - b.rank);
  return rows;
}

// ---- Main ----
async function main() {
  const { sourceUrl, apiUrl, html } = await fetchParsedHtml(GAME_PAGE);

  const parsedRows = parseMedalTable(html);

  // Consider "live" if any medals are present
  const isLiveData = parsedRows.some(r => (r.gold + r.silver + r.bronze) > 0);

  const finalRows =
    parsedRows.length > 0
      ? parsedRows.slice(0, 10)
      : buildPlaceholders(PLACEHOLDER_COUNT);

  // Keep Widgy-friendly JSON shape
  const payload = {
    updatedAt: new Date().toISOString(),
    source: "Wikipedia",
    sourceUrl,
    games: GAMES_NAME,
    gamePage: GAME_PAGE,
    isLiveData,
    rows: finalRows
  };

  // (Optional) leave apiUrl out to keep schema stable; uncomment if you want it.
  // payload.apiUrl = apiUrl;

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), "utf8");

  console.log(`Wrote ${OUT_FILE} live=${isLiveData} rows=${finalRows.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});