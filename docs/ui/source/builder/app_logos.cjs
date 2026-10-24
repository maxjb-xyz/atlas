// Writes the app's copy of the logos (app/src/logos.ts) from logos.json: node app_logos.cjs
const fs = require("fs");
const path = require("path");
const logos = JSON.parse(fs.readFileSync(path.join(__dirname, "logos.json"), "utf8"));
let out = `// Real logos for outside services (docs/ui/README.md §8), from docs/ui/source/builder/logos.json:
// CC0 icon sets (Iconify's logos, Simple Icons) and the vendors' own icons where those have none.
// Each is a data URI; \`inv\` marks a black logo, inverted in the dark theme. Written by
// docs/ui/source/builder/app_logos.cjs; change logos.json and run it again.

export interface LogoData {
  uri: string;
  inv: boolean;
}

export const LOGOS: Record<string, LogoData> = {
`;
for (const [k, v] of Object.entries(logos)) out += `  ${JSON.stringify(k)}: { uri: ${JSON.stringify(v.uri)}, inv: ${!!v.inv} }, // ${v.src}\n`;
out += "};\n";
fs.writeFileSync(path.join(__dirname, "../../../../app/src/logos.ts"), out);
console.log(`wrote ${Object.keys(logos).length} logos`);
