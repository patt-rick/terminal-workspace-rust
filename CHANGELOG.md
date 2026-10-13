# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com); versions follow the app's
`x.y.z` tags. The top **Unreleased** section accumulates entries as work lands;
`scripts/release.mjs` stamps it with the version and date at release time.

## [Unreleased]
### Added
- Usage page (`Ctrl/Cmd+Shift+U`): Claude Code token and estimated-cost history by day,
  model and project over 24 hours to 90 days, plus pooled 5-hour and 7-day limits across
  accounts. History is kept for 100 days, beyond Claude Code's own transcript cleanup.

## [0.4.2] - 2026-09-14
### Added
- Auto-switch to a healthy Claude account when a session hits its usage limit.
