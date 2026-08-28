// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import { AGTMAIToken } from "../../../src/features/token-genesis/AGTMAIToken.sol";
import { TestBase } from "../../TestBase.sol";

contract TokenTransferHandler {
    AGTMAIToken internal immutable TOKEN;
    address[3] internal actors;

    constructor(AGTMAIToken token_, address[3] memory actors_) {
        TOKEN = token_;
        actors = actors_;
    }

    function move(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        uint256 balance = TOKEN.balanceOf(from);
        if (balance == 0) return;
        if (!TOKEN.transferFrom(from, to, amount % (balance + 1))) revert();
    }

    function changeApproval(uint256 actorSeed, uint256 amount) external {
        address actor = actors[actorSeed % actors.length];
        if (!TOKEN.approve(actor, amount)) revert();
    }
}

contract AGTMAITokenInvariantTest is TestBase {
    uint256 internal constant SUPPLY = 1_000_000_000_000;
    address internal constant ALPHA = address(0x1001);
    address internal constant BETA = address(0x1002);
    address internal constant GAMMA = address(0x1003);

    AGTMAIToken internal token;
    TokenTransferHandler internal handler;

    function setUp() public {
        AGTMAIToken.Allocation[] memory allocations = new AGTMAIToken.Allocation[](3);
        allocations[0] = AGTMAIToken.Allocation(bytes32("test-alpha"), ALPHA, 400_000_000_000);
        allocations[1] = AGTMAIToken.Allocation(bytes32("test-beta"), BETA, 350_000_000_000);
        allocations[2] = AGTMAIToken.Allocation(bytes32("test-gamma"), GAMMA, 250_000_000_000);
        token = new AGTMAIToken(SUPPLY, allocations);

        address[3] memory actors = [ALPHA, BETA, GAMMA];
        handler = new TokenTransferHandler(token, actors);
        vm.prank(ALPHA);
        assertTrue(token.approve(address(handler), type(uint256).max));
        vm.prank(BETA);
        assertTrue(token.approve(address(handler), type(uint256).max));
        vm.prank(GAMMA);
        assertTrue(token.approve(address(handler), type(uint256).max));
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariantTotalSupplyNeverChanges() public view {
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.INITIAL_SUPPLY(), SUPPLY);
    }

    function invariantAggregateBalancesEqualInitialSupply() public view {
        assertEq(token.balanceOf(ALPHA) + token.balanceOf(BETA) + token.balanceOf(GAMMA), SUPPLY);
    }
}
