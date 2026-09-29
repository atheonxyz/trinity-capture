// The MCP server codex/.mcp.json starts. Codex hands PLUGIN_DATA to hook
// commands only, so this process finds the plugin's data directory from its
// own install path, and runs the pending-file promotion the hooks run before
// every read, since it may start before any hook has.
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexHome, promotePendingConfig } from "./codex-connect.js";
import { DEFAULT_BASE_URL } from "./connect.js";
import { isMainModule } from "./main-module.js";
import { runProxy } from "./mcp.js";
// An installed plugin lives at
// $CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/, and Codex
// keys its data directory $CODEX_HOME/plugins/data/<plugin>-<marketplace>.
// Anything else (a checkout, a copy) names no directory and stays unpaired.
function installedPlugins(scriptPath) {
    const version = dirname(dirname(scriptPath));
    const plugin = dirname(version);
    const marketplace = dirname(plugin);
    const cache = dirname(marketplace);
    const plugins = dirname(cache);
    if (basename(dirname(scriptPath)) !== "dist" || basename(cache) !== "cache" || basename(plugins) !== "plugins")
        return null;
    return { plugins, key: `${basename(plugin)}-${basename(marketplace)}` };
}
export function codexDataDirFromInstall(scriptPath) {
    const install = installedPlugins(scriptPath);
    return install === null ? null : join(install.plugins, "data", install.key);
}
// Codex starts MCP servers without CODEX_HOME, so the home holding a pending
// pairing is read off the install path as well.
export function codexHomeFromInstall(scriptPath) {
    const install = installedPlugins(scriptPath);
    return install === null ? null : dirname(install.plugins);
}
export async function codexMcpDataDir(env, scriptPath) {
    const dataDir = env.TRINITY_CAPTURE_DATA ?? env.PLUGIN_DATA ?? codexDataDirFromInstall(scriptPath);
    if (dataDir === null)
        return null;
    const home = env.CODEX_HOME ?? codexHomeFromInstall(scriptPath) ?? codexHome(env);
    try {
        await promotePendingConfig(home, dataDir, env.TRINITY_BASE_URL ?? DEFAULT_BASE_URL);
    }
    catch (error) {
        if (!(error instanceof Error))
            throw error;
    }
    return dataDir;
}
if (isMainModule(import.meta.url)) {
    const scriptPath = fileURLToPath(import.meta.url);
    runProxy({ dataDir: () => codexMcpDataDir(process.env, scriptPath) });
}
