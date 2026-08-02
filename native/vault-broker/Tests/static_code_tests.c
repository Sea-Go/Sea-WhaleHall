#include "../process_guard.h"

#ifndef WHALEHALL_CORE_REQUIREMENT
#error "WHALEHALL_CORE_REQUIREMENT is required by this test"
#endif

#ifndef WHALEHALL_OUTER_REQUIREMENT
#error "WHALEHALL_OUTER_REQUIREMENT is required by this test"
#endif

#include <assert.h>

int main(int argc, char **argv) {
    assert(argc == 3);
    assert(whvb_static_path_satisfies_requirement(
        argv[1], 0, WHALEHALL_CORE_REQUIREMENT));
    assert(whvb_static_path_satisfies_requirement(
        argv[2], 1, WHALEHALL_OUTER_REQUIREMENT));
    assert(!whvb_static_path_satisfies_requirement(
        argv[1], 0, WHALEHALL_OUTER_REQUIREMENT));
    assert(!whvb_static_path_satisfies_requirement(
        argv[2], 1, WHALEHALL_CORE_REQUIREMENT));
    return 0;
}
