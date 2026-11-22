// Injected by the macOS live-test build into the real Tauri webview.
(() => {
  const title = "macOS live test (مراجعة)";
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
  function pointer(type, x, y, modifiers = {}) {
    const bounds = canvas().getBoundingClientRect();
    canvas().dispatchEvent(new PointerEvent(type, {
      pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1,
      clientX: bounds.left + x, clientY: bounds.top + y, bubbles: true, ...modifiers,
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

  async function checkDirectEditing(editor, first) {
    const cards = () => [...document.querySelectorAll(".lean-card")];
    const selected = () => cards().filter((card) => card.dataset.selected === "true");
    const revision = () => Number(editor.dataset.semanticRevision);
    const atRevision = (value) => waitFor(() => revision() === value, `board revision ${value}`);
    const click = (x, y, modifiers) => {
      pointer("pointerdown", x, y, modifiers);
      pointer("pointerup", x, y, modifiers);
    };
    const save = (field) => field.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", metaKey: true, bubbles: true, cancelable: true,
    }));
    key("v");
    key("n");
    const dialog = await waitFor(() => find('dialog[aria-label="Add card"][open]'), "Add card");
    const field = dialog.querySelector('[name="title"]');
    field.value = "Second card";
    dialog.querySelector('[name="x"]').value = "400";
    dialog.querySelector('[name="y"]').value = "130";
    let next = revision() + 1;
    save(field);
    await atRevision(next);
    const second = cards().find((item) => item !== first);
    check(second?.textContent.includes("Second card"), "Cmd+Enter must save the new card");

    pointer("pointerdown", 55, 78);
    pointer("pointermove", 650, 218);
    pointer("pointerup", 650, 218);
    await waitFor(() => selected().length === 2, "marquee selection of both cards");
    click(450, 150, { shiftKey: true });
    await waitFor(() => selected().length === 1 && selected()[0] === first, "Shift-click to deselect one card");
    click(450, 150, { shiftKey: true });
    await waitFor(() => selected().length === 2, "Shift-click to add the card back");

    pointer("pointerdown", 110, 120);
    pointer("pointermove", 145, 144);
    check(first.style.left === "105px" && second.style.left === "435px" && revision() === next,
      "Dragging must preview both positions before committing");
    pointer("pointerup", 145, 144);
    await atRevision(++next);
    key("ArrowRight", { shiftKey: true });
    await atRevision(++next);
    check(first.style.left === "115px" && second.style.left === "445px", "Shift+Arrow must nudge both cards");

    key("d", { metaKey: true });
    await atRevision(++next);
    check(cards().length === 4, "Cmd+D must duplicate both selected cards");
    key("Backspace");
    await atRevision(++next);
    check(cards().length === 2, "Backspace must remove the duplicated cards");
    key("z", { metaKey: true });
    await atRevision(++next);
    check(cards().length === 4, "Cmd+Z must restore both deleted cards");
    key("z", { metaKey: true, shiftKey: true });
    await atRevision(++next);
    check(cards().length === 2, "Cmd+Shift+Z must reapply the deletion");

    key("t");
    await waitFor(() => canvas().classList.contains("tool-text"), "the text tool");
    click(80, 360);
    const text = await waitFor(() => find('dialog[aria-label="Place text"][open] [name="title"]'), "the board text editor");
    text.value = "Draft";
    save(text);
    await waitFor(() => find(".lean-label")?.textContent === "Draft", "the placed text");
    key("Enter");
    const edit = await waitFor(() => find('dialog[aria-label="Edit text"][open] [name="title"]'), "editing the selected text");
    edit.value = "مراجعة";
    save(edit);
    await waitFor(() => find(".lean-label")?.textContent === "مراجعة", "the edited Arabic text");
  }

  async function pair(provider, name) {
    find(".lean-presence").click();
    const select = await waitFor(() => find(`.agent-panel [name="provider"] option[value="${provider}"]:enabled`)?.parentElement,
      "the requested MCP client");
    select.value = provider;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const placeholder = { codex: "Codex", claude: "Claude Code", generic: "Client name" }[provider];
    await waitFor(() => find('.agent-panel input[name="label"]')?.placeholder === placeholder, "the selected client to be applied");
    find('.agent-panel input[name="label"]').value = name;
    button("Approve pairing").click();
    if (provider !== "generic") {
      await waitFor(() => find('.agent-panel output[role="status"]')?.textContent.includes("connected"),
        "the provider to finish registering");
    }
    return waitFor(() => find('.agent-panel select[name="binding"]')?.value, "a pairing ID");
  }

  async function run() {
    const started = performance.now();
    const mode = window.__RAQSH_LIVE_MODE__;
    if (mode === "about" || mode === "updater") {
      (await waitFor(() => button("Settings"), "the Settings entry")).click();
      await waitFor(() => find(".about-brand p")?.textContent.startsWith("Version "), "the local app version");
      const state = find(".about-updates [role=status]").textContent;
      check(state.includes("signed release") || (state.includes("contacts GitHub when you check") && button("Check for updates")),
        "About must start in a manual or unavailable update state");
      if (mode === "updater") {
        report("updater-ready");
        const hold = () => new Promise((resolve) => setTimeout(resolve, 550));
        await hold();
        button("Check for updates").click();
        await waitFor(() => button("Download update"), "a newer signed release");
        await hold();
        button("Download update").click();
        await waitFor(() => find('.about-updates [role="alert"]'), "the corrupted package to be rejected");
        check(!button("Install update"), "A corrupted package must not be installable");
        button("Download update").click();
        await waitFor(() => button("Install update"), "a verified package");
        report("updater-downloaded");
        await hold();
        button("Install update").click();
        await waitFor(() => button("Restart Raqsh"), "the install to complete");
        report("updater-installed");
        await hold();
        button("Restart Raqsh").click();
        return;
      }
      button("Done").click();
      await waitFor(() => !find("dialog[open]"), "Settings to close");
      report("pass", { mode });
      return;
    }
    const editor = await waitFor(() => find('[data-editor-ready="true"]'), "the first editor paint");
    if (mode.startsWith("screenshot")) {
      if (mode === "screenshot-agents") {
        await pair("generic", "Codex");
        find('.agent-panel textarea[name="feedback"]').value = "Check the welcome screen at narrow widths before review.";
        button("Queue feedback").click();
        await waitFor(() => find(".agent-panel ol li"), "the demo feedback");
      }
      await document.fonts.ready;
      await new Promise(requestAnimationFrame);
      report("screenshot", { mode });
      return;
    }
    check(canvas().width === Math.round(canvas().clientWidth * devicePixelRatio), "Canvas backing width must match the device scale");
    if (mode === "reopen" || mode === "reopen-edits") {
      check(find(".lean-card")?.textContent.includes(title), "The card title did not survive reopening");
      check(find(".lean-card").dataset.status === "done", "The MCP status did not survive reopening");
      check(painted(120, 224), "The drawing did not survive reopening");
      if (mode === "reopen-edits") {
        const cards = [...document.querySelectorAll(".lean-card")];
        check(cards.length === 2 && cards[0].style.left === "115px" && cards[1].style.left === "445px",
          "The edited card positions did not survive reopening");
        check(find(".lean-label")?.textContent === "مراجعة", "The edited Arabic text did not survive reopening");
      }
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
      check(find('[data-history="undo"]').disabled, "The off-stroke eraser moves changed the drawing");
      check(painted(96, 182), "Expected the first fixture stroke to be visible");
      pointer("pointerdown", 96, 183);
      pointer("pointerup", 96, 183);
      await waitFor(() => !painted(96, 182), "the first stroke to be erased");
      find('[data-history="undo"]').click();
      await waitFor(() => painted(96, 182), "undo to restore the erased stroke");
      report("pass", { mode, initialPaintMs, eraserBatchesMs, movesPerBatch: 160 });
      return;
    }

    check(document.activeElement === canvas(), "The board must have keyboard focus when it opens");
    key("F1");
    await waitFor(() => find('dialog[aria-label="Board shortcuts"][open]'), "F1 to show keyboard shortcuts");
    button("Close shortcuts").click();
    await waitFor(() => !find("dialog[open]"), "the shortcuts dialog to close");
    await createCard();
    key("z", { metaKey: true });
    await waitFor(() => !find(".lean-card"), "Cmd+Z to undo the card");
    const card = await createCard();
    const binding = await pair(window.__RAQSH_LIVE_PROVIDER__, "macOS live test");
    report("paired", { binding, task: card.dataset.cardId, revision: Number(editor.dataset.semanticRevision) });
    await waitFor(() => find(".lean-card")?.dataset.status === "done", "the status update from the MCP process",
      mode === "provider" ? 120_000 : 10_000);

    key("p");
    await waitFor(() => canvas().classList.contains("tool-pen"), "the drawing tool");
    pointer("pointerdown", 60, 225);
    pointer("pointermove", 180, 225);
    pointer("pointerup", 180, 225);
    await waitFor(() => painted(120, 224), "the stroke to be painted");
    key("z", { metaKey: true });
    await waitFor(() => !painted(120, 224), "Cmd+Z to undo the stroke");
    key("z", { metaKey: true, shiftKey: true });
    await waitFor(() => painted(120, 224), "redo to restore the stroke");
    if (mode === "edit") {
      find(".agent-panel header button").click();
      await checkDirectEditing(editor, card);
    }
    report("pass", { mode });
  }
  document.addEventListener("DOMContentLoaded", () => {
    run().catch((error) => report("fail", { message: String(error) }));
  }, { once: true });
})();
