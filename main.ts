/*
 * canvas-smooth-linker
 * ---------------------------------------------------------------------------
 * 让 Obsidian Canvas 里的内部链接获得「PPT 超链接」体验：
 *
 *   点击卡片内的 [[画布名.canvas#目标节点ID|显示文字]]
 *     → 不跳标签页、不进入编辑模式，
 *     → 当前画布视口在 300~400ms 内带缓动地平移 + 缩放，聚焦到目标节点中心。
 *
 * 本文件按 Obsidian 1.13.7 的 Canvas 内部实现（已核对 app bundle）编写，
 * 同时对更早/更晚版本的字段语义做了运行时探测与回退：
 *
 *   1) 视口中心：canvas.x / canvas.y  = 视口中心在「画布坐标系」中的位置
 *                canvas.tx / canvas.ty = 动画目标（同上，画布坐标系）
 *                旧版本里 tx/ty 可能是「屏幕位移」，代码会实测后自动降级处理。
 *   2) 缩放：    canvas.scale = 真实缩放倍数（1 = 100%）
 *                canvas.zoom  = log2(scale)（1.13.7 语义，会被 clamp 到 [-4, 1]）
 *                代码会用 canvas.scale / DOM 变换矩阵交叉验证 zoom 到底是哪种语义。
 *   3) 变换矩阵：.canvas { transform-origin: 0 0;
 *                          transform: translate(W/2, H/2) scale(s) translate(-x, -y); }
 *                即：屏幕坐标(相对画布容器) = (W/2, H/2) + scale * (画布坐标 - 视口中心)
 *   4) 写入 API：setViewport(x, y, zoom) > 属性直写(tx/ty/zoom/scale) > panTo/zoomBy
 *                > 直接写 DOM transform。
 * ---------------------------------------------------------------------------
 */

import {
	App,
	Component,
	EventRef,
	ItemView,
	MarkdownRenderer,
	Menu,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	WorkspaceLeaf,
	finishRenderMath,
	setIcon,
	setTooltip,
} from "obsidian";

/* =========================================================================
 * 1. 数学工具
 * ========================================================================= */

/**
 * 缓动函数：easeInOutQuad
 *   t < 0.5 : 2t²
 *   t ≥ 0.5 : 1 - (-2t + 2)² / 2
 * 输入输出都在 [0, 1]，中间快、两头慢。
 */
export function easeInOutQuad(t: number): number {
	return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export function clamp(value: number, min: number, max: number): number {
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

function isNum(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/* =========================================================================
 * 2. Canvas 容错类型
 *    （Obsidian 官方 d.ts 未导出 CanvasView / Canvas，这里用结构化类型兜住）
 * ========================================================================= */

export interface CanvasBBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/** Canvas 节点：x/y 是节点左上角，width/height 是尺寸（画布坐标系） */
export interface CanvasNodeLike {
	id?: string;
	x: number;
	y: number;
	width: number;
	height: number;
	nodeEl?: HTMLElement;
	getBBox?: () => CanvasBBox;
	/** 节点原始数据（文本卡片有 text，文件卡片有 file） */
	getData?: () => Record<string, unknown>;
	setData?: (data: Record<string, unknown>) => void;
	isEditing?: boolean;
	/** 画布内部的菜单扩展点：原生节点菜单就是在这里拼出来的 */
	showMenu?: (menu: Menu) => void;
}

interface NodeMapLike {
	get(id: string): CanvasNodeLike | undefined;
	has?(id: string): boolean;
	keys?(): IterableIterator<string>;
	values?(): IterableIterator<CanvasNodeLike>;
}

/** Canvas 对象里我们用到的那部分（全部按“可能存在”处理） */
export interface CanvasLike {
	nodes?: NodeMapLike;
	// 视口状态
	x?: number;
	y?: number;
	tx?: number;
	ty?: number;
	zoom?: number;
	tZoom?: number;
	scale?: number;
	zoomCenter?: unknown;
	// DOM
	canvasEl?: HTMLElement;
	wrapperEl?: HTMLElement;
	canvasRect?: { width: number; height: number; cx?: number; cy?: number };
	// 方法
	setViewport?: (x: number, y: number, zoom: number) => void;
	panTo?: (x: number, y: number) => void;
	panBy?: (dx: number, dy: number) => void;
	zoomBy?: (deltaZoom: number, point?: unknown) => void;
	zoomToBbox?: (bbox: CanvasBBox) => void;
	rerenderViewport?: () => void;
	markViewportChanged?: () => void;
	requestFrame?: (time?: number) => void;
	requestSave?: () => void;
	requestPushHistory?: () => void;
	pushHistory?: (data: unknown) => void;
	getData?: () => unknown;
	/** 当前选中的节点集合（Set，内部字段） */
	selection?: unknown;
}

export interface CanvasViewLike {
	file?: TFile | null;
	canvas?: CanvasLike;
	contentEl?: HTMLElement;
	containerEl?: HTMLElement;
	leaf?: { view?: unknown };
	getViewType?: () => string;
}

/** 一条链接的文字样式要写回哪里 */
export type LinkSourceRef =
	| { kind: "text-node"; canvas: CanvasLike; node: CanvasNodeLike }
	| { kind: "note-file"; file: TFile };

/* =========================================================================
 * 3. DOM / 几何工具
 * ========================================================================= */

function getWindowOf(el: Element | null | undefined): Window {
	const doc = el?.ownerDocument ?? document;
	return doc.defaultView ?? window;
}

/** 解析 getComputedStyle(el).transform 得到的矩阵：matrix(a,b,c,d,e,f) 或 matrix3d(...) */
function parseCssMatrix(value: string): { scale: number; tx: number; ty: number } | null {
	if (!value || value === "none") return null;
	const text = value.trim();

	const m2 = /^matrix\(([^)]+)\)$/.exec(text);
	if (m2) {
		const p = m2[1].split(",").map((s) => Number.parseFloat(s));
		if (p.length >= 6 && p.every((n) => Number.isFinite(n))) {
			return { scale: p[0], tx: p[4], ty: p[5] };
		}
		return null;
	}

	const m3 = /^matrix3d\(([^)]+)\)$/.exec(text);
	if (m3) {
		const p = m3[1].split(",").map((s) => Number.parseFloat(s));
		if (p.length >= 16 && p.every((n) => Number.isFinite(n))) {
			return { scale: p[0], tx: p[12], ty: p[13] };
		}
	}
	return null;
}

/**
 * 从 DOM 里实测当前画布变换。
 * 由于 .canvas 是 transform-origin: 0 0，
 * 矩阵 [a,0,0,a,e,f] 中的 a 就是缩放倍数，(e,f) 是「画布原点」在容器里的屏幕位置。
 */
function measureCanvasTransform(canvasEl: HTMLElement | null | undefined): { scale: number; tx: number; ty: number } | null {
	if (!canvasEl || typeof getComputedStyle !== "function") return null;
	try {
		const matrix = parseCssMatrix(getComputedStyle(canvasEl).transform);
		if (!matrix || !(matrix.scale > 0)) return null;
		return matrix;
	} catch {
		return null;
	}
}

/** 画布可视区（.canvas-wrapper）的尺寸 */
function getWrapperSize(canvas: CanvasLike): { width: number; height: number } {
	const wrapper = canvas.wrapperEl;
	if (wrapper) {
		const rect = wrapper.getBoundingClientRect();
		if (rect.width > 0 && rect.height > 0) return { width: rect.width, height: rect.height };
		if (wrapper.clientWidth > 0 && wrapper.clientHeight > 0) {
			return { width: wrapper.clientWidth, height: wrapper.clientHeight };
		}
	}
	const fallback = canvas.canvasRect;
	if (fallback && isNum(fallback.width) && isNum(fallback.height) && fallback.width > 0) {
		return { width: fallback.width, height: fallback.height };
	}
	const canvasRect = canvas.canvasEl?.getBoundingClientRect();
	if (canvasRect && canvasRect.width > 0 && canvasRect.height > 0) {
		return { width: canvasRect.width, height: canvasRect.height };
	}
	return { width: 0, height: 0 };
}

/** 等待 n 个动画帧（用于等 Obsidian 自己的 rAF 把 transform 写进 DOM） */
function nextFrames(win: Window, count: number): Promise<void> {
	return new Promise((resolve) => {
		let left = Math.max(1, count);
		const tick = () => {
			left -= 1;
			if (left <= 0) resolve();
			else win.requestAnimationFrame(tick);
		};
		win.requestAnimationFrame(tick);
	});
}

function setNumberProp(target: Record<string, unknown>, key: string, value: number): boolean {
	try {
		if (!(key in target) && !Object.isExtensible(target)) return false;
		target[key] = value;
		return true;
	} catch {
		return false;
	}
}

function isElementLike(value: unknown): value is HTMLElement {
	return !!value && typeof value === "object" && typeof (value as HTMLElement).tagName === "string";
}

/**
 * 链接显示文字（别名）里出现这些记号时，说明用户想让它变成 markdown / 公式 / HTML，
 * 我们才做“重渲染”，否则保持原样（零开销）。
 */
const ALIAS_MARKDOWN_HINT = /(\*\*|\*|__|_|~~|==|\$|`|<|\[)/;

/* =========================================================================
 * 4. 链接解析
 * ========================================================================= */

export interface ParsedCanvasNodeLink {
	/** data-href / href 原文（已去掉 |显示文字） */
	linktext: string;
	/** # 之前的文件部分，空字符串表示「当前画布」 */
	path: string;
	/** # 之后的原始子路径 */
	subpath: string;
	/** 解析出的节点 ID（可能是 null） */
	nodeId: string | null;
}

/**
 * 从 <a class="internal-link" data-href="..."> 上解析出画布节点链接。
 * 兼容：[[画布.canvas#id]] / [[画布.canvas#^id]] / [[#id]] / [[画布.canvas#id|文字]]
 *
 * 注意：画布节点 ID 是类似 "1f2e3d4c5b6a7988" 的十六进制串，
 * 其中不会出现空格；如果 # 后面带空格，那更像是标题/块引用，直接放弃接管。
 */
export function parseCanvasNodeLink(anchor: Element): ParsedCanvasNodeLink | null {
	const raw = anchor.getAttribute("data-href") ?? anchor.getAttribute("href");
	if (!raw) return null;

	let decoded = raw.trim();
	try {
		decoded = decodeURIComponent(decoded);
	} catch {
		/* 解码失败就用原文 */
	}
	if (!decoded) return null;

	const withoutAlias = decoded.split("|")[0];
	const hashIndex = withoutAlias.indexOf("#");
	const path = (hashIndex === -1 ? withoutAlias : withoutAlias.slice(0, hashIndex)).trim();
	const subpath = (hashIndex === -1 ? "" : withoutAlias.slice(hashIndex + 1)).trim();

	return {
		linktext: withoutAlias,
		path,
		subpath,
		nodeId: normalizeNodeId(subpath),
	};
}

function normalizeNodeId(subpath: string): string | null {
	let id = subpath.trim();
	if (!id) return null;
	// 容错：有人会写成 [[画布.canvas#^nodeid]]
	if (id.startsWith("^")) id = id.slice(1).trim();
	if (!id) return null;
	// 含空格 → 不是节点 ID（节点 ID 为 16 位十六进制）
	if (/\s/.test(id)) return null;
	return id;
}

/* =========================================================================
 * 4b. 链接文字样式：读写别名里的 <span style="…">
 *      Obsidian 没有“每个链接的样式字段”，能跟着文件走的只有内容本身，
 *      所以单链接样式就写成别名里的一段 HTML。
 * ========================================================================= */

export interface LinkStyleSpec {
	/** null = 不设置（跟随主题） */
	color: string | null;
	/** 字号倍数，null = 不缩放 */
	scale: number | null;
	bold: boolean;
	italic: boolean;
	/** null = 不设置 */
	underline: boolean | null;
}

export const COLOR_PRESETS: Array<{ name: string; value: string | null }> = [
	{ name: "红", value: "#e05252" },
	{ name: "橙", value: "#e08a3c" },
	{ name: "黄", value: "#d4a72c" },
	{ name: "绿", value: "#3aa66b" },
	{ name: "蓝", value: "#3c78d8" },
	{ name: "紫", value: "#8b5cf6" },
	{ name: "灰", value: "#8a8a8a" },
	{ name: "默认颜色", value: null },
];

export const SIZE_PRESETS: Array<{ name: string; value: number | null }> = [
	{ name: "80%", value: 0.8 },
	{ name: "100%", value: 1 },
	{ name: "120%", value: 1.2 },
	{ name: "150%", value: 1.5 },
	{ name: "200%", value: 2 },
];

const EMPTY_LINK_STYLE: LinkStyleSpec = {
	color: null,
	scale: null,
	bold: false,
	italic: false,
	underline: null,
};

const OUTER_SPAN_RE = /^<span\s+style="([^"]*)"\s*>([\s\S]*)<\/span>$/i;

/** 解析别名 HTML：认出最外层那层 <span style="…">，其余部分当纯文字 */
export function parseAliasStyle(aliasHtml: string): { style: LinkStyleSpec; text: string; wrapped: boolean } {
	const trimmed = aliasHtml.trim();
	const match = OUTER_SPAN_RE.exec(trimmed);
	if (!match) {
		return { style: { ...EMPTY_LINK_STYLE }, text: aliasHtml, wrapped: false };
	}

	const css = match[1];
	const style: LinkStyleSpec = { ...EMPTY_LINK_STYLE };

	const color = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(css);
	if (color) style.color = color[1].trim();

	const size = /(?:^|;)\s*font-size\s*:\s*([\d.]+)em/i.exec(css);
	if (size) {
		const value = Number.parseFloat(size[1]);
		if (Number.isFinite(value)) style.scale = value;
	}

	style.bold = /(?:^|;)\s*font-weight\s*:\s*(?:bold|[6-9]00)/i.test(css);
	style.italic = /(?:^|;)\s*font-style\s*:\s*italic/i.test(css);
	if (/(?:^|;)\s*text-decoration(?:-line)?\s*:\s*underline/i.test(css)) style.underline = true;
	else if (/(?:^|;)\s*text-decoration(?:-line)?\s*:\s*none/i.test(css)) style.underline = false;

	return { style, text: match[2], wrapped: true };
}

/** 把样式合成为别名 HTML；没有任何样式时返回纯文字 */
export function composeAliasHtml(text: string, style: LinkStyleSpec): string {
	const parts: string[] = [];
	if (style.color) parts.push(`color:${style.color}`);
	if (style.scale && Math.abs(style.scale - 1) > 0.001) parts.push(`font-size:${style.scale}em`);
	if (style.bold) parts.push("font-weight:700");
	if (style.italic) parts.push("font-style:italic");
	if (style.underline === true) parts.push("text-decoration:underline");
	if (style.underline === false) parts.push("text-decoration:none");
	if (parts.length === 0) return text;
	return `<span style="${parts.join(";")}">${text}</span>`;
}

export function isLinkStyleEmpty(style: LinkStyleSpec): boolean {
	const scaled = !!style.scale && Math.abs(style.scale - 1) > 0.001;
	return !style.color && !scaled && !style.bold && !style.italic && style.underline === null;
}

export interface LinkSourceMatch {
	start: number;
	/** 结束下标（不含） */
	end: number;
	/** 原始显示文字；null 表示源码里是 [[链接]] 而没有别名 */
	rawAlias: string | null;
	syntax: "wiki" | "markdown";
}

/**
 * 在 markdown 源码里定位一条内部链接（只按 href 精确匹配，不改动其它内容）。
 * 支持 [[路径#节点ID|别名]] 与 [别名](路径#节点ID) 两种写法。
 */
export function findLinkInSource(source: string, href: string): LinkSourceMatch | null {
	// wikilink
	const wikiNeedle = `[[${href}`;
	let index = source.indexOf(wikiNeedle);
	while (index !== -1) {
		const afterPath = index + wikiNeedle.length;
		const closer = source.indexOf("]]", afterPath);
		if (closer !== -1) {
			const middle = source.slice(afterPath, closer);
			if (middle === "") {
				return { start: index, end: closer + 2, rawAlias: null, syntax: "wiki" };
			}
			if (middle.startsWith("|")) {
				return { start: index, end: closer + 2, rawAlias: middle.slice(1), syntax: "wiki" };
			}
		}
		index = source.indexOf(wikiNeedle, index + 1);
	}

	// markdown 链接 [别名](href)
	const mdTail = `](${href})`;
	const tailIndex = source.indexOf(mdTail);
	if (tailIndex !== -1) {
		const open = source.lastIndexOf("[", tailIndex);
		if (open !== -1) {
			return { start: open, end: tailIndex + mdTail.length, rawAlias: source.slice(open + 1, tailIndex), syntax: "markdown" };
		}
	}
	return null;
}

/** 拼回链接源码；alias 传 null 表示不带别名（仅 wikilink） */
export function buildLinkText(href: string, syntax: "wiki" | "markdown", alias: string | null): string {
	if (syntax === "wiki") return alias === null ? `[[${href}]]` : `[[${href}|${alias}]]`;
	return `[${alias ?? href}](${href})`;
}

/** Menu.addSections 未出现在官方 d.ts 里，这里做存在性保护后再用 */
function forceMenuSections(menu: Menu, sections: string[]): void {
	const api = menu as unknown as { addSections?: (sections: string[]) => Menu };
	try {
		api.addSections?.(sections);
	} catch {
		/* 不支持就用默认顺序，插件项会排在最后，不影响使用 */
	}
}

/**
 * 子菜单：Obsidian 内部有 MenuItem.setSubmenu()（它自己的「格式」菜单就用这个），
 * 但没写在公开 d.ts 里 —— 所以这里做存在性保护。
 */
function createSubmenu(item: unknown): Menu | null {
	const api = item as { setSubmenu?: () => Menu };
	try {
		return typeof api.setSubmenu === "function" ? api.setSubmenu() : null;
	} catch {
		return null;
	}
}

/** 菜单项标题里塞一个真正的色块（setTitle 支持 DocumentFragment） */
function colorSwatchTitle(color: string | null, label: string): DocumentFragment {
	const fragment = document.createDocumentFragment();
	const swatch = document.createElement("span");
	swatch.className = "csl-swatch csl-swatch-inline";
	if (color) swatch.style.background = color;
	else swatch.classList.add("is-theme");
	fragment.appendChild(swatch);
	fragment.appendChild(document.createTextNode(` ${label}`));
	return fragment;
}

/** #abc / #aabbcc / abc 都接受，统一成 #aabbcc */
export function normalizeHexColor(input: string): string | null {
	const raw = input.trim().replace(/^#/, "");
	if (/^[0-9a-fA-F]{3}$/.test(raw)) {
		const expanded = raw
			.split("")
			.map((c) => c + c)
			.join("");
		return `#${expanded.toLowerCase()}`;
	}
	if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
	return null;
}

/* =========================================================================
 * 5. 视口读写（版本容错核心）
 * ========================================================================= */

export interface ViewportTarget {
	/** 视口中心在画布坐标系中的 X */
	centerX: number;
	/** 视口中心在画布坐标系中的 Y */
	centerY: number;
	/** 真实缩放倍数，1 = 100% */
	scale: number;
}

export interface ViewportSnapshot extends ViewportTarget {
	/** canvas.zoom 是否为 log2(scale) 语义 */
	zoomIsLog2: boolean;
	/** canvas.x/.y 是否为「画布坐标系下的视口中心」（false → 只能走 DOM 直写） */
	centerInCanvasCoords: boolean;
}

const MIN_SCALE = Math.pow(2, -4); // 1/16，与 Obsidian 的 clamp 一致
const MAX_SCALE = Math.pow(2, 1); // 2

/** 判断 zoom 字段是 log2(scale) 还是 scale 本身 */
function detectZoomIsLog2(canvas: CanvasLike, measuredScale: number | null): boolean {
	const zoom = canvas.zoom;
	const scaleField = canvas.scale;
	const reference = isNum(scaleField) && scaleField > 0 ? scaleField : measuredScale;

	if (isNum(zoom) && isNum(reference) && reference > 0) {
		const asLog2 = Math.abs(Math.pow(2, zoom) - reference);
		const asLinear = Math.abs(zoom - reference);
		const tol = Math.max(0.002, reference * 0.01);
		if (asLog2 <= tol && asLinear > tol) return true;
		if (asLinear <= tol && asLog2 > tol) return false;
	}

	// 1.13.7 起 zoom 会被 clamp 到 [-4, 1]，超过这个范围不可能是 log2 语义
	if (isNum(zoom) && (zoom < -4.001 || zoom > 1.001)) return false;

	// 有 setViewport 的版本（1.13.x）一定是 log2 语义
	if (typeof canvas.setViewport === "function") return true;

	return true;
}

/**
 * 读取当前视口状态：
 *   - 优先用 canvas.x/.y/.scale/.zoom 字段
 *   - 并用 DOM 实测矩阵交叉验证（防止版本差异导致字段语义不同）
 */
export function readViewport(canvas: CanvasLike): ViewportSnapshot | null {
	const size = getWrapperSize(canvas);
	const dom = measureCanvasTransform(canvas.canvasEl);
	const zoomIsLog2 = detectZoomIsLog2(canvas, dom ? dom.scale : null);

	// ---- scale ----
	let scale: number | null = null;
	if (isNum(canvas.scale) && canvas.scale > 0) scale = canvas.scale;
	else if (isNum(canvas.zoom)) scale = zoomIsLog2 ? Math.pow(2, canvas.zoom) : canvas.zoom;
	else if (dom) scale = dom.scale;
	if (!scale || !Number.isFinite(scale) || scale <= 0) return null;

	// ---- 视口中心 ----
	let centerX = isNum(canvas.x) ? canvas.x : null;
	let centerY = isNum(canvas.y) ? canvas.y : null;
	let centerInCanvasCoords = true;

	const domCenter =
		dom && size.width > 0 && size.height > 0
			? {
					x: (size.width / 2 - dom.tx) / dom.scale,
					y: (size.height / 2 - dom.ty) / dom.scale,
			  }
			: null;

	if (centerX !== null && centerY !== null && dom && domCenter) {
		const tolX = Math.max(4, Math.abs(domCenter.x) * 0.05);
		const tolY = Math.max(4, Math.abs(domCenter.y) * 0.05);
		const matchesCenter =
			Math.abs(centerX - domCenter.x) <= tolX && Math.abs(centerY - domCenter.y) <= tolY;
		// 旧版本里 x/y 可能是「画布原点在屏幕上的位移」，此时它们应当等于矩阵的 (e, f)
		const matchesOffset = Math.abs(centerX - dom.tx) <= 4 && Math.abs(centerY - dom.ty) <= 4;

		if (matchesCenter) {
			centerInCanvasCoords = true;
		} else if (matchesOffset) {
			centerInCanvasCoords = false;
			centerX = domCenter.x;
			centerY = domCenter.y;
		} else {
			// 两个都对不上：多半是动画途中取到的“过时一帧”的 DOM 值，
			// 不能据此判定语义 → 按 1.13.x 的“视口中心”语义继续，并信任字段值。
			centerInCanvasCoords = true;
		}
	} else if (centerX === null || centerY === null) {
		centerInCanvasCoords = false;
		centerX = domCenter ? domCenter.x : 0;
		centerY = domCenter ? domCenter.y : 0;
	}

	return { centerX, centerY, scale, zoomIsLog2, centerInCanvasCoords };
}

export type ViewportWriteMethod = "setViewport" | "properties" | "panTo" | "domTransform" | "none";

function refreshCanvas(canvas: CanvasLike): void {
	if (typeof canvas.markViewportChanged === "function") {
		canvas.markViewportChanged();
		return;
	}
	if (typeof canvas.requestFrame === "function") canvas.requestFrame();
}

/**
 * 把视口写到目标状态，逐级回退：
 *   ① canvas.setViewport(cx, cy, zoom)        —— 1.13.x 官方入口
 *   ② 直接写 canvas.tx/.ty/.x/.y/.zoom/.tZoom —— 字段直写 + 触发重绘
 *   ③ canvas.panTo(cx, cy) + canvas.zoomBy()  —— 老版本组合
 *   ④ canvasEl.style.transform = ...          —— 最后兜底，直接写 DOM
 *
 * 动画每帧都会调用它，所以这里不做任何“动画”，只负责“落值”。
 */
export function writeViewport(canvas: CanvasLike, snapshot: ViewportSnapshot, target: ViewportTarget): ViewportWriteMethod {
	const size = getWrapperSize(canvas);
	const record = canvas as unknown as Record<string, unknown>;

	// 目标缩放先夹进 Obsidian 的合法区间，避免内部 clamp 造成抖动
	const scale = clamp(target.scale, MIN_SCALE, MAX_SCALE);
	const zoomValue = snapshot.zoomIsLog2 ? clamp(Math.log2(scale), -4, 1) : scale;

	// 清掉 canvas 内部「围绕某点缩放」的残留（滚轮缩放会写 zoomCenter）
	if ("zoomCenter" in record) record.zoomCenter = null;

	// ---- ① setViewport(x, y, zoom)：x/y 为画布坐标下的视口中心 ----
	if (snapshot.centerInCanvasCoords && typeof canvas.setViewport === "function") {
		canvas.setViewport(target.centerX, target.centerY, zoomValue);
		return "setViewport";
	}

	// ---- ② 字段直写 ----
	if (snapshot.centerInCanvasCoords) {
		let wrote = false;
		wrote = setNumberProp(record, "tx", target.centerX) || wrote;
		wrote = setNumberProp(record, "ty", target.centerY) || wrote;
		wrote = setNumberProp(record, "x", target.centerX) || wrote;
		wrote = setNumberProp(record, "y", target.centerY) || wrote;
		wrote = setNumberProp(record, "zoom", zoomValue) || wrote;
		wrote = setNumberProp(record, "tZoom", zoomValue) || wrote;
		wrote = setNumberProp(record, "scale", scale) || wrote;
		if (wrote) {
			refreshCanvas(canvas);
			return "properties";
		}
	}

	// ---- ③ panTo / zoomBy ----
	if (typeof canvas.panTo === "function") {
		canvas.panTo(target.centerX, target.centerY);
		if (typeof canvas.zoomBy === "function" && isNum(canvas.zoom)) {
			// zoomBy 接收的是 log2 增量（1.13.x）
			const currentLog2 = snapshot.zoomIsLog2 ? canvas.zoom : Math.log2(snapshot.scale);
			canvas.zoomBy(zoomValue - currentLog2);
		}
		refreshCanvas(canvas);
		return "panTo";
	}

	// ---- ④ 直接写 DOM transform（只保证“看起来对”） ----
	const canvasEl = canvas.canvasEl;
	if (canvasEl && size.width > 0 && size.height > 0) {
		// translate(W/2, H/2) scale(s) translate(-cx, -cy)
		//   ≡ translate(W/2 - cx*s, H/2 - cy*s) scale(s)
		const offsetX = size.width / 2 - target.centerX * scale;
		const offsetY = size.height / 2 - target.centerY * scale;
		canvasEl.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;

		// 让内部状态跟上，且遵循探测到的语义：
		//   - 字段是「视口中心」→ 写画布坐标
		//   - 字段是「屏幕位移」→ 写位移，这样该版本自己重绘时也是同一个结果
		const fieldX = snapshot.centerInCanvasCoords ? target.centerX : offsetX;
		const fieldY = snapshot.centerInCanvasCoords ? target.centerY : offsetY;
		setNumberProp(record, "tx", fieldX);
		setNumberProp(record, "ty", fieldY);
		setNumberProp(record, "x", fieldX);
		setNumberProp(record, "y", fieldY);
		setNumberProp(record, "zoom", zoomValue);
		setNumberProp(record, "tZoom", zoomValue);
		setNumberProp(record, "scale", scale);
		// 有些版本的 x/y 只是渲染用的中间状态，真正的绘制由它自己的重绘触发
		refreshCanvas(canvas);
		return "domTransform";
	}

	return "none";
}

/* =========================================================================
 * 6. 设置
 * ========================================================================= */

interface CanvasSmoothLinkerSettings {
	/** 聚焦时的目标缩放（1 = 100%） */
	targetZoom: number;
	/** 动画时长（毫秒），按需求限制在 300~400ms */
	animationDuration: number;
	/** 是否接管跨画布的 [[其它画布.canvas#节点]] 链接 */
	interceptCrossCanvasLinks: boolean;
	/** 跨画布跳转时是否复用当前标签页（PPT 幻灯片的观感） */
	crossCanvasOpenInCurrentTab: boolean;
	/** 是否遵循系统的“减弱动态效果” */
	respectReducedMotion: boolean;
	/** 找不到目标节点时是否提示 */
	showNoticeOnMissingNode: boolean;
	/** 输出调试日志 */
	debug: boolean;
	/** 渲染链接显示文字里的 Markdown / 数学公式 / 内联 HTML */
	renderAliasMarkdown: boolean;
	/** 悬停在画布卡片链接上时不弹出笔记预览 */
	suppressHoverPreview: boolean;
	/** 链接颜色是否跟随主题（关掉后用 linkColor） */
	linkUseThemeColor: boolean;
	/** 自定义链接颜色 */
	linkColor: string;
	/** 链接下划线 */
	linkUnderline: boolean;
	/** 链接加粗 */
	linkBold: boolean;
	/** 链接斜体 */
	linkItalic: boolean;
	/** 链接字号倍数 */
	linkFontScale: number;
	/** 悬停时是否加背景高亮 */
	linkHoverBackground: boolean;
	/** 是否在画布右上角显示「链接样式」按钮 */
	showCanvasStyleButton: boolean;
	/** 自己调出来并保存的常用色（HEX） */
	customColors: string[];
}

const DEFAULT_SETTINGS: CanvasSmoothLinkerSettings = {
	targetZoom: 1.2,
	animationDuration: 350,
	interceptCrossCanvasLinks: true,
	crossCanvasOpenInCurrentTab: true,
	respectReducedMotion: true,
	showNoticeOnMissingNode: false,
	debug: false,
	renderAliasMarkdown: true,
	suppressHoverPreview: true,
	linkUseThemeColor: true,
	linkColor: "#7f6df2",
	linkUnderline: true,
	linkBold: false,
	linkItalic: false,
	linkFontScale: 1,
	linkHoverBackground: true,
	showCanvasStyleButton: true,
	customColors: [],
};

/* =========================================================================
 * 7. 插件主体
 * ========================================================================= */

export default class CanvasSmoothLinkerPlugin extends Plugin {
	settings: CanvasSmoothLinkerSettings = { ...DEFAULT_SETTINGS };

	/** 自增令牌：新的跳转 / 用户手动操作都会作废正在播放的动画 */
	private animationToken = 0;
	/** 当前正在播放动画的目标，用于吞掉重复的 click / dblclick */
	private activeTarget: { path: string; nodeId: string } | null = null;
	private pendingTimers = new Set<number>();
	/** 每个画布容器的 MutationObserver：内容变化时重渲染链接别名里的公式/格式 */
	private canvasObservers = new Map<Element, MutationObserver>();
	private aliasRefreshHandle = 0;
	private aliasRefreshWin: Window | null = null;
	private pendingAliasWrappers = new Set<Element>();
	/** 每个被重渲染过的链接一个 Component，元素离开 DOM 后连带卸载，避免长会话里越积越多 */
	private aliasComponents = new Map<HTMLAnchorElement, Component>();
	/** 同一次右键只处理一遍（Menu.forEvent 本身也按事件缓存，重复调用会拿到同一个菜单） */
	private handledContextMenus = new WeakSet<Event>();

	async onload(): Promise<void> {
		await this.loadSettings();

		// 需求要求：监听全局 document click。
		// 用「捕获阶段」监听，才能在 Obsidian / 内嵌视图自己的 click 处理器之前拿到事件，
		// 从而 preventDefault + stopPropagation 阻止“跳转标签页 / 进入编辑模式”。
		this.registerDomEvent(document, "click", this.onDocumentClick, { capture: true });
		// 双击卡片里的链接时，Obsidian 会尝试进入编辑模式，这里一并接管。
		this.registerDomEvent(document, "dblclick", this.onDocumentClick, { capture: true });

		// 弹出式窗口（popout）里的画布同样接管。
		const workspaceEvents = this.app.workspace as unknown as {
			on(name: string, callback: (...args: unknown[]) => void): EventRef;
		};
		this.registerEvent(workspaceEvents.on("window-open", this.onWindowOpen));

		// 悬停预览：Page preview（核心插件）在链接元素自身上挂了 mouseover，
		// 并在那里触发 hover-link；其中并不检查 defaultPrevented，
		// 所以只能在捕获阶段截断事件流，让它根本收不到这个事件。
		this.registerDomEvent(document, "mouseover", this.onDocumentMouseOver, { capture: true });
		// 兜底：万一某个版本改成检查 hover-link 事件的 preventDefault
		this.registerEvent(workspaceEvents.on("hover-link", this.onHoverLink));
		// 右键画布卡片里的链接 → 链接样式菜单（含原生菜单项）
		this.registerDomEvent(document, "contextmenu", this.onDocumentContextMenu, { capture: true });

		// 画布重新布局 / 切换视图时，重新扫一遍画布里的链接
		this.registerEvent(this.app.workspace.on("layout-change", this.onLayoutChange));
		this.registerEvent(this.app.workspace.on("active-leaf-change", this.onLayoutChange));

		this.addSettingTab(new CanvasSmoothLinkerSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			this.applyAppearance();
			this.syncCanvasObservers();
			this.syncCanvasUi();
		});

		// 便捷命令：把选中节点的内部链接复制到剪贴板。
		// 手写 [[画布.canvas#节点ID]] 时不用再去翻 canvas 文件找 ID。
		this.addCommand({
			id: "copy-selected-node-link",
			name: "复制选中画布节点的内部链接",
			checkCallback: (checking: boolean) => {
				const context = this.getActiveCanvasContext();
				if (!context || !context.view.file) return false;
				const nodes = this.getSelectedNodes(context.canvas);
				if (nodes.length === 0) return false;
				if (!checking) void this.copyNodeLink(context.view, nodes[0]);
				return true;
			},
		});

		if (this.settings.debug) console.debug("[canvas-smooth-linker] loaded");
	}

	private onWindowOpen = (...args: unknown[]): void => {
		for (const arg of args) {
			const doc = (arg as { document?: Document } | null)?.document;
			if (doc && typeof doc.addEventListener === "function") {
				this.registerDomEvent(doc, "click", this.onDocumentClick, { capture: true });
				this.registerDomEvent(doc, "dblclick", this.onDocumentClick, { capture: true });
				this.registerDomEvent(doc, "mouseover", this.onDocumentMouseOver, { capture: true });
				this.registerDomEvent(doc, "contextmenu", this.onDocumentContextMenu, { capture: true });
				this.applyAppearance();
				this.syncCanvasObservers();
				this.syncCanvasUi();
			}
		}
	};

	onunload(): void {
		this.animationToken += 1;
		for (const id of this.pendingTimers) window.clearTimeout(id);
		this.pendingTimers.clear();
		for (const observer of this.canvasObservers.values()) observer.disconnect();
		this.canvasObservers.clear();
		this.pendingAliasWrappers.clear();
		this.releaseAllAliasComponents();
		this.closeStylePanel();
		// 用当初申请时那个窗口来取消（弹出窗口的 rAF 句柄要在它自己的窗口里取消）
		if (this.aliasRefreshHandle && this.aliasRefreshWin) {
			this.aliasRefreshWin.cancelAnimationFrame(this.aliasRefreshHandle);
		}
		this.aliasRefreshHandle = 0;
		this.aliasRefreshWin = null;
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** 设置面板改动后立刻生效：外观 CSS 变量 + 链接显示文字的重渲染 / 还原 */
	async applySettingsToUI(): Promise<void> {
		this.applyAppearance();

		if (this.settings.renderAliasMarkdown) {
			this.syncCanvasObservers();
			for (const wrapper of Array.from(this.canvasObservers.keys())) this.scheduleAliasRefresh(wrapper);
			return;
		}

		// 关闭该功能：断开观察者，并把已经重渲染的链接恢复成原始纯文本
		const knownWrappers = Array.from(this.canvasObservers.keys());
		for (const observer of this.canvasObservers.values()) observer.disconnect();
		this.canvasObservers.clear();
		this.pendingAliasWrappers.clear();
		this.releaseAllAliasComponents();

		const scopes: Array<Element | Document> = [...knownWrappers, ...this.collectDocuments()];
		for (const scope of scopes) {
			for (const el of Array.from(scope.querySelectorAll("a[data-csl-src]"))) {
				const anchor = el as HTMLAnchorElement;
				const source = anchor.dataset.cslSrc;
				if (source === undefined) continue;
				anchor.textContent = source;
				delete anchor.dataset.cslSrc;
			}
		}
	}

	private log(...args: unknown[]): void {
		if (this.settings.debug) console.debug("[canvas-smooth-linker]", ...args);
	}

	private wait(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const id = window.setTimeout(() => {
				this.pendingTimers.delete(id);
				resolve();
			}, ms);
			this.pendingTimers.add(id);
		});
	}

	/* ---------------------------------------------------------------------
	 * 7.1 点击入口
	 * ------------------------------------------------------------------- */

	private onDocumentClick = (evt: MouseEvent): void => {
		if (evt.defaultPrevented) return;
		if (evt.button !== 0) return; // 只处理左键
		// 带修饰键时保留 Obsidian 原生行为（新标签页 / 新窗口 / 分屏）
		if (evt.ctrlKey || evt.metaKey || evt.altKey || evt.shiftKey) return;

		const anchor = this.findCanvasLinkAnchor(evt);
		if (!anchor) return;

		const parsed = parseCanvasNodeLink(anchor);
		if (!parsed || !parsed.nodeId) return;

		const view = this.findCanvasViewForElement(anchor);
		const canvas = view ? this.getCanvasObject(view) : null;
		if (!view || !canvas) return;

		const currentFile = view.file ?? null;
		if (!currentFile) return;

		// 目标是哪个画布文件？
		let targetFile: TFile | null = currentFile;
		if (parsed.path) {
			targetFile = this.app.metadataCache.getFirstLinkpathDest(parsed.path, currentFile.path);
		} else {
			// [[#节点ID]] → 当前画布
			targetFile = currentFile;
		}
		// 只接管 .canvas 链接，其它内部链接完全交还 Obsidian
		if (!targetFile || targetFile.extension !== "canvas") return;

		const sameCanvas = targetFile.path === currentFile.path;

		if (sameCanvas) {
			const node = this.getNodeById(canvas, parsed.nodeId);
			if (!node) {
				this.log("当前画布中找不到节点", parsed.nodeId);
				if (this.settings.showNoticeOnMissingNode) {
					new Notice(`canvas-smooth-linker: 画布中找不到节点 ${parsed.nodeId}`);
				}
				return; // 交给 Obsidian 原生逻辑处理
			}

			// 关键：阻止原生跳转 / 编辑模式
			evt.preventDefault();
			evt.stopPropagation();

			if (this.isActiveTarget(targetFile.path, parsed.nodeId)) return;
			void this.focusNode(canvas, node, targetFile.path, parsed.nodeId);
			return;
		}

		// ---- 跨画布链接 ----
		if (!this.settings.interceptCrossCanvasLinks) return;
		evt.preventDefault();
		evt.stopPropagation();
		void this.jumpToOtherCanvas(view, targetFile, parsed.nodeId);
	};

	/**
	 * 找出本次点击真正落在的 canvas 内部链接。
	 *
	 * 情况 A：styles.css 隐藏了 .canvas-node-content-blocker，点击可以直接命中 <a>。
	 * 情况 B：拦截层还在最上层（用户删掉了那段 CSS），此时用 elementsFromPoint 做
	 *        “点穿透”命中测试，依然能找到拦截层下面的 <a>。
	 */
	private findCanvasLinkAnchor(evt: MouseEvent): HTMLAnchorElement | null {
		const target = isElementLike(evt.target) ? evt.target : null;
		const direct = this.findCanvasLinkElement(target);
		if (direct) return direct;

		const doc = evt.view?.document ?? (target ? target.ownerDocument : document);
		const elementsFromPoint = (doc as Document & {
			elementsFromPoint?: (x: number, y: number) => Element[];
		}).elementsFromPoint;
		if (typeof elementsFromPoint !== "function") return null;

		let stack: Element[];
		try {
			stack = elementsFromPoint.call(doc, evt.clientX, evt.clientY);
		} catch {
			return null;
		}
		for (const el of stack) {
			const anchor = this.findCanvasLinkElement(el);
			if (anchor) return anchor;
		}
		return null;
	}

	/**
	 * 从元素往上找「画布里的链接元素」。
	 * 同时认 wikilink（a.internal-link）与 markdown 链接（a[data-href]）。
	 */
	private findCanvasLinkElement(target: Element | null): HTMLAnchorElement | null {
		if (!target || typeof target.closest !== "function") return null;
		for (const selector of ["a.internal-link", "a[data-href]"]) {
			const hit = target.closest(selector);
			if (hit && isElementLike(hit) && hit.tagName === "A" && this.isInsideCanvas(hit)) {
				return hit as HTMLAnchorElement;
			}
		}
		return null;
	}

	private isInsideCanvas(el: Element): boolean {
		return !!el.closest(".canvas-wrapper");
	}

	/* ---------------------------------------------------------------------
	 * 7.1b 悬停不弹预览 + 链接显示文字支持 markdown / 公式
	 * ------------------------------------------------------------------- */

	/**
	 * 悬停在画布卡片链接上时不弹出笔记预览。
	 * Page preview 把 mouseover 挂在链接元素自身，且在捕获阶段截断事件流最可靠。
	 */
	private onDocumentMouseOver = (evt: MouseEvent): void => {
		if (!this.settings.suppressHoverPreview) return;
		const target = isElementLike(evt.target) ? evt.target : null;
		if (!this.findCanvasLinkElement(target)) return;
		evt.stopPropagation();
	};

	/** 兜底：若某版本改为检查 hover-link 事件的 preventDefault，这里同样能拦住。 */
	private onHoverLink = (evt: unknown): void => {
		if (!this.settings.suppressHoverPreview) return;
		const record = evt as { preventDefault?: () => void; targetEl?: Element | null } | null;
		if (!record || typeof record !== "object") return;
		const targetEl = record.targetEl ?? null;
		if (!targetEl || !this.isInsideCanvas(targetEl)) return;
		if (typeof record.preventDefault === "function") record.preventDefault();
	};

	private onLayoutChange = (): void => {
		this.syncCanvasObservers();
		this.syncCanvasUi();
	};

	/** 给每个画布容器挂一个 MutationObserver（同一个容器只挂一次） */
	private syncCanvasObservers(): void {
		if (!this.settings.renderAliasMarkdown) return;
		for (const doc of this.collectDocuments()) {
			let wrappers: Element[];
			try {
				wrappers = Array.from(doc.querySelectorAll(".canvas-wrapper"));
			} catch {
				continue;
			}
			for (const wrapper of wrappers) {
				if (this.canvasObservers.has(wrapper)) continue;
				const observer = new MutationObserver(() => this.scheduleAliasRefresh(wrapper));
				observer.observe(wrapper, { childList: true, subtree: true });
				this.canvasObservers.set(wrapper, observer);
				this.scheduleAliasRefresh(wrapper);
			}
		}
	}

	/** 所有可能承载画布的文档（主窗口 + 弹出窗口） */
	private collectDocuments(): Set<Document> {
		const docs = new Set<Document>();
		docs.add(document);
		for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
			const doc = (leaf.view as unknown as CanvasViewLike | undefined)?.containerEl?.ownerDocument;
			if (doc) docs.add(doc);
		}
		return docs;
	}

	private scheduleAliasRefresh(wrapper: Element): void {
		if (!this.settings.renderAliasMarkdown) return;
		this.pendingAliasWrappers.add(wrapper);
		if (this.aliasRefreshHandle) return;
		const win = getWindowOf(wrapper);
		this.aliasRefreshHandle = win.requestAnimationFrame(() => {
			this.aliasRefreshHandle = 0;
			this.aliasRefreshWin = null;
			this.releaseDetachedAliasComponents();
			const targets = Array.from(this.pendingAliasWrappers);
			this.pendingAliasWrappers.clear();
			for (const target of targets) {
				if (target.isConnected) void this.refreshAliasMarkdown(target);
			}
		});
		this.aliasRefreshWin = win;
	}

	/** 卡片被重新渲染 / 画布关闭后，旧链接元素会离开 DOM，这里把它们对应的组件释放掉 */
	private releaseDetachedAliasComponents(): void {
		for (const [el, component] of Array.from(this.aliasComponents)) {
			if (el.isConnected) continue;
			this.aliasComponents.delete(el);
			try {
				this.removeChild(component);
				component.unload();
			} catch {
				/* 忽略：组件可能已被卸载 */
			}
		}
	}

	private releaseAllAliasComponents(): void {
		for (const [el, component] of Array.from(this.aliasComponents)) {
			this.aliasComponents.delete(el);
			try {
				this.removeChild(component);
				component.unload();
			} catch {
				/* 忽略 */
			}
		}
	}

	/**
	 * 把画布卡片里链接的「显示文字」按 markdown 重新渲染。
	 *
	 * Obsidian 的 [[链接|显示文字]] 别名是纯文本，所以 $公式$、**粗体**、==高亮==、
	 * <span style="color:red"> 都只会原样显示；这里用 MarkdownRenderer 重渲染，
	 * 再用 finishRenderMath 让 MathJax 真正排版公式。
	 *
	 * 只处理指向画布节点的链接，并用 data-csl-src 打标记，避免 MutationObserver 自我循环。
	 */
	private async refreshAliasMarkdown(wrapper: Element): Promise<void> {
		if (!this.settings.renderAliasMarkdown) return;
		const anchors = Array.from(wrapper.querySelectorAll("a.internal-link, a[data-href]"));
		if (anchors.length === 0) return;

		const view = this.findCanvasViewForElement(wrapper);
		const sourcePath = view?.file?.path ?? "";
		let needMathFlush = false;

		for (const anchor of anchors) {
			if (!isElementLike(anchor)) continue;
			const el = anchor as HTMLAnchorElement;
			if (el.dataset.cslSrc !== undefined) continue;

			const parsed = parseCanvasNodeLink(el);
			if (!parsed || !parsed.nodeId) continue;
			// 只处理「指向画布节点」的链接，普通笔记链接保持 Obsidian 原生渲染
			const targetFile = parsed.path
				? this.app.metadataCache.getFirstLinkpathDest(parsed.path, sourcePath)
				: (view?.file ?? null);
			if (!targetFile || targetFile.extension !== "canvas") continue;

			const source = el.textContent ?? "";
			el.dataset.cslSrc = source;
			if (!ALIAS_MARKDOWN_HINT.test(source)) continue;

			const component = new Component();
			this.addChild(component);
			try {
				el.replaceChildren();
				await MarkdownRenderer.render(this.app, source, el, sourcePath, component);
				this.aliasComponents.set(el, component);
				needMathFlush = true;
			} catch (error) {
				this.log("渲染链接显示文字失败，已回退纯文本", error);
				el.textContent = source;
				try {
					this.removeChild(component);
					component.unload();
				} catch {
					/* 忽略 */
				}
			}
		}

		if (needMathFlush) {
			try {
				await finishRenderMath();
			} catch {
				/* MathJax 未加载等情况忽略 */
			}
		}
	}

	/** 把「链接外观」设置写成 CSS 变量，由 styles.css 消费 */
	private applyAppearance(): void {
		const settings = this.settings;
		for (const doc of this.collectDocuments()) {
			const style = doc.body?.style;
			if (!style) continue;
			style.setProperty("--csl-link-color", settings.linkUseThemeColor ? "" : settings.linkColor);
			style.setProperty("--csl-link-decoration", settings.linkUnderline ? "underline" : "none");
			style.setProperty("--csl-link-weight", settings.linkBold ? "600" : "");
			style.setProperty("--csl-link-style", settings.linkItalic ? "italic" : "");
			style.setProperty("--csl-link-scale", String(settings.linkFontScale));
			style.setProperty(
				"--csl-link-hover-bg",
				settings.linkHoverBackground ? "var(--background-modifier-hover)" : ""
			);
		}
	}

	/* ---------------------------------------------------------------------
	 * 7.1c 右键菜单：链接样式 / 复制卡片链接；画布内的样式面板（A + D）
	 * ------------------------------------------------------------------- */

	/**
	 * 右键画布卡片里的链接：重建一份菜单，里面既有插件的样式项，
	 * 也用公开 API 把 Obsidian 原生的链接菜单项（在新标签页打开、复制链接…）带上。
	 */
	private onDocumentContextMenu = (evt: MouseEvent): void => {
		if (this.handledContextMenus.has(evt)) return;
		const target = isElementLike(evt.target) ? evt.target : null;
		const anchor = this.findCanvasLinkElement(target);
		if (!anchor) return;

		const parsed = parseCanvasNodeLink(anchor);
		if (!parsed || !parsed.nodeId) return;

		const view = this.findCanvasViewForElement(anchor);
		const canvas = view ? this.getCanvasObject(view) : null;
		const currentFile = view?.file ?? null;
		if (!view || !canvas || !currentFile) return;

		const targetFile = parsed.path
			? this.app.metadataCache.getFirstLinkpathDest(parsed.path, currentFile.path)
			: currentFile;
		if (!targetFile || targetFile.extension !== "canvas") return;

		// 接管这次右键：preventDefault + 自己重建菜单（forEvent 会在下一个 tick 弹出来）
		this.handledContextMenus.add(evt);
		evt.preventDefault();
		evt.stopPropagation();

		const node = this.findNodeForElement(canvas, anchor);
		const sourceRef = this.locateLinkSource(canvas, currentFile, node);
		const currentStyle = parseAliasStyle(anchor.textContent ?? "").style;

		const menu = Menu.forEvent(evt);
		forceMenuSections(menu, [
			"title",
			"open",
			"canvas",
			"csl-style",
			"action",
			"action-primary",
			"view",
			"info",
			"info.copy",
			"system",
			"",
			"danger",
		]);

		// ① 原生链接菜单
		try {
			this.app.workspace.handleLinkContextMenu(
				menu,
				parsed.linktext,
				currentFile.path,
				view.leaf as WorkspaceLeaf | undefined
			);
		} catch (error) {
			this.log("原生链接菜单构建失败，只显示插件项", error);
		}

		// ② 链接文字样式（写进别名的 HTML 里，跟着文件走）
		const openPanelFor = (focus?: "color" | "size"): void => {
			const label = (anchor.textContent ?? "").trim();
			this.openStylePanel({
				mode: "link",
				title: label ? `链接文字样式：${label.slice(0, 18)}` : "链接文字样式",
				anchorEl: anchor,
				focus,
				initial: parseAliasStyle(anchor.textContent ?? "").style,
				onPreview: (style) => this.previewLinkStyle(anchor, style),
				onCommit: (style) => void this.applyLinkStyle(sourceRef, anchor, parsed.linktext, style),
			});
		};
		this.addLinkStyleMenuItems(menu, currentStyle, {
			pick: (style) => void this.applyLinkStyle(sourceRef, anchor, parsed.linktext, style),
			openColorPanel: () => openPanelFor("color"),
			openSizePanel: () => openPanelFor("size"),
			openPanel: () => openPanelFor(),
		});

		// ③ 复制所在卡片链接
		if (node) {
			menu.addItem((item) =>
				item
					.setTitle("复制所在卡片链接")
					.setIcon("lucide-clipboard-copy")
					.setSection("info.copy")
					.onClick(() => void this.copyNodeLink(view, node))
			);
		}
	};

	/** 链接样式的菜单项（右键链接时用） */
	/**
	 * 链接样式的菜单项（右键链接时用），做成层级：
	 *   调整链接文本 ▸ 颜色 / 大小 / 加粗 / 斜体 / 下划线
	 * 颜色与大小里既有预设，也有「自定义…」打开样式面板（滑块 / HEX 输入放不进菜单）。
	 */
	private addLinkStyleMenuItems(
		menu: Menu,
		current: LinkStyleSpec,
		handlers: {
			pick: (style: LinkStyleSpec) => void;
			openColorPanel: () => void;
			openSizePanel: () => void;
			openPanel: () => void;
		}
	): void {
		menu.addItem((item) => {
			item.setTitle("调整链接文本").setIcon("lucide-type").setSection("csl-style");
			const sub = createSubmenu(item);
			if (!sub) {
				// 该版本不支持子菜单 → 直接打开面板
				item.onClick(() => handlers.openPanel());
				return;
			}

			// ---- 颜色 ----
			sub.addItem((colorItem) => {
				colorItem.setTitle("颜色").setIcon("lucide-palette");
				const colorMenu = createSubmenu(colorItem);
				if (!colorMenu) {
					colorItem.onClick(() => handlers.openColorPanel());
					return;
				}
				for (const preset of COLOR_PRESETS) {
					colorMenu.addItem((entry) => {
						entry.setTitle(colorSwatchTitle(preset.value, preset.name));
						if (current.color === preset.value) entry.setChecked(true);
						entry.onClick(() => handlers.pick({ ...current, color: preset.value }));
					});
				}
				for (const custom of this.settings.customColors) {
					colorMenu.addItem((entry) => {
						entry.setTitle(colorSwatchTitle(custom, custom));
						if (current.color === custom) entry.setChecked(true);
						entry.onClick(() => handlers.pick({ ...current, color: custom }));
					});
				}
				colorMenu.addSeparator();
				colorMenu.addItem((entry) =>
					entry
						.setTitle("自定义颜色 / HEX / 存为常用…")
						.setIcon("lucide-pipette")
						.onClick(() => handlers.openColorPanel())
				);
			});

			// ---- 大小 ----
			sub.addItem((sizeItem) => {
				sizeItem.setTitle("大小").setIcon("lucide-a-large-small");
				const sizeMenu = createSubmenu(sizeItem);
				if (!sizeMenu) {
					sizeItem.onClick(() => handlers.openSizePanel());
					return;
				}
				for (const preset of SIZE_PRESETS) {
					sizeMenu.addItem((entry) => {
						const value = preset.value ?? 1;
						const same = Math.abs((current.scale ?? 1) - value) < 0.001;
						entry.setTitle(`字号 ${preset.name}`);
						if (same) entry.setChecked(true);
						entry.onClick(() => handlers.pick({ ...current, scale: preset.value }));
					});
				}
				sizeMenu.addSeparator();
				sizeMenu.addItem((entry) =>
					entry.setTitle("自定义大小（滑块 / 百分比）…").setIcon("lucide-sliders-horizontal").onClick(() => handlers.openSizePanel())
				);
			});

			// ---- 加粗 / 斜体 / 下划线 ----
			sub.addItem((entry) =>
				entry
					.setTitle("加粗")
					.setIcon("lucide-bold")
					.setChecked(current.bold)
					.onClick(() => handlers.pick({ ...current, bold: !current.bold }))
			);
			sub.addItem((entry) =>
				entry
					.setTitle("斜体")
					.setIcon("lucide-italic")
					.setChecked(current.italic)
					.onClick(() => handlers.pick({ ...current, italic: !current.italic }))
			);
			sub.addItem((entry) =>
				entry
					.setTitle("下划线")
					.setIcon("lucide-underline")
					.setChecked(current.underline === true)
					.onClick(() => handlers.pick({ ...current, underline: current.underline === true ? false : true }))
			);

			sub.addSeparator();
			sub.addItem((entry) =>
				entry
					.setTitle("清除链接文字样式")
					.setIcon("lucide-eraser")
					.onClick(() => handlers.pick({ ...EMPTY_LINK_STYLE }))
			);
			sub.addItem((entry) =>
				entry
					.setTitle("打开样式面板…")
					.setIcon("lucide-settings-2")
					.onClick(() => handlers.openPanel())
			);
		});
	}

	/* ---- 样式面板：色板 + HEX + 字号滑块 + 常用色（这些控件放不进菜单） ---- */

	private stylePanel: HTMLElement | null = null;
	private stylePanelCleanup: (() => void) | null = null;

	private closeStylePanel(): void {
		try {
			this.stylePanelCleanup?.();
		} catch {
			/* 忽略 */
		}
		this.stylePanelCleanup = null;
		this.stylePanel?.remove();
		this.stylePanel = null;
	}

	/** 画布右上角按钮 → 全局样式面板 */
	openGlobalStylePanel(evt: MouseEvent): void {
		const settings = this.settings;
		this.openStylePanel({
			mode: "global",
			title: "链接样式（全局默认）",
			evt,
			initial: {
				color: settings.linkUseThemeColor ? null : settings.linkColor,
				scale: settings.linkFontScale,
				bold: settings.linkBold,
				italic: settings.linkItalic,
				underline: settings.linkUnderline ? true : null,
			},
			onPreview: (style) => {
				this.applySpecToGlobalSettings(style);
				this.applyAppearance();
			},
			onCommit: (style) => {
				this.applySpecToGlobalSettings(style);
				void this.saveSettings().then(() => this.applySettingsToUI());
			},
		});
	}

	private applySpecToGlobalSettings(style: LinkStyleSpec): void {
		const settings = this.settings;
		settings.linkUseThemeColor = !style.color;
		if (style.color) settings.linkColor = style.color;
		settings.linkFontScale = style.scale && style.scale > 0 ? style.scale : 1;
		settings.linkBold = style.bold;
		settings.linkItalic = style.italic;
		settings.linkUnderline = style.underline !== false;
	}

	/** 拖动滑块时的即时预览（只改这个链接的 DOM，不写文件） */
	private previewLinkStyle(anchor: HTMLElement, style: LinkStyleSpec): void {
		anchor.style.color = style.color ?? "";
		anchor.style.fontSize = style.scale && Math.abs(style.scale - 1) > 0.001 ? `${style.scale}em` : "";
		anchor.style.fontWeight = style.bold ? "700" : "";
		anchor.style.fontStyle = style.italic ? "italic" : "";
		anchor.style.textDecoration = style.underline === true ? "underline" : style.underline === false ? "none" : "";
	}

	/**
	 * 弹出式样式面板（色板 / HEX 输入 / 字号滑块 / 常用色）。
	 * 菜单里只能放文字与勾选，所以需要输入与拖动的东西都放在这里。
	 */
	private openStylePanel(opts: {
		mode: "link" | "global";
		title: string;
		initial: LinkStyleSpec;
		anchorEl?: HTMLElement | null;
		evt?: MouseEvent | null;
		focus?: "color" | "size";
		onPreview?: (style: LinkStyleSpec) => void;
		onCommit: (style: LinkStyleSpec) => void;
	}): void {
		this.closeStylePanel();

		const anchorEl = opts.anchorEl ?? null;
		const doc = anchorEl?.ownerDocument ?? document;
		const win = getWindowOf(anchorEl);
		const state: LinkStyleSpec = { ...opts.initial };
		const committed: LinkStyleSpec = { ...opts.initial };

		const make = <K extends keyof HTMLElementTagNameMap>(
			tag: K,
			cls?: string,
			text?: string
		): HTMLElementTagNameMap[K] => {
			const node = doc.createElement(tag);
			if (cls) node.className = cls;
			if (text !== undefined) node.textContent = text;
			return node;
		};

		const panel = make("div", "csl-panel");
		const header = make("div", "csl-panel-header");
		header.appendChild(make("div", "csl-panel-title", opts.title));
		const closeBtn = make("button", "csl-panel-close", "×");
		closeBtn.addEventListener("click", () => this.closeStylePanel());
		header.appendChild(closeBtn);
		panel.appendChild(header);

		// 颜色
		const colorSection = make("div", "csl-panel-section");
		colorSection.appendChild(make("div", "csl-panel-label", "颜色"));
		const grid = make("div", "csl-swatch-grid");
		colorSection.appendChild(grid);
		const hexRow = make("div", "csl-row");
		const hexInput = make("input", "csl-hex");
		hexInput.type = "text";
		hexInput.placeholder = "#e05252";
		const applyHexBtn = make("button", "csl-btn", "应用");
		const saveHexBtn = make("button", "csl-btn", "存为常用");
		const themeBtn = make("button", "csl-btn", "跟随主题");
		hexRow.append(hexInput, applyHexBtn, saveHexBtn, themeBtn);
		colorSection.appendChild(hexRow);
		colorSection.appendChild(make("div", "csl-panel-hint", "点色块即换色；输入 HEX 后可「应用」或「存为常用」。"));
		panel.appendChild(colorSection);

		// 大小
		const sizeSection = make("div", "csl-panel-section");
		sizeSection.appendChild(make("div", "csl-panel-label", "大小"));
		const sizeRow = make("div", "csl-row");
		const range = make("input", "csl-range");
		range.type = "range";
		range.min = "50";
		range.max = "300";
		range.step = "5";
		const sizeInput = make("input", "csl-size-input");
		sizeInput.type = "number";
		sizeInput.min = "50";
		sizeInput.max = "300";
		sizeInput.step = "5";
		sizeRow.append(range, sizeInput, make("span", "csl-panel-hint", "%"));
		sizeSection.appendChild(sizeRow);
		sizeSection.appendChild(make("div", "csl-panel-hint", "拖动滑块或直接输入百分比，松手即写入。"));
		panel.appendChild(sizeSection);

		// 样式
		const styleSection = make("div", "csl-panel-section");
		styleSection.appendChild(make("div", "csl-panel-label", "样式"));
		const styleRow = make("div", "csl-row");
		const boldBtn = make("button", "csl-btn csl-toggle", "B");
		boldBtn.title = "加粗";
		const italicBtn = make("button", "csl-btn csl-toggle", "I");
		italicBtn.title = "斜体";
		const underlineBtn = make("button", "csl-btn csl-toggle", "U");
		underlineBtn.title = "下划线";
		const clearBtn = make("button", "csl-btn", "清除样式");
		styleRow.append(boldBtn, italicBtn, underlineBtn, clearBtn);
		styleSection.appendChild(styleRow);
		panel.appendChild(styleSection);

		const footer = make("div", "csl-panel-footer");
		const settingsBtn = make("button", "csl-btn", "完整设置…");
		settingsBtn.addEventListener("click", () => this.openPluginSettings());
		const doneBtn = make("button", "csl-btn mod-cta", "完成");
		footer.append(settingsBtn, doneBtn);
		panel.appendChild(footer);

		const commit = (): void => {
			Object.assign(committed, state);
			opts.onCommit({ ...state });
		};
		const preview = (): void => opts.onPreview?.({ ...state });
		const commitAndRefresh = (): void => {
			commit();
			syncUi();
		};

		const renderGrid = (): void => {
			while (grid.firstChild) grid.removeChild(grid.firstChild);
			const entries: Array<{ value: string | null; label: string }> = [
				...COLOR_PRESETS.map((preset) => ({ value: preset.value, label: preset.name })),
				...this.settings.customColors.map((color) => ({ value: color, label: color })),
			];
			for (const entry of entries) {
				const swatch = make("button", "csl-swatch");
				swatch.title = entry.label;
				if (entry.value) swatch.style.background = entry.value;
				else swatch.classList.add("is-theme");
				if ((state.color ?? null) === entry.value) swatch.classList.add("is-active");
				swatch.addEventListener("click", () => {
					state.color = entry.value;
					preview();
					commitAndRefresh();
				});
				grid.appendChild(swatch);
			}
		};

		const syncUi = (): void => {
			const percent = String(Math.round((state.scale ?? 1) * 100));
			range.value = percent;
			sizeInput.value = percent;
			hexInput.value = state.color ?? "";
			boldBtn.classList.toggle("is-active", state.bold);
			italicBtn.classList.toggle("is-active", state.italic);
			underlineBtn.classList.toggle("is-active", state.underline === true);
			themeBtn.classList.toggle("is-active", !state.color);
			renderGrid();
		};

		range.addEventListener("input", () => {
			state.scale = clamp(Number(range.value) / 100, 0.5, 3);
			sizeInput.value = String(Math.round(state.scale * 100));
			preview();
		});
		range.addEventListener("change", () => {
			state.scale = clamp(Number(range.value) / 100, 0.5, 3);
			commitAndRefresh();
		});
		sizeInput.addEventListener("input", () => {
			const value = Number(sizeInput.value);
			if (!Number.isFinite(value) || value <= 0) return;
			state.scale = clamp(value / 100, 0.5, 3);
			range.value = String(Math.round(state.scale * 100));
			preview();
		});
		sizeInput.addEventListener("change", () => {
			const value = Number(sizeInput.value);
			if (!Number.isFinite(value) || value <= 0) {
				syncUi();
				return;
			}
			state.scale = clamp(value / 100, 0.5, 3);
			commitAndRefresh();
		});
		applyHexBtn.addEventListener("click", () => {
			const color = normalizeHexColor(hexInput.value);
			if (!color) {
				new Notice("色号格式不对，请用 #RGB 或 #RRGGBB");
				return;
			}
			state.color = color;
			preview();
			commitAndRefresh();
		});
		saveHexBtn.addEventListener("click", () => {
			const color = normalizeHexColor(hexInput.value) ?? state.color;
			if (!color) {
				new Notice("先输入一个色号再保存");
				return;
			}
			if (!this.settings.customColors.includes(color)) {
				this.settings.customColors = [color, ...this.settings.customColors].slice(0, 16);
			}
			void this.saveSettings();
			state.color = color;
			preview();
			commitAndRefresh();
			new Notice(`已加入常用色：${color}`);
		});
		themeBtn.addEventListener("click", () => {
			state.color = null;
			preview();
			commitAndRefresh();
		});
		boldBtn.addEventListener("click", () => {
			state.bold = !state.bold;
			preview();
			commitAndRefresh();
		});
		italicBtn.addEventListener("click", () => {
			state.italic = !state.italic;
			preview();
			commitAndRefresh();
		});
		underlineBtn.addEventListener("click", () => {
			state.underline = state.underline === true ? false : true;
			preview();
			commitAndRefresh();
		});
		clearBtn.addEventListener("click", () => {
			Object.assign(state, EMPTY_LINK_STYLE);
			preview();
			commitAndRefresh();
		});
		doneBtn.addEventListener("click", () => this.closeStylePanel());

		// 定位到点击处 / 链接下方
		const panelWidth = 320;
		const panelHeight = 380;
		let left = 12;
		let top = 90;
		if (anchorEl) {
			try {
				const rect = anchorEl.getBoundingClientRect();
				left = rect.left;
				top = rect.bottom + 8;
			} catch {
				/* 拿不到位置就用默认坐标 */
			}
		} else if (opts.evt) {
			left = opts.evt.clientX;
			top = opts.evt.clientY + 8;
		}
		panel.style.left = `${clamp(left, 8, Math.max(8, (win.innerWidth || 1200) - panelWidth - 8))}px`;
		panel.style.top = `${clamp(top, 8, Math.max(8, (win.innerHeight || 800) - panelHeight - 8))}px`;

		syncUi();
		(doc.body ?? document.body).appendChild(panel);
		this.stylePanel = panel;

		// 关闭：点面板外 / Esc / 完成；关闭时把临时预览还原成已提交的状态
		const onPointerDown = (event: PointerEvent): void => {
			const target = event.target as Node | null;
			if (target && panel.contains(target)) return;
			this.closeStylePanel();
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") this.closeStylePanel();
		};
		this.stylePanelCleanup = () => {
			doc.removeEventListener("pointerdown", onPointerDown, true);
			doc.removeEventListener("keydown", onKeyDown, true);
			if (anchorEl) this.previewLinkStyle(anchorEl, committed);
		};
		win.setTimeout(() => {
			doc.addEventListener("pointerdown", onPointerDown, true);
			doc.addEventListener("keydown", onKeyDown, true);
		}, 0);

		if (opts.focus === "color") hexInput.focus();
		else if (opts.focus === "size") range.focus();
	}

	private openPluginSettings(): void {
		const setting = (this.app as unknown as {
			setting?: { open: () => void; openTabById: (id: string) => void };
		}).setting;
		try {
			setting?.open();
			setting?.openTabById(this.manifest.id);
		} catch (error) {
			this.log("无法打开设置页", error);
			new Notice("请到「设置 → 第三方插件 → Canvas Smooth Linker」里查看完整设置");
		}
	}

	/** 找到链接所在的画布节点（DOM 元素 → 节点对象） */
	private findNodeForElement(canvas: CanvasLike, el: Element): CanvasNodeLike | null {
		const nodeEl = el.closest(".canvas-node");
		if (!nodeEl) return null;
		const nodes = canvas.nodes;
		if (!nodes || typeof nodes.values !== "function") return null;
		try {
			for (const node of nodes.values()) {
				if (node && node.nodeEl === nodeEl) return node;
			}
		} catch {
			/* 忽略 */
		}
		return null;
	}

	/** 这条链接的文字到底该改哪里：画布文本卡片的 text，还是卡片里嵌入笔记的文件 */
	private locateLinkSource(
		canvas: CanvasLike,
		currentFile: TFile,
		node: CanvasNodeLike | null
	): LinkSourceRef | null {
		if (!node || typeof node.getData !== "function") return null;
		let data: Record<string, unknown> | null = null;
		try {
			data = node.getData();
		} catch {
			return null;
		}
		if (!data) return null;

		if (typeof data.text === "string") {
			return { kind: "text-node", canvas, node };
		}

		const filePath = typeof data.file === "string" ? data.file : null;
		if (!filePath) return null;
		const noteFile =
			this.app.vault.getAbstractFileByPath(filePath) ??
			this.app.metadataCache.getFirstLinkpathDest(filePath, currentFile.path);
		if (noteFile && typeof (noteFile as TFile).extension === "string") {
			return { kind: "note-file", file: noteFile as TFile };
		}
		return null;
	}

	/**
	 * 应用单链接样式：把新别名写回源文本。
	 * 文本卡片走画布节点的 setData（会同步进编辑器、并进撤销历史）；
	 * 文件卡片里的链接则写回那张笔记（用 vault.process，原子写入）。
	 */
	private async applyLinkStyle(
		ref: LinkSourceRef | null,
		anchor: HTMLAnchorElement,
		href: string,
		style: LinkStyleSpec
	): Promise<void> {
		if (!ref) {
			new Notice("没能在原文里定位这条链接，未做修改");
			return;
		}

		const rewrite = (source: string): string | null => {
			const found = findLinkInSource(source, href);
			if (!found) return null;
			const plainText =
				found.rawAlias === null ? (anchor.textContent ?? "") : parseAliasStyle(found.rawAlias).text;
			const replacement = isLinkStyleEmpty(style)
				? found.rawAlias === null
					? buildLinkText(href, found.syntax, null)
					: buildLinkText(href, found.syntax, plainText)
				: buildLinkText(href, found.syntax, composeAliasHtml(plainText, style));
			return source.slice(0, found.start) + replacement + source.slice(found.end);
		};

		try {
			if (ref.kind === "text-node") {
				const data = ref.node.getData?.() ?? null;
				if (!data || typeof data.text !== "string") {
					new Notice("这条链接不在文本卡片里，未做修改");
					return;
				}
				const next = rewrite(data.text);
				if (next === null) {
					new Notice("没能在卡片原文里定位这条链接（可能被手工改写过）");
					return;
				}
				ref.node.setData?.({ ...data, text: next });
				// requestSave 会把新状态推进撤销历史
				ref.canvas.requestSave?.();
			} else {
				let changed = false;
				await this.app.vault.process(ref.file, (source) => {
					const next = rewrite(source);
					if (next === null) return source;
					changed = true;
					return next;
				});
				if (!changed) new Notice("没能在笔记原文里定位这条链接，未做修改");
			}
		} catch (error) {
			this.log("应用链接样式失败", error);
			new Notice("应用链接样式失败，详见控制台");
		}
	}

	/** 把「复制卡片链接」加进画布原生的节点右键菜单 */
	private patchCanvasNodeMenus(canvas: CanvasLike): void {
		const nodes = canvas.nodes;
		if (!nodes || typeof nodes.values !== "function") return;
		const view = this.findViewForCanvas(canvas);
		if (!view) return;

		try {
			for (const node of nodes.values()) {
				if (!node) continue;
				const record = node as unknown as {
					showMenu?: (menu: Menu) => void;
					__cslMenuPatched?: boolean;
				};
				if (record.__cslMenuPatched || typeof record.showMenu !== "function") continue;
				const original = record.showMenu.bind(node);
				record.showMenu = (menu: Menu) => {
					original(menu);
					try {
						menu.addItem((item) =>
							item
								.setTitle("复制卡片链接")
								.setIcon("lucide-link")
								.setSection("canvas")
								.onClick(() => void this.copyNodeLink(view, node))
						);
					} catch (error) {
						this.log("追加节点菜单项失败", error);
					}
				};
				record.__cslMenuPatched = true;
			}
		} catch (error) {
			this.log("遍历画布节点失败", error);
		}
	}

	private findViewForCanvas(canvas: CanvasLike): CanvasViewLike | null {
		for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
			const view = leaf.view as unknown as CanvasViewLike;
			if (view && view.canvas === canvas) return view;
		}
		if (canvas.wrapperEl) return this.findCanvasViewForElement(canvas.wrapperEl);
		return null;
	}

	/** 在画布右上角的控制组里插一个「链接样式」按钮（D） */
	private syncCanvasStyleButtons(): void {
		if (!this.settings.showCanvasStyleButton) return;
		for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
			const view = leaf.view as unknown as CanvasViewLike;
			const container = view?.containerEl;
			if (!container) continue;
			let group: Element | null = null;
			try {
				group = container.querySelector(".canvas-control-group");
			} catch {
				group = null;
			}
			if (!group || group.querySelector(".csl-style-button")) continue;
			if (typeof group.createDiv !== "function") continue;

			const button = group.createDiv({ cls: "canvas-control-item csl-style-button" });
			try {
				setIcon(button, "lucide-palette");
				setTooltip(button, "链接样式", { placement: "left" });
			} catch {
				/* 图标失败不影响功能 */
			}
			button.addEventListener("click", (evt) => this.openGlobalStylePanel(evt));
		}
	}

	/** 画布相关 UI（样式按钮 + 节点菜单）在布局变化后同步一遍 */
	private syncCanvasUi(): void {
		this.syncCanvasStyleButtons();
		for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
			const canvas = this.getCanvasObject(leaf.view as unknown as CanvasViewLike);
			if (canvas) this.patchCanvasNodeMenus(canvas);
		}
	}

	/** 设置里打开该按钮时立即补上 */
	syncCanvasStyleButtonNow(): void {
		this.syncCanvasStyleButtons();
	}

	/** 设置里关闭该按钮时移除已插入的按钮 */
	removeCanvasStyleButtons(): void {
		for (const doc of this.collectDocuments()) {
			for (const el of Array.from(doc.querySelectorAll(".csl-style-button"))) el.remove();
		}
	}

	/* ---------------------------------------------------------------------
	 * 7.2 从 DOM / view 反查 CanvasView 与 Canvas 对象
	 * ------------------------------------------------------------------- */

	private findCanvasViewForElement(el: Element): CanvasViewLike | null {
		const wrapper = el.closest(".canvas-wrapper");
		let best: { view: CanvasViewLike; wrapper: Element } | null = null;

		for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
			const view = leaf.view as unknown as CanvasViewLike;
			if (!view) continue;

			// 优先按 canvas.wrapperEl 精确匹配（处理画布里嵌画布的情况）
			const canvas = this.getCanvasObject(view);
			const wrapperEl = canvas?.wrapperEl;
			if (wrapper && wrapperEl && wrapperEl === wrapper) {
				return view;
			}

			const container = view.contentEl ?? view.containerEl;
			if (wrapper && container && container.contains(wrapper)) {
				// 取“最深”的那个：嵌套画布时内层才是真正要移动的视口
				if (!best || best.wrapper.contains(wrapper)) best = { view, wrapper };
			}
		}
		if (best) return best.view;

		// 兜底：按当前活动视图判断（CanvasView 未在官方 d.ts 导出，用 ItemView + viewType 判断）
		const active = this.app.workspace.getActiveViewOfType(ItemView);
		if (active && active.getViewType() === "canvas") {
			const candidate = active as unknown as CanvasViewLike;
			if (this.getCanvasObject(candidate)) return candidate;
		}

		return null;
	}

	/** 从 CanvasView 上取 Canvas 对象（view.canvas 是 1.13.x 的正式字段） */
	private getCanvasObject(view: CanvasViewLike): CanvasLike | null {
		const direct = view.canvas;
		if (this.isCanvasLike(direct)) return direct;

		// 兜底：扫描自有属性，找出带 nodes 容器的对象
		const record = view as unknown as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			let value: unknown;
			try {
				value = record[key];
			} catch {
				continue;
			}
			if (this.isCanvasLike(value)) return value;
		}
		return null;
	}

	private isCanvasLike(value: unknown): value is CanvasLike {
		if (!value || typeof value !== "object") return false;
		const candidate = value as CanvasLike;
		const hasNodeMap = !!candidate.nodes && typeof (candidate.nodes as NodeMapLike).get === "function";
		const hasViewport =
			isNum(candidate.tx) || isNum(candidate.ty) || isNum(candidate.zoom) || isNum(candidate.scale);
		const hasDom = isElementLike(candidate.canvasEl) || isElementLike(candidate.wrapperEl);
		return hasNodeMap && (hasViewport || hasDom);
	}

	/** 找节点：先精确命中，再忽略大小写兜底 */
	private getNodeById(canvas: CanvasLike, nodeId: string): CanvasNodeLike | null {
		const nodes = canvas.nodes;
		if (!nodes || typeof nodes.get !== "function") return null;

		const direct = nodes.get(nodeId);
		if (direct && typeof direct === "object") return direct;

		if (typeof nodes.keys === "function") {
			const lowered = nodeId.toLowerCase();
			for (const key of nodes.keys()) {
				if (typeof key === "string" && key.toLowerCase() === lowered) {
					const hit = nodes.get(key);
					if (hit && typeof hit === "object") return hit;
				}
			}
		}
		return null;
	}

	/**
	 * 节点中心（画布坐标系）。
	 * 优先用 getBBox()，它对 group / 文本节点都最准确；
	 * 退化时用 x/y + width/height（已核对：x/y 是左上角）。
	 */
	private getNodeCenter(node: CanvasNodeLike): { x: number; y: number } | null {
		try {
			const bbox = node.getBBox?.();
			if (bbox && isNum(bbox.minX) && isNum(bbox.maxX) && isNum(bbox.minY) && isNum(bbox.maxY)) {
				return { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 };
			}
		} catch {
			/* 忽略，走下面的兜底 */
		}
		if (isNum(node.x) && isNum(node.y)) {
			const width = isNum(node.width) ? node.width : 0;
			const height = isNum(node.height) ? node.height : 0;
			return { x: node.x + width / 2, y: node.y + height / 2 };
		}
		return null;
	}

	private isActiveTarget(path: string, nodeId: string): boolean {
		return !!this.activeTarget && this.activeTarget.path === path && this.activeTarget.nodeId === nodeId;
	}

	/* ---------------------------------------------------------------------
	 * 7.3 聚焦逻辑
	 * ------------------------------------------------------------------- */

	private async focusNode(canvas: CanvasLike, node: CanvasNodeLike, path: string, nodeId: string): Promise<void> {
		const center = this.getNodeCenter(node);
		if (!center) return;

		this.activeTarget = { path, nodeId };
		const target: ViewportTarget = { centerX: center.x, centerY: center.y, scale: this.getTargetScale() };

		// 当前 viewport 状态（含语义探测），后续所有写入都用同一份快照
		const snapshot = readViewport(canvas);
		if (!snapshot) {
			// 极端情况：拿不到状态 → 直接落值，不做动画
			const fallback: ViewportSnapshot = {
				centerX: center.x,
				centerY: center.y,
				scale: target.scale,
				zoomIsLog2: true,
				centerInCanvasCoords: true,
			};
			writeViewport(canvas, fallback, target);
			this.activeTarget = null;
			return;
		}

		const method = await this.animateViewport(canvas, snapshot, target);
		this.log("聚焦节点", nodeId, "目标", target, "写入方式", method);
		// 只有还在“我们这一趟”里才清空守卫（期间可能有别的点击接管了 activeTarget）
		if (this.isActiveTarget(path, nodeId)) this.activeTarget = null;
	}

	private getTargetScale(): number {
		return clamp(this.settings.targetZoom, MIN_SCALE, MAX_SCALE);
	}

	/**
	 * 平滑动画：requestAnimationFrame + easeInOutQuad，把视口从当前位置移动到目标中心。
	 *
	 *   位置：线性插值   cx(t) = cx0 + (cx1 - cx0) * ease(t)
	 *   缩放：对数插值   log2(s(t)) = log2(s0) + (log2(s1) - log2(s0)) * ease(t)
	 *        （等价于 s(t) = s0 * (s1/s0)^ease(t)，等比缩放看起来更自然）
	 */
	private async animateViewport(
		canvas: CanvasLike,
		snapshot: ViewportSnapshot,
		target: ViewportTarget
	): Promise<ViewportWriteMethod> {
		const canvasEl = canvas.canvasEl ?? null;
		const win = getWindowOf(canvasEl ?? canvas.wrapperEl ?? null);
		const duration = this.resolveDuration();

		const token = ++this.animationToken;
		const startCenterX = snapshot.centerX;
		const startCenterY = snapshot.centerY;
		const startScale = clamp(snapshot.scale, MIN_SCALE, MAX_SCALE);
		const endScale = clamp(target.scale, MIN_SCALE, MAX_SCALE);
		const endCenterX = target.centerX;
		const endCenterY = target.centerY;

		const startLog2 = Math.log2(startScale);
		const endLog2 = Math.log2(endScale);

		let lastMethod: ViewportWriteMethod = "none";

		// 动一帧就落一帧的值
		const apply = (progress: number): ViewportWriteMethod => {
			const eased = easeInOutQuad(progress);
			const centerX = startCenterX + (endCenterX - startCenterX) * eased;
			const centerY = startCenterY + (endCenterY - startCenterY) * eased;
			const scale = Math.pow(2, startLog2 + (endLog2 - startLog2) * eased);
			lastMethod = writeViewport(canvas, snapshot, { centerX, centerY, scale });
			return lastMethod;
		};

		// 用户一旦手动拖拽 / 滚轮，立刻放弃动画，避免和用户抢视口
		const abort = () => {
			this.animationToken += 1;
		};
		const abortTarget = canvas.wrapperEl ?? canvasEl;
		abortTarget?.addEventListener("wheel", abort, { passive: true });
		abortTarget?.addEventListener("pointerdown", abort, true);

		try {
			if (duration <= 0) {
				lastMethod = apply(1);
			} else {
				const startTime = win.performance.now();
				await new Promise<void>((resolve) => {
					const step = (now: number) => {
						if (token !== this.animationToken) {
							resolve(); // 被取消
							return;
						}
						const elapsed = now - startTime;
						const progress = clamp(elapsed / duration, 0, 1);
						apply(progress);
						if (progress < 1) win.requestAnimationFrame(step);
						else resolve();
					};
					win.requestAnimationFrame(step);
				});
			}
		} finally {
			abortTarget?.removeEventListener("wheel", abort);
			abortTarget?.removeEventListener("pointerdown", abort, true);
		}

		// 动画结束时精确落一次目标值，并做一次“实测自校正”
		if (token === this.animationToken) {
			lastMethod = writeViewport(canvas, snapshot, { centerX: endCenterX, centerY: endCenterY, scale: endScale });
			await this.settleAndVerify(canvas, snapshot, { centerX: endCenterX, centerY: endCenterY, scale: endScale }, win);
		}

		return lastMethod;
	}

	private resolveDuration(): number {
		let duration = clamp(this.settings.animationDuration, 300, 400);
		if (this.settings.respectReducedMotion) {
			try {
				const win = getWindowOf(this.app.workspace.containerEl ?? null);
				if (win.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) duration = 0;
			} catch {
				/* matchMedia 不可用时忽略 */
			}
		}
		return duration;
	}

	/**
	 * 实测自校正。
	 *
	 * 不同 Obsidian 版本的视口语义未必和 1.13.7 一致（例如 tx/ty 可能是屏幕位移、
	 * zoom 可能是线性缩放）。这里等 Obsidian 自己的 rAF 把 transform 写进 DOM 后，
	 * 反解出“屏幕上真实显示的位置”，和我们的目标做对比：
	 *   - 缩放偏差 > 2%  → 翻转 zoom 语义（log2 ↔ 线性）再写一次
	 *   - 中心偏差 > 1 画布单位 → 按常数偏差做一次定点修正
	 * 1.13.7 上这两步通常都是空操作（偏差为 0）。
	 */
	private async settleAndVerify(
		canvas: CanvasLike,
		initialSnapshot: ViewportSnapshot,
		target: ViewportTarget,
		win: Window
	): Promise<void> {
		let snapshot = initialSnapshot;
		let want = { ...target };
		let triedFlip = false;
		let bestScore = Number.POSITIVE_INFINITY;
		let best: { snapshot: ViewportSnapshot; want: ViewportTarget } = { snapshot, want };

		for (let attempt = 0; attempt < 3; attempt++) {
			await nextFrames(win, 2);

			const dom = measureCanvasTransform(canvas.canvasEl);
			if (!dom) return;
			const size = getWrapperSize(canvas);
			if (size.width <= 0 || size.height <= 0) return;

			const gotScale = dom.scale;
			const gotCenterX = (size.width / 2 - dom.tx) / gotScale;
			const gotCenterY = (size.height / 2 - dom.ty) / gotScale;

			const scaleDelta = Math.abs(gotScale / want.scale - 1);
			const centerDeltaX = want.centerX - gotCenterX;
			const centerDeltaY = want.centerY - gotCenterY;
			const centerOff = Math.abs(centerDeltaX) > 1 || Math.abs(centerDeltaY) > 1;

			// 记录到目前为止最接近目标的一次，用于失败回滚
			const score = scaleDelta * 1000 + Math.hypot(centerDeltaX, centerDeltaY);
			if (score < bestScore) {
				bestScore = score;
				best = { snapshot, want };
			}

			if (scaleDelta <= 0.02 && !centerOff) return; // 已经到位

			if (scaleDelta > 0.02) {
				// 缩放对不上 → 先怀疑 zoom 语义猜错了。只翻转一次；
				// 若翻转后仍然对不上（例如该版本的缩放上限比我们低），回滚到最好的一次，避免来回抖。
				if (triedFlip) {
					this.log("缩放仍无法对齐，回滚到最佳状态", { gotScale, want: want.scale });
					writeViewport(canvas, best.snapshot, best.want);
					return;
				}
				triedFlip = true;
				this.log("缩放偏差，尝试翻转 zoom 语义", { gotScale, want: want.scale, zoomIsLog2: snapshot.zoomIsLog2 });
				// 用真实测得的 scale 作为新的插值基准，避免额外跳动
				snapshot = { ...snapshot, zoomIsLog2: !snapshot.zoomIsLog2, scale: gotScale, centerX: gotCenterX, centerY: gotCenterY };
				writeViewport(canvas, snapshot, want);
				continue;
			}

			if (centerOff) {
				// 只在一个屏幕范围内做“常数偏移”修正：偏差过大说明判断本身有问题，宁可不动
				const maxCorrection = Math.max(size.width, size.height) / Math.max(gotScale, 1e-6);
				if (Math.abs(centerDeltaX) > maxCorrection || Math.abs(centerDeltaY) > maxCorrection) {
					this.log("中心偏差过大，放弃自校正", { centerDeltaX, centerDeltaY });
					writeViewport(canvas, best.snapshot, best.want);
					return;
				}
				this.log("中心偏差，修正", { centerDeltaX, centerDeltaY });
				want = { centerX: want.centerX + centerDeltaX, centerY: want.centerY + centerDeltaY, scale: want.scale };
				writeViewport(canvas, snapshot, want);
			}
		}

		// 三次仍未收敛 → 回到最接近目标的那一次
		writeViewport(canvas, best.snapshot, best.want);
	}

	/* ---------------------------------------------------------------------
	 * 7.4 便捷命令：复制节点链接
	 * ------------------------------------------------------------------- */

	private getActiveCanvasContext(): { canvas: CanvasLike; view: CanvasViewLike } | null {
		const active = this.app.workspace.getActiveViewOfType(ItemView);
		if (!active || active.getViewType() !== "canvas") return null;
		const view = active as unknown as CanvasViewLike;
		const canvas = this.getCanvasObject(view);
		return canvas ? { canvas, view } : null;
	}

	private getSelectedNodes(canvas: CanvasLike): CanvasNodeLike[] {
		const out: CanvasNodeLike[] = [];
		const selection = canvas.selection;
		const iterable = selection as { values?: () => IterableIterator<unknown> } | null | undefined;
		if (!iterable || typeof iterable.values !== "function") return out;
		try {
			for (const item of iterable.values()) {
				if (item && typeof item === "object") out.push(item as CanvasNodeLike);
			}
		} catch {
			/* 忽略 */
		}
		return out;
	}

	private async copyNodeLink(view: CanvasViewLike, node: CanvasNodeLike): Promise<void> {
		const file = view.file;
		const nodeId = node.id;
		if (!file || !nodeId) {
			new Notice("canvas-smooth-linker: 该节点没有可用 ID");
			return;
		}
		const link = `[[${file.path}#${nodeId}]]`;
		try {
			await navigator.clipboard.writeText(link);
			new Notice(`已复制节点链接：${link}`);
		} catch (error) {
			new Notice(`复制失败，请手动复制：${link}`);
			this.log("clipboard error", error);
		}
	}

	/* ---------------------------------------------------------------------
	 * 7.5 跨画布跳转
	 * ------------------------------------------------------------------- */

	private async jumpToOtherCanvas(view: CanvasViewLike, file: TFile, nodeId: string): Promise<void> {
		if (this.isActiveTarget(file.path, nodeId)) return;
		this.activeTarget = { path: file.path, nodeId };

		try {
			const sourceLeaf = view.leaf as unknown as WorkspaceLeaf | undefined;
			const leaf: WorkspaceLeaf =
				this.settings.crossCanvasOpenInCurrentTab && sourceLeaf ? sourceLeaf : this.app.workspace.getLeaf("tab");

			// 打开目标画布（复用当前标签页 = PPT 翻页观感）
			await leaf.openFile(file, { active: true });

			// 轮询等待目标画布加载完成
			const deadline = Date.now() + 4000;
			while (Date.now() < deadline) {
				const targetView = leaf.view as unknown as CanvasViewLike | null;
				const canvas = targetView ? this.getCanvasObject(targetView) : null;
				const node = canvas ? this.getNodeById(canvas, nodeId) : null;
				if (canvas && node) {
					await this.focusNode(canvas, node, file.path, nodeId);
					return;
				}
				await this.wait(50);
			}

			if (this.settings.showNoticeOnMissingNode) {
				new Notice(`canvas-smooth-linker: 未在 ${file.basename} 中找到节点 ${nodeId}`);
			}
		} finally {
			if (this.isActiveTarget(file.path, nodeId)) this.activeTarget = null;
		}
	}

	/** 供设置面板与调试使用：当前画布的视口语义快照 */
	describeViewport(canvas: CanvasLike): ViewportSnapshot | null {
		return readViewport(canvas);
	}
}

/* =========================================================================
 * 8. 设置面板
 * ========================================================================= */

class CanvasSmoothLinkerSettingTab extends PluginSettingTab {
	private plugin: CanvasSmoothLinkerPlugin;

	constructor(app: App, plugin: CanvasSmoothLinkerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Canvas Smooth Linker" });

		new Setting(containerEl)
			.setName("聚焦缩放")
			.setDesc("点击卡片内链接后，视口缩放到的倍数（1 = 100%）。默认 1.2。")
			.addSlider((slider) =>
				slider
					.setLimits(0.5, 2, 0.05)
					.setValue(this.plugin.settings.targetZoom)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.targetZoom = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("动画时长 (ms)")
			.setDesc("平滑移动的时长，建议 300~400ms。")
			.addSlider((slider) =>
				slider
					.setLimits(300, 400, 10)
					.setValue(this.plugin.settings.animationDuration)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.animationDuration = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("接管跨画布链接")
			.setDesc("开启后，[[其它画布.canvas#节点ID]] 也会由本插件平滑聚焦。")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.interceptCrossCanvasLinks).onChange(async (value) => {
					this.plugin.settings.interceptCrossCanvasLinks = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("跨画布跳转复用当前标签页")
			.setDesc("像 PPT 一样在同一个标签页内翻页；关闭则在新标签页中打开。")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.crossCanvasOpenInCurrentTab).onChange(async (value) => {
					this.plugin.settings.crossCanvasOpenInCurrentTab = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("遵循系统的“减弱动态效果”")
			.setDesc("系统开启减弱动态效果时，直接跳转到目标节点、不播动画。")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.respectReducedMotion).onChange(async (value) => {
					this.plugin.settings.respectReducedMotion = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("找不到节点时提示")
			.setDesc("目标节点 ID 不存在时弹出 Notice。")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showNoticeOnMissingNode).onChange(async (value) => {
					this.plugin.settings.showNoticeOnMissingNode = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("调试日志")
			.setDesc("在开发者控制台输出视口语义探测 / 写入方式 / 自校正过程。")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.debug).onChange(async (value) => {
					this.plugin.settings.debug = value;
					await this.plugin.saveSettings();
				})
			);

		containerEl.createEl("h3", { text: "交互" });

		new Setting(containerEl)
			.setName("渲染显示文字里的 Markdown / 公式")
			.setDesc(
				"开启后，[[画布.canvas#节点ID|显示文字]] 里的 $公式$、**粗体**、==高亮==、" +
					"<span style=\"color:red\">颜色</span> 都会真正生效（别名默认是纯文本）。"
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.renderAliasMarkdown).onChange(async (value) => {
					this.plugin.settings.renderAliasMarkdown = value;
					await this.plugin.saveSettings();
					await this.plugin.applySettingsToUI();
				})
			);

		new Setting(containerEl)
			.setName("悬停不弹出笔记预览")
			.setDesc("鼠标移到画布卡片的链接上时，不再显示笔记概览（保留点击跳转）。")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.suppressHoverPreview).onChange(async (value) => {
					this.plugin.settings.suppressHoverPreview = value;
					await this.plugin.saveSettings();
				})
			);

		containerEl.createEl("h3", { text: "链接外观（画布卡片内）" });

		new Setting(containerEl)
			.setName("颜色跟随主题")
			.setDesc("关闭后使用下面自选的颜色。")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.linkUseThemeColor).onChange(async (value) => {
					this.plugin.settings.linkUseThemeColor = value;
					await this.plugin.saveSettings();
					await this.plugin.applySettingsToUI();
				})
			);

		new Setting(containerEl)
			.setName("链接颜色")
			.setDesc("需要先关闭上面的“颜色跟随主题”。")
			.addColorPicker((picker) =>
				picker.setValue(this.plugin.settings.linkColor).onChange(async (value) => {
					this.plugin.settings.linkColor = value;
					this.plugin.settings.linkUseThemeColor = false;
					await this.plugin.saveSettings();
					await this.plugin.applySettingsToUI();
				})
			);

		new Setting(containerEl)
			.setName("下划线")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.linkUnderline).onChange(async (value) => {
					this.plugin.settings.linkUnderline = value;
					await this.plugin.saveSettings();
					await this.plugin.applySettingsToUI();
				})
			);

		new Setting(containerEl)
			.setName("加粗")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.linkBold).onChange(async (value) => {
					this.plugin.settings.linkBold = value;
					await this.plugin.saveSettings();
					await this.plugin.applySettingsToUI();
				})
			);

		new Setting(containerEl)
			.setName("斜体")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.linkItalic).onChange(async (value) => {
					this.plugin.settings.linkItalic = value;
					await this.plugin.saveSettings();
					await this.plugin.applySettingsToUI();
				})
			);

		new Setting(containerEl)
			.setName("字号 (%)")
			.setDesc("相对卡片正文字号缩放链接，100 = 不缩放。")
			.addSlider((slider) =>
				slider
					.setLimits(80, 160, 5)
					.setValue(Math.round(this.plugin.settings.linkFontScale * 100))
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.linkFontScale = value / 100;
						await this.plugin.saveSettings();
						await this.plugin.applySettingsToUI();
					})
			);

		new Setting(containerEl)
			.setName("悬停背景高亮")
			.setDesc("鼠标移到链接上时加一层背景色，方便在卡片里找到可点的位置。")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.linkHoverBackground).onChange(async (value) => {
					this.plugin.settings.linkHoverBackground = value;
					await this.plugin.saveSettings();
					await this.plugin.applySettingsToUI();
				})
			);

		containerEl.createEl("p", {
			text: "单个链接想要不同颜色/样式：在显示文字里直接写 HTML，例如 [[画布.canvas#ID|<span style=\"color:#e05252;font-weight:700\">第 3 页</span>]]。",
		});

		containerEl.createEl("h3", { text: "画布内操作" });

		new Setting(containerEl)
			.setName("在画布右上角显示「链接样式」按钮")
			.setDesc("点开就能在画布界面直接调链接颜色 / 字号 / 下划线等，不用进设置页。")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showCanvasStyleButton).onChange(async (value) => {
					this.plugin.settings.showCanvasStyleButton = value;
					await this.plugin.saveSettings();
					if (value) this.plugin.syncCanvasStyleButtonNow();
					else this.plugin.removeCanvasStyleButtons();
				})
			);

		containerEl.createEl("p", {
			text: "右键画布卡片里的链接 → 可直接给这一条链接改颜色 / 字号 / 加粗 / 斜体 / 下划线（写进该链接的显示文字里，跟着文件走，支持 Ctrl+Z 撤销）。",
		});

		new Setting(containerEl)
			.setName("已保存的常用色")
			.setDesc(
				this.plugin.settings.customColors.length > 0
					? this.plugin.settings.customColors.join("、")
					: "还没有保存过自定义色。在样式面板里输入 HEX 后点「存为常用」即可添加。"
			)
			.addButton((button) =>
				button.setButtonText("清空").onClick(async () => {
					this.plugin.settings.customColors = [];
					await this.plugin.saveSettings();
					this.display();
				})
			);
	}
}
