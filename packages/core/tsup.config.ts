import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	outDir: "dist",
	sourcemap: true,
	clean: true,
	format: ["esm"], // Ensure you're targeting CommonJS
	platform: "node",
	target: "node23",
	bundle: true,
	splitting: true, // Add this for better code splitting
	dts: false, // Disable type generation
	// Use esbuild's simpler DTS generation
	tsconfig: "./tsconfig.build.json", // Use build-specific tsconfig
	external: [
		"dotenv", // Externalize dotenv to prevent bundling
		"fs", // Externalize fs to use Node.js built-in module
		"path", // Externalize other built-ins if necessary
		"node:fs",
		"node:path",
		"http",
		"https",
		"sharp",
	],
	// Improve source map configuration
	esbuildOptions(options) {
		options.sourceRoot = "./"; // Set source root to help with source mapping
		options.sourcesContent = true;
		options.outbase = "./src"; // Makes output paths match input structure
	},
	keepNames: true, // Preserve names for better debugging
});
