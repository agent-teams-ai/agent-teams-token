// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import { AGTMAIToken } from "../token-genesis/AGTMAIToken.sol";
import { GrantAccounting } from "./GrantAccounting.sol";
import { GrantVault } from "./GrantVault.sol";
import { GrantCalendar } from "./GrantCalendar.sol";

/// @notice One-shot funding of the immutable 3% founder entitlement using existing grant custody.
/// @dev No replacement, cancellation, sweep or discretionary grant-creation API. The token must
/// be the verified fixed-supply genesis token; calendar instants are enforced at construction.
contract FounderGrantReserve {
    error InvalidFounderAllocation();
    error ApprovalFailed();

    AGTMAIToken public immutable TOKEN;
    GrantVault public immutable VAULT;

    constructor(
        AGTMAIToken token,
        address beneficiary,
        address controller,
        GrantAccounting.Terms memory terms
    ) {
        uint256 supply = token.INITIAL_SUPPLY();
        if (
            supply == 0 || supply % 100 != 0 || terms.allocation != supply / 100 * 3
                || terms.kind != GrantAccounting.Kind.Founder
        ) revert InvalidFounderAllocation();
        GrantCalendar.validate(terms.start, terms.cliff, terms.end);
        TOKEN = token;
        VAULT = new GrantVault(token, beneficiary, address(this), controller, terms);
    }

    /// @notice Anyone can activate the already-bound grant once inventory arrives, by its start.
    /// @dev GrantVault enforces one-shot activation and immutable destination and terms.
    function fund() external {
        if (!TOKEN.approve(address(VAULT), VAULT.grant().terms.allocation)) {
            revert ApprovalFailed();
        }
        VAULT.fund();
        if (!TOKEN.approve(address(VAULT), 0)) revert ApprovalFailed();
    }
}
