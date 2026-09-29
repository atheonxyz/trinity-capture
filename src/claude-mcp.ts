// The MCP server claude-code/.mcp.json starts. Claude Code sets
// CLAUDE_PLUGIN_DATA in a plugin server's environment itself; an env entry
// naming ${CLAUDE_PLUGIN_DATA} would arrive literally, so .mcp.json has none.
// The directory resolves the way the hooks resolve it.
import { claudeCodeDialect } from "./claude-hook.js";
import { isMainModule } from "./main-module.js";
import { runProxy } from "./mcp.js";

if (isMainModule(import.meta.url)) {
  runProxy({ dataDir: async () => claudeCodeDialect.dataDir(process.env) });
}
