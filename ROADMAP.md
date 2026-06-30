# Continuum Roadmap

Continuum is currently **production-ready** for individual developers and small-to-medium teams. The core features—incremental parsing, SQLite FTS5 search, and MCP tool integration—provide immediate, tangible value by solving the context compaction problem.

However, to scale this into a massive enterprise-grade architecture and fully autonomous AI agent layer, the following architectural enhancements are proposed for future development.

## ✅ Completed (Production Enhancements)
- **SQLite WAL Mode & Busy Timeout**: Added `busy_timeout` to ensure concurrent AI connections wait politely instead of throwing `SQLITE_BUSY` crashes.
- **Watcher Queueing**: Built a background batching queue into `chokidar` to gracefully handle massive changes like `git checkout`.
- **Parsing Safeguards**: Added file size limits to prevent OOM errors on massive minified files.
- **Stale Memory Decay**: Touched files are now automatically physically pruned (Garbage Collected) from the database after 24 hours to prevent infinite DB bloat.

## Phase 2: IDE Extensions (Adoption)
- **VS Code Extension**: A lightweight extension that detects Continuum in the project, auto-generates the correct `mcp.json` with absolute paths, and shows a status bar item with live server health. Removes the manual path-editing step that is the single biggest install failure point.
- **JetBrains Plugin**: Same lifecycle management for IntelliJ-based IDEs.
- **Pre-built System Prompts**: Ship `.cursorrules` and `.claude.md` template files in the repository. These will train the AI to autonomously call `save_task` when context is getting full, without relying entirely on human-triggered Slash Commands.

## Phase 3: Memory Management (Stability)
- **Task Garbage Collection**: `save_task` entries can accumulate without bound. When the task count for a session exceeds a configurable limit (default: 10), the oldest entries are collapsed into a single "prior context" summary row and the raw history is pruned. Fully deterministic — no LLM required, no cloud dependency, preserves the offline guarantee.
- **Session Resume on Restart**: Each server restart currently creates a new session UUID, losing the previous session's context even though the data is still in the DB. Add an option to resume the most recent session on startup if it was active within the last N hours.

## Phase 4: Architectural Scaling (Search & Parsing)
- **Semantic Search (Vector Embeddings)**: Currently, Continuum relies on SQLite's FTS5 engine, which is a *keyword* search. If the AI searches for `"user authentication"`, but the function is named `verify_jwt()`, it won't be found. We plan to integrate a Vector Database (like SQLite-VSS or Chroma) to store text embeddings, allowing the AI to search by *meaning* rather than exact character matching.
- **AST Parsing (Tree-sitter)**: Our `IncrementalParser` currently uses Regex. While Regex is incredibly fast, it lacks deep semantic understanding. If a developer writes a wildly complex, multi-line nested generic function in C++ or Rust, Regex can fail to extract the signature properly. Migrating to an AST (Abstract Syntax Tree) parser via Tree-sitter will provide 100% accurate symbol extraction, drastically reducing false positives in complex languages.
- **Dependency Graphing**: Expand the `get_dependencies` tool to statically analyze imports and build a true DAG (Directed Acyclic Graph) of the codebase, allowing the AI to trace execution paths perfectly.
