// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

// Test-only fixture: never copied into the production closure.
contract Vulnerable {
    function destroy(address payable recipient) external {
        selfdestruct(recipient);
    }
}
