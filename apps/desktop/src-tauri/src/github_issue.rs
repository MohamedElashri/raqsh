use serde::{Deserialize, Serialize};
use std::{process::Stdio, time::Duration};
use tauri::Url;
use tokio::{io::AsyncReadExt, process::Command, sync::Semaphore, time::timeout};

const INVALID_URL: &str = "Enter a GitHub issue URL like https://github.com/owner/repo/issues/123.";
const MAX_URL_BYTES: usize = 2_048;
const MAX_RESPONSE_BYTES: u64 = 512 * 1024;
static ISSUE_REQUESTS: Semaphore = Semaphore::const_new(2);

#[derive(Debug, Deserialize, Serialize)]
pub struct Issue {
    title: String,
    body: Option<String>,
    url: String,
}

fn issue_url(input: &str) -> Result<String, &'static str> {
    let input = input.trim();
    if input.len() > MAX_URL_BYTES || input.chars().any(char::is_whitespace) {
        return Err(INVALID_URL);
    }
    let url = Url::parse(input).map_err(|_| INVALID_URL)?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err(INVALID_URL);
    }
    let parts: Vec<_> = url.path().trim_end_matches('/').split('/').collect();
    let ["", owner, repo, "issues", number] = parts.as_slice() else {
        return Err(INVALID_URL);
    };
    let slug = |value: &str| {
        !matches!(value, "" | "." | "..")
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
    };
    if !slug(owner) || !slug(repo) || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(INVALID_URL);
    }
    let number = number.parse::<u64>().map_err(|_| INVALID_URL)?;
    if number == 0 {
        return Err(INVALID_URL);
    }
    Ok(format!("https://github.com/{owner}/{repo}/issues/{number}"))
}

async fn read_issue(mut command: Command, deadline: Duration) -> Result<Issue, &'static str> {
    let issue = timeout(deadline, async {
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| "GitHub CLI could not start. Check your gh installation.")?;
        let mut bytes = Vec::new();
        child
            .stdout
            .take()
            .ok_or("Could not read the GitHub issue.")?
            .take(MAX_RESPONSE_BYTES + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "Could not read the GitHub issue.")?;
        if bytes.len() as u64 > MAX_RESPONSE_BYTES {
            return Err("This issue is too large to load. Paste the relevant text into the brief.");
        }
        if !child.wait().await.is_ok_and(|status| status.success()) {
            return Err("Could not load the issue. Check your connection and issue access, or sign in with gh auth login.");
        }
        let mut issue: Issue =
            serde_json::from_slice(&bytes).map_err(|_| "GitHub CLI returned an invalid issue.")?;
        issue.url = issue_url(&issue.url).map_err(|_| "GitHub CLI returned an invalid issue URL.")?;
        if issue.title.trim().is_empty() {
            return Err("GitHub CLI returned an issue without a title.");
        }
        Ok(issue)
    })
    .await
    .map_err(|_| "GitHub took too long to respond. Try again or paste the issue text.")??;
    Ok(issue)
}

#[tauri::command]
pub async fn load_github_issue(url: String) -> Result<Issue, String> {
    let url = issue_url(&url)?;
    let _permit = ISSUE_REQUESTS
        .try_acquire()
        .map_err(|_| "GitHub imports are busy. Try again shortly.")?;
    let gh = crate::mcp_setup::find_local_executable(&["gh"]).ok_or(
        "Install GitHub CLI and run gh auth login, or paste the issue text into the brief.",
    )?;
    let mut command = Command::new(gh);
    command
        .args(["issue", "view", &url, "--json", "title,body,url"])
        .env("GH_PROMPT_DISABLED", "1");
    read_issue(command, Duration::from_secs(15))
        .await
        .map_err(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizes_issue_links_and_rejects_other_destinations() {
        assert_eq!(
            issue_url(" https://GITHUB.com/owner/example.repo/issues/042/?share=1#issuecomment-9 "),
            Ok("https://github.com/owner/example.repo/issues/42".into())
        );
        for invalid in [
            "http://github.com/o/r/issues/2",
            "https://github.com.evil.test/o/r/issues/2",
            "https://user@github.com/o/r/issues/2",
            "https://github.com:1010/o/r/issues/2",
            "https://github.com/o/r/pull/2",
            "https://github.com/o/r/issues/0",
            "https://github.com/o/r/issues/+2",
            "https://github.com/o/r/issues/2\n7",
            "https://github.com/o/r/issues/2/extra",
            "https://github.com/o/r/issues/18446744073709551616",
        ] {
            assert!(issue_url(invalid).is_err(), "{invalid}");
        }
    }

    #[tokio::test]
    async fn reads_bounded_output_and_validates_the_returned_url() {
        let mut valid = Command::new("/bin/sh");
        valid.args([
            "-c",
            r#"printf '%s' '{"title":"Test","body":null,"url":"https://github.com/o/r/issues/1"}'"#,
        ]);
        let issue = read_issue(valid, Duration::from_secs(2)).await.unwrap();
        assert_eq!(issue.title, "Test");
        assert!(issue.body.is_none());

        for (script, expected) in [
            ("exit 1", "Could not load"),
            ("printf invalid", "invalid issue"),
            (
                r#"printf '%s' '{"title":"Test","url":"https://example.com/o/r/issues/1"}'"#,
                "invalid issue URL",
            ),
            ("exec yes", "too large"),
        ] {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", script]);
            let error = read_issue(command, Duration::from_secs(2))
                .await
                .unwrap_err();
            assert!(error.contains(expected), "{error}");
        }

        let mut slow = Command::new("/bin/sleep");
        slow.arg("10");
        assert!(
            read_issue(slow, Duration::from_millis(20))
                .await
                .unwrap_err()
                .contains("too long")
        );
    }
}
