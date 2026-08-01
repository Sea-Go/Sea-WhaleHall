#ifndef WHALEHALL_VAULT_BROKER_PROCESS_GUARD_H
#define WHALEHALL_VAULT_BROKER_PROCESS_GUARD_H

#include <sys/types.h>

struct whvb_process_snapshot {
    pid_t pid;
    pid_t parent_pid;
    unsigned long long started_seconds;
    unsigned long long started_microseconds;
    char path[4096];
};

struct whvb_peer_guard {
    int queue_fd;
    struct whvb_process_snapshot core;
    struct whvb_process_snapshot bun;
    struct whvb_process_snapshot launcher;
};

int whvb_peer_guard_open(int socket_fd, struct whvb_peer_guard *guard);
int whvb_peer_guard_revalidate(const struct whvb_peer_guard *guard);
void whvb_peer_guard_close(struct whvb_peer_guard *guard);

/* Internal test seam for the same strict static validation used by the guard.
 * Production builds hide this symbol with -fvisibility=hidden. */
int whvb_static_path_satisfies_requirement(const char *path, int is_directory,
                                           const char *requirement_text);

#endif
