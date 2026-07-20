use std::io::{self, BufRead, Write};
use whalehall_core::handle_line;

fn main() -> io::Result<()> {
    eprintln!("whalehall-core {} started", env!("CARGO_PKG_VERSION"));

    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());

    for line in stdin.lock().lines() {
        let response = handle_line(&line?);
        serde_json::to_writer(&mut stdout, &response)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }

    eprintln!("whalehall-core stopped");
    Ok(())
}
