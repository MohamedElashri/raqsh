import { invoke } from "@tauri-apps/api/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export const appearances = ["system", "light", "dark"] as const;
export const interfaceFonts = ["default", "system", "assistant", "nunito"] as const;
export const textSizes = ["default", "large", "extraLarge"] as const;

export type Preferences = {
  appearance: typeof appearances[number];
  interfaceFont: typeof interfaceFonts[number];
  textSize: typeof textSizes[number];
  showShortcutHints: boolean;
  onboardingSeen: boolean;
};

const defaults: Preferences = {
  appearance: "system",
  interfaceFont: "default",
  textSize: "default",
  showShortcutHints: true,
  onboardingSeen: false,
};

export function usePreferences() {
  const [value, setValue] = useState(defaults);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [media] = useState(() => window.matchMedia("(prefers-color-scheme: dark)"));
  const [systemDark, setSystemDark] = useState(media.matches);
  const saved = useRef(defaults);
  const desired = useRef(defaults);
  const loading = useRef(false);
  const work = useRef<Promise<void>>();
  const dark = value.appearance === "system" ? systemDark : value.appearance === "dark";

  async function load() {
    if (loading.current || work.current) return;
    loading.current = true;
    setError("");
    try {
      const initial = await invoke<Preferences>("read_preferences");
      saved.current = desired.current = initial;
      setValue(initial);
      setLoaded(true);
    } catch (error) { setError(String(error)); }
    finally { loading.current = false; }
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const change = () => setSystemDark(media.matches);
    media.addEventListener("change", change);
    change();
    return () => media.removeEventListener("change", change);
  }, [media]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = dark ? "dark" : "light";
    root.dataset.interfaceFont = value.interfaceFont;
    root.dataset.textSize = value.textSize;
    root.dataset.shortcutHints = value.showShortcutHints ? "show" : "hide";
  }, [dark, value]);

  async function persist() {
    setSaving(true);
    try {
      // A newer change supersedes any queued snapshot while a write is in flight.
      while (desired.current !== saved.current) {
        const next = desired.current;
        try {
          await invoke("save_preferences", { preferences: next });
          saved.current = next;
        } catch (error) {
          if (desired.current !== next) continue;
          desired.current = saved.current;
          setValue(saved.current);
          setError(String(error));
        }
      }
    } finally {
      work.current = undefined;
      setSaving(false);
    }
  }

  function update(changes: Partial<Preferences>) {
    if (!loaded) return;
    desired.current = { ...desired.current, ...changes };
    setValue(desired.current);
    setError("");
    work.current ??= persist();
  }

  return { value, loaded, error, saving, dark, load, update, work };
}
