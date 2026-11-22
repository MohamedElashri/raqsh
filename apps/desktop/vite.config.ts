import { defineConfig } from "vite";
import { brand } from "./src/generated/brand.ts";

const htmlEntities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

export default defineConfig({
  base: "./",
  publicDir: ".generated-public",
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  plugins: [{
    name: "app-title",
    transformIndexHtml(html) {
      const title = brand.displayName.replace(/[&<>]/g, (character) => htmlEntities[character]);
      return html.replace("<title></title>", () => `<title>${title}</title>`);
    },
  }],
});
