// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import { TestBase } from "../../TestBase.sol";
import { GrantAccounting as G } from "../../../src/features/contributor-grants/GrantAccounting.sol";
import {
    GrantAccountingHarness as Harness
} from "../../features/contributor-grants/GrantAccountingHarness.sol";

/// @dev Each generated call performs a positive release. Settled records remain in the ledger;
/// a new ID replaces that slot in the workload so long CI sequences never become idle handlers.
/// The second slot is an independent founder. Ghost arithmetic uses small direct multiplication,
/// never the production curve, and observes refund instructions exactly once per grant.
contract GrantSequenceHandler is TestBase {
    struct Ghost {
        uint256 id;
        uint256 allocation;
        uint256 paid;
        uint256 refund;
        uint256 frozen;
        uint64 time;
        bool cancelled;
    }

    Harness public immutable LEDGER;
    Ghost[2] private ghosts;
    uint256 public steps;
    uint256 public releases;
    uint256 public cancellations;
    uint256 public totalAllocated;
    uint256 public totalPaid;
    uint256 public totalRefund;
    uint256 private nextId = 2;

    constructor() {
        LEDGER = new Harness(_terms(360, 0));
        LEDGER.initialize(1, _terms(720, 1));
        ghosts[0] = Ghost(0, 360, 0, 0, 0, 0, false);
        ghosts[1] = Ghost(1, 720, 0, 0, 0, 0, false);
        totalAllocated = 1080;
    }

    function _terms(uint256 amount, uint256 slot) private pure returns (G.Terms memory) {
        return G.Terms(
            amount,
            100,
            112,
            148,
            slot == 0 ? G.Kind.TeamService : G.Kind.Founder,
            bytes32(slot + 1)
        );
    }

    function ghost(uint256 slot) external view returns (Ghost memory) {
        return ghosts[slot];
    }

    function step(uint256 slotSeed, uint256 timeSeed, uint256 amountSeed, uint128 allocationSeed)
        external
    {
        // First generated operation guarantees cancellation coverage; later calls explore both
        // kinds.
        uint256 slot = steps == 0 ? 0 : slotSeed % 2;
        Ghost storage g = ghosts[slot];
        uint256 otherId = ghosts[1 - slot].id;
        bytes32 otherBefore = keccak256(abi.encode(LEDGER.snapshot(otherId)));
        if (g.paid + g.refund == g.allocation) {
            bytes32 settledBefore = keccak256(abi.encode(LEDGER.snapshot(g.id)));
            uint256 settledId = g.id;
            uint256 allocation = uint256(allocationSeed) + 360;
            uint256 id = nextId++;
            LEDGER.initialize(id, _terms(allocation, slot));
            ghosts[slot] = Ghost(id, allocation, 0, 0, 0, 0, false);
            totalAllocated += allocation;
            assertEq(keccak256(abi.encode(LEDGER.snapshot(settledId))), settledBefore);
        }
        uint64 lower = g.time > 113 ? g.time : 113;
        uint64 time = uint64(bound(timeSeed, lower, 148));
        uint256 expected = g.cancelled ? g.frozen : g.allocation * (time - 112) / 36;
        uint256 owed = expected - g.paid;
        // If rounding left no new entitlement at this time, advance to full vesting.
        if (owed == 0) {
            time = 148;
            expected = g.cancelled ? g.frozen : g.allocation;
            owed = expected - g.paid;
        }
        assertTrue(owed > 0);
        uint256 payment = bound(amountSeed, 1, owed);
        LEDGER.release(g.id, time, payment);
        g.paid += payment;
        g.time = time;
        totalPaid += payment;
        ++releases;
        if (slot == 0 && !g.cancelled && (steps == 0 || slotSeed % 3 == 0)) {
            (uint256 refund, bytes32 purpose) = LEDGER.cancel(g.id, time);
            assertEq(refund, g.allocation - expected);
            assertEq(purpose, bytes32(uint256(1)));
            g.cancelled = true;
            g.frozen = expected;
            g.refund = refund;
            totalRefund += refund;
            ++cancellations;
        }
        ++steps;
        assertEq(keccak256(abi.encode(LEDGER.snapshot(otherId))), otherBefore);
        assertLedger();
    }

    function assertLedger() public view {
        uint256 outstanding;
        for (uint256 slot; slot < 2; ++slot) {
            Ghost memory g = ghosts[slot];
            G.Grant memory actual = LEDGER.snapshot(g.id);
            assertTrue(actual.initialized);
            assertEq(actual.terms.allocation, g.allocation);
            assertEq(actual.terms.originalPurpose, bytes32(slot + 1));
            assertEq(uint256(actual.terms.kind), 1 - slot);
            // TeamService=1 and Founder=0, opposite the workload slot ordering.
            assertEq(actual.terms.start, 100);
            assertEq(actual.terms.cliff, 112);
            assertEq(actual.terms.end, 148);
            assertEq(actual.released, g.paid);
            assertEq(actual.lastTransition, g.time);
            assertEq(actual.frozenEntitlement, g.frozen);
            assertTrue(actual.cancelled == g.cancelled);
            uint256 vested =
                g.cancelled ? g.frozen : (g.time <= 112 ? 0 : g.allocation * (g.time - 112) / 36);
            assertTrue(g.paid <= vested && vested <= g.allocation);
            assertEq(LEDGER.available(g.id, g.time), vested - g.paid);
            assertEq(LEDGER.available(g.id, 148), (g.cancelled ? g.frozen : g.allocation) - g.paid);
            if (g.cancelled) assertEq(g.paid + (g.frozen - g.paid) + g.refund, g.allocation);
            outstanding += g.allocation - g.paid - g.refund;
        }
        assertEq(totalPaid + totalRefund + outstanding, totalAllocated);
        assertEq(releases, steps);
    }
}

contract GrantAccountingInvariantTest is TestBase {
    GrantSequenceHandler internal handler;

    function setUp() public {
        handler = new GrantSequenceHandler();
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariantConservationFrozenDebtImmutableTermsAndIsolation() public view {
        handler.assertLedger();
    }

    function afterInvariant() public {
        assertTrue(handler.steps() > 0);
        assertEq(handler.releases(), handler.steps());
        assertTrue(handler.cancellations() > 0);
        Harness ledger = handler.LEDGER();
        for (uint256 slot; slot < 2; ++slot) {
            GrantSequenceHandler.Ghost memory g = handler.ghost(slot);
            uint256 expected = g.cancelled ? g.frozen : g.allocation;
            uint256 remainder = expected - g.paid;
            if (remainder > 0) ledger.release(g.id, 148, remainder);
            assertEq(ledger.snapshot(g.id).released, expected);
            assertEq(ledger.available(g.id, type(uint64).max), 0);
            assertEq(expected + g.refund, g.allocation);
        }
    }
}
