'use strict';

const fs = require('node:fs');
const path = require('node:path');
try {
  const dotenvPath = fs.existsSync(path.join(__dirname, '.env'))
    ? path.join(__dirname, '.env')
    : path.join(__dirname, '..', '.env');
  require('dotenv').config({ path: dotenvPath });
} catch {
  // GitHub Actions injecte directement RIOT_API_KEY dans l'environnement.
}

const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const LEAGUES = [
  ['CHALLENGER', 'challengerleagues'],
  ['GRANDMASTER', 'grandmasterleagues'],
  ['MASTER', 'masterleagues'],
];
const PLATFORMS = [
  ['BR1', 'americas'],
  ['EUN1', 'europe'],
  ['EUW1', 'europe'],
  ['JP1', 'asia'],
  ['KR', 'asia'],
  ['LA1', 'americas'],
  ['LA2', 'americas'],
  ['NA1', 'americas'],
  ['OC1', 'sea'],
  ['RU', 'europe'],
  ['TR1', 'europe'],
];
const RATE_LIMIT_DELAY_MS = Math.max(1200, Number(process.env.BENCHMARK_REQUEST_DELAY_MS) || 1250);
const ACCOUNTS_PER_TIER = Math.max(1, Number(process.env.BENCHMARK_ACCOUNTS_PER_TIER) || 5);
const MATCHES_PER_ACCOUNT = Math.max(1, Number(process.env.BENCHMARK_MATCHES_PER_ACCOUNT) || 3);
const RECENT_DAYS = 45;
const MIN_ROLE_SAMPLES = 20;
const API_KEY = process.env.RIOT_API_KEY || process.env.riot_api_key || process.env.RIOTAPIKEY;
const OUTPUT_PATH = process.env.BENCHMARK_OUTPUT || path.join(__dirname, 'public', 'benchmarks.json');
let lastRequestAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sample(items, limit) {
  const selected = items.slice();
  const count = Math.min(limit, selected.length);
  for (let index = 0; index < count; index += 1) {
    const swapIndex = index + Math.floor(Math.random() * (selected.length - index));
    [selected[index], selected[swapIndex]] = [selected[swapIndex], selected[index]];
  }
  return selected.slice(0, count);
}

async function riotGet(url) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const pause = RATE_LIMIT_DELAY_MS - (Date.now() - lastRequestAt);
    if (pause > 0) await sleep(pause);
    lastRequestAt = Date.now();

    let response;
    try {
      response = await fetch(url, {
        headers: { 'X-Riot-Token': API_KEY },
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      if (attempt === 5) throw error;
      await sleep(Math.min(attempt * 1000, 5000));
      continue;
    }

    if (response.status === 429) {
      if (attempt === 5) throw new Error('Riot API rate limit: retries épuisés.');
      const retryAfter = Number(response.headers.get('retry-after')) || 5;
      await sleep(Math.max(retryAfter * 1000, RATE_LIMIT_DELAY_MS));
      continue;
    }
    if (response.status >= 500 && attempt < 5) {
      await sleep(Math.min(attempt * 1000, 5000));
      continue;
    }
    if (!response.ok) {
      const error = new Error(`Riot API ${response.status} sur ${new URL(url).pathname}.`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
  throw new Error('Riot API indisponible après plusieurs tentatives.');
}

async function collectHighEloAccounts(platform, routing) {
  const accounts = new Map();
  const baseUrl = `https://${platform.toLowerCase()}.api.riotgames.com`;

  for (const [tier, endpoint] of LEAGUES) {
    const url = `${baseUrl}/lol/league/v4/${endpoint}/by-queue/RANKED_SOLO_5x5`;
    let league;
    try {
      league = await riotGet(url);
    } catch (error) {
      if (error.status === 401 || error.status === 403) throw error;
      console.warn(`[benchmarks] ${platform} ${tier}: ligue ignorée (${error.message})`);
      continue;
    }

    for (const entry of sample(league.entries || [], ACCOUNTS_PER_TIER)) {
      if (entry.puuid && !accounts.has(entry.puuid)) {
        accounts.set(entry.puuid, { puuid: entry.puuid, platform, routing, tier });
      }
    }
  }

  return [...accounts.values()];
}

async function collectMatchIds(accounts) {
  const matches = new Map();
  const startTime = Math.floor(Date.now() / 1000) - RECENT_DAYS * 24 * 60 * 60;

  for (const account of accounts) {
    const url = new URL(
      `https://${account.routing}.api.riotgames.com/lol/match/v5/matches/by-puuid/${encodeURIComponent(account.puuid)}/ids`
    );
    url.searchParams.set('queue', '420');
    url.searchParams.set('start', '0');
    url.searchParams.set('count', String(MATCHES_PER_ACCOUNT));
    url.searchParams.set('startTime', String(startTime));
    try {
      const ids = await riotGet(url.toString());
      ids.forEach((id) => matches.set(id, account.routing));
    } catch (error) {
      if (error.status === 401 || error.status === 403) throw error;
      console.warn(`[benchmarks] Matchlist ignorée (${account.platform}, ${error.message})`);
    }
  }

  return matches;
}

function average(values, digits) {
  const value = values.reduce((sum, item) => sum + item, 0) / values.length;
  return Number(value.toFixed(digits));
}

function aggregateMatches(matches, eligiblePuuids) {
  const samples = Object.fromEntries(ROLES.map((role) => [role, []]));
  const roleMatches = Object.fromEntries(ROLES.map((role) => [role, new Set()]));
  const patchCounts = new Map();
  let sampledGames = 0;

  for (const match of matches) {
    const info = match && match.info;
    const duration = Number(info && info.gameDuration);
    if (!info || info.queueId !== 420 || duration < 900) continue;

    const participants = info.participants || [];
    const teamKills = new Map();
    participants.forEach((participant) => {
      teamKills.set(participant.teamId, (teamKills.get(participant.teamId) || 0) + Number(participant.kills || 0));
    });

    let includedPlayer = false;
    for (const participant of participants) {
      if (!eligiblePuuids.has(participant.puuid)) continue;
      const role = String(participant.teamPosition || participant.individualPosition || '').toUpperCase();
      if (!samples[role]) continue;
      const minutes = duration / 60;
      const killsOnTeam = teamKills.get(participant.teamId) || 0;
      if (killsOnTeam <= 0) continue;

      samples[role].push({
        csm: (Number(participant.totalMinionsKilled || 0) + Number(participant.neutralMinionsKilled || 0)) / minutes,
        gpm: Number(participant.goldEarned || 0) / minutes,
        kp: ((Number(participant.kills || 0) + Number(participant.assists || 0)) / killsOnTeam) * 100,
        visionPerMin: Number(participant.visionScore || 0) / minutes,
      });
      roleMatches[role].add(info.gameId);
      includedPlayer = true;
    }

    if (includedPlayer) {
      sampledGames += 1;
      const patch = String(info.gameVersion || '').split('.').slice(0, 2).join('.');
      if (patch) patchCounts.set(patch, (patchCounts.get(patch) || 0) + 1);
    }
  }

  const roles = {};
  for (const role of ROLES) {
    const values = samples[role];
    if (values.length === 0) {
      roles[role] = { csm: 0, gpm: 0, kp: 0, visionPerMin: 0, sampleSize: 0, matches: 0 };
      continue;
    }
    roles[role] = {
      csm: average(values.map((item) => item.csm), 1),
      gpm: average(values.map((item) => item.gpm), 0),
      kp: average(values.map((item) => item.kp), 1),
      visionPerMin: average(values.map((item) => item.visionPerMin), 1),
      sampleSize: values.length,
      matches: roleMatches[role].size,
    };
  }

  const patch = [...patchCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: 'Riot Match-V5, Ranked Solo/Duo, participants Master+ actuels',
    region: 'Global',
    queueId: 420,
    recentDays: RECENT_DAYS,
    patch,
    sampledAccounts: eligiblePuuids.size,
    sampledGames,
    roles,
  };
}

async function main() {
  if (!API_KEY) throw new Error('RIOT_API_KEY manquante (secret GitHub Actions ou variable .env).');
  const accounts = [];
  for (const [platform, routing] of PLATFORMS) {
    const platformAccounts = await collectHighEloAccounts(platform, routing);
    accounts.push(...platformAccounts);
    console.log(`[benchmarks] ${platform}: ${platformAccounts.length} comptes Master+ échantillonnés.`);
  }
  if (accounts.length === 0) throw new Error('Aucun compte Master+ trouvé. Vérifie la clé Riot et les API.');

  const eligiblePuuids = new Set(accounts.map((account) => account.puuid));
  const matchIds = await collectMatchIds(accounts);
  console.log(`[benchmarks] ${matchIds.size} parties récentes à récupérer.`);

  const matches = [];
  for (const [matchId, routing] of matchIds) {
    try {
      matches.push(await riotGet(`https://${routing}.api.riotgames.com/lol/match/v5/matches/${encodeURIComponent(matchId)}`));
    } catch (error) {
      if (error.status === 401 || error.status === 403) throw error;
      console.warn(`[benchmarks] Partie ignorée (${error.message})`);
    }
  }

  const data = aggregateMatches(matches, eligiblePuuids);
  for (const role of ROLES) {
    if (data.roles[role].sampleSize < MIN_ROLE_SAMPLES) {
      throw new Error(`Échantillon trop faible pour ${role}: ${data.roles[role].sampleSize} parties-joueurs.`);
    }
  }
  data.platforms = PLATFORMS.map(([platform]) => platform);
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`[benchmarks] ${data.sampledGames} parties, ${data.sampledAccounts} comptes; JSON écrit dans ${OUTPUT_PATH}.`);
  for (const role of ROLES) {
    console.log(`[benchmarks] ${role}: ${data.roles[role].sampleSize} observations, ${data.roles[role].matches} parties.`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[benchmarks] Échec de génération: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { aggregateMatches };
