import { defineConfig } from "tsup";

// Builds ESM + CJS output with declarations and source maps. Both
// formats are actually built and covered by the pack/install smoke test
// (test/pack.test.ts) before either is claimed as supported.
export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    minify: false,
    target: "es2022",
});
