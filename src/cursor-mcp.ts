// The MCP server cursor/mcp.json starts: Cursor supplies no plugin data path,
// so the credential lives where the hooks keep it, the platform's per-user
// application-data directory (cursorDataDir).
import { cursorDataDir } from "./cursor-hook.js";
import { isMainModule } from "./main-module.js";
import { runProxy } from "./mcp.js";

if (isMainModule(import.meta.url)) {
  runProxy({ dataDir: async () => cursorDataDir(process.env) });
}
