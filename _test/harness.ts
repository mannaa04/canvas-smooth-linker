/*
 * 视口数学回归测试。
 *
 * 在 Node 里模拟 Obsidian 1.13.7 的 Canvas：
 *   - .canvas 的 transform = translate(W/2, H/2) scale(s) translate(-x, -y)
 *   - canvas.x/.y = 视口中心（画布坐标），canvas.zoom = log2(scale)，canvas.scale = scale
 *   - setViewport / markViewportChanged 会立即把 transform 写进 DOM
 * 再断言插件“聚焦节点”后，目标节点中心确实落在视口中心上。
 */

import CanvasSmoothLinkerPlugin, {
	easeInOutQuad,
	parseCanvasNodeLink,
	readViewport,
	type CanvasNodeLike,
} from "../main";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
	if (ok) {
		console.log(`  PASS  ${name}`);
	} else {
		failures += 1;
		console.log(`  FAIL  ${name}`, detail ?? "");
	}
}

function approx(actual: number, expected: number, tol: number): boolean {
	return Math.abs(actual - expected) <= tol;
}

/* ------------------------------------------------------------------ */
/* 虚拟窗口 + 虚拟画布                                                  */
/* ------------------------------------------------------------------ */

interface FakeWin {
	clock: number;
	queue: Array<(t: number) => void>;
	performance: { now: () => number };
	requestAnimationFrame: (cb: (t: number) => void) => number;
	addEventListener: () => void;
	removeEventListener: () => void;
	matchMedia: () => { matches: boolean };
	document: unknown;
}

function createFakeWin(): FakeWin {
	const win: FakeWin = {
		clock: 0,
		queue: [],
		performance: { now: () => win.clock },
		requestAnimationFrame(cb) {
			win.queue.push(cb);
			return win.queue.length;
		},
		addEventListener() {},
		removeEventListener() {},
		matchMedia: () => ({ matches: false }),
		document: null,
	};
	win.document = { defaultView: win };
	return win;
}

async function drive(win: FakeWin, frames: number): Promise<void> {
	for (let i = 0; i < frames; i++) {
		win.clock += 16.7;
		const pending = win.queue.splice(0, win.queue.length);
		for (const cb of pending) cb(win.clock);
		await new Promise((resolve) => setImmediate(resolve));
	}
}

type Semantics = "canvas-1.13" | "canvas-clamped-zoom" | "legacy-offset" | "legacy-linear-zoom";

interface FakeCanvas {
	canvas: any;
	canvasEl: any;
	win: FakeWin;
	/** 每次重绘记录一次，用于断言动画是否平滑 */
	renders: Array<{ t: number; cx: number; cy: number; scale: number }>;
	/** 把 DOM 矩阵换算回“画布坐标下的视口中心”，用于断言真实渲染结果 */
	screenOf: (x: number, y: number) => { x: number; y: number };
}

function createFakeCanvas(
	size: { width: number; height: number },
	semantics: Semantics,
	initial = { centerX: 0, centerY: 0, scale: 1 }
): FakeCanvas {
	const win = createFakeWin();
	const canvasEl: any = { style: {}, _matrix: "none" };
	const wrapperEl: any = {
		getBoundingClientRect: () => ({
			left: 0,
			top: 0,
			right: size.width,
			bottom: size.height,
			width: size.width,
			height: size.height,
			x: 0,
			y: 0,
		}),
		clientWidth: size.width,
		clientHeight: size.height,
		addEventListener() {},
		removeEventListener() {},
	};
	canvasEl.ownerDocument = win.document;

	const canvas: any = {
		nodes: new Map<string, CanvasNodeLike>(),
		canvasEl,
		wrapperEl,
		x: initial.centerX,
		y: initial.centerY,
		tx: initial.centerX,
		ty: initial.centerY,
		scale: initial.scale,
	};

	if (semantics === "canvas-1.13" || semantics === "canvas-clamped-zoom") {
		// canvas-clamped-zoom 模拟“某版本把最大缩放压到 100%”的情形：
		// 插件申请 1.2 也只会得到 1.0，用来验证自校正不会来回抖动
		const maxLog2 = semantics === "canvas-clamped-zoom" ? 0 : 1;
		canvas.zoom = Math.log2(initial.scale);
		canvas.tZoom = canvas.zoom;
		canvas.markViewportChanged = () => render();
		canvas.setViewport = (x: number, y: number, zoom: number) => {
			const z = Math.max(-4, Math.min(maxLog2, zoom));
			canvas.x = canvas.tx = x;
			canvas.y = canvas.ty = y;
			canvas.zoom = canvas.tZoom = z;
			canvas.scale = Math.pow(2, z);
			render();
		};
	} else if (semantics === "legacy-offset") {
		// 旧语义：x/y 是「画布原点在屏幕上的位移」，zoom 仍是 log2
		canvas.zoom = Math.log2(initial.scale);
		canvas.tZoom = canvas.zoom;
		canvas.markViewportChanged = () => render();
	} else {
		// 旧语义：zoom 直接就是缩放倍数，没有 scale 字段
		delete canvas.scale;
		canvas.zoom = initial.scale;
		canvas.tZoom = initial.scale;
		canvas.markViewportChanged = () => render();
	}

	/** 按各版本的语义把当前状态渲染成 DOM 矩阵 */
	function render(): void {
		let scale: number;
		let offsetX: number;
		let offsetY: number;

		if (semantics === "canvas-1.13" || semantics === "canvas-clamped-zoom") {
			scale = Math.pow(2, canvas.zoom);
			offsetX = size.width / 2 - canvas.x * scale;
			offsetY = size.height / 2 - canvas.y * scale;
			canvas.scale = scale;
		} else if (semantics === "legacy-offset") {
			scale = Math.pow(2, canvas.zoom);
			offsetX = canvas.x;
			offsetY = canvas.y;
		} else {
			scale = canvas.zoom;
			offsetX = size.width / 2 - canvas.tx * scale;
			offsetY = size.height / 2 - canvas.ty * scale;
		}

		canvasEl._matrix = `matrix(${scale}, 0, 0, ${scale}, ${offsetX}, ${offsetY})`;
		canvasEl.style.transform = canvasEl._matrix;

		renders.push({
			t: win.clock,
			cx: (size.width / 2 - offsetX) / scale,
			cy: (size.height / 2 - offsetY) / scale,
			scale,
		});
	}

	const renders: Array<{ t: number; cx: number; cy: number; scale: number }> = [];
	render();

	return {
		canvas,
		canvasEl,
		win,
		renders,
		screenOf: (x: number, y: number) => {
			const m = /matrix\(([^)]+)\)/.exec(canvasEl._matrix);
			const p = (m?.[1] ?? "1,0,0,1,0,0").split(",").map(Number);
			return { x: p[4] + x * p[0], y: p[5] + y * p[3] };
		},
	};
}

/* 让插件代码里的 getComputedStyle(canvasEl) 能读到我们写的矩阵 */
(globalThis as any).getComputedStyle = (el: any) => ({ transform: el?._matrix ?? "none" });

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

async function testFocus(semantics: Semantics, expectedScale = 1.2): Promise<void> {
	const size = { width: 1200, height: 800 };
	const fake = createFakeCanvas(size, semantics, { centerX: 0, centerY: 0, scale: 1 });
	const node: CanvasNodeLike = {
		id: "1a2b3c4d5e6f7788",
		x: 1000,
		y: 600,
		width: 200,
		height: 100,
		getBBox: () => ({ minX: 1000, minY: 600, maxX: 1200, maxY: 700 }),
	};
	fake.canvas.nodes.set(node.id!, node);

	const plugin: any = new CanvasSmoothLinkerPlugin({ workspace: { containerEl: null } } as any);
	plugin.settings = {
		targetZoom: 1.2,
		animationDuration: 350,
		interceptCrossCanvasLinks: true,
		crossCanvasOpenInCurrentTab: true,
		respectReducedMotion: false,
		showNoticeOnMissingNode: false,
		debug: false,
	};

	console.log(`\n[${semantics}] 聚焦节点 ${node.id} → 中心应为 (1100, 650), scale ${expectedScale}`);

	const snapshot = readViewport(fake.canvas);
	check(`${semantics}: readViewport 可读`, !!snapshot, snapshot);
	// legacy-offset 版本里字段是屏幕位移，初始位移 (0,0) 对应视口中心 (600,400)
	const expectedStartX = semantics === "legacy-offset" ? size.width / 2 : 0;
	const expectedStartY = semantics === "legacy-offset" ? size.height / 2 : 0;
	check(
		`${semantics}: 起始视口中心 = (${expectedStartX}, ${expectedStartY}), scale=1`,
		!!snapshot &&
			approx(snapshot.centerX, expectedStartX, 1) &&
			approx(snapshot.centerY, expectedStartY, 1) &&
			approx(snapshot.scale, 1, 0.001),
		snapshot
	);

	// 真正走一遍 focusNode（含 rAF 动画 + settleAndVerify 自校正）
	const renderCountBefore = fake.renders.length;
	const animateStartClock = fake.win.clock;
	const running = plugin.focusNode(fake.canvas, node, "画布.canvas", node.id);
	await drive(fake.win, 120);
	await running;
	const frames = fake.renders.slice(renderCountBefore);

	const after = readViewport(fake.canvas);
	check(
		`${semantics}: 最终视口中心 = 节点中心`,
		!!after && approx(after.centerX, 1100, 1.5) && approx(after.centerY, 650, 1.5),
		after
	);
	check(
		`${semantics}: 最终缩放 = ${expectedScale}`,
		!!after && approx(after.scale, expectedScale, 0.005),
		after?.scale
	);

	// 用真实渲染出来的矩阵验证：节点中心确实落在视口中心（600, 400）
	const screen = fake.screenOf(1100, 650);
	check(
		`${semantics}: 渲染矩阵把节点中心放在 (600, 400)`,
		approx(screen.x, size.width / 2, 2) && approx(screen.y, size.height / 2, 2),
		screen
	);

	// 反向验证：readViewport 从 DOM 反解出的中心应与字段一致
	check(
		`${semantics}: DOM 反解中心与字段一致`,
		!!after && approx((size.width / 2 - Number(/matrix\(([^)]+)\)/.exec(fake.canvasEl._matrix)![1].split(",")[4])) / Number(/matrix\(([^)]+)\)/.exec(fake.canvasEl._matrix)![1].split(",")[0]), after.centerX, 2),
		fake.canvasEl._matrix
	);

	// ---- 动画本身的验收：时长、步数、单调、缓动形状 ----
	const first = frames[0];
	const last = frames[frames.length - 1];
	const startCx = snapshot ? snapshot.centerX : 0;
	const span = 1100 - startCx;
	const arrived = frames.find((f) => approx(f.cx, 1100, 1.5));
	const arrivedMs = arrived ? arrived.t - animateStartClock : Number.POSITIVE_INFINITY;
	check(
		`${semantics}: 视口在 300~400ms 之间抵达目标中心`,
		arrivedMs >= 300 && arrivedMs <= 400,
		arrivedMs
	);
	check(
		`${semantics}: 300ms 之前没有提前抵达（确实是平滑移动）`,
		frames.filter((f) => f.t - animateStartClock < 300).every((f) => !approx(f.cx, 1100, 1.5))
	);
	check(`${semantics}: 动画有足够多的帧`, frames.length >= 15, frames.length);
	check(
		`${semantics}: 位置单调推进（无回跳）`,
		frames.every((f, i) => i === 0 || f.cx >= frames[i - 1].cx - 0.001)
	);
	check(
		`${semantics}: 首帧不是终点（没有瞬移）`,
		!!first && Math.abs(first.cx - startCx) < Math.abs(span) * 0.1,
		first?.cx
	);

	// 逐帧核对：第 t 帧的位置必须等于 easeInOutQuad((t - start) / 350) 插值
	const duration = 350;
	const sample = frames.reduce(
		(best, f) => (Math.abs(f.t - animateStartClock - 175) < Math.abs(best.t - animateStartClock - 175) ? f : best),
		frames[0]
	);
	const p = (sample.t - animateStartClock) / duration;
	const expectedCx = startCx + span * easeInOutQuad(p);
	check(
		`${semantics}: 第 ${Math.round(sample.t - animateStartClock)}ms 帧符合 easeInOutQuad（p=${p.toFixed(3)} → ${expectedCx.toFixed(1)}）`,
		approx(sample.cx, expectedCx, 1),
		sample.cx
	);
	check(
		`${semantics}: 缓动两端慢中间快（首帧位移 < 线性值）`,
		!!first && first.cx - startCx < span * ((first.t - animateStartClock) / duration),
		first?.cx
	);
	check(
		`${semantics}: 缩放单调递增到 ${expectedScale}`,
		frames.every((f, i) => i === 0 || f.scale >= frames[i - 1].scale - 1e-6) &&
			approx(last.scale, expectedScale, 0.005),
		last?.scale
	);
}

async function testParse(): Promise<void> {
	console.log("\n[链接解析]");
	const cases: Array<[string, string | null, string]> = [
		["画布.canvas#1a2b3c4d5e6f7788", "1a2b3c4d5e6f7788", "画布.canvas"],
		["画布.canvas#1a2b3c4d5e6f7788|显示文字", "1a2b3c4d5e6f7788", "画布.canvas"],
		["#1a2b3c4d5e6f7788", "1a2b3c4d5e6f7788", ""],
		["画布.canvas#^1a2b3c4d5e6f7788", "1a2b3c4d5e6f7788", "画布.canvas"],
		["folder/画布 名.canvas#abc123", "abc123", "folder/画布 名.canvas"],
		// 非十六进制的子路径也会被“宽松解析”，但真正的接管还要过两道闸门：
		// 目标文件必须是 .canvas，且在画布里必须真的存在这个节点 ID。
		["笔记#某标题", "某标题", "笔记"],
		["笔记.canvas", null, "笔记.canvas"],
	];
	for (const [href, expectedId, expectedPath] of cases) {
		const anchor = {
			getAttribute: (name: string) => (name === "data-href" ? href : null),
		} as unknown as Element;
		const parsed = parseCanvasNodeLink(anchor);
		check(
			`解析 "${href}"`,
			!!parsed && parsed.nodeId === expectedId && parsed.path === expectedPath,
			parsed
		);
	}
}

function testEase(): void {
	console.log("\n[缓动]");
	check("ease(0) = 0", approx(easeInOutQuad(0), 0, 1e-9));
	check("ease(0.5) = 0.5", approx(easeInOutQuad(0.5), 0.5, 1e-9));
	check("ease(1) = 1", approx(easeInOutQuad(1), 1, 1e-9));
	check("单调递增", easeInOutQuad(0.25) < easeInOutQuad(0.5) && easeInOutQuad(0.5) < easeInOutQuad(0.75));
	check("两端慢中间快", easeInOutQuad(0.1) < 0.1 && easeInOutQuad(0.9) > 0.9);
}

async function main(): Promise<void> {
	testEase();
	await testParse();
	await testFocus("canvas-1.13");
	await testFocus("canvas-clamped-zoom", 1);
	await testFocus("legacy-offset");
	await testFocus("legacy-linear-zoom");

	console.log(failures === 0 ? "\n全部通过 ✅" : `\n失败 ${failures} 项 ❌`);
	if (failures > 0) process.exit(1);
}

void main();
