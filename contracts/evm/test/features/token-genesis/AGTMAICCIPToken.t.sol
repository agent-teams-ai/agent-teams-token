// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import { AGTMAIToken } from "../../../src/features/token-genesis/AGTMAIToken.sol";
import { AGTMAICCIPToken } from "../../../src/features/token-genesis/AGTMAICCIPToken.sol";
import { TestBase } from "../../TestBase.sol";

contract AGTMAICCIPTokenTest is TestBase {
    address internal constant RECIPIENT = address(0x1001);
    address internal constant ADMIN = address(0x2001);

    function allocations() internal pure returns (AGTMAIToken.Allocation[] memory rows) {
        rows = new AGTMAIToken.Allocation[](1);
        rows[0] = AGTMAIToken.Allocation(bytes32(uint256(1)), RECIPIENT, 1000);
    }

    function testRegistrationAdminDoesNotReceiveSupplyOrChangeGenesis() public {
        AGTMAIToken base = new AGTMAIToken(1000, allocations());
        AGTMAICCIPToken token = new AGTMAICCIPToken(1000, allocations(), ADMIN);
        assertEq(token.getCCIPAdmin(), ADMIN);
        assertEq(token.GENESIS_ALLOCATION_HASH(), base.GENESIS_ALLOCATION_HASH());
        assertEq(token.totalSupply(), 1000);
        assertEq(token.balanceOf(RECIPIENT), 1000);
        assertEq(token.balanceOf(ADMIN), 0);
        assertEq(token.balanceOf(address(this)), 0);
        assertEq(token.decimals(), 9);
    }

    function testRejectsZeroRegistrationAdmin() public {
        vm.expectRevert(AGTMAICCIPToken.ZeroCCIPAdmin.selector);
        new AGTMAICCIPToken(1000, allocations(), address(0));
    }

    function testRegistrationAdminCannotMintOrReplaceItself() public {
        AGTMAICCIPToken token = new AGTMAICCIPToken(1000, allocations(), ADMIN);
        vm.prank(ADMIN);
        (bool minted,) = address(token).call(abi.encodeWithSignature("mint(address,uint256)", ADMIN, 1));
        assertFalse(minted);
        vm.prank(ADMIN);
        (bool changed,) = address(token).call(abi.encodeWithSignature("setCCIPAdmin(address)", RECIPIENT));
        assertFalse(changed);
        assertEq(token.getCCIPAdmin(), ADMIN);
        assertEq(token.totalSupply(), 1000);
    }
}
