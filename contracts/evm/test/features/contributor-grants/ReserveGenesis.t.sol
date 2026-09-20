// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import { TestBase } from "../../TestBase.sol";
import { AGTMAIToken } from "../../../src/features/token-genesis/AGTMAIToken.sol";
import { GrantAccounting as G } from "../../../src/features/contributor-grants/GrantAccounting.sol";
import { GrantVault } from "../../../src/features/contributor-grants/GrantVault.sol";
import { ReserveController } from "../../../src/features/contributor-grants/ReserveController.sol";
import {
    FounderGrantReserve
} from "../../../src/features/contributor-grants/FounderGrantReserve.sol";

/// @dev Disposable local constructor-order fixture. No deployment or broadcast capability.
contract ReserveGenesisFixture {
    AGTMAIToken public token;
    ReserveController public contributors;
    FounderGrantReserve public founder;

    constructor(address controller, address beneficiary) {
        AGTMAIToken.Allocation[] memory allocations = new AGTMAIToken.Allocation[](8);
        allocations[0] = AGTMAIToken.Allocation(bytes32("a"), address(0x1001), 300_000);
        allocations[1] = AGTMAIToken.Allocation(bytes32("b"), address(0x1002), 300_000);
        allocations[2] = AGTMAIToken.Allocation(bytes32("contributors"), _created(2), 170_000);
        allocations[3] = AGTMAIToken.Allocation(bytes32("d"), address(0x1004), 90_000);
        allocations[4] = AGTMAIToken.Allocation(bytes32("e"), address(0x1005), 50_000);
        allocations[5] = AGTMAIToken.Allocation(bytes32("f"), address(0x1006), 50_000);
        allocations[6] = AGTMAIToken.Allocation(bytes32("founder"), _created(3), 30_000);
        allocations[7] = AGTMAIToken.Allocation(bytes32("g"), address(0x1007), 10_000);
        token = new AGTMAIToken(1_000_000, allocations);
        contributors =
            new ReserveController(token, controller, bytes32("contributors"), 20_000, 5000);
        founder = new FounderGrantReserve(
            token,
            beneficiary,
            controller,
            G.Terms(30_000, 100, 31_536_100, 126_230_500, G.Kind.Founder, bytes32("founder"))
        );
        require(
            address(contributors) == _created(2) && address(founder) == _created(3), "fixture nonce"
        );
        founder.fund();
    }

    function _created(uint8 nonce) private view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(hex"d694", address(this), bytes1(nonce)))))
        );
    }
}

contract ReserveGenesisTest is TestBase {
    function testDirectGenesisAllocationAndCustodyConserveSupply() public {
        vm.warp(100);
        address beneficiary = address(0xBEEF);
        ReserveGenesisFixture fixture = new ReserveGenesisFixture(address(this), beneficiary);
        AGTMAIToken token = fixture.token();
        ReserveController contributors = fixture.contributors();
        GrantVault founder = fixture.founder().VAULT();
        assertEq(token.INITIAL_SUPPLY(), 1_000_000);
        assertEq(token.totalSupply(), 1_000_000);
        assertEq(token.balanceOf(address(contributors)), 170_000);
        assertEq(token.balanceOf(address(founder)), 30_000);
        assertEq(token.balanceOf(address(fixture)), 0);
        assertEq(token.balanceOf(address(fixture.founder())), 0);
        assertEq(token.balanceOf(beneficiary), 0);
        vm.expectRevert(G.FounderCannotCancel.selector);
        founder.cancel();
        GrantVault team = contributors.commit(
            beneficiary,
            G.Terms(5000, 100, 31_536_100, 126_230_500, G.Kind.TeamService, bytes32("contributors"))
        );
        assertEq(team.cancel(), 5000);
        assertEq(contributors.rollingCommitted(), 5000);
        assertEq(token.balanceOf(address(contributors)), 170_000);
        uint256 outside = token.balanceOf(address(0x1001)) + token.balanceOf(address(0x1002))
            + token.balanceOf(address(0x1004)) + token.balanceOf(address(0x1005))
            + token.balanceOf(address(0x1006)) + token.balanceOf(address(0x1007));
        assertEq(outside, 800_000);
        assertEq(
            outside + token.balanceOf(address(contributors)) + token.balanceOf(address(founder)),
            token.totalSupply()
        );
    }
}
