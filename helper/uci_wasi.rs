//! UCI over WASI: the poll helper for a Rust engine.
//!
//! A WASI build has one thread, so an engine whose UCI loop and search ran on two
//! threads runs its search on the UCI thread, and the search's own periodic time
//! check calls [`poll`]. The helper owns stdin: the engine's UCI loop reads its
//! lines through [`getline`], and nothing else reads fd 0, because `std::io::Stdin`
//! buffers ahead, which would hide a waiting line from the poll.
//!
//! ```ignore
//! // the UCI loop
//! while let Some(line) = uci_wasi::getline() { run_command(&line); }
//!
//! // the search's periodic check
//! let heard = uci_wasi::poll(infinite || pondering);
//! if heard & uci_wasi::STOP != 0 { stop.store(true, Ordering::Relaxed); }
//! if heard & uci_wasi::PONDERHIT != 0 { pondering = false; }
//!
//! // where a finished `go infinite` or ponder search waited for its stop
//! while !stopped { if uci_wasi::wait() & uci_wasi::STOP != 0 { stopped = true; } }
//! ```
//!
//! It is one file with no crate: copy it into the engine and declare it
//! `#[cfg(target_os = "wasi")] mod uci_wasi;`. It is the Rust form of uci_wasi.c.
//!
//! SPDX-License-Identifier: MIT
//!
//! Copyright (c) 2026 the uci-over-wasi contributors
//!
//! Permission is hereby granted, free of charge, to any person obtaining a copy
//! of this software and associated documentation files (the "Software"), to deal
//! in the Software without restriction, including without limitation the rights
//! to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//! copies of the Software, and to permit persons to whom the Software is
//! furnished to do so, subject to the following conditions:
//!
//! The above copyright notice and this permission notice shall be included in all
//! copies or substantial portions of the Software.
//!
//! THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//! IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//! FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//! AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//! LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//! OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//! SOFTWARE.
#![allow(dead_code)]

use std::cell::RefCell;
use std::collections::VecDeque;
use std::io::Write;

/// End the search: a stop, a quit, or the end of input in an unbounded search.
pub const STOP: u32 = 1;
/// A quit arrived; it also waits in the queue, so the UCI loop reads it next.
pub const QUIT: u32 = 2;
/// A ponderhit arrived.
pub const PONDERHIT: u32 = 4;

// WASI preview 1 (WebAssembly/WASI, legacy/preview1/docs.md): a subscription is 48
// bytes, its tag at 8 and its union at 16; an event is 32 bytes, its type at 10.
#[link(wasm_import_module = "wasi_snapshot_preview1")]
extern "C" {
    fn fd_read(fd: u32, iovs: *const [u32; 2], iovs_len: u32, nread: *mut u32) -> u16;
    fn poll_oneoff(subs: *const u8, events: *mut u8, n: u32, nevents: *mut u32) -> u16;
}
const EVENT_FD_READ: u8 = 1;
const CLOCK_MONOTONIC: u32 = 1;

#[derive(Default)]
struct Input {
    /// stdin's bytes not yet split into lines
    raw: Vec<u8>,
    /// whole lines that wait for `getline`
    queue: VecDeque<String>,
    /// stdin has ended
    at_end: bool,
}

thread_local! {
    static INPUT: RefCell<Input> = RefCell::new(Input::default());
}

/// Whether stdin has bytes, or its end, to read; waits for that when `wait` is set.
fn input_ready(wait: bool) -> bool {
    let mut subs = [0u8; 96];
    subs[0] = 1; // userdata 1: stdin
    subs[8] = EVENT_FD_READ;
    // a second subscription, a clock with a zero relative timeout: the call returns at once
    subs[48] = 2;
    subs[64..68].copy_from_slice(&CLOCK_MONOTONIC.to_le_bytes());
    let mut events = [0u8; 64];
    let mut n = 0u32;
    if unsafe { poll_oneoff(subs.as_ptr(), events.as_mut_ptr(), if wait { 1 } else { 2 }, &mut n) } != 0 {
        return false;
    }
    (0..n as usize).any(|i| events[32 * i] == 1)
}

impl Input {
    /// Reads once into `raw`; a read of nothing is the end of input, where a last
    /// line with no line end still counts as a line.
    fn fill(&mut self) {
        let mut buf = [0u8; 4096];
        let iov = [buf.as_mut_ptr() as u32, buf.len() as u32];
        let mut n = 0u32;
        if unsafe { fd_read(0, &iov, 1, &mut n) } != 0 || n == 0 {
            self.at_end = true;
            if self.raw.last().is_some_and(|&b| b != b'\n') {
                self.raw.push(b'\n');
            }
        } else {
            self.raw.extend_from_slice(&buf[..n as usize]);
        }
    }

    /// The first line of `raw`, without its line end.
    fn take_line(&mut self) -> Option<String> {
        let nl = self.raw.iter().position(|&b| b == b'\n')?;
        let line: Vec<u8> = self.raw.drain(..=nl).collect();
        Some(String::from_utf8_lossy(&line).trim_end_matches(['\n', '\r']).to_string())
    }

    /// Splits `raw` into lines and acts on each or queues it; returns what it heard.
    fn handle_lines(&mut self, unbounded: bool) -> u32 {
        let mut heard = 0;
        while let Some(line) = self.take_line() {
            match line.split_whitespace().next() {
                Some("isready") if self.queue.is_empty() => {
                    println!("readyok");
                    std::io::stdout().flush().ok();
                }
                Some("stop") => heard |= STOP,
                Some("ponderhit") => heard |= PONDERHIT,
                word => {
                    if word == Some("quit") {
                        heard |= STOP | QUIT;
                    }
                    self.queue.push_back(line);
                }
            }
        }
        if self.at_end && unbounded {
            heard |= STOP;
        }
        heard
    }

    fn poll(&mut self, unbounded: bool) -> u32 {
        while !self.at_end && input_ready(false) {
            self.fill();
        }
        self.handle_lines(unbounded)
    }
}

/// The next line of input, without its line end: a line queued during a search
/// first, else it waits for one. `None` at the end of input. A line end is a
/// line feed, with or without a carriage return before it.
pub fn getline() -> Option<String> {
    INPUT.with_borrow_mut(|input| loop {
        if let Some(line) = input.queue.pop_front().or_else(|| input.take_line()) {
            return Some(line);
        }
        if input.at_end {
            return None;
        }
        input.fill();
    })
}

/// Handles the input that waits now, without waiting for more. It answers an
/// `isready` that has no line queued ahead of it, reports stop, quit and
/// ponderhit in its result, and queues every other line, in order, for `getline`.
///
/// `unbounded`: whether only a stop ends the search: `go infinite`, pondering, or
/// a `go` with no limit the engine acts on (no clock, movetime, depth, nodes or
/// mate).
/// At the end of input such a search gets `STOP` on every call. A bounded search
/// gets nothing, so it finishes and its `go` still gets a bestmove.
pub fn poll(unbounded: bool) -> u32 {
    INPUT.with_borrow_mut(|input| input.poll(unbounded))
}

/// Waits for input or its end, then handles it as `poll(true)` does. It takes the
/// place of a loop that spins until another thread sets a stop flag.
pub fn wait() -> u32 {
    INPUT.with_borrow_mut(|input| {
        let heard = input.poll(true);
        if heard != 0 || input.at_end {
            return heard;
        }
        if input_ready(true) {
            input.fill();
        }
        input.handle_lines(true)
    })
}
