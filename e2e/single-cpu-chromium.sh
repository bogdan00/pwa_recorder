#!/usr/bin/env bash
set -euo pipefail

# Pin each CPU-throttled Chromium process (and all of its threads) to one Linux CPU
# core, balanced round-robin across available cores per Playwright parallel worker.
#
# Root cause: Chromium's Linux ThreadCPUThrottler::HandleSignal (SIGUSR2) clamps
# `now - last_sample_time_` to <= 1000us without clamping >= 0 before 32-bit
# multiplication and unsigned `/ 100`. When CPUThrottlingThread and the renderer
# main thread run concurrently on different vCPUs, a -1us delta underflows to
# `0xFFFFFFFF / 100 = 42.95s`, freezing the renderer in a clock_gettime spin loop.
# Pinning each throttled Chrome process to a single core eliminates the cross-vCPU
# race completely while preserving full 4x CDP CPU throttling and multi-worker speed.

if [ -z "${STORYTAPE_REAL_CHROMIUM:-}" ]; then
  echo "STORYTAPE_REAL_CHROMIUM is not set" >&2
  exit 1
fi

CORES="$(nproc 2>/dev/null || echo 1)"
if [ "${CORES}" -lt 1 ] 2>/dev/null; then
  CORES=1
fi
SLOT="${TEST_PARALLEL_INDEX:-$$}"
CORE="$(( SLOT % CORES ))"

exec taskset -c "${CORE}" "${STORYTAPE_REAL_CHROMIUM}" "$@"
