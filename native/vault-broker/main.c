#include "frame.h"
#include "keychain_store.h"
#include "process_guard.h"

#include <errno.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#define BROKER_SOCKET_FD 3

static int disable_core_dumps(void) {
    struct rlimit limit = {0, 0};
    return setrlimit(RLIMIT_CORE, &limit) == 0;
}

static int configure_socket(int socket_fd) {
    struct timeval timeout = {5, 0};
    int no_sigpipe = 1;

    return setsockopt(socket_fd, SOL_SOCKET, SO_RCVTIMEO, &timeout,
                      sizeof(timeout)) == 0 &&
           setsockopt(socket_fd, SOL_SOCKET, SO_SNDTIMEO, &timeout,
                      sizeof(timeout)) == 0 &&
           setsockopt(socket_fd, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe,
                      sizeof(no_sigpipe)) == 0;
}

static int send_all(int socket_fd, const uint8_t *frame, size_t frame_length) {
    size_t offset = 0;

    while (offset < frame_length) {
        ssize_t sent = send(socket_fd, frame + offset, frame_length - offset, 0);
        if (sent > 0) {
            offset += (size_t)sent;
            continue;
        }
        if (sent < 0 && errno == EINTR) {
            continue;
        }
        return 0;
    }
    return 1;
}

static int send_invalid_response(int socket_fd, const uint8_t *request_frame,
                                 size_t request_length) {
    struct whvb_response response;
    uint8_t frame[WHVB_ERROR_RESPONSE_SIZE];
    size_t frame_length = 0;
    int sent;

    memset(&response, 0, sizeof(response));
    response.status = WHVB_STATUS_INVALID;
    if (request_length == WHVB_REQUEST_SIZE) {
        memcpy(response.nonce, request_frame + 16, WHVB_NONCE_SIZE);
    }
    if (!whvb_encode_response(&response, frame, sizeof(frame), &frame_length)) {
        whvb_secure_zero(&response, sizeof(response));
        whvb_secure_zero(frame, sizeof(frame));
        return 0;
    }
    sent = send_all(socket_fd, frame, frame_length);
    whvb_secure_zero(&response, sizeof(response));
    whvb_secure_zero(frame, sizeof(frame));
    return sent;
}

int main(void) {
    uint8_t request_frame[WHVB_REQUEST_SIZE];
    uint8_t response_frame[WHVB_AVAILABLE_RESPONSE_SIZE];
    struct whvb_request request;
    struct whvb_response response;
    struct whvb_peer_guard guard;
    size_t request_length = 0;
    size_t response_length = 0;
    int request_valid;
    int response_key_locked = 0;
    int response_frame_locked = 0;
    int sent = 0;
    int exit_code = 1;

    memset(request_frame, 0, sizeof(request_frame));
    memset(response_frame, 0, sizeof(response_frame));
    memset(&request, 0, sizeof(request));
    memset(&response, 0, sizeof(response));
    memset(&guard, 0, sizeof(guard));
    guard.queue_fd = -1;

    if (!disable_core_dumps() || signal(SIGPIPE, SIG_IGN) == SIG_ERR ||
        !configure_socket(BROKER_SOCKET_FD)) {
        goto cleanup;
    }

    request_valid = whvb_receive_request_frame(BROKER_SOCKET_FD, request_frame,
                                               &request_length) &&
                    whvb_parse_request(request_frame, request_length, &request);
    if (!request_valid) {
        exit_code = send_invalid_response(BROKER_SOCKET_FD, request_frame,
                                          request_length)
                        ? 0
                        : 1;
        goto cleanup;
    }

    if (!whvb_peer_guard_open(BROKER_SOCKET_FD, &guard)) {
        goto cleanup;
    }
    if (mlock(response.key, sizeof(response.key)) != 0) {
        goto cleanup;
    }
    response_key_locked = 1;
    if (mlock(response_frame, sizeof(response_frame)) != 0) {
        goto cleanup;
    }
    response_frame_locked = 1;

    memcpy(response.nonce, request.nonce, WHVB_NONCE_SIZE);
    if (!whvb_keychain_operation(request.operation, &response)) {
        response.status = WHVB_STATUS_UNAVAILABLE;
        response.flags = 0U;
        response.key_version = WHVB_KEY_VERSION_NONE;
        whvb_secure_zero(response.key, sizeof(response.key));
    }

    if (!whvb_peer_guard_revalidate(&guard) ||
        !whvb_encode_response(&response, response_frame, sizeof(response_frame),
                              &response_length)) {
        goto cleanup;
    }
    if (response.status == WHVB_STATUS_AVAILABLE &&
        !whvb_peer_guard_revalidate(&guard)) {
        goto cleanup;
    }
    sent = send_all(BROKER_SOCKET_FD, response_frame, response_length);
    if (!sent) {
        goto cleanup;
    }
    if (response.status == WHVB_STATUS_AVAILABLE &&
        !whvb_peer_guard_revalidate(&guard)) {
        goto cleanup;
    }
    exit_code = 0;

cleanup:
    whvb_peer_guard_close(&guard);
    whvb_secure_zero(&response, sizeof(response));
    whvb_secure_zero(response_frame, sizeof(response_frame));
    whvb_secure_zero(&request, sizeof(request));
    whvb_secure_zero(request_frame, sizeof(request_frame));
    if (response_frame_locked) {
        (void)munlock(response_frame, sizeof(response_frame));
    }
    if (response_key_locked) {
        (void)munlock(response.key, sizeof(response.key));
    }
    (void)close(BROKER_SOCKET_FD);
    return exit_code;
}
