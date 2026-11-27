// SPDX-License-Identifier: MIT
// Copyright (c) 2026 the uci-over-wasi contributors. The license's text is in LICENSE.
/* A toy UCI loop on the helper, to run tools/wasi-check.ts against it. Built for wasm32-wasip1-threads, it
   is also the first form of the spec's § Threads: threads only above Threads 1, and a spawn that fails
   leaves it searching on the threads it has. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "uci_wasi.h"
#ifdef _REENTRANT
#include <pthread.h>
#include <stdatomic.h>
static int threads = 1;
static atomic_int stopping, running;
/* a helper counts itself in, so the search reports the threads that ran during it */
static void *spin(void *arg) { atomic_fetch_add(&running, 1); volatile unsigned long n = 0; while (!atomic_load(&stopping)) n++; return arg; }
#endif
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }
int main(void) {
    int black = 0;
    setvbuf(stdout, NULL, _IOLBF, 0);
    for (const char *l; (l = uci_getline());) {
#ifdef _REENTRANT
        if (!strcmp(l, "uci")) puts("option name Threads type spin default 1 min 1 max 4");
        if (!strncmp(l, "setoption name Threads value ", 29)) {
            threads = atoi(l + 29);
            if (threads < 1) threads = 1;
            if (threads > 4) threads = 4;
        }
#endif
        if (!strcmp(l, "uci")) puts("option name Ponder type check default false\nuciok");
        else if (!strcmp(l, "isready")) puts("readyok");
        else if (!strncmp(l, "position", 8)) black = strstr(l, "e2e4") && !strstr(l, "e7e5");
        else if (!strcmp(l, "quit")) return 0;
        else if (!strncmp(l, "go", 2)) {
            int infinite = !!strstr(l, "infinite"), ponder = !!strstr(l, "ponder"), stop = 0;
            double end = now() + (strstr(l, "movetime") ? 1500 : strstr(l, "depth") ? 10 : 500);
            volatile unsigned long n = 0;
#ifdef _REENTRANT
            pthread_t helpers[4];
            int started = 0;
            atomic_store(&stopping, 0);
            atomic_store(&running, 0);
            while (started < threads - 1 && !pthread_create(&helpers[started], NULL, spin, NULL)) started++;
#endif
            while (!stop && (infinite || ponder || now() < end)) {
                for (int i = 0; i < 100000; i++) n++;
                int h = uci_poll(infinite || ponder);
                if (h & UCI_STOP) stop = 1;
                if (h & UCI_PONDERHIT) ponder = 0, end = now() + 500;
            }
#ifdef _REENTRANT
            int ran = atomic_load(&running);
            atomic_store(&stopping, 1);
            for (int i = 0; i < started; i++) pthread_join(helpers[i], NULL);
            printf("info string searched on %d threads\n", ran + 1);
#endif
            puts(black ? "bestmove e7e5" : "bestmove e2e4");
        }
    }
    return 0;
}
