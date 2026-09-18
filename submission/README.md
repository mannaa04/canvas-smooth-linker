# 发布到 GitHub / 上架 Obsidian 社区插件

> 本插件的构建产物 `main.js` **不进仓库**（`.gitignore` 已忽略），它由 Release 附件或 GitHub Actions 提供。

## 一、把代码推到 GitHub

```bash
cd <本仓库目录>
git add -A
git commit -m "Canvas Smooth Linker 1.3.0"
git branch -M main
git remote add origin https://github.com/<你的用户名>/canvas-smooth-linker.git
git push -u origin main
```

首次推送会要求登录（HTTPS 用 Personal Access Token，或改用 SSH）。

## 二、发 Release（BRAT / 社区插件都靠它）

**方式 A：推 tag，让 GitHub Actions 自动发**（仓库自带 `.github/workflows/release.yml`）

```bash
git tag 1.3.0          # 必须与 manifest.json 里的 version 完全一致，不能带 v
git push origin 1.3.0
```

**方式 B：本地打包后手动发**

```bash
npm run release        # 生成 release/（三件套 + zip），并打印 gh 命令
gh release create 1.3.0 release/main.js release/manifest.json release/styles.css \
  release/canvas-smooth-linker-1.3.0.zip --title "1.3.0" --generate-notes
```

Release 附件里**必须**有 `main.js`、`manifest.json`、`styles.css` 这三个文件（Obsidian 的硬性要求，zip 只是给人手动下载用的）。

装插件的人这时就能用：

- 手动：下载三个文件放进 `<仓库>/.obsidian/plugins/canvas-smooth-linker/`；
- **BRAT**：`Add beta plugin` → 填仓库地址 → 自动安装并跟随更新（不用上架商店）。

## 三、上架社区插件商店（可选，需要审核）

1. 确认仓库是**公开**的，且有 `LICENSE`、`README.md`、`manifest.json`、`versions.json`；
2. 生成要提交的条目：

   ```bash
   node scripts/make-submission-entry.mjs <你的GitHub用户名>
   ```

   会得到 `submission/community-plugins-entry.json`；

3. Fork [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases)，
   把上面那段 JSON **追加到 `community-plugins.json` 的末尾**（这个 PR 只改这一个文件），然后提 PR；
4. 等自动校验（机器人会检查 manifest、tag、Release 资产、版本号）与人工审核通过，合并后就会出现在
   Obsidian 的「浏览社区插件」里。

### 审核常见检查点（本项目已满足）

| 要求 | 状态 |
| --- | --- |
| id 只含小写字母/数字/连字符，且不含 `obsidian` | ✅ |
| name / description 不含 `Obsidian`，description 以句号结尾且 ≤250 字符 | ✅ |
| `versions.json` 与 `manifest.json` 版本、`minAppVersion` 一致 | ✅ |
| Release 的 tag 与 `manifest.json` 版本完全一致 | ✅（workflow 会校验） |
| 仓库里有源码（不能只放打包产物）、有 LICENSE / README | ✅ |
| 没有提交 `main.js`、`data.json`、`node_modules` | ✅ |
| `isDesktopOnly` 与实际使用的 API 相符（本项目只用 DOM / Obsidian API） | ✅ |
| 不发送任何网络请求、不使用 `innerHTML` | ✅ |

跑一次 `npm run check` 可以在本地复核上表。

## 四、之后的每次更新

```bash
node scripts/set-version.mjs 1.4.0   # 三处版本号一起改
npm run build && npm test            # 构建 + 回归测试
git add -A && git commit -m "Release 1.4.0"
git push && git tag 1.4.0 && git push origin 1.4.0
```

推 tag 后 GitHub Actions 会自动发 Release；已上架商店的插件会在几小时内提示更新。
