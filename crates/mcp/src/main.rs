fn main() -> std::io::Result<()> {
    visual_board_mcp::main_entry(std::env::args_os().skip(1), false)
}
