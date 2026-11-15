//! FlexASIO's config file (%USERPROFILE%\FlexASIO.toml): read the backend and the output device, and change only the [output] device line as text (no toml crate), keeping every other line, comment, line ending and a leading BOM.
use crate::setup_file::backup_path;
use std::ops::Range;
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "FlexASIO.toml";
pub const WASAPI_BACKEND: &str = "Windows WASAPI";

#[derive(Debug, Clone, PartialEq, Default)]
pub struct FlexAsioConfig {
    pub backend: Option<String>,
    pub output_device: Option<String>,
}

impl FlexAsioConfig {
    /// True when FlexASIO uses Windows WASAPI; a missing backend key is FlexASIO's default, WASAPI.
    pub fn uses_wasapi(&self) -> bool {
        match &self.backend {
            None => true,
            Some(b) => b.trim().eq_ignore_ascii_case(WASAPI_BACKEND),
        }
    }
}

/// %USERPROFILE%\FlexASIO.toml, or None when USERPROFILE is unset or empty.
pub fn config_path() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .filter(|v| !v.is_empty())
        .map(|v| PathBuf::from(v).join(FILE_NAME))
}

pub fn toml_string(v: &str) -> String {
    let mut out = String::from("\"");
    for c in v.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

struct Value {
    range: Range<usize>,
    text: String,
}

enum Kind {
    Header(String),
    Key {
        section: Option<String>,
        key: String,
        value: Option<Value>,
    },
}

struct Line {
    start: usize,
    end: usize,
    kind: Kind,
}

fn split_bom(text: &str) -> (&str, &str) {
    match text.strip_prefix('\u{feff}') {
        Some(body) => ("\u{feff}", body),
        None => ("", text),
    }
}

/// Parses the string at the start of s. Returns the bytes used (including both quotes) and the unescaped text.
fn parse_string(s: &str) -> Option<(usize, String)> {
    if let Some(rest) = s.strip_prefix('\'') {
        let close = rest.find('\'')?;
        return Some((close + 2, rest[..close].to_string()));
    }
    let rest = s.strip_prefix('"')?;
    let mut out = String::new();
    let mut chars = rest.char_indices();
    while let Some((i, c)) = chars.next() {
        match c {
            '"' => return Some((i + 2, out)),
            '\\' => match chars.next()?.1 {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                'r' => out.push('\r'),
                '\\' => out.push('\\'),
                '"' => out.push('"'),
                o => {
                    out.push('\\');
                    out.push(o);
                }
            },
            _ => out.push(c),
        }
    }
    None
}

fn scan(body: &str) -> Vec<Line> {
    let mut lines = Vec::new();
    let mut section: Option<String> = None;
    let mut offset = 0;
    for raw in body.split_inclusive('\n') {
        let start = offset;
        let end = offset + raw.len();
        offset = end;
        let content = raw
            .strip_suffix("\r\n")
            .or_else(|| raw.strip_suffix('\n'))
            .unwrap_or(raw);
        let lead = content.len() - content.trim_start().len();
        let t = content.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if let Some(rest) = t.strip_prefix('[') {
            if let Some(close) = rest.find(']') {
                let name = rest[..close].trim().to_string();
                lines.push(Line {
                    start,
                    end,
                    kind: Kind::Header(name.clone()),
                });
                section = Some(name);
            }
            continue;
        }
        let Some(eq) = t.find('=') else { continue };
        let key: String = t[..eq].chars().filter(|c| !c.is_whitespace()).collect();
        let after = lead + eq + 1;
        let rest = &content[after..];
        let vs = after + rest.len() - rest.trim_start_matches([' ', '\t']).len();
        let value = parse_string(&content[vs..]).map(|(len, text)| Value {
            range: start + vs..start + vs + len,
            text,
        });
        lines.push(Line {
            start,
            end,
            kind: Kind::Key {
                section: section.clone(),
                key,
                value,
            },
        });
    }
    lines
}

fn is_backend(section: Option<&str>, key: &str) -> bool {
    section.is_none() && key == "backend"
}

fn is_device(section: Option<&str>, key: &str) -> bool {
    match section {
        Some("output") => key == "device",
        None => key == "output.device",
        _ => false,
    }
}

fn find_key(lines: &[Line], wanted: fn(Option<&str>, &str) -> bool) -> Option<&Line> {
    lines.iter().find(|l| {
        matches!(&l.kind, Kind::Key { section, key, .. } if wanted(section.as_deref(), key.as_str()))
    })
}

fn string_value(lines: &[Line], wanted: fn(Option<&str>, &str) -> bool) -> Option<String> {
    match &find_key(lines, wanted)?.kind {
        Kind::Key {
            value: Some(v), ..
        } => Some(v.text.clone()),
        _ => None,
    }
}

pub fn parse(text: &str) -> FlexAsioConfig {
    let (_, body) = split_bom(text);
    let lines = scan(body);
    FlexAsioConfig {
        backend: string_value(&lines, is_backend),
        output_device: string_value(&lines, is_device),
    }
}

pub fn set_output_device(text: &str, device: Option<&str>) -> Result<String, String> {
    let (bom, body) = split_bom(text);
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let lines = scan(body);
    let inline = lines.iter().any(|l| {
        matches!(&l.kind, Kind::Key { section: None, key, .. } if key.as_str() == "output")
    });
    if inline {
        return match device {
            None => Ok(text.to_string()),
            Some(_) => Err(
                "FlexASIO.toml sets output in a form the setup window cannot edit (output = {...}); change it by hand"
                    .to_string(),
            ),
        };
    }
    let new_body = match (find_key(&lines, is_device), device) {
        (Some(line), Some(d)) => {
            let value = match &line.kind {
                Kind::Key {
                    value: Some(v), ..
                } => v,
                _ => {
                    return Err(
                        "the [output] device in FlexASIO.toml is not a string; change it by hand"
                            .to_string(),
                    )
                }
            };
            format!(
                "{}{}{}",
                &body[..value.range.start],
                toml_string(d),
                &body[value.range.end..]
            )
        }
        (Some(line), None) => format!("{}{}", &body[..line.start], &body[line.end..]),
        (None, None) => body.to_string(),
        (None, Some(d)) => {
            let value_line = format!("device = {}{eol}", toml_string(d));
            match lines
                .iter()
                .find(|l| matches!(&l.kind, Kind::Header(n) if n.as_str() == "output"))
            {
                Some(header) => {
                    if header.end == body.len() && !body.ends_with('\n') {
                        format!("{body}{eol}{value_line}")
                    } else {
                        format!(
                            "{}{}{}",
                            &body[..header.end],
                            value_line,
                            &body[header.end..]
                        )
                    }
                }
                None => {
                    let sep = if body.is_empty() || body.ends_with('\n') {
                        ""
                    } else {
                        eol
                    };
                    format!("{body}{sep}[output]{eol}{value_line}")
                }
            }
        }
    };
    Ok(format!("{bom}{new_body}"))
}

pub fn load(path: &Path) -> Result<FlexAsioConfig, String> {
    if !path.exists() {
        return Ok(FlexAsioConfig::default());
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    Ok(parse(&text))
}

#[derive(Debug, Clone, PartialEq)]
pub enum WriteOutcome {
    Unchanged,
    Written { backup: Option<PathBuf> },
}

pub fn write_output_device(path: &Path, device: Option<&str>) -> Result<WriteOutcome, String> {
    let exists = path.exists();
    let text = if exists {
        std::fs::read_to_string(path)
            .map_err(|e| format!("cannot read {}: {e}", path.display()))?
    } else {
        String::new()
    };
    let new = set_output_device(&text, device)?;
    if new == text {
        return Ok(WriteOutcome::Unchanged);
    }
    let backup = if exists {
        let b = backup_path(path);
        std::fs::copy(path, &b).map_err(|e| {
            format!(
                "cannot back up {} to {}: {e}",
                path.display(),
                b.display()
            )
        })?;
        Some(b)
    } else {
        None
    };
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, new)
        .and_then(|_| std::fs::rename(&tmp, path))
        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(WriteOutcome::Written { backup })
}

pub fn apply_output(path: &Path, device: Option<&str>) -> Result<Option<String>, String> {
    match write_output_device(path, device)? {
        WriteOutcome::Unchanged => Ok(None),
        WriteOutcome::Written { backup } => {
            let kept = backup
                .map(|b| format!(" (old file kept as {})", b.display()))
                .unwrap_or_default();
            Ok(Some(format!(
                "FlexASIO output set to {} in {}{}.",
                device.unwrap_or("the Windows default"),
                path.display(),
                kept
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = "backend = \"Windows WASAPI\"\nbufferSizeSamples = 64\n[input]\ndevice = \"\"\n[output]\ndevice = \"Speakers (Realtek(R) Audio)\"\n";
    const HEADPHONES: &str = "backend = \"Windows WASAPI\"\nbufferSizeSamples = 64\n[input]\ndevice = \"\"\n[output]\ndevice = \"Headphones (USB Audio)\"\n";

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rusty_piano_flexasio_{}_{}",
            std::process::id(),
            name
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parse_user_file() {
        let c = parse(USER);
        assert_eq!(c.backend.as_deref(), Some("Windows WASAPI"));
        assert_eq!(
            c.output_device.as_deref(),
            Some("Speakers (Realtek(R) Audio)")
        );
        assert!(c.uses_wasapi());
    }

    #[test]
    fn parse_backends() {
        assert_eq!(parse(""), FlexAsioConfig::default());
        assert!(parse("").uses_wasapi());
        assert!(!parse("backend = \"Windows WDM-KS\"\n").uses_wasapi());
        assert!(parse("backend = 'windows wasapi'\n").uses_wasapi());
        assert_eq!(
            parse("[output]\ndevice = \"\"\n").output_device,
            Some(String::new())
        );
    }

    #[test]
    fn replace_keeps_every_other_line() {
        assert_eq!(
            set_output_device(USER, Some("Headphones (USB Audio)")),
            Ok(HEADPHONES.to_string())
        );
        let crlf = USER.replace('\n', "\r\n");
        let out = set_output_device(&crlf, Some("Headphones (USB Audio)")).unwrap();
        assert_eq!(out, HEADPHONES.replace('\n', "\r\n"));
        let bom = format!("\u{feff}{USER}");
        assert_eq!(
            set_output_device(&bom, Some("Headphones (USB Audio)")),
            Ok(format!("\u{feff}{HEADPHONES}"))
        );
        assert_eq!(
            set_output_device("[output]\ndevice = \"A\"  # mine\n", Some("B")),
            Ok("[output]\ndevice = \"B\"  # mine\n".to_string())
        );
    }

    #[test]
    fn insert_into_existing_section() {
        assert_eq!(
            set_output_device("[output]\nchannels = 2\n", Some("X")),
            Ok("[output]\ndevice = \"X\"\nchannels = 2\n".to_string())
        );
        assert_eq!(
            set_output_device("a = 1\n[output]", Some("X")),
            Ok("a = 1\n[output]\ndevice = \"X\"\n".to_string())
        );
    }

    #[test]
    fn append_section_when_missing() {
        let base = "backend = \"Windows WASAPI\"\nbufferSizeSamples = 64\n";
        let added = "[output]\ndevice = \"X\"\n";
        assert_eq!(
            set_output_device(base, Some("X")),
            Ok(format!("{base}{added}"))
        );
        assert_eq!(
            set_output_device(base.trim_end(), Some("X")),
            Ok(format!("{base}{added}"))
        );
        assert_eq!(
            set_output_device("", Some("X")),
            Ok(added.to_string())
        );
        let input_only = "[input]\ndevice = \"\"\n";
        assert_eq!(
            set_output_device(input_only, Some("X")),
            Ok(format!("{input_only}{added}"))
        );
    }

    #[test]
    fn none_removes_the_device_line() {
        assert_eq!(
            set_output_device(USER, None),
            Ok("backend = \"Windows WASAPI\"\nbufferSizeSamples = 64\n[input]\ndevice = \"\"\n[output]\n"
                .to_string())
        );
        assert_eq!(
            set_output_device("[output]\n", None),
            Ok("[output]\n".to_string())
        );
    }

    #[test]
    fn quotes_round_trip() {
        let s = "a \"b\" \\ c";
        let out = set_output_device(USER, Some(s)).unwrap();
        assert_eq!(parse(&out).output_device, Some(s.to_string()));
        assert_eq!(
            set_output_device("[output]\ndevice = 'C:\\x'\n", Some("D")),
            Ok("[output]\ndevice = \"D\"\n".to_string())
        );
    }

    #[test]
    fn dotted_and_inline_forms() {
        assert_eq!(
            set_output_device("output.device = \"A\"\n", Some("B")),
            Ok("output.device = \"B\"\n".to_string())
        );
        assert!(set_output_device("output = { device = \"A\" }\n", Some("B")).is_err());
        assert!(set_output_device("[output]\ndevice = 5\n", Some("B")).is_err());
    }

    #[test]
    fn inline_table_with_none_is_unchanged() {
        assert_eq!(
            set_output_device("output = { device = \"A\" }\n", None),
            Ok("output = { device = \"A\" }\n".to_string())
        );
    }

    #[test]
    fn write_output_device_keeps_a_backup() {
        let dir = temp_dir("backup");
        let p = dir.join(FILE_NAME);
        std::fs::write(&p, USER).unwrap();
        assert_eq!(
            write_output_device(&p, Some("Headphones")),
            Ok(WriteOutcome::Written {
                backup: Some(dir.join("FlexASIO.toml.bak"))
            })
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("FlexASIO.toml.bak")).unwrap(),
            USER
        );
        let c = load(&p).unwrap();
        assert_eq!(c.output_device.as_deref(), Some("Headphones"));
        assert_eq!(c.backend.as_deref(), Some("Windows WASAPI"));
        assert!(!dir.join("FlexASIO.toml.tmp").exists());
        assert_eq!(
            write_output_device(&p, Some("Headphones")),
            Ok(WriteOutcome::Unchanged)
        );

        let fresh = temp_dir("backup_new");
        let q = fresh.join(FILE_NAME);
        assert_eq!(
            write_output_device(&q, Some("X")),
            Ok(WriteOutcome::Written { backup: None })
        );
        assert_eq!(
            std::fs::read_to_string(&q).unwrap(),
            "[output]\ndevice = \"X\"\n"
        );

        let none_dir = temp_dir("backup_none");
        let r = none_dir.join(FILE_NAME);
        assert_eq!(
            write_output_device(&r, None),
            Ok(WriteOutcome::Unchanged)
        );
        assert!(!r.exists());

        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::remove_dir_all(&fresh).unwrap();
        std::fs::remove_dir_all(&none_dir).unwrap();
    }

    #[test]
    fn load_missing_file_is_default() {
        let dir = temp_dir("missing");
        assert_eq!(load(&dir.join("nope.toml")), Ok(FlexAsioConfig::default()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn apply_output_messages() {
        let dir = temp_dir("apply");
        let p = dir.join(FILE_NAME);
        std::fs::write(&p, USER).unwrap();
        let msg = apply_output(&p, Some("Headphones")).unwrap().unwrap();
        assert!(msg.contains("FlexASIO output set to Headphones"), "{msg}");
        assert!(msg.contains("old file kept as"), "{msg}");
        assert_eq!(apply_output(&p, Some("Headphones")), Ok(None));

        let fresh = temp_dir("apply_new");
        let q = fresh.join(FILE_NAME);
        let msg = apply_output(&q, Some("X")).unwrap().unwrap();
        assert!(msg.contains("FlexASIO output set to X"), "{msg}");
        assert!(!msg.contains("old file kept as"), "{msg}");

        let plain = temp_dir("apply_none");
        let r = plain.join(FILE_NAME);
        std::fs::write(&r, "backend = \"Windows WASAPI\"\n").unwrap();
        assert_eq!(apply_output(&r, None), Ok(None));

        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::remove_dir_all(&fresh).unwrap();
        std::fs::remove_dir_all(&plain).unwrap();
    }
}
