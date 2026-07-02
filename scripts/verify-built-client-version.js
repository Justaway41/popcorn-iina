import { existsSync, readFileSync } from "fs";

const infoPath = "xyz.brbc.popcorn.iinaplugin/Info.json";
const infoRaw = readFileSync(infoPath, "utf8");
const info = JSON.parse(infoRaw);

if (typeof info.version !== "string" || info.version.trim() === "") {
    console.error("Missing or invalid version in Info.json.");
    process.exit(1);
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = new RegExp(`version\\s*:\\s*"${escapeRegExp(info.version)}"`);

const files = [
    "xyz.brbc.popcorn.iinaplugin/dist/main.js",
    "xyz.brbc.popcorn.iinaplugin/dist/global.js",
    "xyz.brbc.popcorn.iinaplugin/ui/dist/sidebar.js",
];

let ok = true;

for (const file of files) {
    if (!existsSync(file)) {
        console.error(`Missing build output: ${file}`);
        ok = false;
        continue;
    }

    const content = readFileSync(file, "utf8");
    if (!pattern.test(content)) {
        console.error(`Version mismatch in ${file}; expected ${info.version}`);
        ok = false;
    }
}

if (!ok) {
    process.exit(1);
}

console.log(`Client version ${info.version} found in built outputs.`);
