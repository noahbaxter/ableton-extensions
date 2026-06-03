import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const production = process.argv.includes("--production");

// Bundle the popup's TypeScript controller (popup.ts, which shares select.ts) into
// an IIFE and inline it into popup.html, so the popup holds no duplicated logic.
const inlinePopupJs: esbuild.Plugin = {
  name: "inline-popup-js",
  setup(build) {
    build.onLoad({ filter: /popup\.html$/ }, async (args) => {
      const html = await fs.promises.readFile(args.path, "utf8");
      const controller = path.join(path.dirname(args.path), "popup.ts");
      const bundled = await esbuild.build({
        entryPoints: [controller],
        bundle: true,
        format: "iife",
        platform: "browser",
        write: false,
        minify: production,
        logLevel: "silent",
      });
      const js = bundled.outputFiles[0]!.text;
      return {
        contents: html.replace("/* __POPUP_JS__ */", () => js),
        loader: "text",
        watchFiles: [controller],
      };
    });
  },
};

await esbuild.build({
  entryPoints: ["src/extension.ts"],
  outfile: manifest.entry,
  bundle: true,
  format: "cjs",
  platform: "node",
  sourcesContent: false,
  logLevel: "info",
  minify: production,
  sourcemap: !production,
  loader: { ".html": "text" },
  plugins: [inlinePopupJs],
});
