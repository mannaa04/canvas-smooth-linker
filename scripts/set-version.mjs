/*
 * 改版本号（manifest.json / package.json / versions.json 三处一起改）：
 *   node scripts/set-version.mjs 1.4.0
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const version = (process.argv[2] || "").trim();

if (!/^\d+\.\d+\.\d+$/.test(version)) {
	console.error("用法：node scripts/set-version.mjs 1.4.0");
	process.exit(1);
}

const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const write = (file, data) => {
	const raw = fs.readFileSync(path.join(root, file), "utf8");
	const indent = raw.includes("\n\t") ? "\t" : "  ";
	fs.writeFileSync(path.join(root, file), JSON.stringify(data, null, indent) + "\n", "utf8");
};
const compare = (a, b) => {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
	return 0;
};

const manifest = read("manifest.json");
manifest.version = version;
write("manifest.json", manifest);

const pkg = read("package.json");
pkg.version = version;
write("package.json", pkg);

const versions = read("versions.json");
versions[version] = manifest.minAppVersion;
const sorted = {};
for (const key of Object.keys(versions).sort(compare)) sorted[key] = versions[key];
write("versions.json", sorted);

console.log(`版本号已改为 ${version}`);
console.log("\n接下来：");
console.log(`  npm run release                # 打包出 release/ （含 zip）`);
console.log(`  git add -A && git commit -m "Release ${version}"`);
console.log(`  git tag ${version} && git push origin main --tags`);
