// Pairs Copilot CLI with a code from Trinity: node dist/copilot-connect.js <pairing-code>.
import { copilotDataDir } from "./copilot-hook.js";
import { runPairingScript } from "./connect.js";
import { isMainModule } from "./main-module.js";

if (isMainModule(import.meta.url)) {
  void runPairingScript("Copilot CLI", copilotDataDir(process.env), process.argv[2]?.trim() ?? "");
}
