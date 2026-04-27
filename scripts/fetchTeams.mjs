// Fetches teams + badges from TheSportsDB and writes /public/teams.json.
// Run with: node scripts/fetchTeams.mjs
//
// TheSportsDB v3 free public key. No auth needed beyond the URL path.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../public/teams.json");

// Leagues we want. TheSportsDB uses underscored names in URL params.
const LEAGUES = [
  "English_Premier_League",
  "English_League_Championship",
  "English_League_1",
  "English_League_2",
  "Spanish_La_Liga",
  "Spanish_Segunda_Division",
  "Italian_Serie_A",
  "Italian_Serie_B",
  "German_Bundesliga",
  "German_2_Bundesliga",
  "French_Ligue_1",
  "French_Ligue_2",
  "Dutch_Eredivisie",
  "Portuguese_Primeira_Liga",
  "Belgian_First_Division_A",
  "Scottish_Premiership",
  "Turkish_Super_Lig",
  "Greek_Super_League",
  "Russian_Premier_League",
  "American_Major_League_Soccer",
  "Mexican_Primera_League",
  "Brazilian_Serie_A",
  "Argentine_Primera_Division",
  "Saudi_Pro_League",
  "Japanese_J1_League",
  "Chinese_Super_League",
  "Australian_A_League",
];

const KEY = "3"; // free public key
const BASE = `https://www.thesportsdb.com/api/v1/json/${KEY}`;

async function fetchLeague(league) {
  const url = `${BASE}/search_all_teams.php?l=${league}`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      console.warn(`  ! ${league}: HTTP ${r.status}`);
      return [];
    }
    const j = await r.json();
    return j.teams || [];
  } catch (e) {
    console.warn(`  ! ${league}: ${e.message}`);
    return [];
  }
}

function clean(team) {
  return {
    id: team.idTeam,
    name: team.strTeam,
    short: team.strTeamShort || null,
    league: team.strLeague || null,
    country: team.strCountry || null,
    badge: team.strBadge || null,
  };
}

async function main() {
  console.log(`Fetching ${LEAGUES.length} leagues from TheSportsDB…`);
  const seen = new Map();

  for (const league of LEAGUES) {
    const teams = await fetchLeague(league);
    let added = 0;
    for (const t of teams) {
      if (!t.idTeam || !t.strTeam || !t.strBadge) continue;
      if (seen.has(t.idTeam)) continue;
      seen.set(t.idTeam, clean(t));
      added++;
    }
    console.log(`  ✓ ${league.padEnd(35)} +${added}`);
    // Rate-limit politely
    await new Promise((r) => setTimeout(r, 250));
  }

  const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(list, null, 0) + "\n");
  console.log(`\nWrote ${list.length} teams to ${out}`);
  console.log(`File size: ${(JSON.stringify(list).length / 1024).toFixed(1)} KB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
