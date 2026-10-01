'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const OWNER = 'KIZAFOX';
const REPOSITORY = 'trackr-release';
const PAGES_BRANCH = 'gh-pages';
const BENCHMARKS_PATH = path.join(__dirname, 'public', 'benchmarks.json');
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_PAT || process.env.GITHUB_PAT;
const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const METRICS = ['csm', 'gpm', 'kp', 'visionPerMin'];

function isValidBenchmarkData(data) {
  return !!data && data.schemaVersion === 1 && !!data.roles && ROLES.every((role) => {
    const values = data.roles[role];
    return !!values && METRICS.every((metric) => Number.isFinite(values[metric]) && values[metric] >= 0);
  });
}

async function githubRequest(endpoint, { method = 'GET', body } = {}) {
  const response = await fetch(`https://api.github.com/repos/${OWNER}/${REPOSITORY}${endpoint}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Trackr-local-benchmark-publisher',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Réponse GitHub invalide (${response.status}).`);
  }
  if (!response.ok) {
    const error = new Error(data.message || `GitHub a répondu avec le code ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function generateBenchmarks() {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'generate-benchmarks.js')], {
    cwd: __dirname,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Le générateur s'est arrêté avec le code ${result.status}.`);

  const json = fs.readFileSync(BENCHMARKS_PATH, 'utf8');
  const data = JSON.parse(json);
  if (!isValidBenchmarkData(data)) throw new Error('Le JSON généré ne passe pas la validation.');
  return { json, data };
}

async function createJsonOnlyPagesBranch(json) {
  const blob = await githubRequest('/git/blobs', {
    method: 'POST',
    body: { content: json, encoding: 'utf-8' },
  });
  const tree = await githubRequest('/git/trees', {
    method: 'POST',
    body: {
      tree: [{ path: 'benchmarks.json', mode: '100644', type: 'blob', sha: blob.sha }],
    },
  });
  const commit = await githubRequest('/git/commits', {
    method: 'POST',
    body: { message: 'Publish Trackr benchmarks', tree: tree.sha, parents: [] },
  });
  await githubRequest('/git/refs', {
    method: 'POST',
    body: { ref: `refs/heads/${PAGES_BRANCH}`, sha: commit.sha },
  });
}

async function publishBenchmarks(json) {
  let reference;
  try {
    reference = await githubRequest(`/git/ref/heads/${PAGES_BRANCH}`);
  } catch (error) {
    if (error.status !== 404) throw error;
    await createJsonOnlyPagesBranch(json);
    return;
  }

  const tree = await githubRequest(`/git/trees/${reference.object.sha}?recursive=1`);
  if (tree.truncated) throw new Error('Impossible de vérifier le contenu complet de la branche gh-pages.');
  const files = tree.tree.filter((entry) => entry.type === 'blob');
  const unexpected = files.filter((entry) => !['benchmarks.json', '.nojekyll'].includes(entry.path));
  if (unexpected.length) {
    throw new Error(`La branche gh-pages contient déjà des fichiers autres que le JSON : ${unexpected.map((entry) => entry.path).join(', ')}`);
  }

  const existingFile = files.find((entry) => entry.path === 'benchmarks.json');
  await githubRequest('/contents/benchmarks.json', {
    method: 'PUT',
    body: {
      message: 'Update Trackr benchmark data',
      content: Buffer.from(json, 'utf8').toString('base64'),
      branch: PAGES_BRANCH,
      ...(existingFile ? { sha: existingFile.sha } : {}),
    },
  });
}

async function main() {
  if (!TOKEN) {
    throw new Error('Token GitHub absent : définis GH_TOKEN (ou GITHUB_TOKEN) dans cet environnement.');
  }
  const { json, data } = generateBenchmarks();
  await publishBenchmarks(json);
  console.log(`[benchmarks] ${data.sampledGames} parties publiées sur ${OWNER}/${REPOSITORY}:${PAGES_BRANCH}.`);
  console.log('Active GitHub Pages sur la branche gh-pages, dossier /(root), pour rendre le JSON public.');
}

main().catch((error) => {
  console.error(`[benchmarks] Publication impossible : ${error.message}`);
  process.exitCode = 1;
});
