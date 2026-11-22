import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

async function waitFor(check, description) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await check();
    if (result) return result;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function loopbackPort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

async function inspect(address) {
  const path = await waitFor(async () => {
    try {
      const response = await fetch(`http://${address}/`);
      return (await response.text()).match(/\/socket\/\d+\/\d+\/WebPage/)?.[0];
    } catch {
      return undefined;
    }
  }, "a local inspectable page");
  const socket = new WebSocket(`ws://${address}${path}`);
  let targetId;
  let next = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Target.targetCreated" && message.params.targetInfo.type === "page") {
      targetId = message.params.targetInfo.targetId;
    } else if (message.method === "Target.dispatchMessageFromTarget") {
      const reply = JSON.parse(message.params.message);
      pending.get(reply.id)?.(reply);
    }
  });
  try {
    await waitFor(() => targetId, "the WebKit page target");
    return {
      close: () => socket.close(),
      request(method, params = {}) {
        const id = ++next;
        return new Promise((done, failed) => {
          const timeout = setTimeout(() => {
            pending.delete(id);
            failed(new Error(`WebKit did not answer ${method}`));
          }, 12_000);
          pending.set(id, (response) => {
            pending.delete(id);
            clearTimeout(timeout);
            if (response.error) failed(new Error(response.error.message));
            else done(response.result);
          });
          socket.send(JSON.stringify({ id, method: "Target.sendMessageToTarget", params: { targetId, message: JSON.stringify({ id, method, params }) } }));
        });
      },
    };
  } catch (error) {
    socket.close();
    throw error;
  }
}

async function profile(binary, library) {
  const address = `127.0.0.1:${await loopbackPort()}`;
  const app = spawn(resolve(binary), ["--fixture=normal", "--phase-zero-probe"], {
    env: { ...process.env, WEBKIT_INSPECTOR_HTTP_SERVER: address, LD_PRELOAD: library },
    stdio: "ignore",
  });
  let inspector;
  try {
    inspector = await inspect(address);
    const evaluate = async (expression) => {
      const response = await inspector.request("Runtime.evaluate", { expression, returnByValue: true });
      if (response.wasThrown) throw new Error(response.result.description);
      return response.result.value;
    };
    const snapshot = async () => {
      const { snapshotData } = await inspector.request("Heap.snapshot");
      const { type, version, nodes } = JSON.parse(snapshotData);
      if (type !== "Inspector" || version !== 3 || !nodes.length || nodes.length % 4) {
        throw new Error("Unexpected JavaScriptCore heap snapshot format");
      }
      let bytes = 0;
      for (let index = 1; index < nodes.length; index += 4) bytes += nodes[index];
      return { described_js_bytes: bytes, nodes: nodes.length / 4 - 1 };
    };

    await waitFor(() => evaluate('document.querySelector(".board-editor")?.dataset.editorReady === "true"'), "normal-board mount");
    const view = await evaluate(`({ count: Number(document.querySelector(".board-editor").dataset.initialElements),
      backing: [...document.querySelectorAll(".board-editor canvas")].map((canvas) => [canvas.width, canvas.height]),
      callbacks: Number(document.querySelector(".board-editor").dataset.sceneCallbacks ?? 0) })`);
    if (view.count !== 800) throw new Error("The normal fixture did not finish loading");
    await inspector.request("Heap.enable");
    const mounted = await snapshot();
    await evaluate('document.querySelector(".zoom-in-button").click()');
    await sleep(500);
    const viewportCallbacks = (await evaluate('Number(document.querySelector(".board-editor").dataset.sceneCallbacks ?? 0)')) - view.callbacks;
    await evaluate('document.querySelector(".board-header button").click()');
    await waitFor(() => evaluate('!document.querySelector(".board-editor") && !!document.querySelector(".board-picker")'), "editor unmount");
    const closed = await snapshot();
    return {
      binary_sha256: createHash("sha256").update(await readFile(binary)).digest("hex"),
      normal: mounted, closed, viewport_callback_delta: viewportCallbacks,
      normal_canvas_sizes_px: view.backing,
      nominal_normal_canvas_rgba_bytes: view.backing.reduce((total, [width, height]) => total + 4 * width * height, 0),
    };
  } finally {
    inspector?.close();
    if (app.exitCode === null && app.signalCode === null) {
      app.kill();
      await once(app, "exit");
    }
  }
}

const [excalidraw, canvas, output] = process.argv.slice(2);
if (!output) throw new Error("Supply an Excalidraw binary, a Canvas2D binary, and an output JSON path.");
const scratch = await mkdtemp(join(tmpdir(), "board-heap-"));
try {
  const library = join(scratch, "inspector.so");
  await promisify(execFile)("cc", ["-shared", "-fPIC", "-o", library, fileURLToPath(new URL("./webkit-inspector.c", import.meta.url)), "-ldl"]);
  const measurements = {
    method: "Loopback-only WebKit Inspector. Inspector snapshots describe live JavaScript allocations and run full collection. Canvas RGBA bytes are nominal dimensions. This diagnostic run is separate from release timing and process memory gates.",
    excalidraw: await profile(excalidraw, library),
    canvas2d: await profile(canvas, library),
  };
  await writeFile(output, `${JSON.stringify(measurements, null, 2)}\n`);
  console.log(JSON.stringify(measurements, null, 2));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
