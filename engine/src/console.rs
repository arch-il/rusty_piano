//! Console stop events (Ctrl-C, Ctrl-Break, window close, logoff, shutdown).
//!
//! `on_stop` registers one handler that runs on the Windows console control
//! thread, so a live session can save its recording before the process exits.

use std::sync::OnceLock;

static STOP: OnceLock<Box<dyn Fn(&'static str) + Send + Sync>> = OnceLock::new();

/// Name of a console control event type, or None if it is not a stop event.
pub fn ctrl_event_name(ctrl_type: u32) -> Option<&'static str> {
    match ctrl_type {
        0 => Some("Ctrl-C"),
        1 => Some("Ctrl-Break"),
        2 => Some("window closed"),
        5 => Some("logoff"),
        6 => Some("shutdown"),
        _ => None,
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn SetConsoleCtrlHandler(handler: Option<unsafe extern "system" fn(u32) -> i32>, add: i32) -> i32;
}

#[cfg(windows)]
unsafe extern "system" fn handler(ctrl_type: u32) -> i32 {
    use std::io::Write;
    if let (Some(name), Some(f)) = (ctrl_event_name(ctrl_type), STOP.get()) {
        f(name);
        let _ = std::io::stdout().flush();
        std::process::exit(0);
    }
    0
}

/// Runs `f` with the event name on a stop event, then exits the process.
pub fn on_stop(f: impl Fn(&'static str) + Send + Sync + 'static) -> Result<(), String> {
    STOP.set(Box::new(f))
        .map_err(|_| "stop handler already set".to_string())?;
    #[cfg(windows)]
    {
        // SAFETY: `handler` has the signature Windows expects and lives for the whole program.
        let ok = unsafe { SetConsoleCtrlHandler(Some(handler), 1) };
        if ok == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_names() {
        assert_eq!(ctrl_event_name(0), Some("Ctrl-C"));
        assert_eq!(ctrl_event_name(1), Some("Ctrl-Break"));
        assert_eq!(ctrl_event_name(2), Some("window closed"));
        assert_eq!(ctrl_event_name(5), Some("logoff"));
        assert_eq!(ctrl_event_name(6), Some("shutdown"));
        assert_eq!(ctrl_event_name(3), None);
        assert_eq!(ctrl_event_name(99), None);
    }
}
