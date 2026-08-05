import { existsSync, readFileSync } from "fs";

const infoPath = "Info.json";
const info = JSON.parse(readFileSync(infoPath, "utf8"));
const requiredStrings = ["name", "identifier", "version", "entry"];

for (const key of requiredStrings) {
    if (typeof info[key] !== "string" || info[key].trim() === "") {
        console.error(`Missing or invalid ${key} in ${infoPath}.`);
        process.exit(1);
    }
}

if (typeof info.author?.name !== "string" || !Number.isInteger(info.ghVersion)) {
    console.error(`Missing or invalid author or ghVersion in ${infoPath}.`);
    process.exit(1);
}

for (const key of ["entry", "globalEntry", "preferencesPage"]) {
    if (typeof info[key] !== "string" || !existsSync(info[key])) {
        console.error(`Missing ${key} target: ${info[key] ?? "undefined"}`);
        process.exit(1);
    }
}

console.log(`${infoPath} is directly installable by IINA.`);
