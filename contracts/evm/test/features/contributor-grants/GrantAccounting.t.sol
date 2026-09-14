// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import { TestBase } from "../../TestBase.sol";
import { GrantAccounting as G } from "../../../src/features/contributor-grants/GrantAccounting.sol";
import { GrantAccountingHarness as Harness } from "./GrantAccountingHarness.sol";

contract GrantAccountingTest is TestBase {
    Harness internal ledger;

    function terms(uint256 amount, G.Kind kind) internal pure returns (G.Terms memory) {
        // Compressed ratio fixtures, NOT a calendar-month conversion.
        return G.Terms(amount, 100, 112, 148, kind, bytes32("contributors"));
    }

    function setUp() public {
        ledger = new Harness(terms(360, G.Kind.TeamService));
    }

    function digest(uint256 id) internal view returns (bytes32) {
        return keccak256(abi.encode(ledger.snapshot(id)));
    }

    function rejects(uint256 id, bytes memory callData, bytes4 errorSelector) internal {
        bytes32 beforeState = digest(id);
        (bool ok, bytes memory result) = address(ledger).call(callData);
        assertFalse(ok);
        assertEq(keccak256(result), keccak256(abi.encodeWithSelector(errorSelector)));
        assertEq(digest(id), beforeState);
    }

    function rejectRelease(uint64 time, uint256 amount, bytes4 errorSelector) internal {
        rejects(0, abi.encodeCall(Harness.release, (0, time, amount)), errorSelector);
    }

    function rejectCancel(uint64 time, bytes4 errorSelector) internal {
        rejects(0, abi.encodeCall(Harness.cancel, (0, time)), errorSelector);
    }

    function testCurveBoundaryTableAndIndividualStart() public {
        uint64[11] memory times = [uint64(0), 99, 100, 111, 112, 113, 130, 147, 148, 149, 200];
        uint256[11] memory expected = [uint256(0), 0, 0, 0, 0, 10, 180, 350, 360, 360, 360];
        G.Terms memory t = terms(360, G.Kind.TeamService);
        for (uint256 i; i < times.length; ++i) {
            assertEq(ledger.curve(t, times[i]), expected[i]);
            assertEq(ledger.available(0, times[i]), expected[i]);
        }
        t.start += 100;
        t.cliff += 100;
        t.end += 100;
        ledger.initialize(1, t);
        assertEq(ledger.available(1, 148), 0);
        assertEq(ledger.available(1, 230), 180);
        assertEq(ledger.available(0, 230), 360);
    }

    function testTinyAllocationsAndEndDust() public {
        ledger = new Harness(terms(10, G.Kind.TeamService));
        assertEq(ledger.available(0, 113), 0);
        assertEq(ledger.available(0, 130), 5);
        for (uint256 i; i < 5; ++i) {
            ledger.release(0, 130, 1);
        }
        rejectRelease(130, 1, G.InvalidRelease.selector);
        assertEq(ledger.available(0, 147), 4);
        ledger.release(0, 147, 4);
        ledger.release(0, 148, 1);
        assertEq(ledger.snapshot(0).released, 10);
        rejectRelease(148, 1, G.InvalidRelease.selector);
        G.Terms memory tiny = terms(1, G.Kind.TeamService);
        ledger.initialize(1, tiny);
        assertEq(ledger.available(1, 147), 0);
        ledger.release(1, 148, 1);
        assertEq(ledger.available(1, 149), 0);
    }

    function testMaximumAllocationIndependentVectors() public {
        G.Terms memory t = G.Terms(type(uint256).max, 0, 1, 3, G.Kind.Founder, bytes32("max"));
        assertEq(ledger.curve(t, 2), (uint256(1) << 255) - 1);
        assertEq(ledger.curve(t, 3), type(uint256).max);
        t.allocation -= 1;
        assertEq(ledger.curve(t, 2), (uint256(1) << 255) - 1);
        t.end = 2;
        assertEq(ledger.curve(t, 1), 0);
        assertEq(ledger.curve(t, 2), t.allocation);
        t.allocation = type(uint256).max;
        t.end = type(uint64).max;
        // d = 2^64-2 is even; its midpoint yields floor(max/2).
        assertEq(ledger.curve(t, uint64(1 + (uint256(t.end) - 1) / 2)), t.allocation / 2);
        t.start = type(uint64).max - 3;
        t.cliff = type(uint64).max - 2;
        assertEq(ledger.curve(t, type(uint64).max - 1), t.allocation / 2);
        ledger = new Harness(t);
        ledger.release(0, type(uint64).max - 1, t.allocation / 2);
        ledger.release(0, type(uint64).max, (uint256(1) << 255));
        assertEq(ledger.snapshot(0).released, type(uint256).max);
    }

    function testReleaseValidationHistoricalQueriesAndAtomicFailures() public {
        rejectRelease(0, 1, G.InvalidRelease.selector);
        rejectRelease(112, 1, G.InvalidRelease.selector);
        rejectRelease(130, 0, G.InvalidRelease.selector);
        rejectRelease(130, 181, G.InvalidRelease.selector);
        ledger.release(0, 130, 60);
        rejectRelease(129, 1, G.PastTime.selector);
        rejectCancel(129, G.PastTime.selector);
        rejects(0, abi.encodeCall(Harness.available, (0, 112)), G.PastTime.selector);
        rejects(0, abi.encodeCall(Harness.entitlement, (0, 129)), G.PastTime.selector);
        assertEq(ledger.curve(terms(360, G.Kind.TeamService), 112), 0);
        ledger.release(0, 130, 120);
        rejectRelease(130, 1, G.InvalidRelease.selector);
        ledger.release(0, 148, 180);
        assertEq(ledger.available(0, type(uint64).max), 0);
    }

    function testCancelBeforeStartAndCliff() public {
        uint64[5] memory times = [uint64(0), 99, 100, 111, 112];
        for (uint256 i; i < times.length; ++i) {
            ledger = new Harness(terms(360, G.Kind.TeamService));
            (uint256 refund, bytes32 purpose) = ledger.cancel(0, times[i]);
            assertEq(refund, 360);
            assertEq(purpose, bytes32("contributors"));
            assertEq(ledger.available(0, 148), 0);
            rejectRelease(148, 1, G.InvalidRelease.selector);
            rejectCancel(148, G.AlreadyCancelled.selector);
        }
    }

    function testCancelProtectsFrozenDebtAfterPartialRelease() public {
        ledger.release(0, 118, 60);
        (uint256 refund, bytes32 purpose) = ledger.cancel(0, 130);
        assertEq(refund, 180); // A-R would incorrectly refund 300 and steal 120 debt.
        assertEq(purpose, bytes32("contributors"));
        assertEq(ledger.snapshot(0).frozenEntitlement, 180);
        assertEq(ledger.available(0, 130), 120);
        assertEq(ledger.available(0, type(uint64).max), 120);
        rejectRelease(129, 1, G.PastTime.selector);
        rejectRelease(148, 121, G.InvalidRelease.selector);
        rejectCancel(148, G.AlreadyCancelled.selector);
        rejects(0, abi.encodeCall(Harness.available, (0, 118)), G.PastTime.selector);
        ledger.release(0, 148, 120);
        assertEq(ledger.available(0, 200), 0);
        assertEq(ledger.snapshot(0).released + refund, 360);
        rejectRelease(200, 1, G.InvalidRelease.selector);
        rejectCancel(200, G.AlreadyCancelled.selector);
        assertEq(ledger.curve(terms(360, G.Kind.TeamService), 148), 360);
    }

    function testCancelWithoutReleaseAndAtEndPreservesAllDebt() public {
        uint64[4] memory times = [uint64(130), 147, 148, 200];
        uint256[4] memory debts = [uint256(180), 350, 360, 360];
        for (uint256 i; i < times.length; ++i) {
            ledger = new Harness(terms(360, G.Kind.TeamService));
            (uint256 refund,) = ledger.cancel(0, times[i]);
            assertEq(refund, 360 - debts[i]);
            assertEq(ledger.available(0, 200), debts[i]);
            ledger.release(0, 200, debts[i]);
            assertEq(ledger.snapshot(0).released + refund, 360);
        }
        ledger = new Harness(terms(360, G.Kind.TeamService));
        ledger.release(0, 148, 360);
        (uint256 zeroRefund,) = ledger.cancel(0, 148);
        assertEq(zeroRefund, 0);
        assertEq(ledger.available(0, 200), 0);
    }

    function testSameTimeOrderingAndCrossGrantIsolation() public {
        G.Terms memory t = terms(360, G.Kind.TeamService);
        t.originalPurpose = bytes32("other-reserve");
        ledger.initialize(1, t);
        bytes32 other = digest(1);
        ledger.release(0, 130, 60);
        (uint256 refund0,) = ledger.cancel(0, 130);
        assertEq(digest(1), other);
        bytes32 first = digest(0);
        (uint256 refund1, bytes32 purpose) = ledger.cancel(1, 130);
        ledger.release(1, 130, 60);
        assertEq(digest(0), first);
        assertEq(refund0, refund1);
        assertEq(ledger.available(0, 148), ledger.available(1, 148));
        assertEq(purpose, bytes32("other-reserve"));
        assertEq(ledger.snapshot(0).terms.originalPurpose, bytes32("contributors"));
    }

    function testFounderAlwaysRejectsCancellationAndKeepsReleasing() public {
        ledger = new Harness(terms(360, G.Kind.Founder));
        rejectCancel(0, G.FounderCannotCancel.selector);
        rejectCancel(112, G.FounderCannotCancel.selector);
        ledger.release(0, 118, 60);
        rejectCancel(117, G.FounderCannotCancel.selector); // Kind wins even over past time.
        rejectCancel(130, G.FounderCannotCancel.selector);
        rejectCancel(148, G.FounderCannotCancel.selector);
        ledger.release(0, 148, 300);
        rejectCancel(200, G.FounderCannotCancel.selector);
        assertEq(ledger.snapshot(0).released, 360);
        assertFalse(ledger.snapshot(0).cancelled);
    }

    function testUninitializedAndReinitializedRejectWithoutMutation() public {
        rejects(7, abi.encodeCall(Harness.release, (7, 130, 1)), G.Uninitialized.selector);
        rejects(7, abi.encodeCall(Harness.cancel, (7, 130)), G.Uninitialized.selector);
        rejects(7, abi.encodeCall(Harness.available, (7, 130)), G.Uninitialized.selector);
        rejects(7, abi.encodeCall(Harness.entitlement, (7, 130)), G.Uninitialized.selector);
        G.Terms memory replacement = terms(999, G.Kind.Founder);
        replacement.originalPurpose = bytes32("stolen-purpose");
        rejects(
            0, abi.encodeCall(Harness.initialize, (0, replacement)), G.AlreadyInitialized.selector
        );
        ledger.cancel(0, 130);
        rejects(
            0, abi.encodeCall(Harness.initialize, (0, replacement)), G.AlreadyInitialized.selector
        );
    }

    function testMalformedTermsRejectedBeforeBoundaryBranches() public {
        for (uint256 i; i < 6; ++i) {
            G.Terms memory t = terms(360, G.Kind.TeamService);
            if (i == 0) t.allocation = 0;
            if (i == 1) t.originalPurpose = bytes32(0);
            if (i == 2) t.cliff = t.start;
            if (i == 3) t.cliff = t.start - 1;
            if (i == 4) t.end = t.cliff;
            if (i == 5) t.end = t.cliff - 1;
            rejects(1, abi.encodeCall(Harness.initialize, (1, t)), G.InvalidTerms.selector);
            rejects(0, abi.encodeCall(Harness.curve, (t, 0)), G.InvalidTerms.selector);
            rejects(
                0, abi.encodeCall(Harness.curve, (t, type(uint64).max)), G.InvalidTerms.selector
            );
        }
    }

    function testFuzzCurveIndependentMultiplication(
        uint128 amountSeed,
        uint64 cliffSeed,
        uint64 durationSeed,
        uint64 timeSeed
    ) public view {
        uint64 duration = uint64(bound(durationSeed, 1, uint256(type(uint64).max) - 1));
        uint64 cliff = uint64(bound(cliffSeed, 1, uint256(type(uint64).max) - duration));
        G.Terms memory t = G.Terms(
            uint256(amountSeed) + 1,
            cliff - 1,
            cliff,
            cliff + duration,
            G.Kind.TeamService,
            bytes32("fuzz")
        );
        uint256 expected;
        if (timeSeed >= t.end) expected = t.allocation;
        else if (timeSeed > cliff) expected = t.allocation * (uint256(timeSeed) - cliff) / duration;
        // uint129 amount * uint64 elapsed fits uint193: independent direct multiplication.
        assertEq(ledger.curve(t, timeSeed), expected);
    }

    function testFuzzFullWidthCurveAndCancellation(uint256 amountSeed, uint64 xSeed) public {
        uint256 amount = amountSeed == 0 ? 1 : amountSeed;
        uint64 d = type(uint64).max - 1;
        uint64 x = uint64(bound(xSeed, 1, uint256(d) - 1));
        G.Terms memory t =
            G.Terms(amount, 0, 1, type(uint64).max, G.Kind.TeamService, bytes32("wide"));
        uint256 a = ledger.curve(t, 1 + x);
        uint256 b = ledger.curve(t, 1 + (d - x));
        // Complementary floors sum to A or A-1, without reusing quotient/remainder arithmetic.
        assertTrue(a <= amount);
        assertTrue(b <= amount - a);
        assertTrue(amount - a - b <= 1);
        assertTrue(ledger.curve(t, 2 + x) >= a);
        ledger = new Harness(t);
        if (a > 0) ledger.release(0, 1 + x, a / 2 + a % 2);
        (uint256 refund,) = ledger.cancel(0, 1 + x);
        assertEq(refund, amount - a);
        uint256 debt = ledger.available(0, type(uint64).max);
        assertEq(ledger.snapshot(0).released + debt, a);
        if (debt > 0) ledger.release(0, type(uint64).max, debt);
        assertEq(ledger.snapshot(0).released + refund, amount);
    }

    function testFuzzSplitReleaseHasNoRoundingLoss(uint128 seed, uint8 piecesSeed) public {
        uint256 amount = uint256(seed) + 1;
        ledger = new Harness(terms(amount, G.Kind.TeamService));
        uint256 vested = amount / 2;
        uint256 pieces = uint256(piecesSeed) % 16 + 1;
        uint256 chunk = vested / pieces;
        if (chunk > 0) {
            for (uint256 i; i < pieces; ++i) {
                ledger.release(0, 130, chunk);
            }
        }
        uint256 remaining = vested - chunk * pieces;
        if (remaining > 0) ledger.release(0, 130, remaining);
        assertEq(ledger.snapshot(0).released, vested);
        ledger.release(0, 148, amount - vested);
        assertEq(ledger.snapshot(0).released, amount);
    }
}
