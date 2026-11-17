//go:build wasip1

// Package uciwasi is UCI over WASI's poll helper for a Go engine: the Go form
// of helper/uci_wasi.h and helper/uci_wasi.c, with the same three calls and rules.
//
// A wasip1 build has one thread and no preemption, so a search goroutine starves
// every other goroutine, and a blocking read of stdin halts the whole module. The
// search runs on the UCI loop's goroutine, and its periodic check calls Poll. The
// helper owns stdin: the UCI loop reads its lines through Getline, and nothing
// else reads fd 0.
//
//	// the UCI loop
//	for line, ok := uciwasi.Getline(); ok; line, ok = uciwasi.Getline() { run(line) }
//
//	// the search's periodic check
//	heard := uciwasi.Poll(infinite || pondering)
//	if heard&uciwasi.Stop != 0 { stop = true }
//	if heard&uciwasi.Ponderhit != 0 { pondering = false }
//
//	// where a finished `go infinite` or ponder search waited for its stop
//	for !stop { if uciwasi.Wait()&uciwasi.Stop != 0 { stop = true } }
//
// It calls fd_read and poll_oneoff directly: Go's os.Stdin on wasip1 is a
// blocking fd (the host refuses fd_fdstat_set_flags), so a bufio reader over it
// would block in fd_read and hide a waiting line from a poll.
//
// It is one file: copy it into the engine as a package, such as
// internal/uciwasi. Nothing here catches a `go` statement the edits missed, as
// the C form's trap catches a thread start; such a goroutine never runs.
//
// SPDX-License-Identifier: MIT
//
// Copyright (c) 2026 the Ratchet contributors
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
package uciwasi

import (
	"bytes"
	"os"
	"unsafe"
)

// What Poll and Wait heard, as bits.
const (
	Stop      = 1 // end the search: a stop, a quit, or the end of input in an unbounded search
	Quit      = 2 // a quit arrived; it also waits in the queue, so the UCI loop reads it next
	Ponderhit = 4 // a ponderhit arrived
)

//go:wasmimport wasi_snapshot_preview1 fd_read
func fdRead(fd int32, iovs unsafe.Pointer, iovsLen uint32, nread unsafe.Pointer) uint32

//go:wasmimport wasi_snapshot_preview1 poll_oneoff
func pollOneoff(in unsafe.Pointer, out unsafe.Pointer, nsubs uint32, nevents unsafe.Pointer) uint32

var (
	raw   []byte // stdin's bytes not yet split into lines
	queue []byte // whole lines, each ended by '\n', that wait for Getline
	atEnd bool   // stdin has ended

	// preview 1's subscription (48 bytes) and event (32 bytes), as words; package
	// variables, so a poll allocates nothing
	subs   [2][6]uint64
	events [2][4]uint64
	chunk  [4096]byte
	iov    [2]uint32
)

const (
	eventtypeClock  = 0
	eventtypeFdRead = 1
	clockMonotonic  = 1
)

// inputReady reports whether stdin has bytes, or its end, to read; it waits for that when wait is set.
func inputReady(wait bool) bool {
	subs[0] = [6]uint64{1, eventtypeFdRead, 0} // userdata 1, fd 0
	// a zero relative timeout: the call returns at once
	subs[1] = [6]uint64{2, eventtypeClock, clockMonotonic}
	n := uint32(2)
	if wait {
		n = 1
	}
	var got uint32
	if pollOneoff(unsafe.Pointer(&subs[0]), unsafe.Pointer(&events[0]), n, unsafe.Pointer(&got)) != 0 {
		return false
	}
	for i := uint32(0); i < got; i++ {
		if events[i][0] == 1 {
			return true
		}
	}
	return false
}

// fill reads once into raw; a read of nothing is the end of input.
func fill() {
	iov[0] = uint32(uintptr(unsafe.Pointer(&chunk[0])))
	iov[1] = uint32(len(chunk))
	var n uint32
	if fdRead(0, unsafe.Pointer(&iov[0]), 1, unsafe.Pointer(&n)) != 0 || n == 0 {
		atEnd = true
	} else {
		raw = append(raw, chunk[:n]...)
	}
	// at the end of input, a last line with no line end still counts as a line
	if atEnd && len(raw) > 0 && raw[len(raw)-1] != '\n' {
		raw = append(raw, '\n')
	}
}

// takeLine removes the first line of *from and returns it without its line end; ok is whether one was there.
func takeLine(from *[]byte) (line string, ok bool) {
	i := bytes.IndexByte(*from, '\n')
	if i < 0 {
		return "", false
	}
	line = string(bytes.TrimRight((*from)[:i], "\r"))
	*from = (*from)[:copy(*from, (*from)[i+1:])]
	return line, true
}

// isCommand reports whether the first word of line is word.
func isCommand(line, word string) bool {
	for len(line) > 0 && (line[0] == ' ' || line[0] == '\t') {
		line = line[1:]
	}
	if len(line) < len(word) || line[:len(word)] != word {
		return false
	}
	return len(line) == len(word) || line[len(word)] == ' ' || line[len(word)] == '\t'
}

// Getline returns the next line of input, without its line end: a line queued
// during a search first, else it waits for one. ok is false at the end of input.
// A line end is a line feed, with or without a carriage return before it.
func Getline() (line string, ok bool) {
	for {
		if line, ok = takeLine(&queue); ok {
			return line, true
		}
		if line, ok = takeLine(&raw); ok {
			return line, true
		}
		if atEnd {
			return "", false
		}
		fill()
	}
}

// handleLines splits raw into lines and acts on each or queues it; it returns what it heard.
func handleLines(unbounded bool) int {
	heard := 0
	for {
		line, ok := takeLine(&raw)
		if !ok {
			break
		}
		switch {
		case isCommand(line, "isready") && len(queue) == 0:
			os.Stdout.WriteString("readyok\n")
		case isCommand(line, "stop"):
			heard |= Stop
		case isCommand(line, "ponderhit"):
			heard |= Ponderhit
		default:
			if isCommand(line, "quit") {
				heard |= Stop | Quit
			}
			queue = append(queue, line...)
			queue = append(queue, '\n')
		}
	}
	if atEnd && unbounded {
		heard |= Stop
	}
	return heard
}

// Poll handles the input that waits now, without waiting for more. It answers
// an isready that has no line queued ahead of it, reports stop, quit and
// ponderhit in its result, and queues every other line, in order, for Getline.
//
// unbounded: true when only a stop ends the search: go infinite, pondering, or
// a go with no limit the engine acts on (no clock, movetime, depth, nodes or
// mate).
// At the end of input such a search gets Stop on every call. A bounded search
// gets nothing, so it finishes and its go still gets a bestmove.
func Poll(unbounded bool) int {
	for !atEnd && inputReady(false) {
		fill()
	}
	return handleLines(unbounded)
}

// Wait waits for input or its end, then handles it as Poll(true) does. It takes
// the place of a loop that blocks until another goroutine sets a stop.
func Wait() int {
	heard := Poll(true)
	if heard != 0 || atEnd {
		return heard
	}
	if inputReady(true) {
		fill()
	}
	return handleLines(true)
}
