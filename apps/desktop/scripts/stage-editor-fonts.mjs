import { cp, mkdir, rm } from "node:fs/promises";

const target = new URL("../.generated-public/fonts/", import.meta.url);
const source = new URL("../node_modules/@excalidraw/excalidraw/dist/prod/fonts/Excalifont/", import.meta.url);
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, new URL("Excalifont/", target), { recursive: true });
