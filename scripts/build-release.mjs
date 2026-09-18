/*
 * 发布打包：npm run release
 *   1) 上架自检   2) 类型检查 + 打包   3) 生成 release/（三件套 + zip）
 *   4) 打印 GitHub Release 与社区提交的下一步命令
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createZip } from "./zip.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const assets = ["main.js", "manifest.json", "styles.css"];

const run = (script, args = []) => execFileSync(process.execPath, [path.join(root, script), ...args], { stdio: "inherit", cwd: root });

console.log("① 上架自检");
run("scripts/check-plugin.mjs");

console.log("\n② 类型检查 + 打包");
execFileSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--skipLibCheck"], { stdio: "inherit", cwd: root });
execFileSync(process.execPath, [path.join(root, "esbuild.config.mjs"), "production"], { stdio: "inherit", cwd: root });

console.log("\n③ 生成 release/");
const outDir = path.join(root, "release");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
for (const asset of assets) {
	fs.copyFileSync(path.join(root, asset), path.join(outDir, asset));
}
const zipName = `${manifest.id}-${manifest.version}.zip`;
fs.writeFileSync(
	path.join(outDir, zipName),
	createZip(assets.map((asset) => ({ name: asset, data: fs.readFileSync(path.join(root, asset)) })))
);
for (const file of [...assets, zipName]) {
	const size = fs.statSync(path.join(outDir, file)).size;
	console.log(`   release/${file}  (${size} bytes)`);
}

console.log(`
④ 发布到 GitHub（二选一）

  A. 有 gh CLI：
     git tag ${manifest.version} && git push origin main --tags
     gh release create ${manifest.version} release/main.js release/manifest.json release/styles.css release/${zipName} \\
       --title "${manifest.version}" --generate-notes

  B. 只在网页上操作：
     把 release/ 里的三个文件上传到 GitHub Releases（tag 必须正好是 ${manifest.version}，不带 v）
     注意：这是 Obsidian 社区插件的硬性要求 —— Release 附件必须包含 main.js / manifest.json / styles.css

⑤ 想上架社区插件商店
     见 submission/README.md（需要先有公开仓库）
`);
