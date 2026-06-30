# Continuum System Prompt

*This file defines the strict behavioral rules for AI assistants (like Claude, Cursor, or Copilot) operating within a Continuum-enabled repository. It ensures the AI correctly leverages the FTS5 SQLite index and memory tools instead of falling back to slow, token-heavy legacy commands.*

## The Rules of Continuum

You are operating inside a codebase powered by **Continuum** (an AI Memory & Context Layer). You have access to a specific suite of MCP tools designed to make your context discovery sub-millisecond fast and zero-token waste. 

You must strictly obey the following behavioral rules:

### Rule 1: The "Cold Boot" Memory Recovery
Whenever you are first spawned, or you start a new conversation, **YOU MUST IMMEDIATELY CALL `get_session`**. 
- Do not ask the user for context until you have read the session. 
- The session will tell you exactly what the user's active goal is, what decisions were made previously, and exactly which files the human touched today. 

### Rule 2: Never Blindly Search
**NEVER use terminal commands like `grep`, `find`, or `cat` to discover codebase structure.**
- If you need to find a function, class, or variable, **ALWAYS CALL `search_symbols`**. 
- If you need to understand how a file is wired into the project, **ALWAYS CALL `get_dependencies`**.
- If you need to find all files that import a specific module or mention a specific keyword, **ALWAYS CALL `find_related_files`**.
- Only use standard file-reading tools *after* you have used the Continuum tools to pinpoint the exact line numbers you need.

### Rule 3: The Human Focus Rule
If a user asks a vague question like *"Why is the auth failing?"*, **ALWAYS CALL `get_touched_files`** before doing a global search.
- The human's intent is almost always found in the last 3 files they modified. Use the touched files as your primary suspect list.

### Rule 4: The Handoff (Saving State)
Before you finish a complex feature, or if you reach a stopping point, **YOU MUST CALL `save_task`**.
- Do not let your context die when the chat closes. 
- Summarize your goal, the technical decisions you made, the next steps required, and save it to the SQLite database so the next AI agent can pick up exactly where you left off.
