// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    PurposeReserveVault
} from "../../../src/features/purpose-reserves/PurposeReserveVault.sol";
import { TestBase, Vm } from "../../TestBase.sol";

contract PurposeToken is IERC20 {
    enum Mode {
        Normal,
        FalseReturn,
        Revert,
        Fee,
        NoMove,
        ExtraCredit,
        Reenter
    }

    mapping(address => uint256) public override balanceOf;
    Mode public mode;
    PurposeController public controller;
    PurposeReserveVault public vault;

    function setMode(Mode next) external {
        mode = next;
    }

    function setReentry(PurposeController next, PurposeReserveVault target) external {
        controller = next;
        vault = target;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function totalSupply() external pure override returns (uint256) {
        return 0;
    }

    function allowance(address, address) external pure override returns (uint256) {
        return 0;
    }

    function approve(address, uint256) external pure override returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure override returns (bool) {
        return false;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        if (mode == Mode.FalseReturn) return false;
        if (mode == Mode.Revert) revert("token failure");
        if (mode == Mode.Reenter) controller.send(vault, to, 1);
        if (mode == Mode.NoMove) return true;
        uint256 debit = mode == Mode.Fee ? amount + 1 : amount;
        balanceOf[msg.sender] -= debit;
        balanceOf[to] += mode == Mode.ExtraCredit ? amount + 1 : amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}

contract PurposeController {
    function send(PurposeReserveVault vault, address recipient, uint256 amount) external {
        vault.transferOut(recipient, amount);
    }
}

contract MalformedPurposeToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    // A typed IERC20 caller must reject missing return data and roll back checkpoints.
    fallback() external { }
}

contract PurposeReserveVaultTest is TestBase {
    event Configured(
        address indexed token,
        address indexed controller,
        bytes32 indexed purpose,
        uint64 opensAt,
        uint64 windowSeconds,
        uint256 rollingCap
    );
    event Outflow(
        address indexed recipient,
        uint256 amount,
        uint256 grossOutflow,
        uint256 rollingOutflow,
        uint256 timestamp
    );

    PurposeToken token;
    PurposeController controller;
    PurposeReserveVault vault;
    address constant RECIPIENT = address(0x1234);
    bytes32 constant PURPOSE = keccak256("users");

    function setUp() public {
        token = new PurposeToken();
        controller = new PurposeController();
        vault = new PurposeReserveVault(token, address(controller), PURPOSE, 100, 10, 100);
        token.mint(address(vault), 300);
        vm.warp(100);
    }

    function testConstructorRejectsInvalidBindingsAndPolicy() public {
        vm.expectRevert(PurposeReserveVault.InvalidPolicy.selector);
        new PurposeReserveVault(IERC20(address(0x1234)), address(controller), PURPOSE, 1, 1, 1);
        vm.expectRevert(PurposeReserveVault.InvalidPolicy.selector);
        new PurposeReserveVault(token, address(0x1234), PURPOSE, 1, 1, 1);
        vm.expectRevert(PurposeReserveVault.InvalidPolicy.selector);
        new PurposeReserveVault(token, address(token), PURPOSE, 1, 1, 1);
        vm.expectRevert(PurposeReserveVault.InvalidPolicy.selector);
        new PurposeReserveVault(token, address(controller), bytes32(0), 1, 1, 1);
        vm.expectRevert(PurposeReserveVault.InvalidPolicy.selector);
        new PurposeReserveVault(token, address(controller), PURPOSE, 0, 1, 1);
        vm.expectRevert(PurposeReserveVault.InvalidPolicy.selector);
        new PurposeReserveVault(token, address(controller), PURPOSE, 1, 0, 1);
        vm.expectRevert(PurposeReserveVault.InvalidPolicy.selector);
        new PurposeReserveVault(token, address(controller), PURPOSE, 1, 1, 0);
    }

    function testConfigurationAndOutflowEventsReportObservedPolicy() public {
        vm.expectEmit(true, true, true, true);
        emit Configured(address(token), address(controller), PURPOSE, 100, 10, 100);
        PurposeReserveVault configured =
            new PurposeReserveVault(token, address(controller), PURPOSE, 100, 10, 100);
        assertEq(address(configured.TOKEN()), address(token));
        assertEq(configured.CONTROLLER(), address(controller));
        assertEq(configured.PURPOSE(), PURPOSE);
        assertEq(configured.OPENS_AT(), 100);
        assertEq(configured.WINDOW_SECONDS(), 10);
        assertEq(configured.ROLLING_CAP(), 100);

        vm.expectEmit(true, false, false, true);
        emit Outflow(RECIPIENT, 20, 20, 20, 100);
        controller.send(vault, RECIPIENT, 20);
        vm.expectEmit(true, false, false, true);
        emit Outflow(RECIPIENT, 15, 35, 35, 100);
        controller.send(vault, RECIPIENT, 15);
    }

    function testOpeningAuthorizationAndRecipientChecks() public {
        vm.warp(99);
        assertEq(vault.availableOutflow(), 0);
        vm.expectRevert(PurposeReserveVault.NotOpen.selector);
        controller.send(vault, RECIPIENT, 1);
        vm.warp(100);
        vm.expectRevert(PurposeReserveVault.Unauthorized.selector);
        vault.transferOut(RECIPIENT, 1);
        for (uint256 i; i < 4; ++i) {
            address recipient =
                i == 0 ? address(0) : i == 1 ? address(vault) : i == 2 ? address(token) : RECIPIENT;
            vm.expectRevert(PurposeReserveVault.InvalidOutflow.selector);
            controller.send(vault, recipient, i == 3 ? 0 : 1);
        }
        controller.send(vault, RECIPIENT, 100);
        assertEq(vault.grossOutflow(), 100);
        assertEq(vault.rollingOutflow(), 100);
        assertEq(vault.availableOutflow(), 0);
        vm.expectRevert(PurposeReserveVault.CapExceeded.selector);
        controller.send(vault, RECIPIENT, 1);
    }

    function testRollingBoundariesAndIndependentSum() public {
        // An inclusive cutoff or a calendar reset changes the independent sum.
        uint256[4] memory times = [uint256(100), 100, 105, 109];
        uint256[4] memory amounts = [uint256(20), 15, 30, 25];
        uint256 gross;
        for (uint256 i; i < times.length; ++i) {
            vm.warp(times[i]);
            controller.send(vault, RECIPIENT, amounts[i]);
            gross += amounts[i];
            assertEq(vault.grossOutflow(), gross);
            uint256 independent;
            for (uint256 j; j <= i; ++j) {
                if (times[j] + 10 > times[i]) independent += amounts[j];
            }
            assertEq(vault.rollingOutflow(), independent);
        }
        vm.warp(110); // The two transfers at 100 have expired exactly.
        assertEq(vault.rollingOutflow(), 55);
        vm.warp(115);
        assertEq(vault.rollingOutflow(), 25);
        vm.warp(119);
        assertEq(vault.rollingOutflow(), 0);
        assertEq(vault.grossOutflow(), 90);
        assertEq(vault.availableOutflow(), 100);
        controller.send(vault, RECIPIENT, 100);
        assertEq(vault.grossOutflow(), 190);
        assertEq(vault.rollingOutflow(), 100);
    }

    function testPastOpeningAndTimeBelowWindow() public {
        PurposeReserveVault early =
            new PurposeReserveVault(token, address(controller), PURPOSE, 1, 200, 10);
        token.mint(address(early), 10);
        controller.send(early, RECIPIENT, 7);
        assertEq(early.rollingOutflow(), 7);
        vm.warp(300);
        assertEq(early.rollingOutflow(), 0);
        assertEq(early.grossOutflow(), 7);
    }

    function testReturnDoesNotNetCapAndInventoryCanRecover() public {
        controller.send(vault, RECIPIENT, 60);
        token.mint(address(vault), 100); // Donation cannot change gross cap use.
        assertEq(vault.availableOutflow(), 40);
        controller.send(vault, RECIPIENT, 40);
        assertEq(vault.availableOutflow(), 0);
        vm.warp(110);
        assertEq(vault.availableOutflow(), 100);
        assertEq(vault.grossOutflow(), 100);
    }

    function testInventoryLimitsAvailability() public {
        PurposeReserveVault thin =
            new PurposeReserveVault(token, address(controller), PURPOSE, 100, 10, 100);
        token.mint(address(thin), 2);
        assertEq(thin.availableOutflow(), 2);
        vm.expectRevert(PurposeReserveVault.InsufficientInventory.selector);
        controller.send(thin, RECIPIENT, 3);
        assertEq(thin.grossOutflow(), 0);
        controller.send(thin, RECIPIENT, 2);
        assertEq(thin.availableOutflow(), 0);
        vm.prank(RECIPIENT);
        token.transfer(address(thin), 2); // A real return increases inventory, not the cap.
        assertEq(thin.grossOutflow(), 2);
        assertEq(thin.rollingOutflow(), 2);
        assertEq(thin.availableOutflow(), 2);
        vm.warp(110);
        assertEq(thin.rollingOutflow(), 0);
        assertEq(thin.availableOutflow(), 2);
    }

    function testTokenFailureAndIncorrectMovementIsAtomic() public {
        for (uint256 i = 1; i <= 5; ++i) {
            token.setMode(PurposeToken.Mode(i));
            uint256 vaultBefore = token.balanceOf(address(vault));
            uint256 recipientBefore = token.balanceOf(RECIPIENT);
            vm.recordLogs();
            (bool success,) = address(controller)
                .call(abi.encodeCall(PurposeController.send, (vault, RECIPIENT, 10)));
            assertFalse(success);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            for (uint256 j; j < logs.length; ++j) {
                assertFalse(logs[j].emitter == address(vault));
            }
            assertEq(vault.grossOutflow(), 0);
            assertEq(vault.rollingOutflow(), 0);
            assertEq(token.balanceOf(address(vault)), vaultBefore);
            assertEq(token.balanceOf(RECIPIENT), recipientBefore);
        }
        token.setMode(PurposeToken.Mode.Normal);
        controller.send(vault, RECIPIENT, 10); // The lock also rolled back.
        assertEq(vault.grossOutflow(), 10);
    }

    function testMalformedReturnAndReentryAreAtomic() public {
        MalformedPurposeToken malformed = new MalformedPurposeToken();
        PurposeReserveVault malformedVault = new PurposeReserveVault(
            IERC20(address(malformed)), address(controller), PURPOSE, 100, 10, 100
        );
        malformed.mint(address(malformedVault), 100);
        (bool success,) = address(controller)
            .call(abi.encodeCall(PurposeController.send, (malformedVault, RECIPIENT, 1)));
        assertFalse(success);
        assertEq(malformedVault.grossOutflow(), 0);
        assertEq(malformed.balanceOf(address(malformedVault)), 100);

        token.setReentry(controller, vault);
        token.setMode(PurposeToken.Mode.Reenter);
        (success,) =
            address(controller).call(abi.encodeCall(PurposeController.send, (vault, RECIPIENT, 1)));
        assertFalse(success);
        assertEq(vault.grossOutflow(), 0);
        token.setMode(PurposeToken.Mode.Normal);
        controller.send(vault, RECIPIENT, 1);
        assertEq(vault.grossOutflow(), 1);
    }
}
