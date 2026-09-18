import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

await esbuild.build({
	entryPoints: ["_test/harness.ts"],
	bundle: true,
	platform: "node",
	format: "cjs",
	outfile: "_test/harness.cjs",
	logLevel: "info",
	plugins: [
		{
			name: "stub-obsidian",
			setup(build) {
				build.onResolve({ filter: /^obsidian$/ }, () => ({
					path: fileURLToPath(new URL("./obsidian-stub.ts", import.meta.url)),
				}));
			},
		},
	],
});
