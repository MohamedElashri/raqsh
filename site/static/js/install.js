const installer = document.querySelector("[data-installer]");

if (installer) {
  const tools = installer.querySelector(".install-tools");
  const methods = tools.querySelectorAll("[data-method]");
  const commands = installer.querySelectorAll("[data-command]");
  const copy = tools.querySelector(".copy");
  const status = tools.querySelector("[role='status']");
  let active = installer.querySelector("[data-command='curl'] code");
  let copyRequest = 0;

  for (const method of methods) {
    method.addEventListener("click", () => {
      for (const button of methods) {
        button.setAttribute("aria-pressed", String(button === method));
      }
      for (const command of commands) {
        command.hidden = command.dataset.command !== method.dataset.method;
        if (!command.hidden) active = command.querySelector("code");
      }
      copyRequest++;
      copy.textContent = "Copy command";
      status.textContent = "";
    });
  }

  copy.addEventListener("click", async () => {
    const request = ++copyRequest;
    const command = active;
    try {
      await navigator.clipboard.writeText(command.textContent.trim());
      if (request !== copyRequest) return;
      copy.textContent = "Copied";
      status.textContent = "Install command copied.";
    } catch {
      if (request !== copyRequest) return;
      const selection = window.getSelection();
      selection?.selectAllChildren(command);
      copy.textContent = selection ? "Command selected" : "Copy command";
      status.textContent = selection
        ? "Install command selected for manual copying."
        : "Select and copy the install command manually.";
    }
  });

  installer.querySelector("[data-command='wget']").hidden = true;
  tools.hidden = false;
}
