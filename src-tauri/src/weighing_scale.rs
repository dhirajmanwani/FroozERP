//! The counter's weighing scale, read over a serial port (23 Oct 2026).
//!
//! The shop's scale is an iScale Smart Bluetooth scale. Its manual: Bluetooth SPP, 9600 bps, 8N1,
//! no flow control, and once connected it sends its live weight as plain ASCII ("+001.250 kg")
//! over and over, with no command or handshake. Windows shows a paired SPP device as a virtual COM
//! port, so reading it is reading a serial port. A USB or RS-232 scale with the same output reads
//! the same way.
//!
//! This module only moves bytes. One reader thread at a time keeps the last characters it heard
//! (`ScaleStatus::text`); the frontend polls `scale_status` and reads the weight out of that text
//! in `frontend/src/local/weighingScale.js`, where it is testable. Nothing here is ever a weight:
//! a port that sends nothing, sends rubbish or drops out is a status with a message, never 0.
//!
//! The reader keeps going by itself (24 Oct 2026, "taaki future me kabhi dikkat nhi aaye"): a port
//! that cannot be opened (scale off, out of range, held by the phone's iScale app) or a link that
//! drops mid-day is tried again every `RETRY_DELAY` until it answers or someone disconnects. What
//! happened is written to the app log, so a counter's scale trouble can be read afterwards.
//!
//! Local only. A serial port is not the network, so LOCAL_ONLY is untouched.

use serde::Serialize;
use std::io::{ErrorKind, Read};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The manual's settings. A Bluetooth virtual port ignores them; a wired one needs them.
const BAUD_RATE: u32 = 9600;
/// How long one read waits before the thread checks whether it has been told to stop.
const READ_TIMEOUT: Duration = Duration::from_millis(400);
/// The characters kept: several whole readings, so the newest complete one is always in there.
const TEXT_TAIL: usize = 160;
/// How long to wait before trying a port that failed again.
const RETRY_DELAY: Duration = Duration::from_secs(3);
/// After this many failures in a row, only every tenth one is logged.
const LOG_EVERY_FAILURE_UNTIL: u32 = 3;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct ScalePort {
    pub port_name: String,
    /// "bluetooth", "usb", "pci" or "unknown". Windows usually reports a Bluetooth port as unknown.
    pub kind: String,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct ScaleStatus {
    /// "idle" (not connected), "connecting", "reading" or "failed".
    pub status: String,
    pub port_name: Option<String>,
    /// The newest characters the scale sent, at most `TEXT_TAIL` of them. Non-ASCII bytes are '?'.
    pub text: String,
    pub bytes_read: u64,
    /// Milliseconds since 1970 of the last byte, so the frontend can tell a scale that stopped.
    pub last_data_at_ms: Option<u64>,
    pub now_ms: u64,
    pub error: Option<String>,
    /// Opening attempts since the last time the scale answered; 0 while it is answering.
    pub attempts: u32,
    /// True while a failed port is waiting to be tried again by itself.
    pub retrying: bool,
    /// Raised by every connect and disconnect; a reader thread stops once it is out of date.
    pub generation: u64,
}

static GENERATION: AtomicU64 = AtomicU64::new(0);
static STATUS: OnceLock<Mutex<ScaleStatus>> = OnceLock::new();
static LOGGER: OnceLock<fn(&str, &str)> = OnceLock::new();

/// The app log writer (lib.rs `write_app_log`), set once at startup. Without one, nothing is logged.
pub fn set_logger(logger: fn(&str, &str)) {
    let _ = LOGGER.set(logger);
}

fn log(level: &str, message: &str) {
    if let Some(logger) = LOGGER.get() {
        logger(level, &format!("[weighing scale] {message}"));
    }
}

fn is_current(generation: u64) -> bool {
    GENERATION.load(Ordering::SeqCst) == generation
}

/// Sleep for `total` in short steps; false as soon as this reader has been replaced.
fn wait_while_current(generation: u64, total: Duration) -> bool {
    let step = Duration::from_millis(100);
    let mut waited = Duration::ZERO;
    while waited < total {
        if !is_current(generation) {
            return false;
        }
        thread::sleep(step);
        waited += step;
    }
    is_current(generation)
}

fn status_cell() -> &'static Mutex<ScaleStatus> {
    STATUS.get_or_init(|| {
        Mutex::new(ScaleStatus {
            status: "idle".to_string(),
            ..ScaleStatus::default()
        })
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Update the shared status, but only for the reader of `generation`: a thread that was replaced
/// by a newer connect must not overwrite what the new one says.
fn update_if_current(generation: u64, change: impl FnOnce(&mut ScaleStatus)) -> bool {
    let mut status = match status_cell().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if status.generation != generation {
        return false;
    }
    change(&mut status);
    true
}

/// Append what was read to the kept text, keeping only the last `cap` characters.
pub(crate) fn append_tail(tail: &mut String, bytes: &[u8], cap: usize) {
    for byte in bytes {
        let ch = match *byte {
            b'\r' | b'\n' | b'\t' => *byte as char,
            0x20..=0x7e => *byte as char,
            _ => '?',
        };
        tail.push(ch);
    }
    if tail.len() > cap {
        // ASCII only, so every index is a character boundary.
        let cut = tail.len() - cap;
        tail.drain(..cut);
    }
}

pub(crate) fn port_kind(port_type: &serialport::SerialPortType) -> (&'static str, Option<String>) {
    match port_type {
        serialport::SerialPortType::BluetoothPort => ("bluetooth", None),
        serialport::SerialPortType::UsbPort(info) => (
            "usb",
            info.product.clone().or_else(|| info.manufacturer.clone()),
        ),
        serialport::SerialPortType::PciPort => ("pci", None),
        serialport::SerialPortType::Unknown => ("unknown", None),
    }
}

pub fn list_ports() -> Result<Vec<ScalePort>, String> {
    let mut ports: Vec<ScalePort> = serialport::available_ports()
        .map_err(|error| format!("The computer's ports could not be listed: {error}"))?
        .into_iter()
        .map(|info| {
            let (kind, description) = port_kind(&info.port_type);
            ScalePort {
                port_name: info.port_name,
                kind: kind.to_string(),
                description,
            }
        })
        .collect();
    ports.sort_by(|left, right| left.port_name.cmp(&right.port_name));
    ports.dedup_by(|left, right| left.port_name == right.port_name);
    Ok(ports)
}

pub fn status() -> ScaleStatus {
    let mut snapshot = match status_cell().lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    };
    snapshot.now_ms = now_ms();
    snapshot
}

/// Stop reading. Safe to call when nothing is connected.
pub fn disconnect() -> ScaleStatus {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    log("INFO", "disconnected");
    if let Ok(mut status) = status_cell().lock() {
        *status = ScaleStatus {
            status: "idle".to_string(),
            generation,
            ..ScaleStatus::default()
        };
    }
    status()
}

/// Start reading `port_name`, replacing any reader already running. Returns at once; opening a
/// Bluetooth port can take several seconds while Windows reaches the scale, and that happens on the
/// reader thread ("connecting" until then).
pub fn connect(port_name: String) -> Result<ScaleStatus, String> {
    let port_name = port_name.trim().to_string();
    if port_name.is_empty() || port_name.len() > 64 {
        return Err("Choose the scale's port first.".to_string());
    }
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut status) = status_cell().lock() {
        *status = ScaleStatus {
            status: "connecting".to_string(),
            port_name: Some(port_name.clone()),
            attempts: 1,
            generation,
            ..ScaleStatus::default()
        };
    }
    log("INFO", &format!("connecting to {port_name}"));
    thread::Builder::new()
        .name("froozerp-weighing-scale".to_string())
        .spawn(move || read_port(port_name, generation))
        .map_err(|error| format!("The scale reader could not start: {error}"))?;
    Ok(status())
}

/// One reader: open the port, read until told to stop, and when opening fails or the link drops,
/// wait `retry_delay` and open it again. Only `disconnect` or a newer `connect` ends it.
fn read_port(port_name: String, generation: u64) {
    read_port_with(port_name, generation, RETRY_DELAY)
}

fn read_port_with(port_name: String, generation: u64, retry_delay: Duration) {
    let mut failures: u32 = 0;
    loop {
        if !is_current(generation) {
            return;
        }
        let opened = serialport::new(port_name.as_str(), BAUD_RATE)
            .data_bits(serialport::DataBits::Eight)
            .parity(serialport::Parity::None)
            .stop_bits(serialport::StopBits::One)
            .flow_control(serialport::FlowControl::None)
            .timeout(READ_TIMEOUT)
            .open();
        let mut port = match opened {
            Ok(port) => port,
            Err(error) => {
                failures += 1;
                let message = format!("{port_name} could not be opened: {error}");
                if failures <= LOG_EVERY_FAILURE_UNTIL || failures % 10 == 0 {
                    log("WARN", &format!("{message} (attempt {failures})"));
                }
                let current = update_if_current(generation, |status| {
                    status.status = "failed".to_string();
                    status.error = Some(message);
                    status.attempts = failures;
                    status.retrying = true;
                });
                if !current || !wait_while_current(generation, retry_delay) {
                    return;
                }
                if !update_if_current(generation, |status| {
                    status.status = "connecting".to_string();
                    status.attempts = failures + 1;
                }) {
                    return;
                }
                continue;
            }
        };
        if failures > 0 {
            log("INFO", &format!("{port_name} opened after {failures} failed attempt(s)"));
        } else {
            log("INFO", &format!("{port_name} opened"));
        }
        // A new link starts with nothing heard: a weight from before the drop is not this one.
        if !update_if_current(generation, |status| {
            status.status = "reading".to_string();
            status.text.clear();
            status.last_data_at_ms = None;
            status.error = None;
            status.attempts = 0;
            status.retrying = false;
        }) {
            return;
        }
        let mut buffer = [0u8; 256];
        let dropped = loop {
            if !is_current(generation) {
                return;
            }
            match port.read(&mut buffer) {
                Ok(0) => {}
                Ok(read) => {
                    let at = now_ms();
                    let current = update_if_current(generation, |status| {
                        append_tail(&mut status.text, &buffer[..read], TEXT_TAIL);
                        status.bytes_read += read as u64;
                        status.last_data_at_ms = Some(at);
                    });
                    if !current {
                        return;
                    }
                }
                Err(error) if error.kind() == ErrorKind::TimedOut || error.kind() == ErrorKind::Interrupted => {}
                Err(error) => break format!("The link to the scale on {port_name} dropped: {error}"),
            }
        };
        drop(port);
        log("WARN", &dropped);
        failures = 1;
        let current = update_if_current(generation, |status| {
            status.status = "failed".to_string();
            status.error = Some(dropped);
            status.attempts = 1;
            status.retrying = true;
        });
        if !current || !wait_while_current(generation, retry_delay) {
            return;
        }
        if !update_if_current(generation, |status| {
            status.status = "connecting".to_string();
            status.attempts = 2;
        }) {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_kept_text_is_the_newest_ascii_and_never_grows_past_its_cap() {
        let mut tail = String::new();
        append_tail(&mut tail, b"+001.250 kg\r\n", 160);
        assert_eq!(tail, "+001.250 kg\r\n");
        append_tail(&mut tail, &[0xff, b'+', 0x00], 160);
        assert_eq!(tail, "+001.250 kg\r\n?+?", "non-ASCII and control bytes are '?'");
        let mut long = String::new();
        for _ in 0..40 {
            append_tail(&mut long, b"+002.500 kg\r\n", 30);
        }
        assert_eq!(long.len(), 30);
        assert!(long.ends_with("+002.500 kg\r\n"));
    }

    #[test]
    fn port_kinds_name_how_the_port_is_connected() {
        assert_eq!(port_kind(&serialport::SerialPortType::BluetoothPort).0, "bluetooth");
        assert_eq!(port_kind(&serialport::SerialPortType::Unknown).0, "unknown");
        assert_eq!(port_kind(&serialport::SerialPortType::PciPort).0, "pci");
    }

    #[test]
    fn a_port_that_cannot_open_is_tried_again_by_itself_until_disconnected() {
        // One test owns the shared reader state, so the cases run in order here.
        let started = connect("COM-FROOZERP-DOES-NOT-EXIST".to_string()).expect("the reader starts");
        assert_eq!(started.status, "connecting");
        assert_eq!(started.attempts, 1);
        // The thread connect() started uses the real delay; replace it with a quick one to watch retries.
        let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(mut status) = status_cell().lock() {
            status.generation = generation;
        }
        let quick = thread::spawn(move || read_port_with("COM-FROOZERP-DOES-NOT-EXIST".to_string(), generation, Duration::from_millis(150)));
        let mut seen = status();
        for _ in 0..100 {
            if seen.attempts >= 3 {
                break;
            }
            thread::sleep(Duration::from_millis(20));
            seen = status();
        }
        assert!(seen.attempts >= 3, "it kept trying: {seen:?}");
        assert!(seen.retrying);
        assert!(seen.error.as_deref().unwrap_or("").contains("COM-FROOZERP-DOES-NOT-EXIST"));
        assert_eq!(seen.text, "", "a port that never opened reports no reading at all");
        let idle = disconnect();
        assert_eq!(idle.status, "idle");
        assert!(!idle.retrying);
        quick.join().expect("the reader stops once disconnected");
        thread::sleep(Duration::from_millis(400));
        assert_eq!(status().status, "idle", "nothing writes after a disconnect");
        assert!(connect("   ".to_string()).is_err(), "no port, no reader");
    }
}
