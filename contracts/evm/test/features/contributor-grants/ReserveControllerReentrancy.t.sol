// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import { TestBase, Vm } from "../../TestBase.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { GrantAccounting as G } from "../../../src/features/contributor-grants/GrantAccounting.sol";
import { GrantVault } from "../../../src/features/contributor-grants/GrantVault.sol";
import { ReserveController } from "../../../src/features/contributor-grants/ReserveController.sol";

/// @dev Test-only adversarial token is also the authorized controller, so callbacks reach the lock.
contract ReentrantReserveToken is ERC20 {
    ReserveController public reserve;
    uint256 public callbacks;
    bool public failClear;
    G.Terms private _terms;
    address private constant BENEFICIARY = address(0xBEEF);

    constructor() ERC20("Callback fixture", "CALL") { }

    function initialize() external {
        require(address(reserve) == address(0), "initialized");
        reserve = new ReserveController(this, address(this), bytes32("contributors"), 1000, 600);
        _mint(address(reserve), 1000);
        _terms =
            G.Terms(100, 100, 31_536_100, 126_230_500, G.Kind.TeamService, bytes32("contributors"));
    }

    function setFailClear(bool value) external {
        failClear = value;
    }

    function commit() external returns (GrantVault) {
        return reserve.commit(BENEFICIARY, _terms);
    }

    function approve(address spender, uint256 value) public override returns (bool) {
        _callback();
        if (value == 0 && failClear) return false;
        return super.approve(spender, value);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        _callback();
        return super.transferFrom(from, to, value);
    }

    function _callback() private {
        ++callbacks;
        // Accounting is already published at all three token call sites.
        require(reserve.grossCommitted() == ((callbacks - 1) / 3 + 1) * 100, "gross state");
        require(reserve.rollingCommitted() == reserve.grossCommitted(), "rolling state");
        (bool success, bytes memory result) =
            address(reserve).call(abi.encodeCall(ReserveController.commit, (BENEFICIARY, _terms)));
        require(!success, "reentry succeeded");
        require(
            keccak256(result)
                == keccak256(abi.encodeWithSelector(ReserveController.ReentrantCall.selector)),
            "must reach reentrancy guard, not authorization"
        );
    }
}

contract ReserveControllerReentrancyTest is TestBase {
    function testAuthorizedCallbacksAtEveryTokenCallAreLockedAndLockResets() public {
        vm.warp(100);
        ReentrantReserveToken token = new ReentrantReserveToken();
        token.initialize();
        ReserveController reserve = token.reserve();
        vm.recordLogs();
        GrantVault first = token.commit();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 committedEvents;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(reserve)) {
                ++committedEvents;
                assertEq(logs[i].topics[0], keccak256("GrantCommitted(address,address,uint256)"));
                assertEq(logs[i].topics[1], bytes32(uint256(uint160(address(first)))));
                assertEq(logs[i].topics[2], bytes32(uint256(uint160(address(0xBEEF)))));
                assertEq(abi.decode(logs[i].data, (uint256)), 100);
            }
        }
        assertEq(committedEvents, 1);
        assertEq(token.callbacks(), 3);
        assertEq(token.balanceOf(address(first)), 100);
        assertEq(token.allowance(address(reserve), address(first)), 0);
        GrantVault second = token.commit();
        assertEq(token.callbacks(), 6);
        assertEq(token.balanceOf(address(second)), 100);
        assertEq(token.balanceOf(address(reserve)), 800);
        assertEq(token.allowance(address(reserve), address(second)), 0);
        assertEq(reserve.grossCommitted(), 200);
        assertEq(reserve.rollingCommitted(), 200);
    }

    function testClearApprovalFailureRollsBackAndAllowsRetry() public {
        vm.warp(100);
        ReentrantReserveToken token = new ReentrantReserveToken();
        token.initialize();
        ReserveController reserve = token.reserve();
        token.setFailClear(true);
        vm.recordLogs();
        vm.expectRevert(ReserveController.ApprovalFailed.selector);
        token.commit();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].emitter != address(reserve));
        }
        assertEq(reserve.grossCommitted(), 0);
        assertEq(reserve.rollingCommitted(), 0);
        assertEq(token.balanceOf(address(reserve)), 1000);
        assertEq(token.callbacks(), 0);
        token.setFailClear(false);
        GrantVault vault = token.commit();
        assertEq(token.callbacks(), 3);
        assertEq(token.balanceOf(address(vault)), 100);
        assertEq(reserve.grossCommitted(), 100);
        assertEq(token.allowance(address(reserve), address(vault)), 0);
    }
}
