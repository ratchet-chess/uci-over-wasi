/*
 * UCI over WASI: the poll helper for a C or C++ engine.
 *
 * A WASI build has one thread, so an engine whose UCI loop and search ran on two
 * threads runs its search on the UCI thread, and the search's own periodic time
 * check calls uci_poll. The helper owns stdin: the engine's UCI loop reads its
 * lines through uci_getline, and nothing else reads fd 0, because a stdio or
 * iostream buffer would hide a waiting line from the poll.
 *
 *   // the UCI loop
 *   for (const char *line; (line = uci_getline()) != NULL;) run_command(line);
 *
 *   // the search's periodic check
 *   int heard = uci_poll(limits.infinite || pondering);
 *   if (heard & UCI_STOP) stop = 1;
 *   if (heard & UCI_PONDERHIT) pondering = 0;
 *
 *   // where a finished `go infinite` or ponder search waited for its stop
 *   while (!stop) if (uci_wait() & UCI_STOP) stop = 1;
 *
 * Link with -Wl,--wrap=pthread_create, so a thread start the port missed traps
 * with a message instead of failing unseen.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef UCI_WASI_H
#define UCI_WASI_H

#ifdef __cplusplus
extern "C" {
#endif

/* what uci_poll and uci_wait heard, as bits */
enum {
    UCI_STOP = 1,      /* end the search: a stop, a quit, or the end of input in an unbounded search */
    UCI_QUIT = 2,      /* a quit arrived; it also waits in the queue, so the UCI loop reads it next */
    UCI_PONDERHIT = 4, /* a ponderhit arrived */
};

/*
 * The next line of input, without its line end: a line queued during a search
 * first, else it waits for one. NULL at the end of input. The text is the
 * helper's, and the next call to the helper overwrites it.
 */
const char *uci_getline(void);

/*
 * Handles the input that waits now, without waiting for more. It answers an
 * isready that has no line queued ahead of it, reports stop, quit and ponderhit
 * in its result, and queues every other line, in order, for uci_getline.
 *
 * unbounded: nonzero when only a stop ends the search (go infinite, or pondering).
 * At the end of input such a search gets UCI_STOP on every call. A bounded
 * search gets nothing, so it finishes and its go still gets a bestmove.
 */
int uci_poll(int unbounded);

/*
 * Waits for input or its end, then handles it as uci_poll(1) does. It takes the
 * place of a loop that spins until another thread sets a stop flag.
 */
int uci_wait(void);

#ifdef __cplusplus
}
#endif

#endif
