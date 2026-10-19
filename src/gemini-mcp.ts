// The MCP server the Gemini CLI extension starts, reading the credential where the hooks keep it.
import { geminiDataDir } from "./gemini-hook.js";
import { isMainModule } from "./main-module.js";
import { runProxy } from "./mcp.js";

if (isMainModule(import.meta.url)) {
  runProxy({ dataDir: async () => geminiDataDir(process.env) });
}
