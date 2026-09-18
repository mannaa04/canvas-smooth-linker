/*
 * 校验 release tag 与 manifest.json / versions.json 一致。
 * Obsidian 要求：tag 必须与 manifest 里的 version 完全相同（不带 v 前缀）。
 * 用法：node scripts/check-release-tag.mjs 1.0.0
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const versions = JSON.parse(fs.readFileSync(path.join(root, "versions.json"), "utf8"));
const tag = (process.argv[2] || "").trim();

let failures = 0;
const fail = (m) => {
	failures += 1;
	console.log("  FAIL  " + m);
};

if (!tag) {
	fail("没有传入 tag，用法：node scripts/check-release-tag.mjs 1.0.0");
} else {
	if (tag !== manifest.version) {
		fail(`tag "${tag}" 与 manifest.version "${manifest.version}" 不一致（tag 不能带 v 前缀）`);
	} else {
		console.log(`  PASS  tag 与 manifest.version 一致：${tag}`);
	}
	if (!(tag in versions)) {
		fail(`versions.json 里没有 ${tag}，先跑 npm run version:set -- ${manifest.version}`);
	} else {
		console.log(`  PASS  versions.json 包含 ${tag}`);
	}
}

console.log(failures === 0 ? "\ntag 校验通过 ✅" : `\ntag 校验失败 ${failures} 项 ❌`);
process.exit(failures === 0 ? 0 : 1);
