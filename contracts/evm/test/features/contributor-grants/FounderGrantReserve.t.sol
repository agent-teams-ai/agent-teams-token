// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import { TestBase } from "../../TestBase.sol";
import { AGTMAIToken } from "../../../src/features/token-genesis/AGTMAIToken.sol";
import { GrantAccounting as G } from "../../../src/features/contributor-grants/GrantAccounting.sol";
import { GrantVault } from "../../../src/features/contributor-grants/GrantVault.sol";
import {
    FounderGrantReserve
} from "../../../src/features/contributor-grants/FounderGrantReserve.sol";

contract FounderGrantReserveTest is TestBase {
    AGTMAIToken private token;
    address private constant BENEFICIARY = address(0xBEEF);

    function setUp() public {
        vm.warp(100);
        AGTMAIToken.Allocation[] memory allocations = new AGTMAIToken.Allocation[](1);
        allocations[0] = AGTMAIToken.Allocation(bytes32("fixture"), address(this), 10_000);
        token = new AGTMAIToken(10_000, allocations);
    }

    function _terms() private pure returns (G.Terms memory) {
        // 1970-01-01T00:01:40Z, first and fourth Gregorian anniversaries.
        return G.Terms(300, 100, 31_536_100, 126_230_500, G.Kind.Founder, bytes32("founder"));
    }

    function testFounderThreePercentIrrevocableAndFundedOnlyOnce() public {
        FounderGrantReserve reserve =
            new FounderGrantReserve(token, BENEFICIARY, address(this), _terms());
        assertTrue(token.transfer(address(reserve), 300));
        vm.prank(BENEFICIARY);
        reserve.fund();
        GrantVault vault = reserve.VAULT();
        assertEq(token.balanceOf(address(vault)), 300);
        assertEq(token.allowance(address(reserve), address(vault)), 0);
        vm.expectRevert(GrantVault.AlreadyFunded.selector);
        reserve.fund();
        vm.expectRevert(G.FounderCannotCancel.selector);
        vault.cancel();
        vm.warp(31_536_100);
        assertEq(vault.available(), 0);
        vm.warp(78_883_300);
        assertEq(vault.available(), 150);
        vm.prank(BENEFICIARY);
        vault.release();
        vm.expectRevert(G.FounderCannotCancel.selector);
        vault.cancel();
        vm.warp(126_230_500);
        vm.prank(BENEFICIARY);
        vault.release();
        assertEq(token.balanceOf(BENEFICIARY), 300);
        assertEq(token.totalSupply(), 10_000);
    }

    function _tokenWithSupply(uint256 supply) private returns (AGTMAIToken) {
        AGTMAIToken.Allocation[] memory allocations = new AGTMAIToken.Allocation[](1);
        allocations[0] = AGTMAIToken.Allocation(bytes32("fixture"), address(this), supply);
        return new AGTMAIToken(supply, allocations);
    }

    function testFuzzFounderExactPercentageAndNonDivisibleSupply(uint256 seed) public {
        uint256 hundreds = bound(seed, 1, type(uint256).max / 100);
        uint256 supply = hundreds * 100;
        AGTMAIToken exactToken = _tokenWithSupply(supply);
        G.Terms memory terms = _terms();
        terms.allocation = hundreds * 3;
        FounderGrantReserve reserve =
            new FounderGrantReserve(exactToken, BENEFICIARY, address(this), terms);
        assertEq(reserve.VAULT().grant().terms.allocation, hundreds * 3);
        assertTrue(exactToken.transfer(address(reserve), terms.allocation));
        reserve.fund();
        assertEq(exactToken.balanceOf(address(reserve.VAULT())), hundreds * 3);
        terms.allocation += 1;
        vm.expectRevert(FounderGrantReserve.InvalidFounderAllocation.selector);
        new FounderGrantReserve(exactToken, BENEFICIARY, address(this), terms);
        terms.allocation -= 1;
        AGTMAIToken inexactToken = _tokenWithSupply(supply + 1);
        vm.expectRevert(FounderGrantReserve.InvalidFounderAllocation.selector);
        new FounderGrantReserve(inexactToken, BENEFICIARY, address(this), terms);
    }

    function testFounderMaximumDivisibleSupplyAvoidsMultiplyOverflow() public {
        uint256 supply = type(uint256).max - type(uint256).max % 100;
        AGTMAIToken maximumToken = _tokenWithSupply(supply);
        G.Terms memory terms = _terms();
        // Independent complement identity; multiplying the supply by three would overflow.
        terms.allocation = supply - (supply / 100) * 97;
        FounderGrantReserve reserve =
            new FounderGrantReserve(maximumToken, BENEFICIARY, address(this), terms);
        assertEq(reserve.VAULT().grant().terms.allocation, terms.allocation);
        assertTrue(maximumToken.transfer(address(reserve), terms.allocation));
        reserve.fund();
        assertEq(maximumToken.balanceOf(address(reserve.VAULT())), terms.allocation);
    }

    function testFounderCannotBeRevocableOrDifferentPercentage() public {
        G.Terms memory terms = _terms();
        terms.kind = G.Kind.TeamService;
        vm.expectRevert(FounderGrantReserve.InvalidFounderAllocation.selector);
        new FounderGrantReserve(token, BENEFICIARY, address(this), terms);
        terms.kind = G.Kind.Founder;
        terms.allocation = 301;
        vm.expectRevert(FounderGrantReserve.InvalidFounderAllocation.selector);
        new FounderGrantReserve(token, BENEFICIARY, address(this), terms);
    }
}
