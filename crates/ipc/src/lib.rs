use board_domain::{Id, Operation, Status};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env, fs,
    io::{self, Read, Write},
    os::fd::{AsRawFd, OwnedFd},
    os::unix::{
        ffi::OsStrExt,
        fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub const VERSION: u16 = 1;
pub const MAX_FRAME: usize = 4 * 1024 * 1024;
pub const MAX_REPLY: usize = 2 * 1024 * 1024;
pub const MAX_OPERATION_BYTES: usize = 128 * 1024;
pub const IO_TIMEOUT: Duration = Duration::from_secs(5);
pub const APP_ID: &str = "dev.local.visualboard";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Credential {
    pub binding_id: Id,
    pub secret: [u8; 32],
}

impl Credential {
    pub fn new() -> io::Result<Self> {
        let mut secret = [0; 32];
        getrandom::fill(&mut secret).map_err(io::Error::other)?;
        Ok(Self {
            binding_id: Id::new_v4(),
            secret,
        })
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub version: u16,
    pub request_id: Id,
    pub credential: Credential,
    pub call: Call,
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "tool",
    content = "arguments",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Call {
    BoardList(List),
    BoardOpen(Open),
    BoardGet(Get),
    BoardApply(Apply),
    BoardGetFeedback(GetFeedback),
    BoardAckFeedback(Ack),
    BoardPostResponse(Post),
    BoardSetTaskStatus(SetStatus),
    BoardSessionState(Session),
    Revoke(Session),
}

macro_rules! args {
    ($name:ident { $($field:ident: $ty:ty),* $(,)? }) => {
        #[derive(Deserialize, Serialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name { $(pub $field: $ty),* }
    }
}
args!(List { project_id: Option<Id>, offset: Option<u32> });
args!(Open { project_id: Option<Id>, board_id: Option<Id>, title: Option<String>, operation_id: Option<Id> });
args!(Get { board_id: Id, section: Option<Section>, offset: Option<u32>, since_revision: Option<u64>, revision: Option<u64> });
args!(Apply {
    board_id: Id,
    operation: Operation
});
args!(GetFeedback { board_id: Id, after: Option<u64> });
args!(Ack {
    board_id: Id,
    feedback_id: Id,
    operation_id: Id
});
args!(Post {
    board_id: Id,
    feedback_id: Id,
    ack_id: Id,
    operation_id: Id,
    text: String
});
args!(SetStatus {
    board_id: Id,
    task_id: Id,
    status: Status,
    operation_id: Id,
    expected_revision: u64
});
args!(Session {});

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Section {
    Nodes,
    Edges,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_revision: Option<u64>,
}

impl Failure {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            current_revision: None,
        }
    }

    pub fn current(revision: u64, message: impl Into<String>) -> Self {
        Self {
            current_revision: Some(revision),
            ..Self::new("revision_conflict", message)
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub version: u16,
    pub request_id: Id,
    pub result: Result<Value, Failure>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireReply {
    version: u16,
    request_id: Id,
    result: Result<Value, RemoteFailure>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFailure {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_revision: Option<u64>,
}

impl RemoteFailure {
    fn local(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            current_revision: None,
        }
    }
}

pub fn uid() -> u32 {
    // geteuid reads the process credential and has no memory or lifetime preconditions.
    unsafe { libc::geteuid() }
}

fn private_directory(path: &Path, create: bool) -> io::Result<()> {
    if create {
        match fs::DirBuilder::new().mode(0o700).create(path) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error),
        }
    }
    let meta = path.symlink_metadata()?;
    if !meta.is_dir() || meta.uid() != uid() || meta.mode() & 0o777 != 0o700 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Expected an owner-only, real directory",
        ));
    }
    Ok(())
}

fn socket_directory() -> io::Result<PathBuf> {
    if let Some(custom) = env::var_os("VISUAL_BOARD_RUNTIME_DIR") {
        let path = PathBuf::from(custom);
        if !path.is_absolute() || path.join("bridge.sock").as_os_str().as_bytes().len() >= 100 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Runtime directory must be an absolute short path",
            ));
        }
        private_directory(&path, false)?;
        return Ok(path);
    }
    if let Some(root) = env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from) {
        let path = root.join("visual-board");
        if root.is_absolute() && path.join("bridge.sock").as_os_str().as_bytes().len() < 100 {
            private_directory(&root, false)?;
            return Ok(path);
        }
    }
    Ok(PathBuf::from(format!("/tmp/visual-board-{}", uid())))
}

pub struct SocketOwner {
    path: PathBuf,
    _lock: fs::File,
}

impl SocketOwner {
    pub fn bind() -> io::Result<(Self, UnixListener)> {
        let directory = socket_directory()?;
        private_directory(&directory, true)?;
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(directory.join("bridge.lock"))?;
        lock.try_lock()
            .map_err(|error| io::Error::new(io::ErrorKind::AddrInUse, error))?;
        let path = directory.join("bridge.sock");
        match path.symlink_metadata() {
            Ok(meta) if meta.file_type().is_socket() && meta.uid() == uid() => {
                fs::remove_file(&path)?
            }
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "Unexpected entry at the socket path",
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
        let listener = UnixListener::bind(&path)?;
        let owner = Self { path, _lock: lock };
        fs::set_permissions(&owner.path, fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        Ok((owner, listener))
    }
}

impl Drop for SocketOwner {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn pairing_path(library: &Path, binding: Id) -> PathBuf {
    library.join("pairings").join(format!("{binding}.json"))
}

pub fn default_library() -> io::Result<PathBuf> {
    #[cfg(feature = "live-test")]
    if let Some(path) = env::var_os("VISUAL_BOARD_TEST_LIBRARY") {
        let path = PathBuf::from(path);
        if path.is_absolute() {
            return Ok(path);
        }
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "The test library must have an absolute path",
        ));
    }
    dirs::data_dir()
        .map(|directory| directory.join(APP_ID).join("library"))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "No user application data directory",
            )
        })
}

pub fn save_credential(library: &Path, credential: &Credential) -> io::Result<()> {
    private_directory(library, false)?;
    let path = pairing_path(library, credential.binding_id);
    private_directory(path.parent().expect("pairing directory"), true)?;
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&path)?;
    let result = serde_json::to_writer(&mut file, credential)
        .map_err(io::Error::other)
        .and_then(|()| file.sync_all());
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}

pub fn read_credential(library: &Path, binding: Id) -> io::Result<Credential> {
    let path = pairing_path(library, binding);
    private_directory(library, false)?;
    private_directory(path.parent().expect("pairing directory"), false)?;
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.uid() != uid() || meta.mode() & 0o777 != 0o600 || meta.len() > 1024 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Invalid pairing file",
        ));
    }
    let credential: Credential =
        serde_json::from_reader(file.take(1024)).map_err(io::Error::other)?;
    if credential.binding_id != binding {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Pairing ID mismatch",
        ));
    }
    Ok(credential)
}

pub fn remove_credential(library: &Path, binding: Id) -> io::Result<()> {
    let path = pairing_path(library, binding);
    match fs::remove_file(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

pub fn frame(bytes: &[u8], limit: usize) -> io::Result<Vec<u8>> {
    if bytes.is_empty() || bytes.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "IPC frame size outside limits",
        ));
    }
    let mut message = Vec::with_capacity(4 + bytes.len());
    message.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    message.extend_from_slice(bytes);
    Ok(message)
}

pub fn frame_len(header: [u8; 4], limit: usize) -> io::Result<usize> {
    let len = u32::from_be_bytes(header) as usize;
    if len == 0 || len > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "IPC frame size outside limits",
        ));
    }
    Ok(len)
}

fn read_deadline(stream: &mut UnixStream, mut output: &mut [u8], end: Instant) -> io::Result<()> {
    while !output.is_empty() {
        let time = end
            .checked_duration_since(Instant::now())
            .filter(|time| !time.is_zero())
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "IPC reply deadline"))?;
        match stream.read(output) {
            Ok(0) => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "IPC closed")),
            Ok(n) => output = &mut output[n..],
            Err(error) if error.kind() == io::ErrorKind::Interrupted => (),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                let mut descriptor = libc::pollfd {
                    fd: stream.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                let timeout = time.as_nanos().div_ceil(1_000_000).min(i32::MAX as u128) as i32;
                // The descriptor stays open, and poll only accesses this one initialized entry.
                if unsafe { libc::poll(&mut descriptor, 1, timeout) } < 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() != io::ErrorKind::Interrupted {
                        return Err(error);
                    }
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    #[cfg(target_os = "linux")]
    {
        let mut credentials = std::mem::MaybeUninit::<libc::ucred>::uninit();
        let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        // Linux writes a ucred into the provided storage for a connected Unix socket.
        let result = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                credentials.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        if size as usize != std::mem::size_of::<libc::ucred>() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Unexpected peer credential length",
            ));
        }
        // A successful getsockopt with the full length initialized the structure.
        Ok(unsafe { credentials.assume_init() }.uid)
    }
    #[cfg(target_os = "macos")]
    {
        let (mut user, mut group) = (0, 0);
        // getpeereid initializes the pair of scalar credentials on success.
        let result = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut user, &mut group) };
        if result == 0 {
            Ok(user)
        } else {
            Err(io::Error::last_os_error())
        }
    }
}

pub fn invoke(request: &Request) -> Result<Value, RemoteFailure> {
    fn exchange(request: &Request) -> io::Result<WireReply> {
        let directory = socket_directory()?;
        private_directory(&directory, false)?;
        let path = directory.join("bridge.sock");
        let meta = path.symlink_metadata()?;
        if !meta.file_type().is_socket() || meta.uid() != uid() || meta.mode() & 0o777 != 0o600 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Invalid desktop socket",
            ));
        }
        let socket = socket2::Socket::new(socket2::Domain::UNIX, socket2::Type::STREAM, None)?;
        socket.connect_timeout(&socket2::SockAddr::unix(path)?, IO_TIMEOUT)?;
        let mut stream = UnixStream::from(OwnedFd::from(socket));
        if peer_uid(&stream)? != uid() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Unexpected desktop peer",
            ));
        }
        let bytes = serde_json::to_vec(request).map_err(io::Error::other)?;
        stream.set_write_timeout(Some(IO_TIMEOUT))?;
        stream.write_all(&frame(&bytes, MAX_FRAME)?)?;
        // Darwin can reject SO_RCVTIMEO changes after the peer closes, even with buffered data.
        stream.set_nonblocking(true)?;
        let deadline = Instant::now() + IO_TIMEOUT;
        let mut header = [0; 4];
        read_deadline(&mut stream, &mut header, deadline)?;
        let mut body = vec![0; frame_len(header, MAX_REPLY)?];
        read_deadline(&mut stream, &mut body, deadline)?;
        serde_json::from_slice(&body).map_err(io::Error::other)
    }
    match exchange(request) {
        Ok(reply) if reply.version == VERSION && reply.request_id == request.request_id => {
            reply.result
        }
        Ok(_) => Err(RemoteFailure::local(
            "protocol",
            "IPC response version or ID did not match.",
        )),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
            ) =>
        {
            Err(RemoteFailure::local(
                "desktop_offline",
                "Open the desktop app and retry.",
            ))
        }
        Err(_) => Err(RemoteFailure::local(
            "transport",
            "The desktop did not return a valid reply. Retry writes with the same operation ID.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_complete_reply_after_the_peer_closes() -> io::Result<()> {
        let (mut reader, mut writer) = UnixStream::pair()?;
        assert_eq!(peer_uid(&reader)?, uid());
        writer.write_all(&frame(b"reply", MAX_REPLY)?)?;
        drop(writer);
        reader.set_nonblocking(true)?;
        let deadline = Instant::now() + IO_TIMEOUT;
        let mut header = [0; 4];
        read_deadline(&mut reader, &mut header, deadline)?;
        let mut body = vec![0; frame_len(header, MAX_REPLY)?];
        read_deadline(&mut reader, &mut body, deadline)?;
        assert_eq!(body, b"reply");
        Ok(())
    }

    #[test]
    fn partial_reply_expires_at_the_original_deadline() -> io::Result<()> {
        let (mut reader, mut writer) = UnixStream::pair()?;
        reader.set_nonblocking(true)?;
        writer.write_all(b"a")?;
        let deadline = Instant::now() + Duration::from_millis(30);
        let mut bytes = [0; 2];
        let error = read_deadline(&mut reader, &mut bytes, deadline).unwrap_err();
        assert_eq!(bytes[0], b'a');
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(Instant::now() >= deadline);
        Ok(())
    }

    #[test]
    fn frame_header_enforces_the_size_limit() {
        assert_eq!(frame_len([0, 0, 0, 8], 8).unwrap(), 8);
        assert!(frame_len([0; 4], 8).is_err());
        assert!(frame_len([0, 0, 0, 9], 8).is_err());
        assert!(frame(&[0; 9], 8).is_err());
    }
}
