use board_domain::Id;
use rustix::{
    fs::{self, AtFlags, Mode, OFlags, RenameFlags},
    io::Errno,
};
use std::{fs::File, io::Write, path::Path};

pub const DOCUMENT: &[u8] = include_bytes!("../../../../skills/raqsh-board/SKILL.md");
pub const FOLDER: &str = "raqsh-board";
pub const FILE: &str = "SKILL.md";

pub fn install(root: &Path, client_directory: &str) -> std::io::Result<bool> {
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let mut directory = fs::open(root, flags, Mode::empty())?;
    for name in [client_directory, "skills", FOLDER] {
        match fs::mkdirat(&directory, name, Mode::from_raw_mode(0o755)) {
            Ok(()) | Err(Errno::EXIST) => {}
            Err(error) => return Err(error.into()),
        }
        directory = fs::openat(&directory, name, flags, Mode::empty())?;
    }

    let temporary = format!(".raqsh-skill-{}.tmp", Id::new_v4());
    let file = fs::openat(
        &directory,
        &temporary,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC,
        Mode::from_raw_mode(0o644),
    )?;
    let publish = || -> std::io::Result<bool> {
        let mut file = File::from(file);
        file.write_all(DOCUMENT)?;
        file.sync_all()?;
        // Publish a complete file without replacing an existing skill.
        match fs::renameat_with(
            &directory,
            &temporary,
            &directory,
            FILE,
            RenameFlags::NOREPLACE,
        ) {
            Ok(()) => Ok(true),
            Err(Errno::EXIST) => Ok(false),
            Err(error) => Err(error.into()),
        }
    };
    let result = publish();
    if !matches!(result, Ok(true)) {
        let _ = fs::unlinkat(&directory, &temporary, AtFlags::empty());
    }
    result
}
