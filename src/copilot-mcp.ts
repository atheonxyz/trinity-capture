// The MCP server the Copilot CLI plugin starts, reading the credential where the hooks keep it.
import { copilotDataDir } from "./copilot-hook.js";
import { isMainModule } from "./main-module.js";
import { runProxy } from "./mcp.js";

if (isMainModule(import.meta.url)) {
  runProxy({ dataDir: async () => copilotDataDir(process.env) });
}
