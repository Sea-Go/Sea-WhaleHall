#ifndef WHALEHALL_VAULT_BROKER_DIAGNOSTICS_H
#define WHALEHALL_VAULT_BROKER_DIAGNOSTICS_H

#include <os/log.h>

enum whvb_diagnostic_stage {
    WHVB_DIAG_GUARD_SOCKET_INVALID,
    WHVB_DIAG_GUARD_PEER_BINDING_FAILED,
    WHVB_DIAG_GUARD_SNAPSHOT_FAILED,
    WHVB_DIAG_GUARD_CHAIN_FAILED,
    WHVB_DIAG_GUARD_INSTALL_PATH_FAILED,
    WHVB_DIAG_GUARD_CORE_STATIC_FAILED,
    WHVB_DIAG_GUARD_OUTER_STATIC_FAILED,
    WHVB_DIAG_GUARD_WATCH_FAILED,
    WHVB_DIAG_KEYCHAIN_INTERACTION_FAILED,
    WHVB_DIAG_KEYCHAIN_DOMAIN_FAILED,
    WHVB_DIAG_KEYCHAIN_TARGET_UNAVAILABLE,
    WHVB_DIAG_KEYCHAIN_LEGACY_LOOKUP_FAILED,
    WHVB_DIAG_KEYCHAIN_MIGRATION_REQUIRED,
    WHVB_DIAG_KEYCHAIN_RANDOM_FAILED,
    WHVB_DIAG_KEYCHAIN_ADD_FAILED,
    WHVB_DIAG_KEYCHAIN_DUPLICATE_WINNER,
    WHVB_DIAG_KEYCHAIN_VERIFY_FAILED,
    WHVB_DIAG_KEYCHAIN_IMPORT_SOURCE_FAILED,
    WHVB_DIAG_KEYCHAIN_IMPORT_CONFLICT,
};

static inline void whvb_log_diagnostic(enum whvb_diagnostic_stage stage) {
    const char *message;

    switch (stage) {
    case WHVB_DIAG_GUARD_SOCKET_INVALID:
        message = "whvb stage=guard.socket_invalid";
        break;
    case WHVB_DIAG_GUARD_PEER_BINDING_FAILED:
        message = "whvb stage=guard.peer_binding_failed";
        break;
    case WHVB_DIAG_GUARD_SNAPSHOT_FAILED:
        message = "whvb stage=guard.snapshot_failed";
        break;
    case WHVB_DIAG_GUARD_CHAIN_FAILED:
        message = "whvb stage=guard.chain_failed";
        break;
    case WHVB_DIAG_GUARD_INSTALL_PATH_FAILED:
        message = "whvb stage=guard.install_path_failed";
        break;
    case WHVB_DIAG_GUARD_CORE_STATIC_FAILED:
        message = "whvb stage=guard.core_static_failed";
        break;
    case WHVB_DIAG_GUARD_OUTER_STATIC_FAILED:
        message = "whvb stage=guard.outer_static_failed";
        break;
    case WHVB_DIAG_GUARD_WATCH_FAILED:
        message = "whvb stage=guard.watch_failed";
        break;
    case WHVB_DIAG_KEYCHAIN_INTERACTION_FAILED:
        message = "whvb stage=keychain.interaction_failed";
        break;
    case WHVB_DIAG_KEYCHAIN_DOMAIN_FAILED:
        message = "whvb stage=keychain.domain_failed";
        break;
    case WHVB_DIAG_KEYCHAIN_TARGET_UNAVAILABLE:
        message = "whvb stage=keychain.target_unavailable";
        break;
    case WHVB_DIAG_KEYCHAIN_LEGACY_LOOKUP_FAILED:
        message = "whvb stage=keychain.legacy_lookup_failed";
        break;
    case WHVB_DIAG_KEYCHAIN_MIGRATION_REQUIRED:
        message = "whvb stage=keychain.migration_required";
        break;
    case WHVB_DIAG_KEYCHAIN_RANDOM_FAILED:
        message = "whvb stage=keychain.random_failed";
        break;
    case WHVB_DIAG_KEYCHAIN_ADD_FAILED:
        message = "whvb stage=keychain.add_failed";
        break;
    case WHVB_DIAG_KEYCHAIN_DUPLICATE_WINNER:
        message = "whvb stage=keychain.duplicate_winner";
        break;
    case WHVB_DIAG_KEYCHAIN_VERIFY_FAILED:
        message = "whvb stage=keychain.verify_failed";
        break;
    case WHVB_DIAG_KEYCHAIN_IMPORT_SOURCE_FAILED:
        message = "whvb stage=keychain.import_source_failed";
        break;
    case WHVB_DIAG_KEYCHAIN_IMPORT_CONFLICT:
        message = "whvb stage=keychain.import_conflict";
        break;
    default:
        message = "whvb stage=unknown";
        break;
    }
    os_log_error(OS_LOG_DEFAULT, "%{public}s", message);
}

#endif
