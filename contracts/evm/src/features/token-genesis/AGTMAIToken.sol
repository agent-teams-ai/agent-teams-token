// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Immutable local candidate core. The allocation hash proves integrity, not approval.
contract AGTMAIToken is ERC20 {
    struct Allocation {
        bytes32 id;
        address recipient;
        uint256 amount;
    }

    error EmptyGenesisAllocations();
    error TooManyGenesisAllocations(uint256 provided, uint256 maximum);
    error ZeroAllocationId(uint256 index);
    error AllocationIdsNotStrictlyIncreasing(uint256 index, bytes32 previousId, bytes32 currentId);
    error ZeroAllocationRecipient(uint256 index);
    error DuplicateAllocationRecipient(uint256 index, address recipient);
    error ZeroAllocationAmount(uint256 index);
    error AllocationSumOverflow(uint256 index);
    error InitialSupplyMismatch(uint256 expected, uint256 actual);

    event GenesisAllocation(bytes32 indexed id, address indexed recipient, uint256 amount);

    uint256 public constant MAX_GENESIS_ALLOCATIONS = 32;
    uint256 public immutable INITIAL_SUPPLY;
    bytes32 public immutable GENESIS_ALLOCATION_HASH;

    bytes32 internal constant ALLOCATION_DOMAIN =
        0x4147544d41495f414c4c4f434154494f4e5f5631000000000000000000000000;
    bytes32 internal constant NAME_HASH = keccak256("Agent Teams AI");
    bytes32 internal constant SYMBOL_HASH = keccak256("AGTMAI");
    uint8 internal constant TOKEN_DECIMALS = 9;

    constructor(uint256 initialSupply, Allocation[] memory sortedAllocations)
        ERC20("Agent Teams AI", "AGTMAI")
    {
        uint256 count = sortedAllocations.length;
        if (count == 0) revert EmptyGenesisAllocations();
        if (count > MAX_GENESIS_ALLOCATIONS) {
            revert TooManyGenesisAllocations(count, MAX_GENESIS_ALLOCATIONS);
        }

        uint256 sum = 0;
        bytes32 previousId = bytes32(0);
        for (uint256 i = 0; i < count; ++i) {
            Allocation memory allocation = sortedAllocations[i];
            if (allocation.id == bytes32(0)) revert ZeroAllocationId(i);
            if (i != 0 && uint256(allocation.id) <= uint256(previousId)) {
                revert AllocationIdsNotStrictlyIncreasing(i, previousId, allocation.id);
            }
            if (allocation.recipient == address(0)) revert ZeroAllocationRecipient(i);
            if (allocation.amount == 0) revert ZeroAllocationAmount(i);
            for (uint256 j = 0; j < i; ++j) {
                if (sortedAllocations[j].recipient == allocation.recipient) {
                    revert DuplicateAllocationRecipient(i, allocation.recipient);
                }
            }
            unchecked {
                uint256 nextSum = sum + allocation.amount;
                if (nextSum < sum) revert AllocationSumOverflow(i);
                sum = nextSum;
            }
            previousId = allocation.id;
        }
        if (sum != initialSupply) revert InitialSupplyMismatch(initialSupply, sum);

        INITIAL_SUPPLY = initialSupply;
        GENESIS_ALLOCATION_HASH = keccak256(
            abi.encode(
                ALLOCATION_DOMAIN,
                block.chainid,
                NAME_HASH,
                SYMBOL_HASH,
                TOKEN_DECIMALS,
                initialSupply,
                sortedAllocations
            )
        );

        for (uint256 i = 0; i < count; ++i) {
            Allocation memory allocation = sortedAllocations[i];
            _mint(allocation.recipient, allocation.amount);
            emit GenesisAllocation(allocation.id, allocation.recipient, allocation.amount);
        }
    }

    function decimals() public pure override returns (uint8) {
        return TOKEN_DECIMALS;
    }
}
