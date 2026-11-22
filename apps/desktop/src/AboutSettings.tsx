import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";
import { brand } from "./generated/brand";
import icon from "./generated/icon.svg";

type Stage = "disabled" | "idle" | "current" | "available" | "downloaded" | "installed";
type UpdateInfo = { currentVersion: string; version: string | null; stage: Stage };
const actions = {
  idle: ["check_update", "Check for updates", "Checking GitHub…"],
  current: ["check_update", "Check again", "Checking GitHub…"],
  available: ["download_update", "Download update", "Downloading and verifying…"],
  downloaded: ["install_update", "Install update", "Installing update…"],
  installed: ["restart_updated", "Restart Raqsh", "Restarting Raqsh…"],
} as const;

export function AboutSettings({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<UpdateInfo>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);

  useEffect(() => {
    // Reading the in-process state never contacts GitHub.
    let mounted = true;
    void invoke<UpdateInfo>("update_info").then((value) => { if (mounted) setInfo(value); })
      .catch((failure) => { if (mounted) setError(String(failure)); });
    return () => { mounted = false; };
  }, []);

  const action = info && info.stage !== "disabled" ? actions[info.stage] : undefined;
  const messages: Record<Stage, string> = {
    disabled: "Install a signed release of Raqsh to get in-app updates.",
    idle: "Raqsh contacts GitHub when you check for or download an update.",
    current: "Raqsh is up to date.",
    available: `Version ${info?.version} is available.`,
    downloaded: `Version ${info?.version} is verified and ready to install.`,
    installed: `Version ${info?.version} is installed. Restart to use it.`,
  };

  async function perform() {
    if (!action || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      if (action[0] === "restart_updated") {
        await invoke(action[0]);
        return;
      }
      setInfo(await invoke<UpdateInfo>(action[0]));
    } catch (failure) {
      setError(String(failure));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return <Modal title="Settings" className="about-settings" cancel={() => { if (!running.current) onClose(); }}>
    <header className="settings-header">
      <h2>Settings</h2>
      <button type="button" data-initial-focus disabled={busy} onClick={onClose}>Done</button>
    </header>
    <section aria-labelledby="about-heading">
      <h3 id="about-heading">About</h3>
      <div className="about-brand">
        <img src={icon} width="64" height="64" alt="" />
        <div><strong>{brand.displayName}</strong>{info && <p>Version {info.currentVersion}</p>}</div>
      </div>
      <div className="about-updates">
        <h3>Software updates</h3>
        <p role="status">{busy && action ? action[2] : info ? messages[info.stage] : "Loading version…"}</p>
        {error && <p className="library-error" role="alert">{error}</p>}
        {action && <button type="button" className="primary" disabled={busy} onClick={() => void perform()}>{action[1]}</button>}
      </div>
    </section>
  </Modal>;
}
