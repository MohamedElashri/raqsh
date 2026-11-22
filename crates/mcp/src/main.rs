fn main() -> std::io::Result<()> {
    raqsh_mcp::main_entry(std::env::args_os().skip(1), false)
}
