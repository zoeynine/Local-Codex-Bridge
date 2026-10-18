#!/bin/bash
set -euo pipefail
printf '%s\n' 'Use the separately trusted external runner: NODE EXTERNAL_VERIFIER PACKAGE_ROOT --check|--deploy|--rollback CONTRACT' >&2
exit 64
