---
name: trinity-connect
description: Connect this Cursor installation to Trinity
---

Locate the installed Trinity Capture Cursor plugin under the current user's `.cursor/plugins` directory. Search only plugin directories containing `.cursor-plugin/plugin.json`; require its `name` to be `trinity-capture` and require the sibling file `dist/cursor-connect.js`. Prefer the local `trinity-capture` install, otherwise use the most recently modified matching Marketplace install. Run that file once with Node. It opens Trinity in the browser for approval and waits until the connection is complete. Report the verification code and final status, but never print device secrets or credentials.
