/*
 * UCI over WASI: the poll helper for a C or C++ engine. uci_wasi.h has its use.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "uci_wasi.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <wasi/api.h>

/* bytes with an end and a capacity, which grows and never shrinks */
typedef struct {
    char *at;
    size_t len, cap;
} Bytes;

static Bytes raw;   /* stdin's bytes not yet split into lines */
static Bytes queue; /* whole lines, each ended by '\n', that wait for uci_getline */
static Bytes line;  /* the line uci_getline last returned */
static int at_end;  /* stdin has ended */

static void fail(const char *why)
{
    fputs(why, stderr);
    fputc('\n', stderr);
    __builtin_trap();
}

static void reserve(Bytes *b, size_t more)
{
    if (b->len + more <= b->cap) return;
    size_t cap = b->cap ? b->cap : 4096;
    while (cap < b->len + more) cap *= 2;
    b->at = realloc(b->at, cap);
    if (!b->at) fail("uci_wasi: out of memory for input");
    b->cap = cap;
}

static void append(Bytes *b, const char *from, size_t n)
{
    reserve(b, n);
    memcpy(b->at + b->len, from, n);
    b->len += n;
}

/* whether stdin has bytes, or its end, to read; waits for that when `wait` is set */
static int input_ready(int wait)
{
    __wasi_subscription_t subs[2] = {0};
    __wasi_event_t events[2];
    size_t n = 0;

    subs[0].userdata = 1;
    subs[0].u.tag = __WASI_EVENTTYPE_FD_READ;
    subs[0].u.u.fd_read.file_descriptor = 0;
    /* a zero relative timeout: the call returns at once */
    subs[1].userdata = 2;
    subs[1].u.tag = __WASI_EVENTTYPE_CLOCK;
    subs[1].u.u.clock.id = __WASI_CLOCKID_MONOTONIC;
    if (__wasi_poll_oneoff(subs, events, wait ? 1 : 2, &n) != 0) return 0;
    for (size_t i = 0; i < n; i++)
        if (events[i].userdata == 1) return 1;
    return 0;
}

/* reads once into raw; a read of nothing is the end of input */
static void fill(void)
{
    reserve(&raw, 4096);
    ssize_t n = read(0, raw.at + raw.len, raw.cap - raw.len);
    if (n <= 0) at_end = 1;
    else raw.len += (size_t)n;
}

/* moves the first line of `from` into `line`, without its line end; returns whether one was there */
static int take_line(Bytes *from)
{
    char *nl = memchr(from->at, '\n', from->len);
    if (!nl) return 0;
    size_t n = (size_t)(nl - from->at);
    line.len = 0;
    append(&line, from->at, n + 1);
    while (n > 0 && line.at[n - 1] == '\r') n--;
    line.at[n] = '\0';
    line.len = n;
    n = (size_t)(nl - from->at) + 1;
    memmove(from->at, from->at + n, from->len - n);
    from->len -= n;
    return 1;
}

/* at the end of input, a last line with no line end still counts as a line */
static void end_last_line(void)
{
    if (at_end && raw.len > 0 && raw.at[raw.len - 1] != '\n') append(&raw, "\n", 1);
}

/* whether the line's first word is `word` */
static int is_command(const char *word)
{
    const char *p = line.at;
    size_t n = strlen(word);
    while (*p == ' ' || *p == '\t') p++;
    return strncmp(p, word, n) == 0 && (p[n] == '\0' || p[n] == ' ' || p[n] == '\t');
}

const char *uci_getline(void)
{
    for (;;) {
        if (take_line(&queue) || take_line(&raw)) return line.at;
        if (at_end) return NULL;
        fill();
        end_last_line();
    }
}

/* splits raw into lines and acts on each or queues it; returns what it heard */
static int handle_lines(int unbounded)
{
    int heard = 0;
    while (take_line(&raw)) {
        if (is_command("isready") && queue.len == 0) {
            fputs("readyok\n", stdout);
            fflush(stdout);
        } else if (is_command("stop")) {
            heard |= UCI_STOP;
        } else if (is_command("ponderhit")) {
            heard |= UCI_PONDERHIT;
        } else {
            if (is_command("quit")) heard |= UCI_STOP | UCI_QUIT;
            append(&queue, line.at, line.len);
            append(&queue, "\n", 1);
        }
    }
    if (at_end && unbounded) heard |= UCI_STOP;
    return heard;
}

int uci_poll(int unbounded)
{
    while (!at_end && input_ready(0)) {
        fill();
        end_last_line();
    }
    return handle_lines(unbounded);
}

int uci_wait(void)
{
    int heard = uci_poll(1);
    if (heard || at_end) return heard;
    if (input_ready(1)) {
        fill();
        end_last_line();
    }
    return handle_lines(1);
}

/*
 * -Wl,--wrap=pthread_create sends every thread start here. wasi-libc's own stub
 * returns ENOTSUP, and an engine that ignores the result goes on with the
 * thread's work undone.
 */
int __wrap_pthread_create(void *thread, const void *attr, void *(*start)(void *), void *arg)
{
    (void)thread, (void)attr, (void)start, (void)arg;
    fail("uci_wasi: the engine started a thread; a WASI build has one thread");
    return 0;
}
