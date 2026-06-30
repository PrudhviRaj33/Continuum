# Continuum Roadmap

Continuum is currently **production-ready** for individual developers and small-to-medium teams. The core features—incremental parsing, SQLite FTS5 search, and MCP tool integration—provide immediate, tangible value by solving the context compaction problem.

However, to scale this into a massive enterprise-grade architecture and fully autonomous AI agent layer, the following architectural enhancements are proposed for future development.

## ✅ Completed (Production Enhancements)
- **SQLite WAL Mode & Busy Timeout**: Added `busy_timeout` to ensure concurrent AI connections wait politely instead of throwing `SQLITE_BUSY` crashes.
- **Watcher Queueing**: Built a background batching queue into `chokidar` to gracefully handle massive changes like `git checkout`.
- **Parsing Safeguards**: Added file size limits to prevent OOM errors on massive minified files.
- **Stale Memory Decay**: Touched files are now automatically physically pruned (Garbage Collected) from the database after 24 hours to prevent infinite DB bloat.

## Phase 2: Advanced Memory Management (Preventing Task Bloat)
- **Session Summarization (Garbage Collection for Tasks)**: While we have garbage collection for `touched_files`, `save_task` entries can accumulate infinitely. If a user saves 500 tasks, the session state payload becomes bloated. We will introduce a background LLM process that periodically reads historical tasks, summarizes them into a single compressed paragraph, and deletes the raw history to keep the database and context payloads extremely lightweight.

## Phase 3: AI Proactivity & Integration
- **Pre-built System Prompts**: Ship `.cursorrules` and `.claude.md` template files in the repository. These will train the AI to autonomously call `save_task` when context is getting full, without relying entirely on human-triggered Slash Commands.
- **IDE Extensions**: Build lightweight wrapper extensions (for VS Code, JetBrains) that automatically spawn and manage the MCP server lifecycle, removing the need for manual JSON configurations.

## Phase 4: Architectural Scaling (Search & Parsing)
- **Semantic Search (Vector Embeddings)**: Currently, Continuum relies on SQLite's FTS5 engine, which is a *keyword* search. If the AI searches for `"user authentication"`, but the function is named `verify_jwt()`, it won't be found. We plan to integrate a Vector Database (like SQLite-VSS or Chroma) to store text embeddings, allowing the AI to search by *meaning* rather than exact character matching.
- **AST Parsing (Tree-sitter)**: Our `IncrementalParser` currently uses Regex. While Regex is incredibly fast, it lacks deep semantic understanding. If a developer writes a wildly complex, multi-line nested generic function in C++ or Rust, Regex can fail to extract the signature properly. Migrating to an AST (Abstract Syntax Tree) parser via Tree-sitter will provide 100% accurate symbol extraction, drastically reducing false positives in complex languages.
- **Dependency Graphing**: Expand the `get_dependencies` tool to statically analyze imports and build a true DAG (Directed Acyclic Graph) of the codebase, allowing the AI to trace execution paths perfectly.
