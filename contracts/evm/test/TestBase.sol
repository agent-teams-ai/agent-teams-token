// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

interface Vm {
    function assume(bool condition) external;
    function chainId(uint256 newChainId) external;
    function expectEmit(bool, bool, bool, bool) external;
    function expectRevert(bytes4 selector) external;
    function expectPartialRevert(bytes4 selector) external;
    function expectRevert(bytes calldata revertData) external;
    function prank(address sender) external;
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error AssertionFailed();
    error AssertionEqUint(uint256 left, uint256 right);
    error AssertionEqBytes32(bytes32 left, bytes32 right);
    error AssertionEqAddress(address left, address right);

    function assertTrue(bool value) internal pure {
        if (!value) revert AssertionFailed();
    }

    function assertFalse(bool value) internal pure {
        if (value) revert AssertionFailed();
    }

    function assertEq(uint256 left, uint256 right) internal pure {
        if (left != right) revert AssertionEqUint(left, right);
    }

    function assertEq(bytes32 left, bytes32 right) internal pure {
        if (left != right) revert AssertionEqBytes32(left, right);
    }

    function assertEq(address left, address right) internal pure {
        if (left != right) revert AssertionEqAddress(left, right);
    }

    function assertEq(string memory left, string memory right) internal pure {
        if (keccak256(bytes(left)) != keccak256(bytes(right))) revert AssertionFailed();
    }

    function bound(uint256 value, uint256 minimum, uint256 maximum)
        internal
        pure
        returns (uint256)
    {
        if (minimum > maximum) revert AssertionFailed();
        if (minimum == 0 && maximum == type(uint256).max) return value;
        uint256 size = maximum - minimum + 1;
        if (size == 0) return value;
        return minimum + (value % size);
    }
}
