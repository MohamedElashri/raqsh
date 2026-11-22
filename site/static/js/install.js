const installTools = document.querySelector(".install-tools");
const methods = installTools.querySelectorAll("[data-method]");
const commands = document.querySelectorAll("[data-command]");
const copy = installTools.querySelector(".copy");
const status = installTools.querySelector("[role='status']");
let activeCommand = document.querySelector("[data-command='curl'] code");

for (const method of methods) {
  method.addEventListener("click", () => {
    for (const button of methods) {
      button.setAttribute("aria-pressed", String(button === method));
    }
    for (const command of commands) {
      command.hidden = command.dataset.command !== method.dataset.method;
      if (!command.hidden) activeCommand = command.querySelector("code");
    }
    copy.textContent = "Copy";
    status.textContent = "";
  });
}

copy.addEventListener("click", async () => {
  const command = activeCommand;
  try {
    await navigator.clipboard.writeText(command.textContent.trim());
    if (command !== activeCommand) return;
    copy.textContent = "Copied";
    status.textContent = "Install command copied.";
  } catch {
    if (command !== activeCommand) return;
    window.getSelection().selectAllChildren(command);
    status.textContent = "Install command selected for manual copying.";
  }
});

document.querySelector("[data-command='wget']").hidden = true;
copy.hidden = !navigator.clipboard;
installTools.hidden = false;
