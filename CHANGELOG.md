# Changelog

All notable changes to this project will be documented in this file.

## [1.0.2] — 2026-06-30

### Added
- SQLite error recovery: corrupt databases are automatically quarantined and a fresh database initialized, with a clear message to stderr
- `engines` field in `package.json` enforcing Node.js ≥20
- Test coverage for MCP tool handler logic (`tests/mcp-logic.test.ts`): `get_dependencies`, `get_session_report`, `health_check`, and `tool_usage` insert

### Changed
- `relationships` table in schema documented as intentional Phase 4 scaffolding (not dead code)
- README: added note on regex parsing accuracy and planned Tree-sitter migration
- README: `get_dependencies` tool description updated to reflect that `outgoing_relationships` is populated in Phase 4

## [1.0.1] — prior

### Added
- WAL mode + busy_timeout for SQLite concurrent access
- Bulk operation detection in FileWatcher (ignores >30 file changes)
- Stale memory garbage collection (touched_files pruned after 24 hours)
- File size limit (1 MB) in IncrementalParser to prevent OOM on minified assets

## [1.0.0] — initial

- 10 MCP tools via stdio transport
- 14 language symbol indexing (regex-based)
- SQLite FTS5 full-text search
- Session state persistence (goals, decisions, touched files)
- Schema reader for PostgreSQL, MSSQL, MySQL with 1-hour caching
- Docker support
