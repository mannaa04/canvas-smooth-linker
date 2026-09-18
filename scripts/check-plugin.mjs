/*
 * 上架前自检：把 Obsidian 社区插件注册表的要求 + 本项目的仓库约定跑一遍。
 * 用法：node scripts/check-plugin.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const readText = (p) => fs.readFileSync(path.join(root, p), "utf8");
const readJson = (p) => JSON.parse(readText(p));
const exists = (p) => fs.existsSync(path.join(root, p));

let failures = 0;
let warnings = 0;
const pass = (m) => console.log("  PASS  " + m);
const warn = (m) => {
	warnings += 1;
	console.log("  WARN  " + m);
};
const fail = (m) => {
	failures += 1;
	console.log("  FAIL  " + m);
};
const check = (name, ok, hint) => (ok ? pass(name) : fail(name + (hint ? " — " + hint : "")));

console.log("manifest.json");
if (!exists("manifest.json")) {
	fail("manifest.json 不存在");
	process.exit(1);
}
const manifest = readJson("manifest.json");

for (const field of ["id", "name", "version", "minAppVersion", "description", "author", "isDesktopOnly", "authorUrl"]) {
	check(`字段 ${field} 存在`, field in manifest);
}
check("id 只含小写字母/数字/连字符", /^[a-z0-9-]+$/.test(manifest.id), manifest.id);
check("id 不含 obsidian", !/obsidian/i.test(manifest.id));
check("name 不含 Obsidian", !/obsidian/i.test(manifest.name));
check("description 不含 Obsidian", !/obsidian/i.test(manifest.description));
check("description 以英文句号结尾", manifest.description.trim().endsWith("."));
check(`description 长度 ≤ 250（当前 ${manifest.description.length}）`, manifest.description.length <= 250);
check(
	"description 不含方括号/竖线/emoji 等特殊字符（官方要求）",
	!/[[\]|{}<>]/.test(manifest.description) && !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(manifest.description),
	manifest.description
);
check("version 形如 x.y.z", /^\d+\.\d+\.\d+$/.test(manifest.version), manifest.version);
check("isDesktopOnly 是布尔值", typeof manifest.isDesktopOnly === "boolean");
check("authorUrl 是 https 链接或者留空", !manifest.authorUrl || /^https:\/\//.test(manifest.authorUrl), manifest.authorUrl);

console.log("\nversions.json / package.json");
check("versions.json 存在", exists("versions.json"));
const versions = exists("versions.json") ? readJson("versions.json") : {};
check(`versions.json 记录了当前版本 ${manifest.version}`, manifest.version in versions);
check(
	"versions.json 的 minAppVersion 与 manifest 一致",
	versions[manifest.version] === manifest.minAppVersion,
	`${versions[manifest.version]} vs ${manifest.minAppVersion}`
);
check("package.json 的 version 与 manifest 一致", readJson("package.json").version === manifest.version);

console.log("\n仓库卫生（Reviewer 会看这些）");
check("LICENSE 存在", exists("LICENSE"));
check("README.md 存在", exists("README.md"));
check("styles.css 存在", exists("styles.css"));
check("main.ts 源码存在（不能只发打包产物）", exists("main.ts"));
check("esbuild 构建配置存在", exists("esbuild.config.mjs"));
const gitignore = exists(".gitignore") ? readText(".gitignore") : "";
check(".gitignore 忽略 node_modules/", /^node_modules\/$/m.test(gitignore));
check(".gitignore 忽略 main.js（构建产物不入库）", /^main\.js$/m.test(gitignore));
check(".gitignore 忽略 release/（打包产物不入库）", /^release\/$/m.test(gitignore));
check("仓库里没有 data.json（运行时生成的设置）", !exists("data.json"), "如果存在请删除并加入 .gitignore");

console.log("\n构建产物 main.js");
if (!exists("main.js")) {
	warn("还没构建 main.js（先跑 npm run build）");
} else {
	const bundle = readText("main.js");
	check("有默认导出（Obsidian 要求 export default Plugin）", /default:/.test(bundle));
	check("没有被压缩成一行（Reviewer 要能读懂）", bundle.split("\n").length > 50, `${bundle.split("\n").length} 行`);
	check(
		"没有引用 Node/Electron 内建模块（isDesktopOnly=false 的前提）",
		!/require\("(node:|fs|path|child_process|electron)"\)/.test(bundle)
	);
	check("只依赖 obsidian API", (bundle.match(/require\("[^"]+"\)/g) || []).every((m) => m.includes("obsidian")));
}

console.log(
	`\n${failures === 0 ? "自检通过 ✅" : `自检失败 ${failures} 项 ❌`}` + (warnings ? `（另有 ${warnings} 条警告）` : "")
);
process.exit(failures === 0 ? 0 : 1);
