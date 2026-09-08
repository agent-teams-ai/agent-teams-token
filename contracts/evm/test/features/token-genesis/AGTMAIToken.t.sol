// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import { AGTMAIToken } from "../../../src/features/token-genesis/AGTMAIToken.sol";
import { TestBase } from "../../TestBase.sol";

contract TokenFactory {
    function deploy(uint256 supply, AGTMAIToken.Allocation[] memory allocations)
        external
        returns (AGTMAIToken)
    {
        return new AGTMAIToken(supply, allocations);
    }
}

contract AGTMAITokenTest is TestBase {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event GenesisAllocation(bytes32 indexed id, address indexed recipient, uint256 amount);

    uint256 internal constant SUPPLY = 1_000_000_000_000;
    address internal constant ALPHA = address(0x1001);
    address internal constant BETA = address(0x1002);
    address internal constant GAMMA = address(0x1003);
    bytes32 internal constant EXPECTED_HASH =
        0xa2ae1f9ed4f241e79b92a6e11417a47c9ae54b6f4740e3b71056d3c8811c106f;

    function testFixtureIdentitySupplyHashEventsAndBalances() public {
        vm.chainId(31_337);
        AGTMAIToken.Allocation[] memory allocations = fixture();
        for (uint256 i = 0; i < allocations.length; ++i) {
            vm.expectEmit(true, true, false, true);
            emit Transfer(address(0), allocations[i].recipient, allocations[i].amount);
            vm.expectEmit(true, true, false, true);
            emit GenesisAllocation(
                allocations[i].id, allocations[i].recipient, allocations[i].amount
            );
        }
        AGTMAIToken token = new AGTMAIToken(SUPPLY, allocations);

        assertEq(token.name(), "Agent Teams AI");
        assertEq(token.symbol(), "AGTMAI");
        assertEq(token.decimals(), 9);
        assertEq(token.INITIAL_SUPPLY(), SUPPLY);
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.GENESIS_ALLOCATION_HASH(), EXPECTED_HASH);
        assertEq(token.MAX_GENESIS_ALLOCATIONS(), 32);
        assertEq(token.balanceOf(ALPHA), 400_000_000_000);
        assertEq(token.balanceOf(BETA), 350_000_000_000);
        assertEq(token.balanceOf(GAMMA), 250_000_000_000);
        assertEq(token.balanceOf(address(this)), 0);
    }

    function testCommittedRawAbiBytesAndHash() public pure {
        AGTMAIToken.Allocation[] memory allocations = fixture();
        bytes memory actual = abi.encode(
            bytes32(0x4147544d41495f414c4c4f434154494f4e5f5631000000000000000000000000),
            uint256(31_337),
            keccak256("Agent Teams AI"),
            keccak256("AGTMAI"),
            uint8(9),
            SUPPLY,
            allocations
        );
        bytes memory expected =
            hex"4147544d41495f414c4c4f434154494f4e5f56310000000000000000000000000000000000000000000000000000000000000000000000000000000000007a69c9c783aec84b864926fc3f1a31f0eb38007b88e0302ca51c49409664d54679e7b615d1628f56132d749a4b7665073bd2fc455bf558d529109f96e1d9741f1dc50000000000000000000000000000000000000000000000000000000000000009000000000000000000000000000000000000000000000000000000e8d4a5100000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000003746573742d616c7068610000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010010000000000000000000000000000000000000000000000000000005d21dba000746573742d6265746100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001002000000000000000000000000000000000000000000000000000000517da02c00746573742d67616d6d610000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010030000000000000000000000000000000000000000000000000000003a35294400";
        assertEq(actual.length, 544);
        assertEq(keccak256(actual), keccak256(expected));
        assertEq(keccak256(actual), EXPECTED_HASH);
    }

    function testRevertEmptyAllocations() public {
        AGTMAIToken.Allocation[] memory allocations = new AGTMAIToken.Allocation[](0);
        vm.expectRevert(AGTMAIToken.EmptyGenesisAllocations.selector);
        new AGTMAIToken(1, allocations);
    }

    function testRevertMoreThan32Allocations() public {
        AGTMAIToken.Allocation[] memory allocations = sequential(33);
        vm.expectRevert(
            abi.encodeWithSelector(AGTMAIToken.TooManyGenesisAllocations.selector, 33, 32)
        );
        new AGTMAIToken(33, allocations);
    }

    function testWorstCase32AllocationsFitsLocalBlockAndCodeLimits() public {
        uint256 gasBefore = gasleft();
        AGTMAIToken token = new AGTMAIToken(32, sequential(32));
        uint256 deploymentGas = gasBefore - gasleft();
        assertEq(token.totalSupply(), 32);
        assertTrue(deploymentGas < 30_000_000);
        assertTrue(address(token).code.length <= 24_576);
        assertTrue(type(AGTMAIToken).creationCode.length <= 49_152);
    }

    function testRevertZeroId() public {
        AGTMAIToken.Allocation[] memory allocations = one(bytes32(0), ALPHA, 1);
        vm.expectRevert(abi.encodeWithSelector(AGTMAIToken.ZeroAllocationId.selector, 0));
        new AGTMAIToken(1, allocations);
    }

    function testRevertNonIncreasingAndDuplicateIds() public {
        AGTMAIToken.Allocation[] memory allocations = sequential(2);
        allocations[1].id = allocations[0].id;
        vm.expectPartialRevert(AGTMAIToken.AllocationIdsNotStrictlyIncreasing.selector);
        new AGTMAIToken(2, allocations);
        allocations[1].id = bytes32(uint256(1));
        allocations[0].id = bytes32(uint256(2));
        vm.expectPartialRevert(AGTMAIToken.AllocationIdsNotStrictlyIncreasing.selector);
        new AGTMAIToken(2, allocations);
    }

    function testRevertZeroAndDuplicateRecipients() public {
        AGTMAIToken.Allocation[] memory allocations = sequential(2);
        allocations[0].recipient = address(0);
        vm.expectRevert(abi.encodeWithSelector(AGTMAIToken.ZeroAllocationRecipient.selector, 0));
        new AGTMAIToken(2, allocations);
        allocations[0].recipient = ALPHA;
        allocations[1].recipient = ALPHA;
        vm.expectRevert(
            abi.encodeWithSelector(AGTMAIToken.DuplicateAllocationRecipient.selector, 1, ALPHA)
        );
        new AGTMAIToken(2, allocations);
    }

    function testRevertZeroAmountUnderAndOverSum() public {
        AGTMAIToken.Allocation[] memory allocations = one(bytes32(uint256(1)), ALPHA, 0);
        vm.expectRevert(abi.encodeWithSelector(AGTMAIToken.ZeroAllocationAmount.selector, 0));
        new AGTMAIToken(1, allocations);
        allocations[0].amount = 9;
        vm.expectRevert(abi.encodeWithSelector(AGTMAIToken.InitialSupplyMismatch.selector, 10, 9));
        new AGTMAIToken(10, allocations);
        vm.expectRevert(abi.encodeWithSelector(AGTMAIToken.InitialSupplyMismatch.selector, 8, 9));
        new AGTMAIToken(8, allocations);
    }

    function testRevertAllocationSumOverflow() public {
        AGTMAIToken.Allocation[] memory allocations = sequential(2);
        allocations[0].amount = type(uint256).max;
        allocations[1].amount = 1;
        vm.expectRevert(abi.encodeWithSelector(AGTMAIToken.AllocationSumOverflow.selector, 1));
        new AGTMAIToken(0, allocations);
    }

    function testPermutationAndUnsortedFixtureRevert() public {
        AGTMAIToken.Allocation[] memory allocations = fixture();
        (allocations[0], allocations[1]) = (allocations[1], allocations[0]);
        vm.expectPartialRevert(AGTMAIToken.AllocationIdsNotStrictlyIncreasing.selector);
        new AGTMAIToken(SUPPLY, allocations);
    }

    function testFuzzSingleAllocation(uint256 amount, address recipient, bytes32 id) public {
        amount = bound(amount, 1, type(uint256).max);
        vm.assume(recipient != address(0));
        vm.assume(id != bytes32(0));
        AGTMAIToken token = new AGTMAIToken(amount, one(id, recipient, amount));
        assertEq(token.totalSupply(), amount);
        assertEq(token.balanceOf(recipient), amount);
    }

    function testFuzzTwoAllocationExactSum(uint128 firstAmount, uint128 secondAmount) public {
        vm.assume(firstAmount != 0 && secondAmount != 0);
        AGTMAIToken.Allocation[] memory allocations = new AGTMAIToken.Allocation[](2);
        allocations[0] = AGTMAIToken.Allocation(bytes32(uint256(1)), ALPHA, firstAmount);
        allocations[1] = AGTMAIToken.Allocation(bytes32(uint256(2)), BETA, secondAmount);
        uint256 expectedSupply = uint256(firstAmount) + uint256(secondAmount);
        AGTMAIToken token = new AGTMAIToken(expectedSupply, allocations);
        assertEq(token.totalSupply(), expectedSupply);
        assertEq(token.balanceOf(ALPHA) + token.balanceOf(BETA), expectedSupply);
    }

    function testFuzzExactSumMismatch(uint128 firstAmount, uint128 secondAmount, bool over) public {
        vm.assume(firstAmount != 0 && secondAmount != 0);
        AGTMAIToken.Allocation[] memory allocations = new AGTMAIToken.Allocation[](2);
        allocations[0] = AGTMAIToken.Allocation(bytes32(uint256(1)), ALPHA, firstAmount);
        allocations[1] = AGTMAIToken.Allocation(bytes32(uint256(2)), BETA, secondAmount);
        uint256 sum = uint256(firstAmount) + uint256(secondAmount);
        uint256 declaredSupply = over ? sum + 1 : sum - 1;
        vm.expectRevert(
            abi.encodeWithSelector(AGTMAIToken.InitialSupplyMismatch.selector, declaredSupply, sum)
        );
        new AGTMAIToken(declaredSupply, allocations);
    }

    function testTransferApproveAndTransferFrom() public {
        AGTMAIToken token = new AGTMAIToken(SUPPLY, fixture());
        vm.prank(ALPHA);
        assertTrue(token.transfer(BETA, 100));
        vm.prank(BETA);
        assertTrue(token.approve(GAMMA, 75));
        assertEq(token.allowance(BETA, GAMMA), 75);
        vm.prank(GAMMA);
        assertTrue(token.transferFrom(BETA, ALPHA, 75));
        assertEq(token.allowance(BETA, GAMMA), 0);
        assertEq(token.balanceOf(ALPHA), 399_999_999_975);
        assertEq(token.balanceOf(BETA), 350_000_000_025);
    }

    function testDeployerAndFactoryReceiveNoUnexplainedBalance() public {
        TokenFactory factory = new TokenFactory();
        AGTMAIToken token = factory.deploy(SUPPLY, fixture());
        assertEq(token.balanceOf(address(this)), 0);
        assertEq(token.balanceOf(address(factory)), 0);
    }

    function testNoFallbackReceiveOrPrivilegedDispatch() public {
        AGTMAIToken token = new AGTMAIToken(SUPPLY, fixture());
        (bool emptySuccess,) = address(token).call("");
        assertFalse(emptySuccess);
        (bool unknownSuccess,) = address(token).call(hex"deadbeef");
        assertFalse(unknownSuccess);
        (bool ownerSuccess,) = address(token).call(abi.encodeWithSignature("owner()"));
        assertFalse(ownerSuccess);
        (bool mintSuccess,) =
            address(token).call(abi.encodeWithSignature("mint(address,uint256)", ALPHA, 1));
        assertFalse(mintSuccess);
        assertEq(token.totalSupply(), SUPPLY);
    }

    function testFuzzArbitraryCalldataHasNoUnknownDispatch(bytes4 selector, bytes calldata tail)
        public
    {
        vm.assume(selector != bytes4(keccak256("GENESIS_ALLOCATION_HASH()")));
        vm.assume(selector != bytes4(keccak256("INITIAL_SUPPLY()")));
        vm.assume(selector != bytes4(keccak256("MAX_GENESIS_ALLOCATIONS()")));
        vm.assume(selector != bytes4(keccak256("allowance(address,address)")));
        vm.assume(selector != bytes4(keccak256("approve(address,uint256)")));
        vm.assume(selector != bytes4(keccak256("balanceOf(address)")));
        vm.assume(selector != bytes4(keccak256("decimals()")));
        vm.assume(selector != bytes4(keccak256("name()")));
        vm.assume(selector != bytes4(keccak256("symbol()")));
        vm.assume(selector != bytes4(keccak256("totalSupply()")));
        vm.assume(selector != bytes4(keccak256("transfer(address,uint256)")));
        vm.assume(selector != bytes4(keccak256("transferFrom(address,address,uint256)")));
        AGTMAIToken token = new AGTMAIToken(SUPPLY, fixture());
        (bool success,) = address(token).call(bytes.concat(selector, tail));
        assertFalse(success);
        assertEq(token.totalSupply(), SUPPLY);
    }

    function fixture() internal pure returns (AGTMAIToken.Allocation[] memory allocations) {
        allocations = new AGTMAIToken.Allocation[](3);
        allocations[0] = AGTMAIToken.Allocation(bytes32("test-alpha"), ALPHA, 400_000_000_000);
        allocations[1] = AGTMAIToken.Allocation(bytes32("test-beta"), BETA, 350_000_000_000);
        allocations[2] = AGTMAIToken.Allocation(bytes32("test-gamma"), GAMMA, 250_000_000_000);
    }

    function one(bytes32 id, address recipient, uint256 amount)
        internal
        pure
        returns (AGTMAIToken.Allocation[] memory allocations)
    {
        allocations = new AGTMAIToken.Allocation[](1);
        allocations[0] = AGTMAIToken.Allocation(id, recipient, amount);
    }

    function sequential(uint256 count)
        internal
        pure
        returns (AGTMAIToken.Allocation[] memory allocations)
    {
        allocations = new AGTMAIToken.Allocation[](count);
        for (uint256 i = 0; i < count; ++i) {
            allocations[i] = AGTMAIToken.Allocation(bytes32(i + 1), address(uint160(0x1000 + i)), 1);
        }
    }
}
