# Trackr benchmark automation

This private repository contains only the Match-V5 benchmark generator and its GitHub Actions workflow. It does not contain the Trackr app source. Successful runs publish only `benchmarks.json` to `KIZAFOX/trackr-release` on the `gh-pages` branch.

## Required repository secrets

- `RIOT_API_KEY`: a Riot API key approved for recurring use. Development keys expire after 24 hours.
- `PUBLISH_TOKEN`: a GitHub fine-grained token restricted to `KIZAFOX/trackr-release`, with **Contents: Read and write** permission.

## Setup

1. Create an empty private GitHub repository and push the contents of this folder to its default branch.
2. Add the two repository secrets listed above.
3. Run **Actions → Update Match-V5 benchmarks → Run workflow** once to verify access and generate the first update.
4. Keep the weekly schedule enabled. It runs every Monday at 08:15 UTC.

The target repository must serve its `gh-pages` branch from `/(root)` in **Settings → Pages → Deploy from a branch**. The publisher creates that branch with only `benchmarks.json` if it does not exist yet.
