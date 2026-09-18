# Canvas Smooth Linker

把 Obsidian Canvas 卡片里的内部链接变成 **PPT 超链接**：

点击卡片内的 `[[画布名.canvas#目标节点ID|显示文字]]`，
当前画布视口在 300~400ms 内带缓动地 **平移 + 缩放**，聚焦到目标节点中心。
不跳新标签页，不进入编辑模式，不破坏当前画布。

## English summary

Make internal links inside Canvas cards behave like PowerPoint hyperlinks.

- Click `[[MyCanvas.canvas#nodeId|label]]` inside a card → the viewport **smoothly pans and zooms**
  (easeInOutQuad, ~350 ms, scale 1.2) to center the target node, in the **same** canvas/tab,
  **without** entering edit mode.
- Works with `[[#nodeId]]`, `[[MyCanvas.canvas#nodeId|label]]` and `[[Other.canvas#nodeId]]`
  (cross-canvas navigation can be disabled). Regular note links are never intercepted;
  `Ctrl/Cmd+click` keeps the native behavior.
- Right-click a link → hierarchical menu **Adjust link text ▸ Color / Size / Bold / Italic / Underline**,
  plus a floating **style panel** with color swatches, HEX input, saved custom colors and a font-size
  slider. Styles are written into the link alias as inline HTML, so they travel with the file and
  support `Ctrl+Z`.
- Right-click a card → **Copy card link**; a palette button in the canvas toolbar opens the global
  style panel.
- Link text supports rendered Markdown/math (`[[c#id|page $\alpha$]]`), and hover previews of notes
  are suppressed on canvas links (both toggleable).

Install: copy `main.js`, `manifest.json`, `styles.css` into
`<vault>/.obsidian/plugins/canvas-smooth-linker/` and enable it in
Settings → Community plugins. Or install from GitHub Releases via **BRAT**.

Verified against Obsidian **1.13.7** (Canvas internals inspected directly). Viewport math has a
68-assertion regression suite (`npm test`) and the bundled artifact has a 66-assertion smoke test.

---

## 1. 安装

### 方式 A：直接放进 vault（不需要 Node）

把下面三个文件复制到 `<你的仓库>/.obsidian/plugins/canvas-smooth-linker/`：

```
main.js        ← 已构建好的插件本体（本仓库根目录，由 main.ts 打包生成）
manifest.json
styles.css
```

然后在 Obsidian → 设置 → 第三方插件 里启用 **Canvas Smooth Linker**。

### 方式 B：从源码构建

```bash
npm install
npm run dev      # 监听 main.ts，改动即重新打包
npm run build    # 类型检查 + 打包出生产版 main.js
npm test         # 视口数学回归测试（见第 6 节）
```

---

## 2. 怎么写出能用的链接

画布节点的 ID 存在 `.canvas` 文件里（`nodes[].id`，形如 `1a2b3c4d5e6f7788`）。
链接写法：

| 写法 | 行为 |
| --- | --- |
| `[[画布名.canvas#1a2b3c4d5e6f7788]]` | 在当前画布内平滑聚焦到该节点 |
| `[[画布名.canvas#1a2b3c4d5e6f7788\|显示文字]]` | 同上（带别名，推荐） |
| `[[#1a2b3c4d5e6f7788]]` | 指向**当前**画布里的节点 |
| `[[别的画布.canvas#1a2b3c4d5e6f7788]]` | 打开那张画布并聚焦（可关闭，见设置） |

**不想手动找 ID？** 在画布里选中节点，运行命令
`Canvas Smooth Linker: 复制选中画布节点的内部链接`，
会得到 `[[路径/画布.canvas#节点ID]]` 并复制到剪贴板。
把这个链接粘进卡片即可（PPT 里做「上一页 / 下一页 / 返回目录」就是这么用的）。

> 提示：链接必须放在能被点击的地方——画布**文本卡片**、或**文件卡片**里嵌入的笔记正文。

---

## 3. 它是怎么工作的

### 3.1 点击拦截

`document` 上的 **捕获阶段** click 监听（外加 dblclick）：

1. 命中 `a.internal-link`（必要时用 `elementsFromPoint` 做“点穿透”，见第 5 节）；
2. 解析 `data-href` → 文件部分 + `#` 后的节点 ID；
3. 按 `closest(".canvas-wrapper")` 反查 `CanvasView`（跨 popout 窗口同样注册了监听）；
4. `canvas.nodes.get(nodeId)` 拿节点，`getBBox()` → 中心点；
5. `preventDefault()` + `stopPropagation()`，然后播放动画。

### 3.2 坐标数学（这是本插件的核心）

Obsidian 1.13.7 的 `.canvas` 元素是：

```css
.canvas {
  width: 100%; height: 100%; left: 0; top: 0;
  transform-origin: 0 0;
  transform: translate(W/2, H/2) scale(s) translate(-x, -y);
}
```

其中 `W/H` 是画布可视区尺寸，`s` 是缩放倍数，`x/y` 是**视口中心在画布坐标系里的位置**。展开后：

```text
屏幕坐标(相对 .canvas-wrapper) = (W/2, H/2) + s · (画布坐标 − 视口中心)
```

反解（用于从 DOM 实测当前视口，见 `readViewport`）：

```text
视口中心 = ( (W/2 − e) / s , (H/2 − f) / s )      // (e, f) 是 .canvas 的 CSS 矩阵平移量
```

让节点中心 `(px, py)` 落到视口中心，就是要 `视口中心 := (px, py)`。若必须直接写 DOM：

```text
transform = translate(W/2 − px·s , H/2 − py·s) scale(s)
```

关键字段语义（已对照 1.13.7 实际代码核对）：

| 字段 | 含义 |
| --- | --- |
| `canvas.x` / `canvas.y` | 当前视口中心（画布坐标） |
| `canvas.tx` / `canvas.ty` | 视口中心的**动画目标**（同上坐标系） |
| `canvas.scale` | 真实缩放倍数（1 = 100%） |
| `canvas.zoom` | `log2(scale)`，内部会被 clamp 到 `[-4, 1]`，即缩放范围 1/16 ~ 2 倍 |
| `canvas.setViewport(x, y, zoom)` | 1.13.x 的官方入口：(视口中心, log2 缩放) |

### 3.3 动画（requestAnimationFrame + easeInOutQuad）

每一帧只做「按缓动曲线插值 → 落值」，不一次性跳过去：

```text
t = clamp(elapsed / duration, 0, 1)              // duration 默认 350ms
k = easeInOutQuad(t) = t < 0.5 ? 2t² : 1 − (−2t + 2)² / 2

centerX = x0 + (x1 − x0) · k                     // 位置：线性插值
centerY = y0 + (y1 − y0) · k
scale   = 2^( log2(s0) + (log2(s1) − log2(s0)) · k )   // 缩放：对数插值（等比缩放更自然）
```

收敛后还会做一次 `settleAndVerify` 自校正：等 Obsidian 自己的 rAF 把 transform 写进 DOM 后，
从矩阵实测「屏幕上真实位置」，与目标比对（缩放偏差 > 2% / 中心偏差 > 1 画布单位才修正），
因此即使在缩放被 clamp、或版本语义略有差异时，最终也会精确落位。

动画期间一旦用户滚轮缩放或按下鼠标，动画立刻放弃，不跟用户抢视口。

---

## 4. 容错设计（不同 Obsidian 版本）

不确定的字段语义都在运行时**实测判定**，并按优先级回退：

| 优先级 | 写入方式 | 适用 |
| --- | --- | --- |
| ① | `canvas.setViewport(cx, cy, zoom)` | 1.13.x 正式入口 |
| ② | 直接写 `tx/ty/x/y/zoom/tZoom/scale` + `markViewportChanged()` | 字段直写 |
| ③ | `canvas.panTo(cx, cy)` + `canvas.zoomBy(Δlog2)` | 较老版本组合 |
| ④ | 直接写 `canvasEl.style.transform` | 最后兜底 |

`zoom` 到底是 `log2(scale)` 还是 `scale` 本身、`x/y` 到底是视口中心还是屏幕位移，
由 `canvas.scale` 与 DOM 实测矩阵交叉验证得出（`detectZoomIsLog2` / `readViewport`）；
判定不出来时按 1.13.7 的语义处理。若某版本判断错误，自校正环节会翻转语义再试一次。

> `zoomTo` 方法在 1.13.7 的 Canvas 上并不存在（只有 `zoomBy` / `zoomToBbox` / `zoomToFit`），
> 所以代码没有依赖它。

---

## 5. 关于 `styles.css` 里的那行 CSS

```css
.canvas-node-content-blocker {
  display: none !important;
}
```

Obsidian 默认在每个节点内容上盖一层透明的 `.canvas-node-content-blocker`，
只有节点「聚焦」后才隐藏它——这就是为什么默认必须**先点一下卡片**才能点到卡片里的链接。
隐藏它之后，卡片内的链接单击即可命中。

副作用与取舍：

- 节点拖拽**不受影响**：画布把 `pointerdown` 监听注册在 `.canvas-wrapper` 的捕获阶段，
  且 `.canvas-wrapper` 自带 `user-select: none`；
- 代价是卡片内容本身（文本选择、内嵌视图里的控件）也变成可交互的。

如果你更想保留拦截层，注释掉这条规则即可——插件会用 `elementsFromPoint`
做「点穿透」命中测试，仍然能找到拦截层下面的链接。

---

## 6. 设置项

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 聚焦缩放 | `1.2` | 聚焦后的缩放倍数 |
| 动画时长 | `350ms` | 限定 300~400ms |
| 接管跨画布链接 | 开 | 是否处理 `[[别的画布.canvas#id]]` |
| 跨画布跳转复用当前标签页 | 开 | 关掉则新标签页打开 |
| 遵循系统“减弱动态效果” | 开 | 开启系统该项时直接跳转，不播动画 |
| 找不到节点时提示 | 关 | ID 不存在时弹 Notice |
| 调试日志 | 关 | 控制台输出语义探测 / 写入方式 / 自校正过程 |
| 渲染显示文字里的 Markdown / 公式 | 开 | 见下方「链接显示文字」 |
| 悬停不弹出笔记预览 | 开 | 鼠标移到卡片链接上不再弹笔记概览 |
| 链接颜色 / 跟随主题、下划线、加粗、斜体、字号、悬停高亮 | — | 只作用于画布卡片内的链接 |
| 画布右上角显示「链接样式」按钮 | 开 | 在画布界面里直接调全局链接样式 |

### 在画布界面里直接改样式（不用进设置页）

**右键卡片里的某一条链接**，菜单里除了 Obsidian 原生的打开 / 复制链接项，还有层级菜单：

```
调整链接文本 ▸
    颜色 ▸  红 / 橙 / 黄 / 绿 / 蓝 / 紫 / 灰 / 默认颜色
            ────
            自定义颜色 / HEX / 存为常用…        ← 打开样式面板
    大小 ▸  字号 80% / 100% / 120% / 150% / 200%
            ────
            自定义大小（滑块 / 百分比）…        ← 打开样式面板
    加粗 / 斜体 / 下划线（勾选）
    清除链接文字样式
    打开样式面板…
复制所在卡片链接
（下面是 Obsidian 原生项）
```

**样式面板**（由上面的「自定义…」「打开样式面板…」，或画布右上角的调色板按钮打开）：

- **颜色**：色板网格（常用色 + 你保存过的自定义色）+ **HEX 输入框**（`#RGB` / `#RRGGBB`），
  可「应用」或「存为常用」；「跟随主题」一键去掉自定义颜色；
- **大小**：**滑块**（50%~300%）+ **百分比数字输入**，拖动即时预览、松手写入；
- **样式**：`B` 加粗 / `I` 斜体 / `U` 下划线 / 清除样式；
- 底部「完成」关闭，另有「完整设置…」直达设置页。

菜单里为什么没有滑块和输入框：Obsidian 的菜单项只能放文字 / 勾选 / 图标，所以需要输入与拖动的
控件都放在这个面板里；菜单负责快速预设，面板负责精细调整。

选中的样式会写进那条链接的**显示文字**里，例如：

```
[[演示.canvas#1a2b…|<span style="color:#e05252;font-size:1.5em;font-weight:700">第 2 页</span>]]
```

- 文本卡片：直接改画布里的文字，`Ctrl+Z` 可撤销；
- 文件卡片（卡片里嵌入的笔记）：改写那张笔记里对应的链接，同样只动这一处；
- 定位不到就**不会**改任何东西，只会提示一句。

**画布右上角还有一个「链接样式」按钮**（调色板图标）：点开可以调全局的链接颜色 / 字号 / 下划线 / 加粗 / 斜体 / 悬停高亮，改完立即生效，最后一项「打开完整设置…」跳到设置页。不想要这个按钮可以在设置里关掉。

**右键卡片本身** → 原生节点菜单里多了一项 `复制卡片链接`，等价于命令面板里的「复制选中画布节点的内部链接」。

### 链接显示文字里可以写公式和格式

`[[链接|显示文字]]` 的显示文字本来是**纯文本**，所以 `$公式$`、`**粗体**` 都只会原样显示。
插件会把「指向画布节点」的链接显示文字按 markdown 重新渲染一次（用 `MarkdownRenderer.render`
配合 `finishRenderMath`），于是这些都能生效：

```
[[演示.canvas#1a2b3c4d5e6f7788|第 2 页  $\frac{a}{b}$]]
[[演示.canvas#1a2b3c4d5e6f7788|**重点页**]]
[[演示.canvas#1a2b3c4d5e6f7788|==高亮页==]]
[[演示.canvas#1a2b3c4d5e6f7788|<span style="color:#e05252;font-weight:700">第 3 页</span>]]
```

关闭「渲染显示文字里的 Markdown / 公式」后，已渲染的链接会立刻恢复成纯文本。

> 注意：如果卡片正处于**编辑状态**，你看到的仍是源码，按 `Esc` 退出编辑即恢复渲染。

### 单个链接单独改颜色 / 样式

- 想**所有**画布卡片里的链接统一改：用设置里的颜色 / 下划线 / 粗细 / 斜体 / 字号；
- 想**某一个**链接单独改：直接把 HTML 写在显示文字里（上面第四个例子），
  或者用主题 CSS 片段覆盖 `.canvas-node-content a.internal-link`。

### 悬停不弹预览

鼠标停在卡片链接上不再弹出笔记概览，只保留点击跳转（默认开启，可在设置里关掉）。
实现方式：Obsidian 的 Page preview 把 `mouseover` 挂在链接元素自身上，且不检查
`defaultPrevented`，所以插件在 document 的捕获阶段截断这个事件——只影响画布卡片里的链接，
普通笔记里的链接悬停预览照旧。

---

## 7. 测试

`npm test` 会在 Node 里模拟 Obsidian 的画布（4 种语义：1.13.7 标准、
缩放被版本压低的版本、旧版“屏幕位移”语义、旧版“线性 zoom”语义），断言：

- 聚焦后节点中心确实落在视口中心、缩放为 1.2；
- 用真实渲染矩阵反算的位置与目标一致；
- 视口在 300~400ms 之间抵达目标、300ms 前不会提前到达、帧数充足、位置单调不回跳、
  且**逐帧**符合 `easeInOutQuad` 插值；
- 缩放对不齐时（例如被版本 clamp）会回滚到最佳状态，不会来回抖；
- 链接解析的 7 种写法。

当前结果：**60 项断言全部通过**（验证环境：Obsidian 1.13.7，插件 API 1.13.1）。

### 安装后的冒烟测试

装进真实仓库后，还对本仓库产出的 `main.js`（与安装到仓库里的文件字节一致）做过一次
“伪 Obsidian 运行时”端到端测试：造一个 `.canvas-wrapper` + `.canvas` 矩阵 + CanvasView，
然后真的派发一次点击事件，断言：

- 命中 `[[画布.canvas#节点ID]]` → 调用 `preventDefault` / `stopPropagation`，且不打开任何标签页；
- 视口最终停在目标节点中心、缩放 1.2、多帧渲染（不是瞬移）；
- **反向**：`[[笔记.md#标题]]`、不存在的节点 ID、`Ctrl+点击` 都不会被劫持；
- `onload` / `onunload` 正常，注册了 click / dblclick / 设置页 / 1 个命令。

---

## 8. 已知限制

- 只在 Canvas 内生效；普通笔记里的链接保持 Obsidian 原生行为。
- 节点 ID 不会变（重命名画布文件不影响），但**删除节点后重建会换 ID**，
  此时旧链接会失效（插件不拦截，交回 Obsidian 原生逻辑）。
- 画布里嵌套画布（canvas embed）时会选择最内层的视口来移动。
