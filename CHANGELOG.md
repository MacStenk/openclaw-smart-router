# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] - 2026-03-15

### Added
- Manual control commands: `/router lock opus|sonnet|haiku`, `/router unlock`, `/router off`, `/router on`
- Persistent state file (`~/.openclaw/extensions/smart-router/state.json`) for locks and overrides
- Commands are always processed, even when router is disabled
- Updated README with manual control guide and state file documentation

### Improved
- Command processing now executes before state file check for reliability

## [1.0.0] - 2026-03-15

### Added
- 3-tier model routing: simple (Haiku), medium (Sonnet), complex (Opus)
- Fast keyword pre-filters for instant routing (zero latency)
- Ollama-based classification for ambiguous messages
- Sticky follow-up routing (configurable decay timer)
- OpenClaw metadata stripping before classification
- Bilingual keyword support (English + German)
- Media detection for vision-capable model routing
- Fail-safe: defaults to Sonnet if Ollama is unavailable
- Full configuration via `plugins.entries.smart-router.config`
- Gateway log output for routing decisions
