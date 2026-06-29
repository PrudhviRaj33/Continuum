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
        args: ["continuum", "start"],
        env: {
          WATCH_PATHS: "${workspaceFolder}/src",
          DB_PATH: "${workspaceFolder}/knowledge.db",
          LOG_LEVEL: "info"
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

  // 3. AI System Prompts
  const rulesContent = `You have access to the Continuum MCP tools.
Always call \`get_session\` when you first start working or if you lose context.
Use \`save_task\` to proactively save goals, decisions, and next steps before closing sessions.
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
    fs.writeFileSync(envPath, `WATCH_PATHS=./src\nDB_PATH=./knowledge.db\nLOG_LEVEL=info\n`);
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
  console.log('  npx continuum init   - Setup MCP config files in current directory');
  console.log('  npx continuum start  - Run the MCP server manually');
}
