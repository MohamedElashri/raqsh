import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateBrand } from "./generate-brand.mjs";

const sources = fileURLToPath(new URL("../branding", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "raqsh-brand-check-"));

try {
  const renamedSources = join(scratch, "sources");
  mkdirSync(renamedSources);
  const brand = JSON.parse(readFileSync(join(sources, "brand.json"), "utf8"));
  writeFileSync(join(renamedSources, "brand.json"), JSON.stringify({ ...brand, displayName: "Planning Board" }));
  writeFileSync(join(renamedSources, "icon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><circle cx="64" cy="64" r="42" fill="#883b52"/></svg>`);

  const original = join(scratch, "original");
  const renamed = join(scratch, "renamed");
  await generateBrand(sources, original);
  await generateBrand(renamedSources, renamed);

  const config = (path) => JSON.parse(readFileSync(join(path, "src-tauri/tauri.conf.json"), "utf8"));
  assert.equal(config(original).app.windows[0].title, brand.displayName);
  assert.equal(config(original).productName, "Raqsh");
  assert.equal(config(renamed).productName, config(original).productName);
  assert.equal(config(renamed).app.windows[0].title, "Planning Board");
  assert.equal(config(renamed).identifier, config(original).identifier);
  assert.match(readFileSync(join(renamed, "src/generated/brand.ts"), "utf8"), /"displayName": "Planning Board"/);
  assert.match(readFileSync(join(renamed, "src-tauri/generated/main.desktop"), "utf8"), /^Name=Planning Board$/m);
  assert.match(readFileSync(join(renamed, "src-tauri/generated/Info.plist"), "utf8"), /<string>Planning Board<\/string>/);
  const originalIcon = readFileSync(join(sources, "icon.svg"), "utf8");
  assert.equal(readFileSync(join(original, "src/generated/icon.svg"), "utf8"),
    originalIcon.replaceAll('fill="currentColor"', `fill="${brand.accent}"`));
  for (const icon of config(original).bundle.icon) {
    assert.notDeepEqual(readFileSync(join(original, "src-tauri", icon)), readFileSync(join(renamed, "src-tauri", icon)));
  }
  console.log("Verified the product name, application ID, window title, and platform icons.");
} finally {
  rmSync(scratch, { force: true, recursive: true });
}
