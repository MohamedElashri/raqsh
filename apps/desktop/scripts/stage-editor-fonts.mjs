import { cp, rm } from "node:fs/promises";

const target = new URL("../.generated-public/fonts/", import.meta.url);
const source = new URL("../node_modules/@excalidraw/excalidraw/dist/prod/fonts/", import.meta.url);
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
