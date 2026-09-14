// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import { GrantAccounting } from "../../../src/features/contributor-grants/GrantAccounting.sol";

/// @dev TEST ONLY. No token custody, authorization, beneficiary policy or production deployment
/// ABI. Multiple records deliberately share storage to test grant isolation. Initialization can
/// only
/// populate a fresh ID; it cannot replace terms or reset a cancelled grant.
contract GrantAccountingHarness {
    using GrantAccounting for GrantAccounting.Grant;

    mapping(uint256 => GrantAccounting.Grant) private grants;

    constructor(GrantAccounting.Terms memory terms) {
        grants[0].initialize(terms);
    }

    function initialize(uint256 id, GrantAccounting.Terms memory terms) external {
        grants[id].initialize(terms);
    }

    function curve(GrantAccounting.Terms memory terms, uint64 time)
        external
        pure
        returns (uint256)
    {
        return GrantAccounting.curve(terms, time);
    }

    function entitlement(uint256 id, uint64 time) external view returns (uint256) {
        return grants[id].entitlement(time);
    }

    function available(uint256 id, uint64 time) external view returns (uint256) {
        return grants[id].available(time);
    }

    function release(uint256 id, uint64 time, uint256 amount) external {
        grants[id].release(time, amount);
    }

    function cancel(uint256 id, uint64 time) external returns (uint256, bytes32) {
        return grants[id].cancel(time);
    }

    function snapshot(uint256 id) external view returns (GrantAccounting.Grant memory) {
        return grants[id];
    }
}
