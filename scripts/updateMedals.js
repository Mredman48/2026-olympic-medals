// scripts/updateMedals.js
import fs from "node:fs";
import path from "node:path";
import { load } from "cheerio";

// ---- Config ----
const GAME_PAGE = process.env.GAME_PAGE || "2026_Winter_Olympics_medal_table";
const GAMES_NAME = process.env.GAMES_NAME || "Milano Cortina 2026";
const PLACEHOLDER_COUNT = parseInt(process.env.PLACEHOLDER_COUNT || "10", 10);
const TOP_N = parseInt(process.env.TOP_N || "5", 10);

const OUT_FILE = path.join("public", "medals.json");

// ---- Helpers ----
function num(x) {
  const n = parseInt(String(x).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

function flagPngFromIso2(iso2) {
  if (!iso2) return null;
  return `https://flagcdn.com/w40/${String(iso2).toLowerCase()}.png`;
}

// ---- Maps (extend as needed) ----
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
  CHN: "cn"
};

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
  "Czechia": "CZE",
  "Czech Republic": "CZE",
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
  "China": "CHN"
};

function inferNoc(countryName, cellText) {
  const t = String(cellText || "").replace(/\s+/g, " ").trim();

  const m = t.match(/\(([A-Z]{3})\)\s*$/);
  if (m) return m[1];

  const last = t.split(" ").pop();
  if (/^[A-Z]{3}$/.test(last)) return last;

  return NAME_TO_NOC[countryName] || null;
}

function inferFlag(noc) {
  const iso2 = NOC_TO_ISO2[noc];
  return flagPngFromIso2(iso2);
}

function buildPlaceholders(count) {
  const defaults = [
    { name: "Italy", noc: "ITA" },
    { name: "Switzerland", noc: "SUI" },
    { name: "Norway", noc: "NOR" },
    { name: "Germany", noc: "GER" },
    { name: "Canada", noc: "CAN" }
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
      flag: inferFlag(base.noc),
      placeholder: true
    };
  });
}

// ---- Wikipedia (MediaWiki API parse) ----
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
    html
  };
}

// ---- Parse medal table ----
function parseMedalTable(html) {
  const $ = load(html);

  let medalTable = null;
  $("table.wikitable").each((_, t) => {
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

    const countryCell = $(cells[1]);

    // Country name from DOM
    let name =
      countryCell
        .find('a[href^="/wiki/"]')
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim() || countryCell.text().replace(/\s+/g, " ").trim();

    name = name.replace(/\*+$/g, "").trim();
    if (!name) return;
    if (name.toLowerCase().startsWith("totals")) return;

    const gold = num($(cells[2]).text());
    const silver = num($(cells[3]).text());
    const bronze = num($(cells[4]).text());
    const total = num($(cells[5]).text());

    const noc = inferNoc(name, countryCell.text());
    const flag = noc ? inferFlag(noc) : null;

    rows.push({
      // rank will be re-assigned after sorting to 1..TOP_N
      rank: null,
      noc: noc || name,
      name,
      gold,
      silver,
      bronze,
      total,
      flag,
      placeholder: false
    });
  });

  return rows;
}

// ---- Sorting: ignore Wikipedia rank ----
function sortByMedals(rows) {
  return rows.sort((a, b) => {
    if (b.gold !== a.gold) return b.gold - a.gold;
    if (b.silver !== a.silver) return b.silver - a.silver;
    if (b.bronze !== a.bronze) return b.bronze - a.bronze;
    if (b.total !== a.total) return b.total - a.total;
    return String(a.name).localeCompare(String(b.name));
  });
}

// ---- Main ----
async function main() {
  const { sourceUrl, html } = await fetchParsedHtml(GAME_PAGE);

  const parsedRows = parseMedalTable(html);
  const hasAnyMedals = parsedRows.some(r => (r.gold + r.silver + r.bronze) > 0);

  let finalRows;

  if (parsedRows.length === 0) {
    finalRows = buildPlaceholders(Math.max(TOP_N, PLACEHOLDER_COUNT)).slice(0, TOP_N);
  } else {
    const sorted = sortByMedals(parsedRows);
    finalRows = sorted.slice(0, TOP_N).map((r, i) => ({
      ...r,
      rank: i + 1 // display-only rank, not Wikipedia rank
    }));
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "Wikipedia",
    sourceUrl,
    games: GAMES_NAME,
    gamePage: GAME_PAGE,
    isLiveData: hasAnyMedals,
    rows: finalRows
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), "utf8");

  console.log(`Wrote ${OUT_FILE} top=${TOP_N} live=${hasAnyMedals} rows=${finalRows.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});