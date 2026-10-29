/*
 * Optional install-time helper. The registry deliberately ships the base fonts
 * inline; this writes the already-verified bytes beside an installed stylesheet
 * only when a consumer explicitly asks for file-backed fonts.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const faces = [
  { family: "DM Sans", file: "dm-sans-variable.woff2", sha256: "511199053bc63da8002f95cebf6d8254c0838d7c3515db9a6d92a579ac81eef8" },
  { family: "Bricolage Grotesque", file: "bricolage-grotesque-variable.woff2", sha256: "732d894c80980fc12f0c5dd955f5e917a6ffefb666553a7cee25a00b058b6368" },
];

const argumentsAfterNode = process.argv.slice(2);
const cssArgument = argumentsAfterNode[0] === "--css" ? argumentsAfterNode[1] : argumentsAfterNode[0]?.startsWith("--css=") ? argumentsAfterNode[0].slice("--css=".length) : undefined;
if (!cssArgument || !((argumentsAfterNode.length === 2 && argumentsAfterNode[0] === "--css") || (argumentsAfterNode.length === 1 && argumentsAfterNode[0] === `--css=${cssArgument}`))) {
  throw new Error("Use: node scripts/cojeev-materialize-fonts.mjs --css src/styles/cojeev-fonts.css");
}

const cssPath = path.resolve(cssArgument);
if (!fs.existsSync(cssPath) || !fs.statSync(cssPath).isFile()) throw new Error(`CSS file does not exist: ${cssPath}`);
const css = fs.readFileSync(cssPath, "utf8");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const sourceFor = family => new RegExp(`font-family\\s*:\\s*["']${family.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}["']\\s*;\\s*src\\s*:\\s*url\\(\\s*["'](data:font/woff2;base64,([^"']+))["']\\s*\\)`, "g");
const relativeSourceFor = file => `./fonts/${file}`;

const found = faces.map(face => {
  const matches = [...css.matchAll(sourceFor(face.family))];
  if (matches.length > 1) throw new Error(`Expected one embedded ${face.family} source, found ${matches.length}.`);
  return { ...face, match: matches[0], target: path.join(path.dirname(cssPath), "fonts", face.file) };
});
const embedded = found.filter(face => face.match);
const materialized = found.filter(face => css.includes(`src:url("${relativeSourceFor(face.file)}")`) || css.includes(`src: url("${relativeSourceFor(face.file)}")`));

if (embedded.length === 0 && materialized.length === faces.length) {
  for (const face of found) {
    if (!fs.existsSync(face.target) || hash(fs.readFileSync(face.target)) !== face.sha256) {
      throw new Error(`Materialized ${face.file} is missing or does not match its verified SHA-256.`);
    }
  }
  console.log("Cojeev fonts are already materialized and verified.");
  process.exit(0);
}
if (embedded.length !== faces.length || materialized.length !== 0 || (css.match(/data:font\/woff2;base64,/g) ?? []).length !== faces.length) {
  throw new Error("Expected the complete embedded Cojeev font pair; refusing partial or drifted stylesheet input.");
}

const existingTargets = found.filter(face => fs.existsSync(face.target));
if (existingTargets.length && existingTargets.length !== faces.length) {
  throw new Error("Refusing partial materialization: one Cojeev target font exists while the other is absent.");
}

for (const face of found) {
  const bytes = Buffer.from(face.match[2], "base64");
  if (hash(bytes) !== face.sha256) throw new Error(`Embedded ${face.family} bytes do not match the verified SHA-256.`);
  face.bytes = bytes;
  if (fs.existsSync(face.target) && hash(fs.readFileSync(face.target)) !== face.sha256) {
    throw new Error(`Refusing to overwrite ${face.target}: it does not match the verified ${face.family} asset.`);
  }
}

const rewritten = found.reduce((next, face) => next.replace(face.match[1], relativeSourceFor(face.file)), css);
fs.mkdirSync(path.dirname(found[0].target), { recursive: true });
for (const face of found) if (!fs.existsSync(face.target)) fs.writeFileSync(face.target, face.bytes, { flag: "wx" });
fs.writeFileSync(cssPath, rewritten);
console.log("Materialized 2 verified WOFF2 fonts beside the active stylesheet.");
