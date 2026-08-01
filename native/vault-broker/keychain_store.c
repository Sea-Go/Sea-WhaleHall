#include "keychain_store.h"
#include "diagnostics.h"

#include <CoreFoundation/CoreFoundation.h>
#include <Security/SecBase.h>
#include <Security/SecKeychain.h>
#include <Security/SecKeychainItem.h>
#include <Security/SecRandom.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <sys/mman.h>

static const char TARGET_SERVICE[] =
    "com.seago.whalehall.observation-v2.local-broker-v2";
static const char LOCAL_SIGNED_SERVICE[] =
    "com.seago.whalehall.observation-v2.local-signed";
static const char DEV_LEGACY_SERVICE[] =
    "com.seago.whalehall.observation-v2.dev-legacy";
static const char CURRENT_ACCOUNT[] = "local-aes-256-gcm-key-v1";
static const char MIGRATED_ACCOUNT[] =
    "local-aes-256-gcm-key-from-dev-legacy-v1";

enum item_state {
    ITEM_MISSING = 0,
    ITEM_AVAILABLE = 1,
    ITEM_UNAVAILABLE = 2,
};

enum source_state {
    SOURCE_NONE = 0,
    SOURCE_AVAILABLE = 1,
    SOURCE_UNAVAILABLE = 2,
};

struct locked_key {
    uint8_t bytes[WHVB_KEY_SIZE];
    bool locked;
};

struct source_descriptor {
    const char *service;
    const char *account;
    uint8_t target_key_version;
    bool migrated;
};

static const struct source_descriptor SOURCES[] = {
    {LOCAL_SIGNED_SERVICE, MIGRATED_ACCOUNT, WHVB_KEY_VERSION_LEGACY, true},
    {LOCAL_SIGNED_SERVICE, CURRENT_ACCOUNT, WHVB_KEY_VERSION_CURRENT, false},
    {DEV_LEGACY_SERVICE, CURRENT_ACCOUNT, WHVB_KEY_VERSION_LEGACY, true},
};

static int locked_key_init(struct locked_key *key) {
    if (key == NULL) {
        return 0;
    }
    memset(key, 0, sizeof(*key));
    if (mlock(key->bytes, sizeof(key->bytes)) != 0) {
        return 0;
    }
    key->locked = true;
    return 1;
}

static void locked_key_destroy(struct locked_key *key) {
    if (key == NULL) {
        return;
    }
    whvb_secure_zero(key->bytes, sizeof(key->bytes));
    /* Nested locked keys can share a stack page. Keep that page locked until
     * this one-shot process exits so destroying an inner key cannot unlock a
     * still-live caller key. */
    memset(key, 0, sizeof(*key));
}

static enum item_state item_exists(SecKeychainRef keychain,
                                   const char *service, const char *account) {
    SecKeychainItemRef item = NULL;
    OSStatus status = SecKeychainFindGenericPassword(
        keychain, (UInt32)strlen(service), service, (UInt32)strlen(account),
        account, NULL, NULL, &item);

    if (item != NULL) {
        CFRelease(item);
    }
    if (status == errSecSuccess) {
        return ITEM_AVAILABLE;
    }
    if (status == errSecItemNotFound) {
        return ITEM_MISSING;
    }
    return ITEM_UNAVAILABLE;
}

static enum item_state read_item(SecKeychainRef keychain, const char *service,
                                 const char *account, struct locked_key *key) {
    SecKeychainItemRef item = NULL;
    UInt32 content_length = 0;
    void *content = NULL;
    OSStatus status;

    status = SecKeychainFindGenericPassword(
        keychain, (UInt32)strlen(service), service, (UInt32)strlen(account),
        account, &content_length, &content, &item);
    if (item != NULL) {
        CFRelease(item);
    }
    if (status == errSecItemNotFound) {
        return ITEM_MISSING;
    }
    if (status != errSecSuccess || content == NULL ||
        content_length != WHVB_KEY_SIZE || key == NULL || !key->locked) {
        if (content != NULL) {
            if (content_length > 0 && mlock(content, content_length) == 0) {
                whvb_secure_zero(content, content_length);
            } else if (content_length > 0) {
                whvb_secure_zero(content, content_length);
            }
            (void)SecKeychainItemFreeContent(NULL, content);
        }
        return ITEM_UNAVAILABLE;
    }

    if (mlock(content, content_length) != 0) {
        whvb_secure_zero(content, content_length);
        (void)SecKeychainItemFreeContent(NULL, content);
        return ITEM_UNAVAILABLE;
    }
    memcpy(key->bytes, content, WHVB_KEY_SIZE);
    whvb_secure_zero(content, content_length);
    if (SecKeychainItemFreeContent(NULL, content) != errSecSuccess) {
        whvb_secure_zero(key->bytes, sizeof(key->bytes));
        return ITEM_UNAVAILABLE;
    }
    return ITEM_AVAILABLE;
}

static OSStatus add_item(SecKeychainRef keychain, const char *account,
                         const struct locked_key *key) {
    SecKeychainItemRef item = NULL;
    OSStatus status = SecKeychainAddGenericPassword(
        keychain, (UInt32)strlen(TARGET_SERVICE), TARGET_SERVICE,
        (UInt32)strlen(account), account, WHVB_KEY_SIZE, key->bytes, &item);
    if (item != NULL) {
        CFRelease(item);
    }
    return status;
}

static void set_available_result(struct whvb_response *response,
                                 const struct locked_key *key,
                                 uint8_t key_version, bool migrated) {
    response->status = WHVB_STATUS_AVAILABLE;
    response->flags = migrated ? 1U : 0U;
    response->key_version = key_version;
    memcpy(response->key, key->bytes, WHVB_KEY_SIZE);
}

static void set_error_result(struct whvb_response *response, uint8_t status) {
    response->status = status;
    response->flags = 0U;
    response->key_version = WHVB_KEY_VERSION_NONE;
    whvb_secure_zero(response->key, sizeof(response->key));
}

int whvb_target_matches_authoritative_source(
    const struct whvb_response *target,
    const uint8_t authoritative_key[WHVB_KEY_SIZE], uint8_t key_version,
    uint8_t migrated) {
    int key_matches;
    int metadata_matches;

    if (target == NULL || authoritative_key == NULL ||
        (key_version != WHVB_KEY_VERSION_CURRENT &&
         key_version != WHVB_KEY_VERSION_LEGACY) ||
        migrated > 1U) {
        return 0;
    }
    key_matches = whvb_constant_time_equal(target->key, authoritative_key,
                                           WHVB_KEY_SIZE);
    metadata_matches =
        target->status == WHVB_STATUS_AVAILABLE &&
        target->flags == migrated && target->key_version == key_version;
    return key_matches & metadata_matches;
}

void whvb_mark_import_idempotent(struct whvb_response *response) {
    if (response != NULL && response->status == WHVB_STATUS_AVAILABLE) {
        response->flags = 0U;
    }
}

int whvb_finalize_load_duplicate_winner(struct whvb_response *response,
                                        int winner_missing) {
    if (response != NULL && !winner_missing &&
        response->status == WHVB_STATUS_AVAILABLE) {
        return 1;
    }
    if (response != NULL) {
        set_error_result(response, WHVB_STATUS_CONFLICT);
    }
    return 0;
}

static int load_target(SecKeychainRef keychain, struct whvb_response *response,
                       int *target_missing) {
    struct locked_key current;
    struct locked_key migrated;
    enum item_state current_state;
    enum item_state migrated_state;
    int initialized_current = 0;
    int initialized_migrated = 0;
    int handled = 0;

    *target_missing = 0;
    if (!locked_key_init(&current)) {
        whvb_log_diagnostic(WHVB_DIAG_KEYCHAIN_TARGET_UNAVAILABLE);
        return 0;
    }
    initialized_current = 1;
    if (!locked_key_init(&migrated)) {
        whvb_log_diagnostic(WHVB_DIAG_KEYCHAIN_TARGET_UNAVAILABLE);
        goto cleanup;
    }
    initialized_migrated = 1;

    current_state =
        read_item(keychain, TARGET_SERVICE, CURRENT_ACCOUNT, &current);
    migrated_state =
        read_item(keychain, TARGET_SERVICE, MIGRATED_ACCOUNT, &migrated);
    if (current_state == ITEM_UNAVAILABLE || migrated_state == ITEM_UNAVAILABLE) {
        whvb_log_diagnostic(WHVB_DIAG_KEYCHAIN_TARGET_UNAVAILABLE);
        response->status = WHVB_STATUS_UNAVAILABLE;
        handled = 1;
        goto cleanup;
    }
    if (current_state == ITEM_MISSING && migrated_state == ITEM_MISSING) {
        *target_missing = 1;
        handled = 1;
        goto cleanup;
    }
    if (current_state == ITEM_AVAILABLE && migrated_state == ITEM_AVAILABLE &&
        !whvb_constant_time_equal(current.bytes, migrated.bytes, WHVB_KEY_SIZE)) {
        response->status = WHVB_STATUS_CONFLICT;
        handled = 1;
        goto cleanup;
    }
    if (current_state == ITEM_AVAILABLE) {
        set_available_result(response, &current, WHVB_KEY_VERSION_CURRENT, false);
    } else {
        set_available_result(response, &migrated, WHVB_KEY_VERSION_LEGACY, true);
    }
    handled = 1;

cleanup:
    if (initialized_migrated) {
        locked_key_destroy(&migrated);
    }
    if (initialized_current) {
        locked_key_destroy(&current);
    }
    return handled;
}

static int legacy_source_exists(SecKeychainRef keychain, int *exists) {
    size_t index;

    *exists = 0;
    for (index = 0; index < sizeof(SOURCES) / sizeof(SOURCES[0]); index += 1U) {
        enum item_state state = item_exists(keychain, SOURCES[index].service,
                                            SOURCES[index].account);
        if (state == ITEM_UNAVAILABLE) {
            return 0;
        }
        if (state == ITEM_AVAILABLE) {
            *exists = 1;
            return 1;
        }
    }
    return 1;
}

static enum source_state
read_legacy_source(SecKeychainRef keychain, struct locked_key *key,
                   const struct source_descriptor **source) {
    size_t index;

    *source = NULL;
    /* Sources are an ordered migration chain. The newer local-signed item was
     * itself verified when it was copied from dev-legacy, so the first item is
     * authoritative. Reading every historical copy would show one separate
     * SecurityAgent prompt per Keychain ACL, defeating the one-time migration
     * contract. Target-account and readback conflicts are still fail-closed. */
    for (index = 0; index < sizeof(SOURCES) / sizeof(SOURCES[0]); index += 1U) {
        enum item_state state = read_item(keychain, SOURCES[index].service,
                                          SOURCES[index].account, key);
        if (state == ITEM_UNAVAILABLE) {
            return SOURCE_UNAVAILABLE;
        }
        if (state == ITEM_AVAILABLE) {
            *source = &SOURCES[index];
            return SOURCE_AVAILABLE;
        }
    }
    return SOURCE_NONE;
}

static int verify_written_target(SecKeychainRef keychain,
                                 const struct locked_key *expected,
                                 uint8_t key_version, bool migrated,
                                 struct whvb_response *response) {
    struct whvb_response loaded;
    int target_missing = 0;

    memset(&loaded, 0, sizeof(loaded));
    loaded.status = WHVB_STATUS_UNAVAILABLE;
    if (mlock(loaded.key, sizeof(loaded.key)) != 0) {
        whvb_log_diagnostic(WHVB_DIAG_KEYCHAIN_VERIFY_FAILED);
        return 0;
    }
    if (!load_target(keychain, &loaded, &target_missing) || target_missing ||
        loaded.status != WHVB_STATUS_AVAILABLE ||
        loaded.key_version != key_version ||
        loaded.flags != (migrated ? 1U : 0U) ||
        !whvb_constant_time_equal(loaded.key, expected->bytes, WHVB_KEY_SIZE)) {
        if (loaded.status == WHVB_STATUS_AVAILABLE && !target_missing) {
            response->status = WHVB_STATUS_CONFLICT;
        } else if (loaded.status == WHVB_STATUS_CONFLICT) {
            response->status = WHVB_STATUS_CONFLICT;
        } else {
            response->status = WHVB_STATUS_UNAVAILABLE;
        }
        whvb_log_diagnostic(WHVB_DIAG_KEYCHAIN_VERIFY_FAILED);
        whvb_secure_zero(loaded.key, sizeof(loaded.key));
        return 1;
    }
    set_available_result(response, expected, key_version, migrated);
    whvb_secure_zero(loaded.key, sizeof(loaded.key));
    return 1;
}

static int handle_load(SecKeychainRef keychain,
                       struct whvb_response *response) {
    struct locked_key generated;
    int target_missing = 0;
    int source_exists = 0;
    OSStatus status;

    if (!load_target(keychain, response, &target_missing)) {
        return 0;
    }
    if (!target_missing) {
        return 1;
    }
    if (!legacy_source_exists(keychain, &source_exists)) {
        whvb_log_diagnostic(WHVB_DIAG_KEYCHAIN_LEGACY_LOOKUP_FAILED);
        response->status = WHVB_STATUS_UNAVAILABLE;
        return 1;
    }
    if (source_exists) {
        whvb_log_diagnostic(WHVB_DIAG_KEYCHAIN_MIGRATION_REQUIRED);
        response->status = WHVB_STATUS_MIGRATION_REQUIRED;
        return 1;
    }

    if (!locked_key_init(&generated)) {
        return 0;
    }
    if (SecRandomCopyBytes(kSecRandomDefault, WHVB_KEY_SIZE, generated.bytes) !=
        errSecSuccess) {
        whvb_log_diagnostic(WHVB_DIAG_KEYCHAIN_RANDOM_FAILED);
        locked_key_destroy(&generated);
        return 0;
    }
    status = add_item(keychain, CURRENT_ACCOUNT, &generated);
    if (status == errSecDuplicateItem) {
        int winner_missing = 0;
        whvb_log_diagnostic(WHVB_DIAG_KEYCHAIN_DUPLICATE_WINNER);
        if (!load_target(keychain, response, &winner_missing)) {
            set_error_result(response, WHVB_STATUS_CONFLICT);
        } else {
            (void)whvb_finalize_load_duplicate_winner(response,
                                                      winner_missing);
        }
    } else if (status != errSecSuccess) {
        whvb_log_diagnostic(WHVB_DIAG_KEYCHAIN_ADD_FAILED);
        response->status = WHVB_STATUS_UNAVAILABLE;
    } else if (!verify_written_target(keychain, &generated,
                                      WHVB_KEY_VERSION_CURRENT, false,
                                      response)) {
        locked_key_destroy(&generated);
        return 0;
    }
    locked_key_destroy(&generated);
    return 1;
}

static int handle_import(SecKeychainRef keychain,
                         struct whvb_response *response) {
    struct locked_key source_key;
    const struct source_descriptor *source = NULL;
    const char *target_account;
    int target_missing = 0;
    OSStatus status;
    enum source_state source_state;

    if (!locked_key_init(&source_key)) {
        whvb_log_diagnostic(WHVB_DIAG_KEYCHAIN_IMPORT_SOURCE_FAILED);
        return 0;
    }
    source_state = read_legacy_source(keychain, &source_key, &source);
    if (source_state == SOURCE_UNAVAILABLE) {
        whvb_log_diagnostic(WHVB_DIAG_KEYCHAIN_IMPORT_SOURCE_FAILED);
        response->status = WHVB_STATUS_UNAVAILABLE;
        locked_key_destroy(&source_key);
        return 1;
    }
    if (source_state == SOURCE_NONE || source == NULL) {
        whvb_log_diagnostic(WHVB_DIAG_KEYCHAIN_IMPORT_SOURCE_FAILED);
        set_error_result(response, WHVB_STATUS_UNAVAILABLE);
        locked_key_destroy(&source_key);
        return 1;
    }

    /* IMPORT always establishes the authoritative legacy key first. A target
     * that already exists is not accepted merely because it is readable. */
    if (!load_target(keychain, response, &target_missing)) {
        locked_key_destroy(&source_key);
        return 0;
    }
    if (!target_missing) {
        if (response->status == WHVB_STATUS_AVAILABLE &&
            !whvb_target_matches_authoritative_source(
                response, source_key.bytes, source->target_key_version,
                source->migrated ? 1U : 0U)) {
            whvb_log_diagnostic(WHVB_DIAG_KEYCHAIN_IMPORT_CONFLICT);
            set_error_result(response, WHVB_STATUS_CONFLICT);
        } else if (response->status == WHVB_STATUS_AVAILABLE) {
            whvb_mark_import_idempotent(response);
        }
        locked_key_destroy(&source_key);
        return 1;
    }

    target_account =
        source->migrated ? MIGRATED_ACCOUNT : CURRENT_ACCOUNT;
    status = add_item(keychain, target_account, &source_key);
    if (status != errSecSuccess && status != errSecDuplicateItem) {
        whvb_log_diagnostic(WHVB_DIAG_KEYCHAIN_ADD_FAILED);
        response->status = WHVB_STATUS_UNAVAILABLE;
    } else if (!verify_written_target(keychain, &source_key,
                                      source->target_key_version,
                                      source->migrated, response)) {
        locked_key_destroy(&source_key);
        return 0;
    }
    if (status == errSecDuplicateItem &&
        response->status == WHVB_STATUS_AVAILABLE) {
        whvb_mark_import_idempotent(response);
    }
    locked_key_destroy(&source_key);
    return 1;
}

int whvb_keychain_operation(uint8_t operation, struct whvb_response *response) {
    SecKeychainRef keychain = NULL;
    Boolean interactive = operation == WHVB_OP_IMPORT_LEGACY ? TRUE : FALSE;
    int handled;

    if (response == NULL ||
        (operation != WHVB_OP_LOAD && operation != WHVB_OP_IMPORT_LEGACY)) {
        return 0;
    }
    response->status = WHVB_STATUS_UNAVAILABLE;
    response->flags = 0U;
    response->key_version = WHVB_KEY_VERSION_NONE;
    whvb_secure_zero(response->key, sizeof(response->key));

    if (SecKeychainSetUserInteractionAllowed(interactive) != errSecSuccess) {
        whvb_log_diagnostic(WHVB_DIAG_KEYCHAIN_INTERACTION_FAILED);
        return 0;
    }
    if (SecKeychainCopyDomainDefault(kSecPreferencesDomainUser, &keychain) !=
            errSecSuccess ||
        keychain == NULL) {
        whvb_log_diagnostic(WHVB_DIAG_KEYCHAIN_DOMAIN_FAILED);
        if (keychain != NULL) {
            CFRelease(keychain);
        }
        return 0;
    }

    handled = operation == WHVB_OP_LOAD ? handle_load(keychain, response)
                                        : handle_import(keychain, response);
    CFRelease(keychain);
    return handled;
}
