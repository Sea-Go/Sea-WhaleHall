#include "../keychain_store.h"

#include <assert.h>
#include <string.h>

int main(void) {
    struct whvb_response target;
    uint8_t source[WHVB_KEY_SIZE];

    memset(&target, 0, sizeof(target));
    memset(source, 0x5c, sizeof(source));
    target.status = WHVB_STATUS_AVAILABLE;
    target.flags = 1U;
    target.key_version = WHVB_KEY_VERSION_LEGACY;
    memcpy(target.key, source, sizeof(source));
    assert(whvb_target_matches_authoritative_source(
        &target, source, WHVB_KEY_VERSION_LEGACY, 1U));
    whvb_mark_import_idempotent(&target);
    assert(target.status == WHVB_STATUS_AVAILABLE);
    assert(target.flags == 0U);
    assert(target.key_version == WHVB_KEY_VERSION_LEGACY);
    assert(memcmp(target.key, source, sizeof(source)) == 0);

    target.flags = 1U;
    target.key[WHVB_KEY_SIZE - 1U] ^= 1U;
    assert(!whvb_target_matches_authoritative_source(
        &target, source, WHVB_KEY_VERSION_LEGACY, 1U));
    target.key[WHVB_KEY_SIZE - 1U] ^= 1U;
    target.flags = 0U;
    assert(!whvb_target_matches_authoritative_source(
        &target, source, WHVB_KEY_VERSION_LEGACY, 1U));
    target.flags = 1U;
    target.key_version = WHVB_KEY_VERSION_CURRENT;
    assert(!whvb_target_matches_authoritative_source(
        &target, source, WHVB_KEY_VERSION_LEGACY, 1U));
    target.key_version = WHVB_KEY_VERSION_LEGACY;
    target.status = WHVB_STATUS_CONFLICT;
    assert(!whvb_target_matches_authoritative_source(
        &target, source, WHVB_KEY_VERSION_LEGACY, 1U));

    target.status = WHVB_STATUS_AVAILABLE;
    target.flags = 0U;
    target.key_version = WHVB_KEY_VERSION_CURRENT;
    memcpy(target.key, source, sizeof(source));
    assert(whvb_finalize_load_duplicate_winner(&target, 0));
    assert(target.status == WHVB_STATUS_AVAILABLE);

    target.status = WHVB_STATUS_UNAVAILABLE;
    target.flags = 1U;
    target.key_version = WHVB_KEY_VERSION_LEGACY;
    memset(target.key, 0x91, sizeof(target.key));
    assert(!whvb_finalize_load_duplicate_winner(&target, 0));
    assert(target.status == WHVB_STATUS_CONFLICT);
    assert(target.flags == 0U);
    assert(target.key_version == WHVB_KEY_VERSION_NONE);
    for (size_t index = 0; index < sizeof(target.key); index += 1U) {
        assert(target.key[index] == 0U);
    }

    target.status = WHVB_STATUS_AVAILABLE;
    target.key_version = WHVB_KEY_VERSION_CURRENT;
    assert(!whvb_finalize_load_duplicate_winner(&target, 1));
    assert(target.status == WHVB_STATUS_CONFLICT);
    return 0;
}
