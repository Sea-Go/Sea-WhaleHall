#include "frame.h"

#include <errno.h>
#include <string.h>
#include <sys/socket.h>

static const uint8_t REQUEST_MAGIC[8] = {'W', 'H', 'V', 'B', 'R', 'E', 'Q', '2'};
static const uint8_t RESPONSE_MAGIC[8] = {'W', 'H', 'V', 'B', 'R', 'S', 'P', '2'};

static uint32_t read_be32(const uint8_t bytes[4]) {
    return ((uint32_t)bytes[0] << 24U) | ((uint32_t)bytes[1] << 16U) |
           ((uint32_t)bytes[2] << 8U) | (uint32_t)bytes[3];
}

static void write_be32(uint8_t bytes[4], uint32_t value) {
    bytes[0] = (uint8_t)(value >> 24U);
    bytes[1] = (uint8_t)(value >> 16U);
    bytes[2] = (uint8_t)(value >> 8U);
    bytes[3] = (uint8_t)value;
}

int whvb_constant_time_equal(const uint8_t *left, const uint8_t *right,
                             size_t length) {
    size_t index;
    uint8_t difference = 0;

    if (left == NULL || right == NULL) {
        return 0;
    }

    for (index = 0; index < length; index += 1U) {
        difference |= (uint8_t)(left[index] ^ right[index]);
    }
    return difference == 0;
}

void whvb_secure_zero(void *value, size_t length) {
    volatile uint8_t *bytes = (volatile uint8_t *)value;

    if (bytes == NULL) {
        return;
    }
    while (length > 0U) {
        *bytes = 0U;
        bytes += 1;
        length -= 1U;
    }
}

int whvb_parse_request(const uint8_t *frame, size_t frame_length,
                       struct whvb_request *request) {
    if (frame == NULL || request == NULL || frame_length != WHVB_REQUEST_SIZE) {
        return 0;
    }
    if (!whvb_constant_time_equal(frame, REQUEST_MAGIC, sizeof(REQUEST_MAGIC)) ||
        frame[8] != 2U ||
        (frame[9] != WHVB_OP_LOAD && frame[9] != WHVB_OP_IMPORT_LEGACY) ||
        frame[10] != 0U || frame[11] != 0U || read_be32(&frame[12]) != 16U) {
        return 0;
    }

    request->operation = frame[9];
    memcpy(request->nonce, &frame[16], WHVB_NONCE_SIZE);
    return 1;
}

int whvb_encode_response(const struct whvb_response *response, uint8_t *frame,
                         size_t frame_capacity, size_t *frame_length) {
    size_t required_length;
    uint32_t payload_length;

    if (response == NULL || frame == NULL || frame_length == NULL ||
        response->status > WHVB_STATUS_INVALID || (response->flags & ~1U) != 0U) {
        return 0;
    }

    if (response->status == WHVB_STATUS_AVAILABLE) {
        if (response->key_version != WHVB_KEY_VERSION_CURRENT &&
            response->key_version != WHVB_KEY_VERSION_LEGACY) {
            return 0;
        }
        required_length = WHVB_AVAILABLE_RESPONSE_SIZE;
        payload_length = WHVB_NONCE_SIZE + WHVB_KEY_SIZE;
    } else {
        if (response->flags != 0U ||
            response->key_version != WHVB_KEY_VERSION_NONE) {
            return 0;
        }
        required_length = WHVB_ERROR_RESPONSE_SIZE;
        payload_length = WHVB_NONCE_SIZE;
    }

    if (frame_capacity < required_length) {
        return 0;
    }

    memset(frame, 0, required_length);
    memcpy(frame, RESPONSE_MAGIC, sizeof(RESPONSE_MAGIC));
    frame[8] = 2U;
    frame[9] = response->status;
    frame[10] = response->flags;
    frame[11] = response->key_version;
    write_be32(&frame[12], payload_length);
    memcpy(&frame[16], response->nonce, WHVB_NONCE_SIZE);
    if (response->status == WHVB_STATUS_AVAILABLE) {
        memcpy(&frame[32], response->key, WHVB_KEY_SIZE);
    }

    *frame_length = required_length;
    return 1;
}

int whvb_receive_request_frame(int socket_fd,
                               uint8_t frame[WHVB_REQUEST_SIZE],
                               size_t *received_length) {
    size_t offset = 0;
    uint8_t extra;

    if (socket_fd < 0 || frame == NULL || received_length == NULL) {
        return 0;
    }
    *received_length = 0;
    while (offset < WHVB_REQUEST_SIZE) {
        ssize_t received =
            recv(socket_fd, frame + offset, WHVB_REQUEST_SIZE - offset, 0);
        if (received > 0) {
            offset += (size_t)received;
            *received_length = offset;
            continue;
        }
        if (received == 0) {
            return 0;
        }
        if (errno != EINTR) {
            return 0;
        }
    }

    /* A stream has no frame boundary at byte 32. Wait for write-side EOF so a
     * delayed byte 33 cannot arrive after validation. The configured socket
     * timeout makes a peer that withholds EOF fail closed. */
    for (;;) {
        ssize_t received = recv(socket_fd, &extra, sizeof(extra), 0);
        if (received == 0) {
            return 1;
        }
        if (received > 0) {
            return 0;
        }
        if (errno != EINTR) {
            return 0;
        }
    }
}
