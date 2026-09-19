// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import { GrantAccounting as G } from "../../../src/features/contributor-grants/GrantAccounting.sol";
import { GrantVault } from "../../../src/features/contributor-grants/GrantVault.sol";
import { AGTMAIToken } from "../../../src/features/token-genesis/AGTMAIToken.sol";
import { TestBase } from "../../TestBase.sol";
import { ContractCaller } from "../../features/contributor-grants/GrantVaultFixtures.sol";

/// @dev Two live grants share one monotonically advancing EVM clock. The ghost model computes
/// vesting by direct bounded multiplication and tracks principal separately from donations.
contract GrantVaultHandler is TestBase {
    struct Ghost {
        GrantVault vault;
        ContractCaller reserve;
        address beneficiary;
        uint256 allocation;
        uint256 released;
        uint256 refunded;
        uint256 donated;
        uint256 frozen;
        uint64 start;
        uint64 cliff;
        uint64 end;
        bool cancelled;
    }

    struct Settled {
        GrantVault vault;
        uint256 refunded;
        uint256 donated;
    }

    uint256 internal constant SUPPLY = 1_000_000_000_000_000_000_000_000;
    AGTMAIToken public immutable TOKEN;
    Ghost[2] private ghosts;
    Settled[] private settled;
    uint64 public clock = 100;
    uint256 public steps;
    uint256 public successfulFundings;
    uint256 public positiveReleases;
    uint256 public positiveRefunds;
    uint256 public founderCancellationAttempts;
    uint256 public reassignmentAttempts;
    uint256 public totalAllocated;
    uint256 public totalReleased;
    uint256 public totalRefunded;
    uint256 private nextId;

    constructor() {
        vm.warp(clock);
        AGTMAIToken.Allocation[] memory rows = new AGTMAIToken.Allocation[](1);
        rows[0] = AGTMAIToken.Allocation(bytes32("invariant-reserve"), address(this), SUPPLY);
        TOKEN = new AGTMAIToken(SUPPLY, rows);
        _create(0, 360);
        _create(1, 721);
    }

    function ghost(uint256 slot) external view returns (Ghost memory) {
        return ghosts[slot];
    }

    function step(uint256 slotSeed, uint256 actionSeed, uint256 timeSeed, uint256 amountSeed)
        external
    {
        if (steps == 0) {
            _attackFounder();
            _attackReassignment(1, actionSeed);
            _releaseAt(0, 130);
        } else if (steps == 1) {
            _cancel(0);
        } else {
            uint256 slot = slotSeed % 2;
            _replaceIfSettled(slot, amountSeed);
            uint256 action = actionSeed % 5;
            if (action == 0) _release(slot, timeSeed);
            else if (action == 1 && slot == 0 && !ghosts[slot].cancelled) _cancel(slot);
            else if (action == 3) _attackFounder();
            else if (action == 4) _attackReassignment(slot, amountSeed);
            else _donate(slot, amountSeed);
        }
        ++steps;
        assertLedger();
    }

    function settleAll() external {
        uint64 finalTime = ghosts[0].end > ghosts[1].end ? ghosts[0].end : ghosts[1].end;
        if (clock < finalTime) {
            clock = finalTime;
            vm.warp(clock);
        }
        for (uint256 slot; slot < 2; ++slot) {
            uint256 amount = ghosts[slot].vault.available();
            if (amount > 0) _pay(slot, amount);
        }
        _attackFounder();
        assertLedger();
    }

    function assertLedger() public view {
        uint256 liveLiability;
        for (uint256 slot; slot < 2; ++slot) {
            Ghost memory g = ghosts[slot];
            G.Grant memory actual = g.vault.grant();
            assertTrue(g.vault.funded());
            assertEq(address(g.vault.TOKEN()), address(TOKEN));
            assertEq(g.vault.BENEFICIARY(), g.beneficiary);
            assertEq(g.vault.ORIGINAL_RESERVE(), address(g.reserve));
            assertEq(g.vault.CONTROLLER(), address(g.reserve));
            assertEq(actual.terms.allocation, g.allocation);
            assertEq(actual.terms.originalPurpose, bytes32(slot + 1));
            assertEq(
                uint256(actual.terms.kind),
                slot == 0 ? uint256(G.Kind.TeamService) : uint256(G.Kind.Founder)
            );
            assertEq(actual.terms.start, g.start);
            assertEq(actual.terms.cliff, g.cliff);
            assertEq(actual.terms.end, g.end);
            assertEq(actual.released, g.released);
            assertEq(actual.frozenEntitlement, g.frozen);
            assertTrue(actual.cancelled == g.cancelled);

            uint256 entitlement = g.cancelled ? g.frozen : _vested(g, clock);
            assertTrue(g.released <= entitlement && entitlement <= g.allocation);
            uint256 liability = (g.cancelled ? g.frozen : g.allocation) - g.released;
            assertEq(g.released + g.refunded + liability, g.allocation);
            assertEq(TOKEN.balanceOf(address(g.vault)), liability + g.donated);
            if (g.cancelled) {
                assertEq(g.refunded, g.allocation - g.frozen);
            } else {
                assertEq(g.refunded, 0);
            }
            if (slot == 1) assertFalse(g.cancelled);
            liveLiability += liability;
        }

        for (uint256 i; i < settled.length; ++i) {
            Settled memory old = settled[i];
            G.Grant memory actual = old.vault.grant();
            uint256 liability =
                (actual.cancelled ? actual.frozenEntitlement : actual.terms.allocation)
                    - actual.released;
            assertEq(liability, 0);
            assertEq(actual.released + old.refunded, actual.terms.allocation);
            assertEq(TOKEN.balanceOf(address(old.vault)), old.donated);
        }

        assertEq(totalReleased + totalRefunded + liveLiability, totalAllocated);
        assertEq(TOKEN.totalSupply(), SUPPLY);
        assertEq(TOKEN.INITIAL_SUPPLY(), SUPPLY);
    }

    function _create(uint256 slot, uint256 allocation) private {
        uint64 start = clock + uint64(slot);
        uint64 cliff = start + 12;
        uint64 end = start + 48;
        ContractCaller reserve = new ContractCaller();
        address beneficiary = address(uint160(uint256(keccak256(abi.encode(nextId, slot)))));
        G.Kind kind = slot == 0 ? G.Kind.TeamService : G.Kind.Founder;
        G.Terms memory terms = G.Terms(allocation, start, cliff, end, kind, bytes32(slot + 1));
        GrantVault vault =
            new GrantVault(TOKEN, beneficiary, address(reserve), address(reserve), terms);
        assertTrue(TOKEN.transfer(address(reserve), allocation));
        reserve.approve(TOKEN, address(vault), allocation);
        reserve.fund(vault);
        ghosts[slot] =
            Ghost(vault, reserve, beneficiary, allocation, 0, 0, 0, 0, start, cliff, end, false);
        ++nextId;
        ++successfulFundings;
        totalAllocated += allocation;
    }

    function _replaceIfSettled(uint256 slot, uint256 amountSeed) private {
        Ghost memory g = ghosts[slot];
        uint256 liability = (g.cancelled ? g.frozen : g.allocation) - g.released;
        if (liability != 0) return;
        settled.push(Settled(g.vault, g.refunded, g.donated));
        _create(slot, bound(amountSeed, 1, 1_000_000_000_000));
    }

    function _release(uint256 slot, uint256 timeSeed) private {
        Ghost storage g = ghosts[slot];
        uint64 lower = clock > g.cliff ? clock : g.cliff + 1;
        uint64 upper = g.cancelled ? lower : g.end;
        if (lower < upper) clock = uint64(bound(timeSeed, lower, upper));
        else clock = lower;
        vm.warp(clock);
        uint256 amount = g.vault.available();
        if (amount == 0 && !g.cancelled) {
            clock = g.end;
            vm.warp(clock);
            amount = g.vault.available();
        }
        assertTrue(amount > 0);
        _pay(slot, amount);
    }

    function _releaseAt(uint256 slot, uint64 time) private {
        clock = time;
        vm.warp(clock);
        uint256 amount = ghosts[slot].vault.available();
        assertTrue(amount > 0);
        _pay(slot, amount);
    }

    function _pay(uint256 slot, uint256 amount) private {
        Ghost storage g = ghosts[slot];
        uint256 beforeBalance = TOKEN.balanceOf(g.beneficiary);
        vm.prank(g.beneficiary);
        uint256 paid = g.vault.release();
        assertEq(paid, amount);
        assertEq(TOKEN.balanceOf(g.beneficiary) - beforeBalance, amount);
        g.released += amount;
        totalReleased += amount;
        ++positiveReleases;
    }

    function _cancel(uint256 slot) private {
        Ghost storage g = ghosts[slot];
        assertTrue(slot == 0 && !g.cancelled);
        uint256 frozen = _vested(g, clock);
        uint256 reserveBefore = TOKEN.balanceOf(address(g.reserve));
        uint256 refund = g.reserve.cancel(g.vault);
        assertEq(refund, g.allocation - frozen);
        assertEq(TOKEN.balanceOf(address(g.reserve)) - reserveBefore, refund);
        g.cancelled = true;
        g.frozen = frozen;
        g.refunded = refund;
        totalRefunded += refund;
        if (refund > 0) ++positiveRefunds;
    }

    function _attackFounder() private {
        Ghost storage g = ghosts[1];
        bytes32 beforeState = _attackSnapshot(g);
        (bool ok, bytes memory reason) =
            address(g.reserve).call(abi.encodeCall(ContractCaller.cancel, (g.vault)));
        assertFalse(ok);
        assertEq(
            keccak256(reason), keccak256(abi.encodeWithSelector(G.FounderCannotCancel.selector))
        );
        assertEq(_attackSnapshot(g), beforeState);
        ++founderCancellationAttempts;
    }

    function _attackReassignment(uint256 slot, uint256 seed) private {
        Ghost storage g = ghosts[slot];
        bytes32 beforeState = _attackSnapshot(g);
        address caller = seed % 2 == 0 ? address(g.reserve) : g.beneficiary;
        vm.prank(caller);
        (bool ok,) =
            address(g.vault).call(abi.encodeWithSignature("setBeneficiary(address)", address(this)));
        assertFalse(ok);
        assertEq(_attackSnapshot(g), beforeState);
        ++reassignmentAttempts;
    }

    function _attackSnapshot(Ghost storage g) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                g.vault.grant(),
                g.vault.funded(),
                g.vault.BENEFICIARY(),
                g.vault.available(),
                TOKEN.balanceOf(address(g.vault)),
                TOKEN.balanceOf(address(g.reserve)),
                TOKEN.balanceOf(g.beneficiary),
                TOKEN.totalSupply()
            )
        );
    }

    function _donate(uint256 slot, uint256 amountSeed) private {
        uint256 amount = bound(amountSeed, 1, 1_000_000);
        assertTrue(TOKEN.transfer(address(ghosts[slot].vault), amount));
        ghosts[slot].donated += amount;
    }

    function _vested(Ghost memory g, uint64 time) private pure returns (uint256) {
        if (time <= g.cliff) return 0;
        if (time >= g.end) return g.allocation;
        // allocation is bounded to 1e12 in generated slots, so this direct oracle cannot overflow.
        return g.allocation * (uint256(time) - g.cliff) / (g.end - g.cliff);
    }
}

contract GrantVaultInvariantTest is TestBase {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    GrantVaultHandler internal handler;

    function setUp() public {
        handler = new GrantVaultHandler();
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory targeted) {
        targeted = new FuzzSelector[](1);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = GrantVaultHandler.step.selector;
        targeted[0] = FuzzSelector(address(handler), selectors);
    }

    function invariantPrincipalCustodyFrozenDebtBindingsAndSupply() public view {
        handler.assertLedger();
    }

    function afterInvariant() public {
        assertTrue(handler.steps() > 0);
        assertTrue(handler.successfulFundings() >= 2);
        assertTrue(handler.positiveReleases() > 0);
        assertTrue(handler.positiveRefunds() > 0);
        assertTrue(handler.founderCancellationAttempts() > 0);
        assertTrue(handler.reassignmentAttempts() > 0);
        handler.settleAll();
        for (uint256 slot; slot < 2; ++slot) {
            GrantVaultHandler.Ghost memory g = handler.ghost(slot);
            assertEq(g.vault.available(), 0);
        }
    }
}
