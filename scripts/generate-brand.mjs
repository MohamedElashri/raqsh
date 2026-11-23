import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const desktop = join(root, "apps/desktop");
const tauriBase = JSON.parse(readFileSync(join(desktop, "src-tauri/tauri.base.json"), "utf8"));
const run = promisify(execFile);

function writeGenerated(path, content) {
  const bytes = Buffer.from(content);
  if (existsSync(path) && readFileSync(path).equals(bytes)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function readBrand(sources) {
  const { displayName, tagline, accent } = JSON.parse(readFileSync(join(sources, "brand.json"), "utf8"));
  if (typeof displayName !== "string" || !displayName.trim() || /[\u0000-\u001f\u007f/\\]/u.test(displayName)) {
    throw new Error("Brand displayName must be a nonempty name without control characters or path separators.");
  }
  if (typeof tagline !== "string" || typeof accent !== "string" || !/^#[0-9a-f]{6}$/i.test(accent)) {
    throw new Error("Brand requires a tagline and a six-digit accent color.");
  }
  return { displayName, tagline, accent };
}

export function readEdition(sources) {
  const { id } = JSON.parse(readFileSync(join(sources, "edition.json"), "utf8"));
  if (id !== "noncommercial" && id !== "commercial") {
    throw new Error("Edition must be noncommercial or commercial.");
  }
  const commercial = id === "commercial";
  const licensePath = commercial ? join(sources, "COMMERCIAL-LICENSE.txt") : join(root, "LICENSE");
  const license = readFileSync(licensePath, "utf8");
  if (!license.trim()) throw new Error("The edition license is empty.");
  return {
    id,
    label: commercial ? "Commercial edition" : "Noncommercial edition",
    summary: commercial ? "Licensed for commercial use." : "Free for personal and other permitted noncommercial use.",
    licenseTitle: commercial ? "Raqsh Commercial License" : "PolyForm Noncommercial License 1.0.0",
    packageLicense: commercial ? "LicenseRef-Raqsh-Commercial" : "PolyForm-Noncommercial-1.0.0",
    publicUpdates: !commercial,
    license,
  };
}

export async function generateBrand(sources = join(root, "branding"), output = desktop) {
  const brand = readBrand(sources);
  const { id, label, summary, licenseTitle, packageLicense, publicUpdates, license } = readEdition(sources);
  const svg = readFileSync(join(sources, "icon.svg"), "utf8").replaceAll('fill="currentColor"', `fill="${brand.accent}"`);
  const tauri = structuredClone(tauriBase);
  tauri.app.windows[0].title = brand.displayName;
  tauri.bundle.license = packageLicense;
  if (!publicUpdates) tauri.plugins.updater.endpoints = [];
  const markupEscapes = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
  const plistName = brand.displayName.replace(/[&<>]/g, (character) => markupEscapes[character]);
  const desktopName = brand.displayName.replaceAll("{{", "\\{{");

  const scratch = mkdtempSync(join(tmpdir(), "raqsh-icons-"));
  try {
    const iconPath = join(scratch, "source.svg");
    const iconOutput = join(scratch, "icons");
    writeGenerated(iconPath, svg);
    await run("pnpm", ["exec", "tauri", "icon", iconPath, "--output", iconOutput], { cwd: root });
    for (const icon of tauri.bundle.icon) {
      writeGenerated(join(output, "src-tauri", icon), readFileSync(join(iconOutput, icon.slice("icons/".length))));
    }
    writeGenerated(join(output, "src-tauri/tauri.conf.json"), `${JSON.stringify(tauri, null, 2)}\n`);
    writeGenerated(join(output, "src-tauri/generated/Raqsh-LICENSE.txt"), license);
    writeGenerated(join(output, "src-tauri/generated/edition"), id);
    writeGenerated(join(output, "src-tauri/generated/main.desktop"), `[Desktop Entry]
Type=Application
Name=${desktopName}
Comment={{comment}}
Exec={{exec}}
Icon={{icon}}
Categories={{categories}}
StartupWMClass={{icon}}
Terminal=false
`);
    writeGenerated(join(output, "src-tauri/generated/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDisplayName</key><string>${plistName}</string>
  <key>CFBundleName</key><string>${plistName}</string>
</dict></plist>
`);
    writeGenerated(join(output, "src/generated/icon.svg"), svg);
    writeGenerated(join(output, "src/generated/brand.css"), `:root { --brand-accent: ${brand.accent}; }\n`);
    writeGenerated(join(output, "src/generated/brand.ts"), `export const brand = ${JSON.stringify(brand, null, 2)} as const;\n`);
    const edition = { label, summary, licenseTitle, publicUpdates };
    writeGenerated(join(output, "src/generated/edition.ts"), `export const edition = ${JSON.stringify(edition, null, 2)} as const;\n`);
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await generateBrand();
}
