use crate::{Error, Id};
use serde::{Deserialize, Serialize};

pub const VERIFICATION_DOCUMENT_VERSION: u32 = 2;
pub const MAX_VERIFICATIONS: usize = 1024;
const MAX_TITLE_BYTES: usize = 512;
const MAX_REVISION_BYTES: usize = 256;
const MAX_REFERENCE_BYTES: usize = 2048;
const MAX_DATE_MS: u64 = 8_640_000_000_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckResult {
    Pending,
    Passed,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerificationDraft {
    pub title: String,
    pub result: CheckResult,
    pub revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CardVerification {
    pub id: Id,
    pub card_id: Id,
    pub recorded_at: u64,
    pub check: VerificationDraft,
}

fn single_line(value: &str, max_bytes: usize) -> bool {
    value.len() <= max_bytes && !value.chars().any(char::is_control)
}

fn web_reference(value: &str) -> bool {
    let Some(rest) = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
    else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    single_line(value, MAX_REFERENCE_BYTES)
        && !authority.is_empty()
        && !authority.contains('@')
        && !value.contains('\\')
        && !value.chars().any(char::is_whitespace)
}

impl VerificationDraft {
    pub fn normalized(mut self) -> Self {
        self.title = self.title.trim().to_owned();
        self.revision = self.revision.trim().to_owned();
        self.reference = self.reference.and_then(|value| {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_owned())
        });
        self
    }

    pub fn validate(&self) -> Result<(), Error> {
        if self.title.trim().is_empty() || !single_line(&self.title, MAX_TITLE_BYTES) {
            return Err(Error::Invalid(
                "Enter one line of check text up to 512 bytes.",
            ));
        }
        if !single_line(&self.revision, MAX_REVISION_BYTES) {
            return Err(Error::Invalid("Enter a revision of at most 256 bytes."));
        }
        if self.result != CheckResult::Pending && self.revision.trim().is_empty() {
            return Err(Error::Invalid("Enter the revision tested for this result."));
        }
        if self
            .reference
            .as_deref()
            .is_some_and(|value| !web_reference(value))
        {
            return Err(Error::Invalid("Enter a valid HTTP or HTTPS reference URL."));
        }
        Ok(())
    }
}

impl CardVerification {
    pub fn validate(&self) -> Result<(), Error> {
        if self.id.is_nil()
            || self.card_id.is_nil()
            || !(1..=MAX_DATE_MS).contains(&self.recorded_at)
        {
            return Err(Error::Invalid("Invalid verification identity or date."));
        }
        self.check.validate()
    }
}
