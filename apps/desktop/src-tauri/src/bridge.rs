use crate::commands::Desktop;
use board_ipc::{
    Failure, IO_TIMEOUT, MAX_FRAME, MAX_REPLY, Request, Response, SocketOwner, VERSION,
};
use board_store::bridge::BoardUpdate;
use std::{
    io,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    sync::Semaphore,
    task::{AbortHandle, JoinSet},
    time::timeout,
};

const CONNECTIONS: usize = 16;

pub struct RuntimeBridge {
    state: Mutex<Option<(SocketOwner, AbortHandle)>>,
}

impl RuntimeBridge {
    pub fn start(
        app: AppHandle,
        owner: SocketOwner,
        listener: std::os::unix::net::UnixListener,
    ) -> io::Result<Self> {
        let listener = {
            let handle = tauri::async_runtime::handle();
            let _runtime = handle.inner().enter();
            UnixListener::from_std(listener)?
        };
        let task = tauri::async_runtime::spawn(serve(app, listener));
        Ok(Self {
            state: Mutex::new(Some((owner, task.inner().abort_handle()))),
        })
    }

    pub fn stop(&self) {
        if let Ok(mut state) = self.state.lock()
            && let Some((owner, task)) = state.take()
        {
            task.abort();
            drop(owner);
        }
    }
}

impl Drop for RuntimeBridge {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn serve(app: AppHandle, listener: UnixListener) {
    let permits = Arc::new(Semaphore::new(CONNECTIONS));
    let mut tasks = JoinSet::new();
    loop {
        tokio::select! {
            _ = tasks.join_next(), if !tasks.is_empty() => (),
            incoming = listener.accept() => match incoming {
                Ok((stream, _)) => {
                    let Ok(permit) = permits.clone().try_acquire_owned() else { continue; };
                    if !stream.peer_cred().is_ok_and(|peer| peer.uid() == board_ipc::uid()) { continue; }
                    let app = app.clone();
                    tasks.spawn(async move {
                        let _permit = permit;
                        let _ = exchange(app, stream).await;
                    });
                }
                Err(_) => break,
            }
        }
    }
}

async fn exchange(app: AppHandle, mut stream: UnixStream) -> io::Result<()> {
    let request = timeout(IO_TIMEOUT, async {
        let size = board_ipc::frame_len(stream.read_u32().await?.to_be_bytes(), MAX_FRAME)?;
        let mut payload = vec![0; size];
        stream.read_exact(&mut payload).await?;
        serde_json::from_slice::<Request>(&payload).map_err(io::Error::other)
    })
    .await??;
    let request_id = request.request_id;
    let events = app.clone();
    let state = app.state::<Desktop>();
    let result = match timeout(
        IO_TIMEOUT,
        state.call(move |store| {
            let result = store.bridge(request).map(|(value, update)| {
                match update {
                    Some(BoardUpdate::Revision { scope, revision }) => {
                        let _ = events.emit_to("main", "board-remote-revision", (scope, revision));
                    }
                    Some(BoardUpdate::Feedback(board)) => {
                        let _ = events.emit_to("main", "board-feedback-changed", board);
                    }
                    Some(BoardUpdate::Bindings) => {
                        let _ = events.emit_to("main", "board-bindings-changed", ());
                    }
                    None => {}
                }
                value
            });
            Ok(result)
        }),
    )
    .await
    {
        Ok(Ok(reply)) => reply,
        Ok(Err(_)) => Err(Failure::new(
            "busy",
            "Board storage is busy. Retry with the same operation ID.",
        )),
        Err(_) => Err(Failure::new(
            "timeout",
            "Board storage did not reply. Retry with the same operation ID.",
        )),
    };
    let mut response = serde_json::to_vec(&Response {
        version: VERSION,
        request_id,
        result,
    })
    .map_err(io::Error::other)?;
    if response.len() > MAX_REPLY {
        response = serde_json::to_vec(&Response {
            version: VERSION,
            request_id,
            result: Err(Failure::new(
                "reply_limit",
                "Read the board using smaller pages.",
            )),
        })
        .map_err(io::Error::other)?;
    }
    timeout(
        IO_TIMEOUT,
        stream.write_all(&board_ipc::frame(&response, MAX_REPLY)?),
    )
    .await??;
    stream.shutdown().await?;
    Ok(())
}
