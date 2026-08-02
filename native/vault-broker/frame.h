#ifndef WHALEHALL_VAULT_BROKER_FRAME_H
#define WHALEHALL_VAULT_BROKER_FRAME_H

#include <stddef.h>
#include <stdint.h>

#define WHVB_REQUEST_SIZE 32U
#define WHVB_ERROR_RESPONSE_SIZE 32U
#define WHVB_AVAILABLE_RESPONSE_SIZE 64U
#define WHVB_NONCE_SIZE 16U
#define WHVB_KEY_SIZE 32U

enum whvb_operation {
    WHVB_OP_LOAD = 1,
    WHVB_OP_IMPORT_LEGACY = 2,
};

enum whvb_status {
    WHVB_STATUS_AVAILABLE = 0,
    WHVB_STATUS_MIGRATION_REQUIRED = 1,
    WHVB_STATUS_UNAVAILABLE = 2,
    WHVB_STATUS_CONFLICT = 3,
    WHVB_STATUS_INVALID = 4,
};

enum whvb_key_version {
    WHVB_KEY_VERSION_NONE = 0,
    WHVB_KEY_VERSION_CURRENT = 1,
    WHVB_KEY_VERSION_LEGACY = 2,
};

struct whvb_request {
    uint8_t operation;
    uint8_t nonce[WHVB_NONCE_SIZE];
};

struct whvb_response {
    uint8_t status;
    uint8_t flags;
    uint8_t key_version;
    uint8_t nonce[WHVB_NONCE_SIZE];
    uint8_t key[WHVB_KEY_SIZE];
};

int whvb_constant_time_equal(const uint8_t *left, const uint8_t *right,
                             size_t length);

void whvb_secure_zero(void *value, size_t length);

int whvb_parse_request(const uint8_t *frame, size_t frame_length,
                       struct whvb_request *request);

int whvb_encode_response(const struct whvb_response *response, uint8_t *frame,
                         size_t frame_capacity, size_t *frame_length);

/* Reads exactly one request and requires write-side EOF after byte 32. The
 * socket must already have its receive timeout configured. */
int whvb_receive_request_frame(int socket_fd,
                               uint8_t frame[WHVB_REQUEST_SIZE],
                               size_t *received_length);

#endif
