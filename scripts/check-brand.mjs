import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateBrand, readEdition } from "./generate-brand.mjs";

const sources = fileURLToPath(new URL("../branding", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "raqsh-brand-check-"));

try {
  const renamedSources = join(scratch, "sources");
  mkdirSync(renamedSources);
  const brand = JSON.parse(readFileSync(join(sources, "brand.json"), "utf8"));
  const edition = readEdition(sources);
  writeFileSync(join(renamedSources, "brand.json"), JSON.stringify({ ...brand, displayName: "Planning Board" }));
  writeFileSync(join(renamedSources, "icon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><circle cx="64" cy="64" r="42" fill="#883b52"/></svg>`);
  const editionPath = join(renamedSources, "edition.json");
  const licensePath = join(renamedSources, "COMMERCIAL-LICENSE.txt");
  writeFileSync(editionPath, '{"id":"invalid"}');
  assert.throws(() => readEdition(renamedSources), /Edition must be noncommercial or commercial/);
  writeFileSync(editionPath, '{"id":"commercial"}');
  assert.throws(() => readEdition(renamedSources), { code: "ENOENT" });
  writeFileSync(licensePath, "\n");
  assert.throws(() => readEdition(renamedSources), /edition license is empty/);
  writeFileSync(licensePath, "Commercial build test fixture\n");

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
  assert.equal(config(original).bundle.license, edition.packageLicense);
  assert.equal(config(original).plugins.updater.endpoints.length, edition.publicUpdates ? 1 : 0);
  assert.equal(readFileSync(join(original, "src-tauri/generated/edition"), "utf8"), edition.id);
  assert.equal(readFileSync(join(original, "src-tauri/generated/Raqsh-LICENSE.txt"), "utf8"), edition.license);
  assert.equal(config(renamed).bundle.license, "LicenseRef-Raqsh-Commercial");
  assert.deepEqual(config(renamed).plugins.updater.endpoints, []);
  assert.equal(readFileSync(join(renamed, "src-tauri/generated/edition"), "utf8"), "commercial");
  assert.equal(readFileSync(join(renamed, "src-tauri/generated/Raqsh-LICENSE.txt"), "utf8"), "Commercial build test fixture\n");
  assert.match(readFileSync(join(renamed, "src/generated/edition.ts"), "utf8"), /"publicUpdates": false/);
  assert.match(readFileSync(join(renamed, "src/generated/brand.ts"), "utf8"), /"displayName": "Planning Board"/);
  assert.match(readFileSync(join(renamed, "src-tauri/generated/main.desktop"), "utf8"), /^Name=Planning Board$/m);
  assert.match(readFileSync(join(renamed, "src-tauri/generated/Info.plist"), "utf8"), /<string>Planning Board<\/string>/);
  const originalIcon = readFileSync(join(sources, "icon.svg"), "utf8");
  assert.equal(readFileSync(join(original, "src/generated/icon.svg"), "utf8"),
    originalIcon.replaceAll('fill="currentColor"', `fill="${brand.accent}"`));
  for (const icon of config(original).bundle.icon) {
    assert.notDeepEqual(readFileSync(join(original, "src-tauri", icon)), readFileSync(join(renamed, "src-tauri", icon)));
  }
  console.log("Verified branding, application identity, edition inputs, licenses, and updater configuration.");
} finally {
  rmSync(scratch, { force: true, recursive: true });
}
