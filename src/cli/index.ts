#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';

const command = process.argv[2];

if (command === 'init') {
  console.log('Initializing Continuum MCP configuration...');

  const cwd = process.cwd();
  
  // Base MCP Configuration
  const mcpConfig = {
    mcpServers: {
      continuum: {
        command: "npx",
        args: ["-y", "continuum-ai-mcp", "start"],
        env: {
          WATCH_PATHS: "${workspaceFolder}/src",
          DB_PATH: "${workspaceFolder}/knowledge.db",
          LOG_LEVEL: "info",
          BULK_TOUCH_THRESHOLD: "30"
        }
      }
    }
  };

  // 1. .vscode/mcp.json (Claude Code / Antigravity)
  const vscodeDir = path.join(cwd, '.vscode');
  if (!fs.existsSync(vscodeDir)) {
    fs.mkdirSync(vscodeDir, { recursive: true });
  }
  
  const vscodeMcpPath = path.join(vscodeDir, 'mcp.json');
  if (!fs.existsSync(vscodeMcpPath)) {
    fs.writeFileSync(vscodeMcpPath, JSON.stringify(mcpConfig, null, 2));
    console.log(`✅ Created ${vscodeMcpPath}`);
  } else {
    console.log(`ℹ️  Skipped ${vscodeMcpPath} (already exists)`);
  }

  // 2. .cursor/mcp.json (Cursor)
  const cursorDir = path.join(cwd, '.cursor');
  if (!fs.existsSync(cursorDir)) {
    fs.mkdirSync(cursorDir, { recursive: true });
  }
  const cursorMcpPath = path.join(cursorDir, 'mcp.json');
  if (!fs.existsSync(cursorMcpPath)) {
    fs.writeFileSync(cursorMcpPath, JSON.stringify(mcpConfig, null, 2));
    console.log(`✅ Created ${cursorMcpPath}`);
  } else {
    console.log(`ℹ️  Skipped ${cursorMcpPath} (already exists)`);
  }

  const rulesContent = `# The Rules of Continuum

You are operating inside a codebase powered by **Continuum** (an AI Memory & Context Layer). You have access to a specific suite of MCP tools designed to make your context discovery sub-millisecond fast and zero-token waste. 

You must strictly obey the following behavioral rules:

### Rule 1: The "Cold Boot" Memory Recovery
Whenever you are first spawned, or you start a new conversation, **YOU MUST IMMEDIATELY CALL \`get_session\`**. 
- Do not ask the user for context until you have read the session. 
- The session will tell you exactly what the user's active goal is, what decisions were made previously, and exactly which files the human touched today. 

### Rule 2: Never Blindly Search
**NEVER use terminal commands like \`grep\`, \`find\`, or \`cat\` to discover codebase structure.**
- If you need to find a function, class, or variable, **ALWAYS CALL \`search_symbols\`**. 
- If you need to understand how a file is wired into the project, **ALWAYS CALL \`get_dependencies\`**.
- If you need to find all files that import a specific module or mention a specific keyword, **ALWAYS CALL \`find_related_files\`**.
- Only use standard file-reading tools *after* you have used the Continuum tools to pinpoint the exact line numbers you need.

### Rule 3: The Human Focus Rule
If a user asks a vague question like *"Why is the auth failing?"*, **ALWAYS CALL \`get_touched_files\`** before doing a global search.
- The human's intent is almost always found in the last 3 files they modified. Use the touched files as your primary suspect list.

### Rule 4: The Handoff (Saving State)
Before you finish a complex feature, or if you reach a stopping point, **YOU MUST CALL \`save_task\`**.
- Summarize your goal, the technical decisions you made, the next steps required, and save it to the SQLite database so the next AI agent can pick up exactly where you left off.
`;
  
  const cursorRulesPath = path.join(cwd, '.cursorrules');
  if (!fs.existsSync(cursorRulesPath)) {
    fs.writeFileSync(cursorRulesPath, rulesContent);
    console.log(`✅ Created ${cursorRulesPath}`);
  } else {
    console.log(`ℹ️  Skipped ${cursorRulesPath} (already exists)`);
  }

  const claudePath = path.join(cwd, '.claude.md');
  if (!fs.existsSync(claudePath)) {
    fs.writeFileSync(claudePath, rulesContent);
    console.log(`✅ Created ${claudePath}`);
  } else {
    console.log(`ℹ️  Skipped ${claudePath} (already exists)`);
  }

  // 4. .env
  const envPath = path.join(cwd, '.env');
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, `WATCH_PATHS=./src\nDB_PATH=./knowledge.db\nLOG_LEVEL=info\nBULK_TOUCH_THRESHOLD=30\n`);
    console.log(`✅ Created ${envPath}`);
  } else {
    console.log(`ℹ️  Skipped ${envPath} (already exists)`);
  }

  console.log('\n🎉 Initialization complete! Restart your IDE or AI assistant to load the tools.');
} else if (command === 'start') {
  // Run the MCP server
  require('../mcp/McpServer.js');
} else {
  console.log('Continuum AI MCP Setup');
  console.log('Usage:');
  console.log('  npx continuum-ai-mcp init   - Setup MCP config files in current directory');
  console.log('  npx continuum-ai-mcp start  - Run the MCP server manually');
}
