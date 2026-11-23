use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::{
    fs::File,
    io::{self, Read},
    path::Path,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Appearance {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum InterfaceFont {
    #[default]
    Default,
    System,
    Assistant,
    Nunito,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum TextSize {
    #[default]
    Default,
    Large,
    ExtraLarge,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    appearance: Appearance,
    interface_font: InterfaceFont,
    text_size: TextSize,
    show_shortcut_hints: bool,
    onboarding_seen: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            appearance: Appearance::default(),
            interface_font: InterfaceFont::default(),
            text_size: TextSize::default(),
            show_shortcut_hints: true,
            onboarding_seen: false,
        }
    }
}

// Read each stored field independently so an invalid or newer value does not
// discard the user's other choices. IPC writes still require a valid snapshot.
fn decode(bytes: &[u8]) -> Preferences {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return Preferences::default();
    };
    fn field<T: DeserializeOwned>(value: &Value, key: &str, fallback: T) -> T {
        value
            .get(key)
            .and_then(|field| T::deserialize(field).ok())
            .unwrap_or(fallback)
    }
    let defaults = Preferences::default();
    Preferences {
        appearance: field(&value, "appearance", defaults.appearance),
        interface_font: field(&value, "interfaceFont", defaults.interface_font),
        text_size: field(&value, "textSize", defaults.text_size),
        show_shortcut_hints: field(&value, "showShortcutHints", defaults.show_shortcut_hints),
        onboarding_seen: field(&value, "onboardingSeen", defaults.onboarding_seen),
    }
}

pub fn read(path: &Path) -> io::Result<Preferences> {
    const MAX_SIZE: usize = 16 * 1024;
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Preferences::default()),
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.take(MAX_SIZE as u64 + 1).read_to_end(&mut bytes)?;
    Ok(if bytes.len() <= MAX_SIZE {
        decode(&bytes)
    } else {
        Preferences::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_valid_preferences_from_partial_or_outdated_data() {
        let stored = br#"{"appearance":"dark","interfaceFont":null,"textSize":"extraLarge",
            "showShortcutHints":"old","onboardingSeen":true,"futureField":42}"#;
        assert_eq!(
            decode(stored),
            Preferences {
                appearance: Appearance::Dark,
                text_size: TextSize::ExtraLarge,
                onboarding_seen: true,
                ..Preferences::default()
            }
        );
        assert!(serde_json::from_slice::<Preferences>(stored).is_err());
        assert_eq!(decode(b"{invalid"), Preferences::default());
    }

    #[test]
    fn preferences_round_trip_with_the_frontend_field_names() {
        let stored = br#"{"appearance":"light","interfaceFont":"nunito","textSize":"large",
            "showShortcutHints":false,"onboardingSeen":true}"#;
        let settings: Preferences = serde_json::from_slice(stored).unwrap();
        assert_eq!(
            serde_json::to_value(&settings).unwrap(),
            serde_json::from_slice::<Value>(stored).unwrap()
        );
        assert_eq!(decode(&serde_json::to_vec(&settings).unwrap()), settings);
    }
}
