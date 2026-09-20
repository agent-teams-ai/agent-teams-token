// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import { TestBase } from "../../TestBase.sol";
import { GrantAccounting as G } from "../../../src/features/contributor-grants/GrantAccounting.sol";
import { GrantCalendar } from "../../../src/features/contributor-grants/GrantCalendar.sol";
import { GrantVault } from "../../../src/features/contributor-grants/GrantVault.sol";
import { ReserveController } from "../../../src/features/contributor-grants/ReserveController.sol";
import { AGTMAIToken } from "../../../src/features/token-genesis/AGTMAIToken.sol";

contract ReserveControllerTest is TestBase {
    AGTMAIToken private token;
    ReserveController private reserve;
    address private constant BENEFICIARY = address(0xBEEF);
    bytes32 private constant PURPOSE = bytes32("contributors");

    function setUp() public {
        vm.warp(100);
        AGTMAIToken.Allocation[] memory allocations = new AGTMAIToken.Allocation[](1);
        allocations[0] = AGTMAIToken.Allocation(bytes32("fixture"), address(this), 10_000);
        token = new AGTMAIToken(10_000, allocations);
        reserve = new ReserveController(token, address(this), PURPOSE, 1000, 600);
        assertTrue(token.transfer(address(reserve), 10_000));
    }

    function _terms(uint256 amount) private view returns (G.Terms memory) {
        uint64 start = uint64(block.timestamp);
        // Calendar vectors are tested independently; these tests exercise gross cap history.
        return G.Terms(
            amount,
            start,
            GrantCalendar.anniversary(start, 1, false),
            GrantCalendar.anniversary(start, 4, false),
            G.Kind.TeamService,
            PURPOSE
        );
    }

    function testPerGrantAndGrossCaps() public {
        vm.expectRevert(ReserveController.CapExceeded.selector);
        reserve.commit(BENEFICIARY, _terms(601));
        reserve.commit(BENEFICIARY, _terms(600));
        reserve.commit(BENEFICIARY, _terms(400));
        assertEq(reserve.rollingCommitted(), 1000);
        vm.expectRevert(ReserveController.CapExceeded.selector);
        reserve.commit(BENEFICIARY, _terms(1));
        assertEq(token.totalSupply(), 10_000);
    }

    function testRefundDoesNotRestoreCapacityAndVestedDebtSurvives() public {
        GrantVault vault = reserve.commit(BENEFICIARY, _terms(600));
        vm.warp((uint256(vault.grant().terms.cliff) + vault.grant().terms.end) / 2);
        assertEq(vault.cancel(), 300);
        assertEq(token.balanceOf(address(reserve)), 9700);
        assertEq(reserve.grossCommitted(), 600);
        vm.warp(vault.grant().terms.end);
        vm.prank(BENEFICIARY);
        assertEq(vault.release(), 300);
        assertEq(token.balanceOf(BENEFICIARY), 300);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(token.totalSupply(), 10_000);
    }

    function testPreCliffRefundDoesNotRestoreRollingCapacity() public {
        GrantVault vault = reserve.commit(BENEFICIARY, _terms(600));
        assertEq(vault.cancel(), 600);
        assertEq(token.balanceOf(address(reserve)), 10_000);
        assertEq(reserve.rollingCommitted(), 600);
        vm.expectRevert(ReserveController.CapExceeded.selector);
        reserve.commit(BENEFICIARY, _terms(401));
    }

    function testExactWindowBoundaryAndStaggeredExpiry() public {
        reserve.commit(BENEFICIARY, _terms(600));
        vm.warp(200);
        reserve.commit(BENEFICIARY, _terms(400));
        vm.warp(100 + 365 days - 1);
        assertEq(reserve.rollingCommitted(), 1000);
        vm.warp(100 + 365 days);
        assertEq(reserve.rollingCommitted(), 400);
        reserve.commit(BENEFICIARY, _terms(600));
        assertEq(reserve.rollingCommitted(), 1000);
        vm.warp(200 + 365 days);
        assertEq(reserve.rollingCommitted(), 600);
        assertEq(reserve.grossCommitted(), 1600);
    }

    function testFundingFailureRollsBackCommitment() public {
        ReserveController empty = new ReserveController(token, address(this), PURPOSE, 1000, 600);
        vm.expectPartialRevert(
            bytes4(keccak256("ERC20InsufficientBalance(address,uint256,uint256)"))
        );
        empty.commit(BENEFICIARY, _terms(600));
        assertEq(empty.grossCommitted(), 0);
        assertEq(empty.rollingCommitted(), 0);
    }

    function testAuthorityPurposeAndKindCannotBeBypassed() public {
        G.Terms memory terms = _terms(100);
        vm.prank(BENEFICIARY);
        vm.expectRevert(ReserveController.Unauthorized.selector);
        reserve.commit(BENEFICIARY, terms);
        terms.originalPurpose = bytes32("other");
        vm.expectRevert(ReserveController.InvalidGrant.selector);
        reserve.commit(BENEFICIARY, terms);
        terms.originalPurpose = PURPOSE;
        terms.kind = G.Kind.Founder;
        vm.expectRevert(ReserveController.InvalidGrant.selector);
        reserve.commit(BENEFICIARY, terms);
    }

    function testControllerCannotAccelerateVesting() public {
        G.Terms memory terms = _terms(100);
        terms.cliff = terms.start + 12;
        terms.end = terms.start + 48;
        vm.expectRevert(GrantCalendar.InvalidCalendarSchedule.selector);
        reserve.commit(BENEFICIARY, terms);
        assertEq(reserve.grossCommitted(), 0);
        assertEq(token.balanceOf(address(reserve)), 10_000);
    }

    function testFuzzRollingMatchesIndependentHistory(uint256 seed) public {
        uint256[24] memory times;
        uint256[24] memory amounts;
        for (uint256 i; i < 24; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            vm.warp(block.timestamp + seed % (90 days));
            uint256 expected;
            for (uint256 j; j < i; ++j) {
                if (block.timestamp - times[j] < 365 days) expected += amounts[j];
            }
            assertEq(reserve.rollingCommitted(), expected);
            uint256 amount = 1 + seed % 40;
            reserve.commit(BENEFICIARY, _terms(amount));
            times[i] = block.timestamp;
            amounts[i] = amount;
            assertEq(reserve.rollingCommitted(), expected + amount);
        }
    }
}
