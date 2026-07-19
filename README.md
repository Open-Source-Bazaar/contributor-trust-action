# Contributor Trust Action

Creates an evidence-first report for the author of a pull request, issue, or issue comment. It reads public GitHub profile and activity data, optionally asks GitHub Models for a second opinion, and updates a single review comment and label.

The action does not infer identity from writing style, does not treat AI disclosure as misconduct, and never blocks an account automatically. Maintainers keep the final decision.

## Usage

```yaml
name: Contributor trust

on:
  issues:
    types: [opened]
  issue_comment:
    types: [created]
  pull_request_target:
    types: [opened]

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
          github-token: ${{ github.token }}
```

The action never checks out or executes code from an external pull request. GitHub Models is best-effort: if Models is disabled, the public-evidence report still completes.

## Outputs

- `author`
- `risk-level`: `low`, `medium`, or `high`
- `risk-score`: `0` to `100`
- `report-json`

Set `fail-on-high-risk: 'true'` only after reviewing the action against your community's contribution patterns.
