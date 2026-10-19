// Pairs Gemini CLI with a code from Trinity: node dist/gemini-connect.js <pairing-code>.
import { geminiDataDir } from "./gemini-hook.js";
import { runPairingScript } from "./connect.js";
import { isMainModule } from "./main-module.js";

if (isMainModule(import.meta.url)) {
  void runPairingScript("Gemini CLI", geminiDataDir(process.env), process.argv[2]?.trim() ?? "");
}
