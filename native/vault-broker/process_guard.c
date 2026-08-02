#include "process_guard.h"
#include "diagnostics.h"

#ifndef WHALEHALL_CORE_REQUIREMENT
#error "WHALEHALL_CORE_REQUIREMENT must be supplied by the signed build"
#endif

#ifndef WHALEHALL_OUTER_REQUIREMENT
#error "WHALEHALL_OUTER_REQUIREMENT must be supplied by the signed build"
#endif

#include <CoreFoundation/CoreFoundation.h>
#include <Security/SecRequirement.h>
#include <Security/SecStaticCode.h>
#include <bsm/libbsm.h>
#include <libproc.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

static const char LAUNCHER_SUFFIX[] = "/Contents/MacOS/launcher";
static const char BUN_SUFFIX[] = "/Contents/MacOS/bun";
static const char CORE_SUFFIX[] =
    "/Contents/Resources/app/native/whalehall-local";
static const char BROKER_BASENAME[] = "whalehall-vault-broker-v2";

static int copy_process_snapshot(pid_t pid,
                                 struct whvb_process_snapshot *snapshot) {
    struct proc_bsdinfo info;
    char raw_path[PROC_PIDPATHINFO_MAXSIZE];
    char resolved_path[PATH_MAX];
    int path_length;
    int info_length;

    if (pid <= 1 || snapshot == NULL) {
        return 0;
    }

    memset(&info, 0, sizeof(info));
    info_length = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info,
                               (int)sizeof(info));
    if (info_length != (int)sizeof(info) || info.pbi_pid != (uint32_t)pid) {
        return 0;
    }

    memset(raw_path, 0, sizeof(raw_path));
    path_length = proc_pidpath(pid, raw_path, (uint32_t)sizeof(raw_path));
    if (path_length <= 0 || (size_t)path_length >= sizeof(raw_path) ||
        realpath(raw_path, resolved_path) == NULL) {
        return 0;
    }

    memset(snapshot, 0, sizeof(*snapshot));
    snapshot->pid = pid;
    snapshot->parent_pid = (pid_t)info.pbi_ppid;
    snapshot->started_seconds = info.pbi_start_tvsec;
    snapshot->started_microseconds = info.pbi_start_tvusec;
    if (strlcpy(snapshot->path, resolved_path, sizeof(snapshot->path)) >=
        sizeof(snapshot->path)) {
        memset(snapshot, 0, sizeof(*snapshot));
        return 0;
    }
    return 1;
}

static int snapshots_equal(const struct whvb_process_snapshot *left,
                           const struct whvb_process_snapshot *right) {
    return left != NULL && right != NULL && left->pid == right->pid &&
           left->parent_pid == right->parent_pid &&
           left->started_seconds == right->started_seconds &&
           left->started_microseconds == right->started_microseconds &&
           strcmp(left->path, right->path) == 0;
}

static int has_suffix(const char *path, const char *suffix) {
    size_t path_length;
    size_t suffix_length;

    if (path == NULL || suffix == NULL) {
        return 0;
    }
    path_length = strlen(path);
    suffix_length = strlen(suffix);
    return path_length > suffix_length &&
           strcmp(path + path_length - suffix_length, suffix) == 0;
}

static int copy_app_root(const char *launcher_path, char app_root[PATH_MAX]) {
    size_t launcher_length;
    size_t suffix_length = strlen(LAUNCHER_SUFFIX);

    if (!has_suffix(launcher_path, LAUNCHER_SUFFIX)) {
        return 0;
    }
    launcher_length = strlen(launcher_path);
    if (launcher_length - suffix_length == 0 ||
        launcher_length - suffix_length >= PATH_MAX) {
        return 0;
    }
    memcpy(app_root, launcher_path, launcher_length - suffix_length);
    app_root[launcher_length - suffix_length] = '\0';
    return has_suffix(app_root, ".app");
}

static int path_is_exactly_in_app(const char *path, const char *app_root,
                                  const char *suffix) {
    char expected[PATH_MAX];
    int written = snprintf(expected, sizeof(expected), "%s%s", app_root, suffix);
    return written > 0 && (size_t)written < sizeof(expected) &&
           strcmp(path, expected) == 0;
}

int whvb_static_path_satisfies_requirement(const char *path, int is_directory,
                                           const char *requirement_text) {
    CFURLRef url = NULL;
    CFStringRef requirement_string = NULL;
    SecRequirementRef requirement = NULL;
    SecStaticCodeRef code = NULL;
    SecCSFlags validation_flags = kSecCSStrictValidate;
    OSStatus status;
    int valid = 0;

    if (path == NULL || path[0] != '/' || requirement_text == NULL) {
        return 0;
    }
    if (is_directory) {
        validation_flags |= kSecCSCheckNestedCode;
    }
    url = CFURLCreateFromFileSystemRepresentation(
        kCFAllocatorDefault, (const UInt8 *)path, (CFIndex)strlen(path),
        is_directory ? TRUE : FALSE);
    if (url == NULL) {
        return 0;
    }
    requirement_string = CFStringCreateWithCString(
        kCFAllocatorDefault, requirement_text, kCFStringEncodingUTF8);
    if (requirement_string == NULL) {
        CFRelease(url);
        return 0;
    }
    status = SecRequirementCreateWithString(requirement_string,
                                            kSecCSDefaultFlags, &requirement);
    if (status == errSecSuccess && requirement != NULL &&
        SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code) ==
            errSecSuccess &&
        code != NULL &&
        SecStaticCodeCheckValidity(code, validation_flags, requirement) ==
            errSecSuccess) {
        valid = 1;
    }
    if (code != NULL) {
        CFRelease(code);
    }
    if (requirement != NULL) {
        CFRelease(requirement);
    }
    CFRelease(requirement_string);
    CFRelease(url);
    return valid;
}

static int no_watched_process_exited(int queue_fd) {
    struct kevent event;
    struct timespec timeout = {0, 0};
    int count;

    memset(&event, 0, sizeof(event));
    count = kevent(queue_fd, NULL, 0, &event, 1, &timeout);
    return count == 0;
}

static int watch_process(int queue_fd, pid_t pid) {
    struct kevent change;
    struct timespec timeout = {0, 0};

    EV_SET(&change, (uintptr_t)pid, EVFILT_PROC,
           EV_ADD | EV_ENABLE | EV_CLEAR, NOTE_EXIT, 0, NULL);
    return kevent(queue_fd, &change, 1, NULL, 0, &timeout) == 0;
}

static int chain_paths_are_valid(const struct whvb_peer_guard *guard) {
    char app_root[PATH_MAX];

    return copy_app_root(guard->launcher.path, app_root) &&
           path_is_exactly_in_app(guard->launcher.path, app_root,
                                  LAUNCHER_SUFFIX) &&
           path_is_exactly_in_app(guard->bun.path, app_root, BUN_SUFFIX) &&
           path_is_exactly_in_app(guard->core.path, app_root, CORE_SUFFIX);
}

static int static_chain_signatures_are_valid(
    const struct whvb_peer_guard *guard) {
    char app_root[PATH_MAX];
    char canonical_app_root[PATH_MAX];

    if (guard == NULL || !copy_app_root(guard->launcher.path, app_root) ||
        realpath(app_root, canonical_app_root) == NULL ||
        strcmp(app_root, canonical_app_root) != 0) {
        whvb_log_diagnostic(WHVB_DIAG_GUARD_CHAIN_FAILED);
        return 0;
    }
    if (!whvb_static_path_satisfies_requirement(
            guard->core.path, 0, WHALEHALL_CORE_REQUIREMENT)) {
        whvb_log_diagnostic(WHVB_DIAG_GUARD_CORE_STATIC_FAILED);
        return 0;
    }
    if (!whvb_static_path_satisfies_requirement(
            canonical_app_root, 1, WHALEHALL_OUTER_REQUIREMENT)) {
        whvb_log_diagnostic(WHVB_DIAG_GUARD_OUTER_STATIC_FAILED);
        return 0;
    }
    return 1;
}

static int safe_owner_and_mode(const struct stat *metadata, int final_component) {
    if (metadata == NULL ||
        (metadata->st_mode & (S_IWGRP | S_IWOTH)) != 0) {
        return 0;
    }
    if (final_component) {
        return S_ISREG(metadata->st_mode) && metadata->st_uid == geteuid() &&
               (metadata->st_mode & (S_IWUSR | S_IWGRP | S_IWOTH)) == 0;
    }
    return S_ISDIR(metadata->st_mode) &&
           (metadata->st_uid == 0 || metadata->st_uid == geteuid());
}

static int broker_install_path_is_safe(void) {
    char raw_path[PROC_PIDPATHINFO_MAXSIZE];
    char resolved_path[PATH_MAX];
    char component_path[PATH_MAX];
    const char *cursor;
    int raw_length;

    memset(raw_path, 0, sizeof(raw_path));
    raw_length = proc_pidpath(getpid(), raw_path, (uint32_t)sizeof(raw_path));
    if (raw_length <= 0 || (size_t)raw_length >= sizeof(raw_path) ||
        raw_path[0] != '/' || realpath(raw_path, resolved_path) == NULL ||
        strcmp(raw_path, resolved_path) != 0) {
        return 0;
    }
    cursor = strrchr(resolved_path, '/');
    if (cursor == NULL || strcmp(cursor + 1, BROKER_BASENAME) != 0) {
        return 0;
    }

    if (strlcpy(component_path, "/", sizeof(component_path)) >=
        sizeof(component_path)) {
        return 0;
    }
    cursor = resolved_path + 1;
    while (*cursor != '\0') {
        const char *separator = strchr(cursor, '/');
        size_t component_length =
            separator == NULL ? strlen(cursor) : (size_t)(separator - cursor);
        size_t existing_length = strlen(component_path);
        struct stat metadata;
        int final_component = separator == NULL;

        if (component_length == 0 ||
            existing_length + (existing_length > 1 ? 1U : 0U) +
                    component_length >=
                sizeof(component_path)) {
            return 0;
        }
        if (existing_length > 1) {
            component_path[existing_length] = '/';
            existing_length += 1U;
        }
        memcpy(component_path + existing_length, cursor, component_length);
        component_path[existing_length + component_length] = '\0';
        if (lstat(component_path, &metadata) != 0 ||
            !safe_owner_and_mode(&metadata, final_component)) {
            return 0;
        }
        if (final_component) {
            return 1;
        }
        cursor = separator + 1;
    }
    return 0;
}

static int current_chain_matches(const struct whvb_peer_guard *guard) {
    struct whvb_process_snapshot current_core;
    struct whvb_process_snapshot current_bun;
    struct whvb_process_snapshot current_launcher;

    if (guard == NULL || guard->queue_fd < 0 ||
        !no_watched_process_exited(guard->queue_fd)) {
        whvb_log_diagnostic(WHVB_DIAG_GUARD_WATCH_FAILED);
        return 0;
    }
    if (
        !copy_process_snapshot(guard->core.pid, &current_core) ||
        !copy_process_snapshot(guard->bun.pid, &current_bun) ||
        !copy_process_snapshot(guard->launcher.pid, &current_launcher)) {
        whvb_log_diagnostic(WHVB_DIAG_GUARD_SNAPSHOT_FAILED);
        return 0;
    }
    if (
        !snapshots_equal(&guard->core, &current_core) ||
        !snapshots_equal(&guard->bun, &current_bun) ||
        !snapshots_equal(&guard->launcher, &current_launcher) ||
        current_core.parent_pid != current_bun.pid ||
        current_bun.parent_pid != current_launcher.pid ||
        getppid() != current_core.pid || !chain_paths_are_valid(guard)) {
        whvb_log_diagnostic(WHVB_DIAG_GUARD_CHAIN_FAILED);
        return 0;
    }
    if (!broker_install_path_is_safe()) {
        whvb_log_diagnostic(WHVB_DIAG_GUARD_INSTALL_PATH_FAILED);
        return 0;
    }
    if (!static_chain_signatures_are_valid(guard)) {
        return 0;
    }
    if (!no_watched_process_exited(guard->queue_fd)) {
        whvb_log_diagnostic(WHVB_DIAG_GUARD_WATCH_FAILED);
        return 0;
    }
    return 1;
}

int whvb_peer_guard_open(int socket_fd, struct whvb_peer_guard *guard) {
    audit_token_t token;
    socklen_t token_length = sizeof(token);
    int socket_type = 0;
    socklen_t socket_type_length = sizeof(socket_type);
    pid_t peer_pid;

    if (guard == NULL) {
        return 0;
    }
    memset(guard, 0, sizeof(*guard));
    guard->queue_fd = -1;

    if (getsockopt(socket_fd, SOL_SOCKET, SO_TYPE, &socket_type,
                   &socket_type_length) != 0 ||
        socket_type_length != sizeof(socket_type) ||
        socket_type != SOCK_STREAM ||
        getsockopt(socket_fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token,
                   &token_length) != 0 ||
        token_length != sizeof(token)) {
        whvb_log_diagnostic(WHVB_DIAG_GUARD_SOCKET_INVALID);
        return 0;
    }

    peer_pid = audit_token_to_pid(token);
    if (peer_pid <= 1 || peer_pid != getppid() ||
        audit_token_to_euid(token) != geteuid()) {
        whvb_log_diagnostic(WHVB_DIAG_GUARD_PEER_BINDING_FAILED);
        return 0;
    }
    if (
        !copy_process_snapshot(peer_pid, &guard->core) ||
        !copy_process_snapshot(guard->core.parent_pid, &guard->bun) ||
        !copy_process_snapshot(guard->bun.parent_pid, &guard->launcher)) {
        whvb_log_diagnostic(WHVB_DIAG_GUARD_SNAPSHOT_FAILED);
        return 0;
    }
    if (
        guard->core.parent_pid != guard->bun.pid ||
        guard->bun.parent_pid != guard->launcher.pid ||
        guard->core.pid == guard->bun.pid ||
        guard->bun.pid == guard->launcher.pid ||
        !chain_paths_are_valid(guard)) {
        whvb_log_diagnostic(WHVB_DIAG_GUARD_CHAIN_FAILED);
        return 0;
    }
    if (!broker_install_path_is_safe()) {
        whvb_log_diagnostic(WHVB_DIAG_GUARD_INSTALL_PATH_FAILED);
        return 0;
    }
    if (!static_chain_signatures_are_valid(guard)) {
        return 0;
    }

    guard->queue_fd = kqueue();
    if (guard->queue_fd < 0 ||
        !watch_process(guard->queue_fd, guard->core.pid) ||
        !watch_process(guard->queue_fd, guard->bun.pid) ||
        !watch_process(guard->queue_fd, guard->launcher.pid) ||
        !current_chain_matches(guard)) {
        whvb_log_diagnostic(WHVB_DIAG_GUARD_WATCH_FAILED);
        whvb_peer_guard_close(guard);
        return 0;
    }
    return 1;
}

int whvb_peer_guard_revalidate(const struct whvb_peer_guard *guard) {
    return current_chain_matches(guard);
}

void whvb_peer_guard_close(struct whvb_peer_guard *guard) {
    if (guard == NULL) {
        return;
    }
    if (guard->queue_fd >= 0) {
        (void)close(guard->queue_fd);
    }
    memset(guard, 0, sizeof(*guard));
    guard->queue_fd = -1;
}
