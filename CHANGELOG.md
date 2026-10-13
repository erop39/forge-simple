# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Application scaffold: Electron + React + TypeScript with electron-vite, a vitest runner that uses Electron's ABI for better-sqlite3, and a dark frameless main window.
- `tools/probe/probe.mjs`, a script that probes a live Forge instance and records its API behaviour; missing option keys are reported as `null`.
- String catalog and typed message lookup (`t()`), shared domain types, and a test that rejects user-visible string literals in renderer components.
