import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [tag, directory] = process.argv.slice(2);
if (!/^v\d+\.\d+\.\d+$/.test(tag) || !directory) {
  throw new Error("Expected a version tag and a release asset directory.");
}

// Tauri stores a base64-encoded minisign file. Match each signature to the public
// key embedded in the desktop builds before publishing the manifest.
function keyId(value, size) {
  const line = Buffer.from(value.trim(), "base64").toString("utf8").split(/\r?\n/)[1] ?? "";
  const record = Buffer.from(line, "base64");
  if (record.length !== size) throw new Error("Invalid Tauri updater key or signature.");
  return record.subarray(2, 10).toString("hex");
}

const publicId = keyId(process.env.RAQSH_UPDATER_PUBLIC_KEY ?? "", 42);
const prefix = `https://github.com/MohamedElashri/raqsh/releases/download/${tag}`;
const assets = {
  "darwin-aarch64": "raqsh-macos-universal.app.tar.gz",
  "darwin-x86_64": "raqsh-macos-universal.app.tar.gz",
  "linux-x86_64-deb": "raqsh-linux-x86_64.deb",
  "linux-x86_64-rpm": "raqsh-linux-x86_64.rpm",
};
const platforms = Object.fromEntries(Object.entries(assets).map(([target, asset]) => {
  const signature = readFileSync(join(directory, `${asset}.sig`), "utf8").trim();
  if (keyId(signature, 74) !== publicId) throw new Error(`Updater signing key mismatch for ${asset}.`);
  return [target, { url: `${prefix}/${asset}`, signature }];
}));
writeFileSync(join(directory, "latest.json"), `${JSON.stringify({ version: tag.slice(1), platforms }, null, 2)}\n`);
