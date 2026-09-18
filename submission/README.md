# 发布与上架（2026 年新流程）

> **注意**：Obsidian 已经不再通过 GitHub PR 收录插件了。
> 老流程（往 `obsidianmd/obsidian-releases` 的 `community-plugins.json` 提 PR）已经作废：
> 那个仓库现在关闭了 Issues，PR 接口返回 404，社区里也搜不到新的 PR。
> 现在官方走的是 **Obsidian 社区目录**：[community.obsidian.md](https://community.obsidian.md)。

## 一、推代码到 GitHub

```bash
cd <本仓库目录>
git add -A
git commit -m "Release x.y.z"
git push origin main
```

> 本机如果需要代理才能访问 GitHub，给 git 配一条只对 github.com 生效的代理即可：
> `git config --global http.https://github.com.proxy http://127.0.0.1:7897`

## 二、发 Release（必须）

官方要求：**Release 的 tag 必须与 `manifest.json` 里的 `version` 完全一致**（不带 `v` 前缀），
并且附件必须包含 `main.js`、`manifest.json`、`styles.css`（`styles.css` 可选，我们有）。

**方式 A：推 tag，让 GitHub Actions 自动发**（仓库自带 `.github/workflows/release.yml`）

```bash
git tag x.y.z
git push origin x.y.z
```

**方式 B：本地打包后手动发**

```bash
npm run release        # 生成 release/（三件套 + zip），并打印后续命令
gh release create x.y.z release/main.js release/manifest.json release/styles.css \
  --title "x.y.z" --generate-notes
```

## 三、提交到社区目录（取代原来的 PR）

1. 打开 <https://community.obsidian.md>，用 **Obsidian 账号**登录（没有就去 <https://obsidian.md/account/> 注册）；
2. 侧边栏 **Profile → GitHub → Connect**，授权后目录才能验证仓库归属（只读权限）；
3. 侧边栏 **Plugins → Add plugin**，选择仓库 `mannaa04/canvas-smooth-linker`；
4. 目录会**自动审核**并列出需要修正的地方；要改就发布一个版本号更高的 Release 再重新提交；
5. 自动审核没有错误后点 **Publish**，插件就会出现在 Obsidian 内的「浏览 → 社区插件」和官网目录里。

> 建议在 Profile 里打开 **Action required notifications**，审核发现问题会邮件通知你。

## 四、审核要求自查（`npm run check` 会自动检查大部分）

| 官方要求 | 我们的状态 |
| --- | --- |
| 仓库根目录有 `README.md` / `LICENSE` / `manifest.json` | ✅（README 摘录会显示在目录页） |
| Release 的 tag = manifest 的 version，附件含三件套 | ✅（CI 会校验 tag） |
| `description` ≤ 250 字符、以句号结尾、不以 "This is a plugin" 开头、不含 emoji/特殊字符 | ✅（1.3.2 已精简，去掉了 `[[...]]`） |
| `minAppVersion` 填合适的最低版本 | ✅ `1.13.7` |
| `isDesktopOnly` 与实际使用的 API 相符（用 Node/Electron 必须为 true） | ✅ 只用 DOM 与 Obsidian API，为 false |
| `fundingUrl` 只用于赞助链接，不需要就别写 | ✅ 未设置 |
| 命令 id 不要重复插件 id（Obsidian 自动加前缀） | ✅ `copy-selected-node-link` |
| 不要保留示例代码 | ✅ 全新项目 |

## 五、之后的每次更新

```bash
node scripts/set-version.mjs x.y.z    # 三处版本号同步
npm run build && npm test && npm run check
git add -A && git commit -m "Release x.y.z"
git push && git tag x.y.z && git push origin x.y.z    # CI 自动发 Release
```

上架之后**不需要**每次重新提交目录，用户会直接从 GitHub Release 拿到新版本。
