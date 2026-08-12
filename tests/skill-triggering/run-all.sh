#!/usr/bin/env bash
# Run all skill-triggering tests for logicprobe
# Usage: ./run-all.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PASS=0
FAIL=0

run_test() {
    local name="$1"
    local skill="$2"
    local prompt="$3"
    local expect="$4"

    echo "=== $name ==="
    if "$SCRIPT_DIR/run-test.sh" "$skill" "$SCRIPT_DIR/prompts/$prompt" "$expect"; then
        PASS=$((PASS + 1))
        echo ""
    else
        FAIL=$((FAIL + 1))
        echo ""
    fi
}

# Positive tests (should trigger)
echo "===== POSITIVE TESTS (should trigger) ====="
echo ""
run_test "Design doc review → logicprobe" "logicprobe" "design-review-fact-verify.txt" "trigger"
run_test "State machine safety question → logicprobe" "logicprobe" "state-machine-deadlock.txt" "trigger"

# Negative tests (should NOT trigger)
echo "===== NEGATIVE TESTS (should NOT trigger) ====="
echo ""
run_test "Fix typo → NOT logicprobe" "logicprobe" "typo-fix-no-skill.txt" "no-trigger"

echo "===== SUMMARY ====="
echo "Passed: $PASS"
echo "Failed: $FAIL"
echo "Total:  $((PASS + FAIL))"

if [ $FAIL -gt 0 ]; then
    exit 1
fi
