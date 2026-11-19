/* A toy UCI loop on the helper, to run tools/wasi-check.ts against it. */
#include <stdio.h>
#include <string.h>
#include <time.h>
#include "uci_wasi.h"
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }
int main(void) {
    int black = 0;
    setvbuf(stdout, NULL, _IOLBF, 0);
    for (const char *l; (l = uci_getline());) {
        if (!strcmp(l, "uci")) puts("option name Ponder type check default false\nuciok");
        else if (!strcmp(l, "isready")) puts("readyok");
        else if (!strncmp(l, "position", 8)) black = strstr(l, "e2e4") && !strstr(l, "e7e5");
        else if (!strcmp(l, "quit")) return 0;
        else if (!strncmp(l, "go", 2)) {
            int infinite = !!strstr(l, "infinite"), ponder = !!strstr(l, "ponder"), stop = 0;
            double end = now() + (strstr(l, "movetime") ? 1500 : strstr(l, "depth") ? 10 : 500);
            volatile unsigned long n = 0;
            while (!stop && (infinite || ponder || now() < end)) {
                for (int i = 0; i < 100000; i++) n++;
                int h = uci_poll(infinite || ponder);
                if (h & UCI_STOP) stop = 1;
                if (h & UCI_PONDERHIT) ponder = 0, end = now() + 500;
            }
            puts(black ? "bestmove e7e5" : "bestmove e2e4");
        }
    }
    return 0;
}
