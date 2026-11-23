import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import aboutLinks from "./about-links.json";
import { brand } from "./generated/brand";
import { edition } from "./generated/edition";
import icon from "./generated/icon.svg";
import license from "../src-tauri/generated/Raqsh-LICENSE.txt?raw";
import excalidrawLicense from "../src-tauri/licenses/Excalidraw-MIT.txt?raw";

const fontNotices = import.meta.glob<string>(
  ["../src-tauri/licenses/*OFL.txt", "../src-tauri/licenses/ComicShanns-MIT.txt", "./lean/fonts/OFL-*.txt"],
  { eager: true, query: "?raw", import: "default" },
);

type Stage = "disabled" | "idle" | "current" | "available" | "downloaded" | "installed";
type UpdateInfo = { currentVersion: string; version: string | null; stage: Stage };
const actions = {
  idle: ["check_update", "Check for updates", "Checking GitHub…"],
  current: ["check_update", "Check again", "Checking GitHub…"],
  available: ["download_update", "Download update", "Downloading and verifying…"],
  downloaded: ["install_update", "Install update", "Installing update…"],
  installed: ["restart_updated", "Restart Raqsh", "Restarting Raqsh…"],
} as const;
const projectLinks = [
  { label: "Project website", url: aboutLinks.website },
  { label: "Source code", url: aboutLinks.source },
  { label: "Release notes", url: aboutLinks.releases },
  { label: "Report an issue", url: aboutLinks.issues },
];

export function AboutSettings({ onClose, onBack }: { onClose: () => void; onBack: () => void }) {
  const [info, setInfo] = useState<UpdateInfo>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [linkError, setLinkError] = useState("");
  const running = useRef(false);

  useEffect(() => {
    // Reading the in-process state never contacts GitHub.
    let mounted = true;
    void invoke<UpdateInfo>("update_info").then((value) => { if (mounted) setInfo(value); })
      .catch((failure) => { if (mounted) setError(String(failure)); });
    return () => { mounted = false; };
  }, []);

  const action = edition.publicUpdates && info && info.stage !== "disabled" ? actions[info.stage] : undefined;
  const messages: Record<Stage, string> = {
    disabled: edition.publicUpdates
      ? "Install a signed release of Raqsh to get in-app updates."
      : "Download commercial updates from your Ko-fi order.",
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

  function openLink(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    const { href } = event.currentTarget;
    setLinkError("");
    void invoke("open_about_link", { url: href }).catch((failure) => setLinkError(String(failure)));
  }

  return <Modal title={`About ${brand.displayName}`} className="about-settings" cancel={() => { if (!running.current) onClose(); }}>
    <header className="settings-header">
      <div className="settings-heading">
        <button type="button" aria-label="Back to Settings" disabled={busy} onClick={onBack}><Icon name="back" size={16} /></button>
        <h2>About</h2>
      </div>
      <div className="about-header-actions">
        <a className="about-tip" href={aboutLinks.support} onClick={openLink}>
          <span aria-hidden="true">♥</span> Leave a tip on Ko-fi
        </a>
        <button type="button" data-initial-focus disabled={busy} onClick={onClose}>Done</button>
      </div>
    </header>
    <section aria-labelledby="about-heading">
      <div className="about-brand">
        <img src={icon} width="76" height="76" alt="" />
        <div>
          <h3 id="about-heading">{brand.displayName}</h3>
          {info && <p className="about-version">Version {info.currentVersion}</p>}
          <p className="edition-label">{edition.label}</p>
          <p className="about-tagline">{brand.tagline}</p>
        </div>
      </div>
      <p className="about-description">Raqsh is a local-first whiteboard for planning with coding agents. Map task dependencies, sketch on the Excalidraw canvas, and share board feedback with agents you pair through MCP.</p>
      <p className="about-license-summary">
        {edition.summary}{edition.publicUpdates && <> <a href={aboutLinks.licensing} onClick={openLink}>Commercial licensing</a></>}
      </p>
      <nav className="about-project-links" aria-label="Raqsh project links">
        {projectLinks.map(({ label, url }) => <a key={url} href={url} onClick={openLink}>{label}<Icon name="arrow" size={15} /></a>)}
      </nav>
    </section>
    <section className="about-updates" aria-labelledby="about-updates-heading">
      <h3 id="about-updates-heading">Software updates</h3>
      <p role="status">{busy && action ? action[2] : info ? messages[info.stage] : "Loading version…"}</p>
      {error && <p className="library-error" role="alert">{error}</p>}
      {action && <button type="button" className="primary" disabled={busy} onClick={() => void perform()}>{action[1]}</button>}
    </section>
    <footer className="about-credits">
      <p>Copyright © 2026 <a href={aboutLinks.author} onClick={openLink}>Mohamed Elashri</a></p>
      <details>
        <summary>{edition.licenseTitle}</summary>
        <pre tabIndex={0} aria-label="Raqsh license">{license}</pre>
      </details>
      <p>Drawing tools powered by <a href={aboutLinks.excalidraw} onClick={openLink}>Excalidraw</a>.</p>
      <details>
        <summary>Excalidraw MIT license</summary>
        <pre tabIndex={0} aria-label="Excalidraw license">{excalidrawLicense}</pre>
      </details>
      <details>
        <summary>Font licenses</summary>
        <pre tabIndex={0} aria-label="Font licenses">{Object.entries(fontNotices).map(([path, notice]) =>
          `${path.split("/").at(-1)}\n\n${notice.trim()}`).join("\n\n")}</pre>
      </details>
    </footer>
    {linkError && <p className="library-error" role="alert">{linkError}</p>}
  </Modal>;
}
