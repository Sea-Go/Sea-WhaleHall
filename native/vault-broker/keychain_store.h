#ifndef WHALEHALL_VAULT_BROKER_KEYCHAIN_STORE_H
#define WHALEHALL_VAULT_BROKER_KEYCHAIN_STORE_H

#include "frame.h"

int whvb_keychain_operation(uint8_t operation, struct whvb_response *response);

/* Pure policy seam used by migration tests. Key comparison always traverses
 * all 32 bytes before metadata decides the result. */
int whvb_target_matches_authoritative_source(
    const struct whvb_response *target,
    const uint8_t authoritative_key[WHVB_KEY_SIZE], uint8_t key_version,
    uint8_t migrated);

void whvb_mark_import_idempotent(struct whvb_response *response);

int whvb_finalize_load_duplicate_winner(struct whvb_response *response,
                                        int winner_missing);

#endif
