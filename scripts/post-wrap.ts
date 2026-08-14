import { verifyMacWrapperSignalForwardingFromEnvironment } from "./electrobun-signal-forwarding";
import { prepareMacWrapperFromEnvironment } from "./macos-build-security";

prepareMacWrapperFromEnvironment();
// Read-only verification after any Canary materialization and before Electrobun
// applies the final Stable signature. The updater archive is verified separately
// by postPackage; postWrap must never mutate either signed/package payload.
verifyMacWrapperSignalForwardingFromEnvironment();
