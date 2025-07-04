import { defineConfig, type Options } from "tsup";

export const tsupConfig: Partial<Options> = {
  format: ["esm", "cjs"],
  target: "es2022",
  clean: true,
  splitting: false,
  sourcemap: true,
  minify: false,
  bundle: true,
  skipNodeModulesBundle: true,
  treeshake: true,
};

export default defineConfig(tsupConfig); 