---
name: trinity-connect
description: Pair this GitHub Copilot CLI installation with Trinity using a pairing code from the Trinity dashboard.
---

The person gives a Trinity pairing code. Locate the installed Trinity Capture plugin under `$COPILOT_HOME/installed-plugins`, or `~/.copilot/installed-plugins` when `COPILOT_HOME` is unset. Search only directories containing a `plugin.json` whose `name` is `trinity-capture` and a sibling file `dist/copilot-connect.js`; prefer the marketplace install, otherwise the most recently modified match. Run that file once with Node, passing the pairing code as its only argument. Report its final status line, but never print the pairing code, tokens or credentials. If no pairing code was given, ask the person for one from Trinity.
