// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import { TestBase } from "../../TestBase.sol";
import {
    PurposeReserveVault
} from "../../../src/features/purpose-reserves/PurposeReserveVault.sol";
import { AGTMAIToken } from "../../../src/features/token-genesis/AGTMAIToken.sol";
import { PurposeController } from "../../features/purpose-reserves/PurposeReserveVault.t.sol";

/// @dev An append-only independent list is the oracle; no checkpoint logic is reused.
contract PurposeOutflowHandler is TestBase {
    struct TransferRecord {
        uint256 time;
        uint256 amount;
        uint256 bucket;
    }

    TransferRecord[] private records;
    AGTMAIToken public immutable TOKEN;
    PurposeController public immutable CONTROLLER;
    PurposeReserveVault public immutable FIRST;
    PurposeReserveVault public immutable SECOND;
    uint256 public currentTime = 100;
    uint256 public attempts;
    uint256 public successes;

    constructor() {
        AGTMAIToken.Allocation[] memory allocations = new AGTMAIToken.Allocation[](1);
        allocations[0] = AGTMAIToken.Allocation(bytes32("local-test"), address(this), 50_000);
        TOKEN = new AGTMAIToken(50_000, allocations);
        CONTROLLER = new PurposeController();
        FIRST =
            new PurposeReserveVault(TOKEN, address(CONTROLLER), keccak256("users"), 100, 17, 100);
        SECOND = new PurposeReserveVault(
            TOKEN, address(CONTROLLER), keccak256("operations"), 100, 17, 100
        );
        assertTrue(TOKEN.transfer(address(FIRST), 20_000));
        assertTrue(TOKEN.transfer(address(SECOND), 20_000));
        vm.warp(currentTime);
    }

    // Detects wrongful acceptance and rejection independently of the vault's
    // checkpoint search, while the append-only ledger checks resulting state.
    function step(uint8 elapsed, uint8 requested, uint8 bucketSeed, bool donate) external {
        currentTime += elapsed % 5;
        vm.warp(currentTime);
        uint256 bucket = bucketSeed % 2;
        PurposeReserveVault selected = bucket == 0 ? FIRST : SECOND;
        uint256 amount = attempts == 0 ? 1 : uint256(requested) % 110 + 1;
        if (donate) assertTrue(TOKEN.transfer(address(selected), 1));
        uint256 oldGross = selected.grossOutflow();
        uint256 oldInventory = TOKEN.balanceOf(address(selected));
        uint256 expectedRolling;
        for (uint256 i; i < records.length; ++i) {
            TransferRecord memory record = records[i];
            if (record.bucket == bucket && record.time + 17 > currentTime) {
                expectedRolling += record.amount;
            }
        }
        address recipient = address(0xBEEF);
        bool expectedSuccess = currentTime >= 100 && recipient != address(0)
            && recipient != address(selected) && recipient != address(TOKEN)
            && expectedRolling + amount <= 100 && amount <= oldInventory;
        (bool success,) = address(CONTROLLER)
            .call(abi.encodeCall(PurposeController.send, (selected, recipient, amount)));
        assertEq(success ? 1 : 0, expectedSuccess ? 1 : 0);
        ++attempts;
        if (success) {
            records.push(TransferRecord(currentTime, amount, bucket));
            ++successes;
            assertEq(selected.grossOutflow(), oldGross + amount);
            assertEq(TOKEN.balanceOf(address(selected)), oldInventory - amount);
        } else {
            assertEq(selected.grossOutflow(), oldGross);
            assertEq(TOKEN.balanceOf(address(selected)), oldInventory);
        }
        assertState();
    }

    function assertState() public view {
        uint256[2] memory gross;
        uint256[2] memory rolling;
        for (uint256 i; i < records.length; ++i) {
            TransferRecord memory record = records[i];
            gross[record.bucket] += record.amount;
            if (record.time + 17 > currentTime) rolling[record.bucket] += record.amount;
        }
        assertEq(FIRST.grossOutflow(), gross[0]);
        assertEq(SECOND.grossOutflow(), gross[1]);
        assertEq(FIRST.rollingOutflow(), rolling[0]);
        assertEq(SECOND.rollingOutflow(), rolling[1]);
        assertTrue(rolling[0] <= 100 && rolling[1] <= 100);
        assertEq(TOKEN.balanceOf(address(0xBEEF)), gross[0] + gross[1]);
        assertEq(
            TOKEN.balanceOf(address(this)) + TOKEN.balanceOf(address(FIRST))
                + TOKEN.balanceOf(address(SECOND)) + TOKEN.balanceOf(address(0xBEEF)),
            TOKEN.totalSupply()
        );
        assertEq(
            FIRST.availableOutflow(), _minimum(100 - rolling[0], TOKEN.balanceOf(address(FIRST)))
        );
        assertEq(
            SECOND.availableOutflow(), _minimum(100 - rolling[1], TOKEN.balanceOf(address(SECOND)))
        );
    }

    function _minimum(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}

contract PurposeReserveVaultInvariantTest is TestBase {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    PurposeOutflowHandler private handler;

    function setUp() public {
        handler = new PurposeOutflowHandler();
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory targeted) {
        targeted = new FuzzSelector[](1);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = PurposeOutflowHandler.step.selector;
        targeted[0] = FuzzSelector(address(handler), selectors);
    }

    function invariantIndependentRollingLedgerAndIsolation() public view {
        handler.assertState();
    }

    function afterInvariant() public view {
        assertTrue(handler.attempts() > 0);
        assertTrue(handler.successes() > 0);
    }
}
