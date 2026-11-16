"use strict";

const fs = require("fs");
const path = require("path");

const srcDir = path.join(__dirname, "..", "data");
const destDir = path.join(__dirname, "..", "dist", "data");

fs.mkdirSync(destDir, { recursive: true });
for (const name of fs.readdirSync(srcDir)) {
  fs.copyFileSync(path.join(srcDir, name), path.join(destDir, name));
}
console.log("Copied data/ -> dist/data/");
