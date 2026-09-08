// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import { AGTMAIToken } from "./AGTMAIToken.sol";

/// @notice Fixed-supply token with an immutable initial CCIP registration administrator.
/// @dev The registry owns subsequent pool administration. This getter grants no token mint power.
contract AGTMAICCIPToken is AGTMAIToken {
    error ZeroCCIPAdmin();

    address private immutable INITIAL_CCIP_ADMIN;

    constructor(uint256 initialSupply, Allocation[] memory sortedAllocations, address ccipAdmin)
        AGTMAIToken(initialSupply, sortedAllocations)
    {
        if (ccipAdmin == address(0)) revert ZeroCCIPAdmin();
        INITIAL_CCIP_ADMIN = ccipAdmin;
    }

    function getCCIPAdmin() external view returns (address) {
        return INITIAL_CCIP_ADMIN;
    }
}
