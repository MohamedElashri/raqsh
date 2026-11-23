import { Modal } from "./Modal";
import { Icon } from "./Icon";
import { appearances, interfaceFonts, textSizes, type Preferences, type usePreferences } from "./preferences";

const themeLabels = { system: "System", light: "Light", dark: "Dark" };
const fontLabels = { default: "Raqsh default", system: "System font", assistant: "Assistant", nunito: "Nunito" };
const sizeLabels = { default: "Default", large: "Large", extraLarge: "Extra large" };

export function Settings({ preferences, onClose, onTour, onAbout }: {
  preferences: ReturnType<typeof usePreferences>;
  onClose: () => void;
  onTour: () => void;
  onAbout: () => void;
}) {
  const { value, loaded, error, saving, update, load } = preferences;
  return <Modal title="Settings" className="preferences-dialog" cancel={onClose}>
    <header className="settings-header">
      <h2>Settings</h2>
      <button type="button" data-initial-focus onClick={onClose}>Done</button>
    </header>
    <div className="preferences-section">
      <h3 id="appearance-heading">Appearance</h3>
      <div aria-labelledby="appearance-heading" role="group" aria-busy={!loaded && !error}>
        <fieldset className="preference-theme" disabled={!loaded}>
          <legend>Theme</legend>
          <div className="theme-options">
            {appearances.map((theme) => <label className="theme-choice" key={theme}>
              <input type="radio" name="appearance" value={theme} checked={value.appearance === theme}
                onChange={() => update({ appearance: theme })} />
              <span className="theme-sample" data-sample={theme} aria-hidden="true"><i /><i /><i /></span>
              {themeLabels[theme]}
            </label>)}
          </div>
          <p>System follows your device’s light or dark appearance.</p>
        </fieldset>
        <div className="preference-row">
          <div><label htmlFor="interface-font">Interface font</label>
            <p id="interface-font-hint">Menus, labels and controls across the app.</p></div>
          <select id="interface-font" aria-describedby="interface-font-hint" disabled={!loaded} value={value.interfaceFont}
            onChange={(event) => update({ interfaceFont: event.currentTarget.value as Preferences["interfaceFont"] })}>
            {interfaceFonts.map((font) => <option key={font} value={font}>{fontLabels[font]}</option>)}
          </select>
        </div>
        <div className="preference-row">
          <label htmlFor="interface-size">Interface text size</label>
          <select id="interface-size" disabled={!loaded} value={value.textSize}
            onChange={(event) => update({ textSize: event.currentTarget.value as Preferences["textSize"] })}>
            {textSizes.map((size) => <option key={size} value={size}>{sizeLabels[size]}</option>)}
          </select>
        </div>
      </div>
    </div>
    <div className="preferences-section">
      <h3>Board</h3>
      <div className="preference-row">
        <div><label htmlFor="shortcut-hints">Show toolbar shortcut hints</label>
          <p id="shortcut-hints-description">Keyboard shortcuts work either way. Press F1 on a board to see the list.</p></div>
        <input id="shortcut-hints" type="checkbox" checked={value.showShortcutHints} disabled={!loaded}
          aria-describedby="shortcut-hints-description" onChange={(event) => update({ showShortcutHints: event.currentTarget.checked })} />
      </div>
    </div>
    <footer className="preferences-footer">
      <div className="preferences-links">
        <button type="button" onClick={onTour}><Icon name="help" size={16} />Quick tour</button>
        <button type="button" onClick={onAbout}>About</button>
      </div>
      <span className="preferences-status" role="status">{saving ? "Saving…" : error ? "" : loaded ? "Saved on this device" : "Loading preferences…"}</span>
      {error && <div className="preferences-error"><p role="alert">{error}</p>
        {!loaded && <button type="button" onClick={() => void load()}>Try again</button>}
      </div>}
    </footer>
  </Modal>;
}
