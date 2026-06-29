# Continuum Roadmap

Continuum is currently **production-ready** for individual developers and small-to-medium teams. The core features—incremental parsing, SQLite FTS5 search, and MCP tool integration—provide immediate, tangible value by solving the context compaction problem.

However, to scale this to enterprise monorepos and fully autonomous AI agents, the following enhancements are proposed for future development.

## Phase 1: Stability & Concurrency (Immediate Enhancements)
- **SQLite WAL Mode**: Enable Write-Ahead Logging (WAL) in SQLite with a `busy_timeout`. This is critical for preventing `SQLITE_BUSY` crashes when multiple AI clients (e.g., Cursor and Claude Code) spawn their own MCP processes and try to write to `knowledge.db` simultaneously.
- **Watcher Debouncing**: Implement robust debouncing for `chokidar` to gracefully handle massive file changes (e.g., running `git checkout` or changing branches), preventing CPU spikes and MCP timeout errors.

## Phase 2: Advanced Memory Management
- **Stale Memory Pruning**: Automatically age-out or clear `touched_files` after 24 hours of inactivity or when a task is explicitly marked as completed. This prevents the AI from getting distracted by old edits.
- **Session Summarization**: When `decisions` or `next_steps` arrays grow too large, use a background LLM call to periodically summarize and compress the task state to keep the DB lightweight.

## Phase 3: AI Proactivity & Integration
- **Pre-built System Prompts**: Ship `.cursorrules` and `.claude.md` template files in the repository. These will train the AI to autonomously call `save_task` when context is getting full, without relying entirely on human-triggered Slash Commands.
- **IDE Extensions**: Build lightweight wrapper extensions (for VS Code, JetBrains) that automatically spawn and manage the MCP server lifecycle, removing the need for manual JSON configurations.

## Phase 4: Parsing Accuracy (Long-term)
- **Tree-sitter Migration**: Transition from fast Regex-based symbol extraction to AST (Abstract Syntax Tree) parsing using Tree-sitter. This will drastically reduce false positives in complex languages and better handle deeply nested generics or multi-line strings.
- **Dependency Graphing**: Expand the `get_dependencies` tool to statically analyze imports and build a true DAG (Directed Acyclic Graph) of the codebase, allowing the AI to trace execution paths perfectly.
