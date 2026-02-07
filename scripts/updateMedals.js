import fs from "node:fs";
import path from "node:path";

// Use the portal page that is actively showing medal updates
const SOURCE_PAGE = process.env.SOURCE_PAGE || "Portal:Olympic_Games/Celebration";
const GAMES_NAME = process.env.GAMES_NAME || "Milano Cortina 2026";
const PLACEHOLDER_COUNT = parseInt(process.env.PLACEHOLDER_COUNT || "10", 10);

const OUT_FILE = path.join("public", "medals.json");
const MAP_FILE = path.join("scripts", "noc_to_iso2.json");

// ---- helpers ----
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

/**
 * Support mapping by:
 * - NOC code (e.g., "ITA": "it")
 * - Country name (e.g., "Switzerland": "ch")
 *
 * Put both kinds of keys into noc_to_iso2.json as needed.
 */
function flagUrlFromKey(nocOrName, map) {
  const iso2 = map[nocOrName];
  if (!iso2) return null;
  return `https://flagcdn.com/w40/${String(iso2).toLowerCase()}.png`;
}

function buildPlaceholders(map, count) {
  const defaults = [
    { key: "Italy", label: "Italy" },
    { key: "United States", label: "United States" },
    { key: "Canada", label: "Canada" },
    { key: "Germany", label: "Germany" },
    { key: "Norway", label: "Norway" },
    { key: "Sweden", label: "Sweden" },
    { key: "France", label: "France" },
    { key: "Switzerland", label: "Switzerland" },
    { key: "Austria", label: "Austria" },
    { key: "Netherlands", label: "Netherlands" }
  ];

  return Array.from({ length: count }, (_, i) => {
    const base = defaults[i % defaults.length];
    return {
      rank: i + 1,
      name: base.label,
      gold: 0,
      silver: 0,
      bronze: 0,
      total: 0,
      flag: flagUrlFromKey(base.key, map),
      placeholder: true
    };
  });
}

async function fetchWikipediaText(page) {
  const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(page)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "olympics-medals-widget/1.0 (GitHub Actions)" }
  });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  const html = await res.text();

  // Simple text extraction: strip tags roughly; good enough for portal medal block parsing.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

  return { url, text };
}

/**
 * Parses the portal's medal block which looks like:
 * "2026 Winter Olympics Medal Table ... Rank NOC Gold Silver Bronze Total 1 ... Switzerland 1 0 0 1 2 ... Italy* 0 1 1 2 ..."
 */
function parsePortalMedalBlock(text, map) {
  const anchor = "2026 Winter Olympics Medal Table";
  const start = text.indexOf(anchor);
  if (start === -1) return [];

  // Take a chunk after the anchor; large enough to include the medal block.
  const chunk = text.slice(start, start + 1200);

  // Regex for rows: rank + country name + 4 medal numbers
  // Country names can include spaces, apostrophes, hyphens; host has trailing *.
  const rowRe = /\b(\d+)\s+([A-Za-z][A-Za-z'’.\- ]*?)(\*)?\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\b/g;

  const rows = [];
  for (const m of chunk.matchAll(rowRe)) {
    const rank = num(m[1]);
    const nameRaw = (m[2] || "").trim();
    const name = nameRaw.replace(/\s+/g, " ");
    const gold = num(m[4]);
    const silver = num(m[5]);
    const bronze = num(m[6]);
    const total = num(m[7]);

    // Skip totals line if it ever matches
    if (!name || name.toLowerCase().startsWith("totals")) continue;

    rows.push({
      rank,
      name,
      gold,
      silver,
      bronze,
      total,
      flag: flagUrlFromKey(name, map),
      placeholder: false
    });
  }

  // Sort and return top 10
  rows.sort((a, b) => a.rank - b.rank);
  return rows;
}

async function main() {
  const map = safeReadJson(MAP_FILE, {});

  const { url, text } = await fetchWikipediaText(SOURCE_PAGE);
  const parsedRows = parsePortalMedalBlock(text, map);

  const finalRows = parsedRows.length > 0 ? parsedRows.slice(0, 10) : buildPlaceholders(map, PLACEHOLDER_COUNT);

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "Wikipedia",
    sourceUrl: url,
    games: GAMES_NAME,
    sourcePage: SOURCE_PAGE,
    isLiveData: parsedRows.length > 0,
    rows: finalRows
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), "utf8");

  console.log(`Wrote ${OUT_FILE} with ${finalRows.length} rows (${payload.isLiveData ? "live" : "placeholder"})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});