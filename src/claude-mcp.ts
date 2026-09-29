// The MCP server claude-code/.mcp.json starts: Claude Code hands the plugin's
// data directory over as CLAUDE_PLUGIN_DATA, resolved the way the hooks
// resolve it, paired sibling surface included.
import { claudeCodeDialect } from "./claude-hook.js";
import { isMainModule } from "./main-module.js";
import { runProxy } from "./mcp.js";

if (isMainModule(import.meta.url)) {
  runProxy({ dataDir: async () => claudeCodeDialect.dataDir(process.env) });
}
