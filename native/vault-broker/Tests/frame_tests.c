#include "../frame.h"

#include <assert.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static void valid_request(uint8_t frame[WHVB_REQUEST_SIZE], uint8_t operation) {
    static const uint8_t magic[8] = {'W', 'H', 'V', 'B', 'R', 'E', 'Q', '2'};
    size_t index;

    memset(frame, 0, WHVB_REQUEST_SIZE);
    memcpy(frame, magic, sizeof(magic));
    frame[8] = 2;
    frame[9] = operation;
    frame[15] = WHVB_NONCE_SIZE;
    for (index = 0; index < WHVB_NONCE_SIZE; index += 1U) {
        frame[16 + index] = (uint8_t)(index + 1U);
    }
}

static void test_request_parser(void) {
    uint8_t frame[WHVB_REQUEST_SIZE];
    uint8_t overlong[WHVB_REQUEST_SIZE + 1U];
    struct whvb_request request;

    valid_request(frame, WHVB_OP_LOAD);
    assert(whvb_parse_request(frame, sizeof(frame), &request));
    assert(request.operation == WHVB_OP_LOAD);
    assert(memcmp(request.nonce, &frame[16], WHVB_NONCE_SIZE) == 0);

    assert(!whvb_parse_request(frame, sizeof(frame) - 1U, &request));
    memcpy(overlong, frame, sizeof(frame));
    overlong[WHVB_REQUEST_SIZE] = 0U;
    assert(!whvb_parse_request(overlong, sizeof(overlong), &request));
    frame[8] = 1U;
    assert(!whvb_parse_request(frame, sizeof(frame), &request));
    frame[8] = 2U;
    frame[0] ^= 1U;
    assert(!whvb_parse_request(frame, sizeof(frame), &request));
    frame[0] ^= 1U;
    frame[10] = 1U;
    assert(!whvb_parse_request(frame, sizeof(frame), &request));
    frame[10] = 0U;
    frame[11] = 1U;
    assert(!whvb_parse_request(frame, sizeof(frame), &request));
    frame[11] = 0U;
    frame[15] = WHVB_NONCE_SIZE + 1U;
    assert(!whvb_parse_request(frame, sizeof(frame), &request));
    frame[15] = WHVB_NONCE_SIZE;
    frame[9] = 3U;
    assert(!whvb_parse_request(frame, sizeof(frame), &request));

    valid_request(frame, WHVB_OP_IMPORT_LEGACY);
    assert(whvb_parse_request(frame, sizeof(frame), &request));
    assert(request.operation == WHVB_OP_IMPORT_LEGACY);
}

static void test_response_encoder(void) {
    uint8_t frame[WHVB_AVAILABLE_RESPONSE_SIZE];
    struct whvb_response response;
    size_t frame_length = 0;
    size_t index;

    memset(&response, 0, sizeof(response));
    response.status = WHVB_STATUS_AVAILABLE;
    response.flags = 1U;
    response.key_version = WHVB_KEY_VERSION_LEGACY;
    for (index = 0; index < WHVB_NONCE_SIZE; index += 1U) {
        response.nonce[index] = (uint8_t)index;
    }
    memset(response.key, 0xa5, sizeof(response.key));
    assert(whvb_encode_response(&response, frame, sizeof(frame), &frame_length));
    assert(frame_length == WHVB_AVAILABLE_RESPONSE_SIZE);
    assert(memcmp(frame, "WHVBRSP2", 8) == 0);
    assert(frame[8] == 2U && frame[9] == WHVB_STATUS_AVAILABLE);
    assert(frame[10] == 1U && frame[11] == WHVB_KEY_VERSION_LEGACY);
    assert(frame[12] == 0U && frame[13] == 0U && frame[14] == 0U &&
           frame[15] == 48U);
    assert(memcmp(&frame[16], response.nonce, WHVB_NONCE_SIZE) == 0);
    assert(memcmp(&frame[32], response.key, WHVB_KEY_SIZE) == 0);

    response.status = WHVB_STATUS_MIGRATION_REQUIRED;
    response.flags = 0U;
    response.key_version = WHVB_KEY_VERSION_NONE;
    assert(whvb_encode_response(&response, frame, sizeof(frame), &frame_length));
    assert(frame_length == WHVB_ERROR_RESPONSE_SIZE);
    assert(frame[15] == WHVB_NONCE_SIZE);

    response.flags = 1U;
    assert(!whvb_encode_response(&response, frame, sizeof(frame), &frame_length));
    response.flags = 0U;
    response.status = WHVB_STATUS_AVAILABLE;
    assert(!whvb_encode_response(&response, frame, sizeof(frame), &frame_length));
    response.key_version = WHVB_KEY_VERSION_CURRENT;
    response.flags = 2U;
    assert(!whvb_encode_response(&response, frame, sizeof(frame), &frame_length));
    response.flags = 0U;
    assert(!whvb_encode_response(&response, frame,
                                 WHVB_AVAILABLE_RESPONSE_SIZE - 1U,
                                 &frame_length));
}

static void test_constant_time_helpers(void) {
    uint8_t left[WHVB_KEY_SIZE];
    uint8_t right[WHVB_KEY_SIZE];

    memset(left, 0x3c, sizeof(left));
    memcpy(right, left, sizeof(right));
    assert(whvb_constant_time_equal(left, right, sizeof(left)));
    right[sizeof(right) - 1U] ^= 1U;
    assert(!whvb_constant_time_equal(left, right, sizeof(left)));
    whvb_secure_zero(left, sizeof(left));
    for (size_t index = 0; index < sizeof(left); index += 1U) {
        assert(left[index] == 0U);
    }
}

static void configure_test_timeout(int socket_fd) {
    struct timeval timeout = {1, 0};
    assert(setsockopt(socket_fd, SOL_SOCKET, SO_RCVTIMEO, &timeout,
                      sizeof(timeout)) == 0);
}

static void test_socket_reader_requires_exact_frame_and_eof(void) {
    uint8_t request[WHVB_REQUEST_SIZE];
    uint8_t received[WHVB_REQUEST_SIZE];
    size_t received_length = 0;
    int sockets[2];

    valid_request(request, WHVB_OP_LOAD);
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
    configure_test_timeout(sockets[0]);
    assert(send(sockets[1], request, sizeof(request), 0) ==
           (ssize_t)sizeof(request));
    assert(shutdown(sockets[1], SHUT_WR) == 0);
    assert(whvb_receive_request_frame(sockets[0], received, &received_length));
    assert(received_length == WHVB_REQUEST_SIZE);
    assert(memcmp(request, received, sizeof(request)) == 0);
    assert(close(sockets[0]) == 0);
    assert(close(sockets[1]) == 0);

    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
    configure_test_timeout(sockets[0]);
    assert(send(sockets[1], request, sizeof(request) - 1U, 0) ==
           (ssize_t)(sizeof(request) - 1U));
    assert(shutdown(sockets[1], SHUT_WR) == 0);
    assert(!whvb_receive_request_frame(sockets[0], received, &received_length));
    assert(received_length == WHVB_REQUEST_SIZE - 1U);
    assert(close(sockets[0]) == 0);
    assert(close(sockets[1]) == 0);
}

static void test_socket_reader_rejects_delayed_byte_33(void) {
    uint8_t request[WHVB_REQUEST_SIZE];
    uint8_t received[WHVB_REQUEST_SIZE];
    size_t received_length = 0;
    int sockets[2];
    pid_t child;
    int child_status = 0;

    valid_request(request, WHVB_OP_LOAD);
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
    configure_test_timeout(sockets[0]);
    child = fork();
    assert(child >= 0);
    if (child == 0) {
        const uint8_t extra = 0xa5U;
        const struct timespec delay = {0, 100 * 1000 * 1000};
        int ok = close(sockets[0]) == 0 &&
                 send(sockets[1], request, sizeof(request), 0) ==
                     (ssize_t)sizeof(request) &&
                 nanosleep(&delay, NULL) == 0 &&
                 send(sockets[1], &extra, sizeof(extra), 0) ==
                     (ssize_t)sizeof(extra) &&
                 shutdown(sockets[1], SHUT_WR) == 0;
        (void)close(sockets[1]);
        _exit(ok ? 0 : 1);
    }
    assert(close(sockets[1]) == 0);
    assert(!whvb_receive_request_frame(sockets[0], received, &received_length));
    assert(received_length == WHVB_REQUEST_SIZE);
    assert(close(sockets[0]) == 0);
    assert(waitpid(child, &child_status, 0) == child);
    assert(WIFEXITED(child_status) && WEXITSTATUS(child_status) == 0);
}

int main(void) {
    test_request_parser();
    test_response_encoder();
    test_constant_time_helpers();
    test_socket_reader_requires_exact_frame_and_eof();
    test_socket_reader_rejects_delayed_byte_33();
    return 0;
}
