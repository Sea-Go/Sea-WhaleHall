use std::io;

use tokio::io::BufReader;
use whalehall_local_server::serve;

#[tokio::main(flavor = "current_thread")]
async fn main() -> io::Result<()> {
    #[cfg(windows)]
    whalehall_local_server::install_current_process_tree_job()?;
    eprintln!("whalehall-local {} started", env!("CARGO_PKG_VERSION"));
    let result = serve(BufReader::new(tokio::io::stdin()), tokio::io::stdout()).await;
    eprintln!("whalehall-local stopped");
    result
}
