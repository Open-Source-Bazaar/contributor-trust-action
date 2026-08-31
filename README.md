# Contributor Detection Action

Detects likely automated contributors from public GitHub evidence for a pull request, issue, or issue comment. It reads public profile and activity data, optionally asks GitHub Models for a second opinion, and updates one detection comment and label.

The action does not infer identity from writing style or treat AI disclosure as misconduct. Organization blocking is opt-in and limited to high-risk user accounts that GitHub Models classifies as likely automated with at least 90% confidence. GitHub App bot accounts are reported but never organization-blocked by this workflow.

## Usage

```yaml
name: Contributor detection

on:
  issues:
    types: 
      - opened
  issue_comment:
    types: 
      - created
  pull_request_target:
    types: 
      - opened

permissions:
  contents: read
  issues: write
  pull-requests: write
  models: read

jobs:
  detection:
    if: github.actor != 'github-actions[bot]'
    runs-on: ubuntu-latest
    steps:
      - uses: Open-Source-Bazaar/contributor-trust-action@v1
        with:
          github-token: ${{ secrets.PAT }}
          block-high-confidence-automation: true
```

The action never checks out or executes code from an external pull request. GitHub Models is best-effort: if Models is disabled, the public-evidence report still completes.

## Outputs

- `author`
- `risk-level`: `low`, `medium`, or `high`
- `risk-score`: `0` to `100`
- `report-json`
- `blocked`: `true` when the organization block request succeeded

Set `fail-on-high-risk: true` only after reviewing the action against your community's contribution patterns.

When `block-high-confidence-automation` is enabled, `github-token` must be a dedicated fine-grained PAT or GitHub App token with organization `Blocking users: write`. Keep blocking disabled when that permission is not intentionally configured.
