// Ticket Tracker loader: always runs the latest widget from the web.
const fm = FileManager.local();
const p = fm.joinPath(fm.documentsDirectory(), "tt-widget-cache.js");
let code = null;
try { code = await new Request("https://dgrazi97.github.io/ticket-tracker/widget.js?t=" + Date.now()).loadString(); if (code.includes("TRACKER_URL")) fm.writeString(p, code); else code = null; } catch (e) {}
if (!code && fm.fileExists(p)) code = fm.readString(p);
await eval("(async () => {\n" + code + "\n})()");
