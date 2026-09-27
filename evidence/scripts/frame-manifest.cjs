// Shared frame manifest for the evidence captures.
//
// The screenshots are PNGs, and a reviewer should not have to trust that an image
// shows what its filename claims. Every capture therefore records the text it read
// out of the rendered table at the moment it took the picture, and this helper
// folds those readings into evidence/frames.json.
//
// Read-modify-write rather than overwrite, so a run that captures only some frames
// does not erase the readings from the others.

const fs = require("node:fs");
const path = require("node:path");

const MANIFEST = path.join(__dirname, "..", "frames.json");

function recordFrame(file, note, tableText) {
  let manifest = { generatedAt: null, frames: [] };
  if (fs.existsSync(MANIFEST)) {
    try {
      manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
    } catch {
      manifest = { generatedAt: null, frames: [] };
    }
  }
  if (!Array.isArray(manifest.frames)) manifest.frames = [];

  const entry = {
    file,
    note,
    capturedAt: new Date().toISOString(),
    // The exact text the screenshot was taken with, so the image can be checked
    // against a claim without opening it.
    renderedText: tableText,
  };

  const existing = manifest.frames.findIndex((f) => f.file === file);
  if (existing >= 0) manifest.frames[existing] = entry;
  else manifest.frames.push(entry);

  manifest.frames.sort((a, b) => a.file.localeCompare(b.file));
  manifest.generatedAt = new Date().toISOString();
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`  recorded evidence/frames.json <- ${file}`);
}

module.exports = { recordFrame };
