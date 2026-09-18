/*
 * 生成提交到社区插件列表用的条目：
 *   node scripts/make-submission-entry.mjs <github用户名> [仓库名]
 * 默认仓库名 = manifest.id
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const user = (process.argv[2] || "").trim();
const repo = (process.argv[3] || manifest.id).trim();

if (!user) {
	console.error("用法：node scripts/make-submission-entry.mjs <github用户名> [仓库名]");
	process.exit(1);
}

const entry = {
	id: manifest.id,
	name: manifest.name,
	author: manifest.author,
	repo: `${user}/${repo}`,
};

const dir = path.join(root, "submission");
fs.mkdirSync(dir, { recursive: true });
const target = path.join(dir, "community-plugins-entry.json");
fs.writeFileSync(target, JSON.stringify(entry, null, "\t") + "\n", "utf8");

console.log(`已写入 submission/community-plugins-entry.json：
${JSON.stringify(entry, null, "\t")}

提交流程见 submission/README.md。核心就是把上面这段 JSON 追加到
obsidianmd/obsidian-releases 仓库 community-plugins.json 的末尾，然后提 PR。
`);
