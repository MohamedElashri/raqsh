// Injected by the macOS live-test build into the real Tauri webview.
(() => {
  const title = "macOS live test — مراجعة";
  const find = (selector) => document.querySelector(selector);
  const report = (event, details = {}) => {
    document.title = `raqsh-live:${JSON.stringify({ event, ...details })}`;
  };
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  async function waitFor(test, description, timeout = 10_000) {
    const deadline = performance.now() + timeout;
    do {
      const result = test();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (performance.now() < deadline);
    throw new Error(`Timed out waiting for ${description}. ${document.body.innerText.slice(0, 750)}`);
  }
  const button = (label) => [...document.querySelectorAll("button")].find((element) =>
    element.textContent.trim() === label && !element.disabled);
  const canvas = () => find("[data-board-surface]");
  function key(value, modifiers = {}) {
    canvas().focus();
    canvas().dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...modifiers }));
  }
  function pointer(type, x, y) {
    const bounds = canvas().getBoundingClientRect();
    canvas().dispatchEvent(new PointerEvent(type, {
      pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1,
      clientX: bounds.left + x, clientY: bounds.top + y, bubbles: true,
    }));
  }
  function painted(x, y) {
    const ratio = devicePixelRatio;
    const pixels = canvas().getContext("2d").getImageData(Math.round(x * ratio), Math.round(y * ratio), 6, 6).data;
    return pixels.some((value, index) => index % 4 === 3 && value > 0);
  }
  async function createCard() {
    key("n");
    const field = await waitFor(() => find('.lean-edit textarea[name="title"]'), "the N shortcut to open Add card");
    field.value = title;
    button("Create card").click();
    return waitFor(() => find(".lean-card"), "the saved card");
  }

  async function run() {
    const started = performance.now();
    const editor = await waitFor(() => find('[data-editor-ready="true"]'), "the first editor paint");
    const mode = window.__RAQSH_LIVE_MODE__;
    check(canvas().width === Math.round(canvas().clientWidth * devicePixelRatio), "Canvas backing width must match the device scale");
    if (mode === "reopen") {
      check(find(".lean-card")?.textContent.includes(title), "The card title did not survive reopening");
      check(find(".lean-card").dataset.status === "done", "The MCP status did not survive reopening");
      check(painted(120, 224), "The drawing did not survive reopening");
      report("pass", { mode });
      return;
    }

    // Synthetic pointer events cannot acquire the OS's pointer capture.
    canvas().setPointerCapture = () => {};
    if (mode === "stress") {
      const initialPaintMs = performance.now() - started;
      check(editor.dataset.initialElements === "3500", "The stress fixture did not load in full");
      key("e");
      await waitFor(() => canvas().classList.contains("tool-eraser"), "the eraser tool");
      const eraserBatchesMs = [];
      pointer("pointerdown", 32, 160);
      for (let batch = 0; batch < 9; batch++) {
        const start = performance.now();
        for (let move = 0; move < 160; move++) pointer("pointermove", 32, 160 + move);
        if (batch > 0) eraserBatchesMs.push(performance.now() - start);
        await new Promise(requestAnimationFrame);
      }
      pointer("pointerup", 32, 320);
      check(!button("Undo drawing"), "The off-stroke eraser moves changed the drawing");
      check(painted(96, 182), "Expected the first fixture stroke to be visible");
      pointer("pointerdown", 96, 183);
      pointer("pointerup", 96, 183);
      await waitFor(() => !painted(96, 182), "the first stroke to be erased");
      button("Undo drawing").click();
      await waitFor(() => painted(96, 182), "undo to restore the erased stroke");
      report("pass", { mode, initialPaintMs, eraserBatchesMs, movesPerBatch: 160 });
      return;
    }

    await createCard();
    key("z", { metaKey: true });
    await waitFor(() => !find(".lean-card"), "Cmd+Z to undo the card");
    const card = await createCard();
    find(".lean-presence").click();
    const label = await waitFor(() => find('.agent-panel input[name="label"]'), "the agent pairing form");
    label.value = "macOS live test";
    button("Approve pairing").click();
    const binding = await waitFor(() => find(".agent-panel select")?.value, "a pairing ID");
    report("paired", { binding, task: card.dataset.cardId, revision: Number(editor.dataset.semanticRevision) });
    await waitFor(() => find(".lean-card")?.dataset.status === "done", "the status update from the MCP process",
      mode === "provider" ? 120_000 : 10_000);

    key("p");
    await waitFor(() => canvas().classList.contains("tool-pen"), "the drawing tool");
    pointer("pointerdown", 60, 225);
    pointer("pointermove", 180, 225);
    pointer("pointerup", 180, 225);
    await waitFor(() => painted(120, 224), "the stroke to be painted");
    key("z", { metaKey: true, shiftKey: true });
    await waitFor(() => !painted(120, 224), "Cmd+Shift+Z to undo the stroke");
    button("Redo drawing").click();
    await waitFor(() => painted(120, 224), "redo to restore the stroke");
    report("pass", { mode });
  }
  document.addEventListener("DOMContentLoaded", () => {
    run().catch((error) => report("fail", { message: String(error) }));
  }, { once: true });
})();
