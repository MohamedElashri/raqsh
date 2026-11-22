// Excalidraw reads this path during module initialization.
Object.assign(window, { EXCALIDRAW_ASSET_PATH: new URL("./", document.baseURI).href });
