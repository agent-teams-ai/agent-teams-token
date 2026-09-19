// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { GrantAccounting as G } from "../../../src/features/contributor-grants/GrantAccounting.sol";
import { GrantVault } from "../../../src/features/contributor-grants/GrantVault.sol";
import { AGTMAIToken } from "../../../src/features/token-genesis/AGTMAIToken.sol";
import { AGTMAICCIPToken } from "../../../src/features/token-genesis/AGTMAICCIPToken.sol";
import { TestBase, Vm } from "../../TestBase.sol";
import {
    ContractCaller,
    ControlledBeneficiary,
    HostileToken,
    VaultDeployer
} from "./GrantVaultFixtures.sol";

contract GrantVaultTest is TestBase {
    event GrantConfigured(
        address indexed token,
        address indexed beneficiary,
        address indexed originalReserve,
        address controller,
        G.Terms terms
    );
    event GrantFunded(uint256 amount, uint64 timestamp);
    event TokensReleased(uint256 amount, uint256 totalReleased, uint64 timestamp);
    event TeamGrantCancelled(
        bytes32 indexed originalPurpose, uint256 frozenEntitlement, uint256 refund, uint64 timestamp
    );

    uint64 internal constant START = 100;
    uint64 internal constant CLIFF = 112;
    uint64 internal constant END = 148;
    uint256 internal constant ALLOCATION = 360;
    address internal constant BENEFICIARY = address(0xBEEF);
    address internal constant RESERVE = address(0xCAFE);
    address internal constant CONTROLLER = address(0xC0DE);
    address internal constant STRANGER = address(0xBAD);

    HostileToken internal token;
    GrantVault internal vault;

    function setUp() public {
        vm.warp(START);
        token = new HostileToken();
        token.mint(RESERVE, ALLOCATION * 10);
        vault = _deploy(
            token, BENEFICIARY, RESERVE, CONTROLLER, _terms(ALLOCATION, G.Kind.TeamService)
        );
    }

    function _terms(uint256 amount, G.Kind kind) internal pure returns (G.Terms memory) {
        // Compressed schedule fixture, not calendar-month conversion.
        return G.Terms(amount, START, CLIFF, END, kind, bytes32("contributors"));
    }

    function _deploy(
        IERC20 asset,
        address beneficiary,
        address reserve,
        address controller,
        G.Terms memory terms
    ) internal returns (GrantVault) {
        return new GrantVault(asset, beneficiary, reserve, controller, terms);
    }

    function _approveAndFund(HostileToken asset, GrantVault target, address reserve) internal {
        uint256 amount = target.grant().terms.allocation;
        vm.prank(reserve);
        assertTrue(asset.approve(address(target), amount));
        vm.prank(reserve);
        target.fund();
    }

    function _fundReal(AGTMAIToken asset, GrantVault target, address reserve) internal {
        uint256 amount = target.grant().terms.allocation;
        vm.prank(reserve);
        assertTrue(asset.approve(address(target), amount));
        vm.prank(reserve);
        target.fund();
    }

    function _one(address recipient, uint256 amount)
        internal
        pure
        returns (AGTMAIToken.Allocation[] memory rows)
    {
        rows = new AGTMAIToken.Allocation[](1);
        rows[0] = AGTMAIToken.Allocation(bytes32("reserve"), recipient, amount);
    }

    function _digest(GrantVault target) internal view returns (bytes32) {
        return keccak256(abi.encode(target.grant()));
    }

    function _reverted(address sender, GrantVault target, bytes memory data)
        internal
        returns (bytes memory result)
    {
        vm.prank(sender);
        (bool ok, bytes memory returned) = address(target).call(data);
        assertFalse(ok);
        return returned;
    }

    function _deploymentReverted(
        IERC20 asset,
        address beneficiary,
        address reserve,
        address controller,
        G.Terms memory terms
    ) internal returns (bytes memory result) {
        VaultDeployer factory = new VaultDeployer();
        (bool ok, bytes memory returned) = address(factory)
            .call(
                abi.encodeCall(
                    VaultDeployer.deploy, (asset, beneficiary, reserve, controller, terms)
                )
            );
        assertFalse(ok);
        return returned;
    }

    function _assertError(bytes memory actual, bytes memory expected) internal pure {
        assertEq(keccak256(actual), keccak256(expected));
    }

    function testBindingsConfigurationEventAliasesAndNoReassignment() public {
        G.Terms memory terms = _terms(ALLOCATION, G.Kind.TeamService);
        vm.expectEmit(true, true, true, true);
        emit GrantConfigured(address(token), BENEFICIARY, RESERVE, CONTROLLER, terms);
        GrantVault configured = _deploy(token, BENEFICIARY, RESERVE, CONTROLLER, terms);
        assertEq(address(configured.TOKEN()), address(token));
        assertEq(configured.BENEFICIARY(), BENEFICIARY);
        assertEq(configured.ORIGINAL_RESERVE(), RESERVE);
        assertEq(configured.CONTROLLER(), CONTROLLER);
        assertEq(keccak256(abi.encode(configured.grant().terms)), keccak256(abi.encode(terms)));

        for (uint256 i; i < 4; ++i) {
            IERC20 asset = i == 0 ? IERC20(address(0)) : IERC20(address(token));
            address beneficiary = i == 1 ? address(0) : BENEFICIARY;
            address reserve = i == 2 ? address(0) : RESERVE;
            address controller = i == 3 ? address(0) : CONTROLLER;
            _assertError(
                _deploymentReverted(asset, beneficiary, reserve, controller, terms),
                abi.encodeWithSelector(GrantVault.InvalidBinding.selector)
            );
        }
        _assertError(
            _deploymentReverted(IERC20(address(0x1234)), BENEFICIARY, RESERVE, CONTROLLER, terms),
            abi.encodeWithSelector(GrantVault.InvalidBinding.selector)
        );

        address aliasRole = address(0xA11A5);
        token.mint(aliasRole, ALLOCATION);
        GrantVault aliased = _deploy(token, aliasRole, aliasRole, aliasRole, terms);
        _approveAndFund(token, aliased, aliasRole);
        vm.warp(END);
        vm.prank(aliasRole);
        assertEq(aliased.release(), ALLOCATION);

        bytes4[3] memory selectors = [
            bytes4(keccak256("setBeneficiary(address)")),
            bytes4(keccak256("setController(address)")),
            bytes4(keccak256("transferOwnership(address)"))
        ];
        for (uint256 i; i < selectors.length; ++i) {
            (bool ok,) = address(configured).call(abi.encodeWithSelector(selectors[i], STRANGER));
            assertFalse(ok);
        }
    }

    function testRejectsEverySelfBinding() public {
        for (uint256 i; i < 3; ++i) {
            VaultDeployer factory = new VaultDeployer();
            address predicted = address(
                uint160(uint256(keccak256(abi.encodePacked(hex"d694", address(factory), hex"01"))))
            );
            address beneficiary = i == 0 ? predicted : BENEFICIARY;
            address reserve = i == 1 ? predicted : RESERVE;
            address controller = i == 2 ? predicted : CONTROLLER;
            (bool ok, bytes memory result) = address(factory)
                .call(
                    abi.encodeCall(
                        VaultDeployer.deploy,
                        (
                            token,
                            beneficiary,
                            reserve,
                            controller,
                            _terms(ALLOCATION, G.Kind.TeamService)
                        )
                    )
                );
            assertFalse(ok);
            _assertError(result, abi.encodeWithSelector(GrantVault.InvalidBinding.selector));
        }
    }

    function testFundingAuthorizationFailuresDeadlineRetryAndDuplicate() public {
        _assertError(
            _reverted(BENEFICIARY, vault, abi.encodeCall(GrantVault.release, ())),
            abi.encodeWithSelector(GrantVault.NotFunded.selector)
        );
        _assertError(
            _reverted(CONTROLLER, vault, abi.encodeCall(GrantVault.cancel, ())),
            abi.encodeWithSelector(GrantVault.NotFunded.selector)
        );
        vm.prank(RESERVE);
        assertTrue(token.approve(address(vault), ALLOCATION));
        bytes memory unauthorized = _reverted(STRANGER, vault, abi.encodeCall(GrantVault.fund, ()));
        _assertError(
            unauthorized,
            abi.encodeWithSelector(GrantVault.Unauthorized.selector, STRANGER, RESERVE)
        );
        assertFalse(vault.funded());
        assertEq(token.balanceOf(address(vault)), 0);

        HostileToken insufficient = new HostileToken();
        insufficient.mint(RESERVE, ALLOCATION - 1);
        GrantVault noBalance = _deploy(
            insufficient, BENEFICIARY, RESERVE, CONTROLLER, _terms(ALLOCATION, G.Kind.TeamService)
        );
        vm.prank(RESERVE);
        assertTrue(insufficient.approve(address(noBalance), ALLOCATION));
        _reverted(RESERVE, noBalance, abi.encodeCall(GrantVault.fund, ()));
        assertFalse(noBalance.funded());

        HostileToken retryToken = new HostileToken();
        retryToken.mint(RESERVE, ALLOCATION);
        GrantVault retry = _deploy(
            retryToken, BENEFICIARY, RESERVE, CONTROLLER, _terms(ALLOCATION, G.Kind.TeamService)
        );
        _reverted(RESERVE, retry, abi.encodeCall(GrantVault.fund, ()));
        assertFalse(retry.funded());
        _approveAndFund(retryToken, retry, RESERVE);
        assertTrue(retry.funded());
        _assertError(
            _reverted(RESERVE, retry, abi.encodeCall(GrantVault.fund, ())),
            abi.encodeWithSelector(GrantVault.AlreadyFunded.selector)
        );

        HostileToken lateToken = new HostileToken();
        lateToken.mint(RESERVE, ALLOCATION * 2);
        GrantVault atBoundary = _deploy(
            lateToken, BENEFICIARY, RESERVE, CONTROLLER, _terms(ALLOCATION, G.Kind.TeamService)
        );
        _approveAndFund(lateToken, atBoundary, RESERVE);
        GrantVault late = _deploy(
            lateToken, BENEFICIARY, RESERVE, CONTROLLER, _terms(ALLOCATION, G.Kind.TeamService)
        );
        vm.prank(RESERVE);
        assertTrue(lateToken.approve(address(late), ALLOCATION));
        vm.warp(START + 1);
        _assertError(
            _reverted(RESERVE, late, abi.encodeCall(GrantVault.fund, ())),
            abi.encodeWithSelector(GrantVault.StartInPast.selector, START, START + 1)
        );
    }

    function testRealTokenTeamRegressionDonationsAndEvents() public {
        AGTMAIToken real = new AGTMAIToken(ALLOCATION + 12, _one(RESERVE, ALLOCATION + 12));
        GrantVault target =
            _deploy(real, BENEFICIARY, RESERVE, CONTROLLER, _terms(ALLOCATION, G.Kind.TeamService));
        vm.prank(RESERVE);
        assertTrue(real.transfer(address(target), 7));
        assertFalse(target.funded());
        assertEq(target.available(), 0);
        uint256 supply = real.totalSupply();
        vm.prank(RESERVE);
        assertTrue(real.approve(address(target), ALLOCATION));
        vm.expectEmit(false, false, false, true);
        emit GrantFunded(ALLOCATION, START);
        vm.prank(RESERVE);
        target.fund();
        assertEq(real.balanceOf(address(target)), ALLOCATION + 7);

        vm.prank(RESERVE);
        assertTrue(real.transfer(address(target), 5));
        _assertError(
            _reverted(STRANGER, target, abi.encodeCall(GrantVault.cancel, ())),
            abi.encodeWithSelector(GrantVault.Unauthorized.selector, STRANGER, CONTROLLER)
        );
        vm.warp(118);
        vm.expectEmit(false, false, false, true);
        emit TokensReleased(60, 60, 118);
        vm.prank(BENEFICIARY);
        assertEq(target.release(), 60);
        vm.warp(130);
        vm.expectEmit(true, false, false, true);
        emit TeamGrantCancelled(bytes32("contributors"), 180, 180, 130);
        vm.prank(CONTROLLER);
        assertEq(target.cancel(), 180);
        vm.prank(RESERVE);
        assertTrue(real.transfer(address(target), 1));
        assertEq(real.balanceOf(RESERVE), 179);
        assertEq(target.available(), 120);
        vm.warp(END + 100);
        vm.prank(BENEFICIARY);
        assertEq(target.release(), 120);
        assertEq(real.balanceOf(BENEFICIARY), 180);
        assertEq(real.balanceOf(address(target)), 13);
        assertEq(real.totalSupply(), supply);
    }

    function testFounderAlwaysNonCancellableAndReleasesIncrementally() public {
        AGTMAIToken real = new AGTMAIToken(ALLOCATION, _one(RESERVE, ALLOCATION));
        GrantVault founder =
            _deploy(real, BENEFICIARY, RESERVE, CONTROLLER, _terms(ALLOCATION, G.Kind.Founder));
        _fundReal(real, founder, RESERVE);
        uint64[3] memory times = [uint64(START), 130, END];
        for (uint256 i; i < times.length; ++i) {
            vm.warp(times[i]);
            bytes32 beforeState = _digest(founder);
            _assertError(
                _reverted(CONTROLLER, founder, abi.encodeCall(GrantVault.cancel, ())),
                abi.encodeWithSelector(G.FounderCannotCancel.selector)
            );
            assertEq(_digest(founder), beforeState);
        }
        vm.warp(130);
        vm.prank(BENEFICIARY);
        assertEq(founder.release(), 180);
        vm.warp(END);
        vm.prank(BENEFICIARY);
        assertEq(founder.release(), 180);
        _assertError(
            _reverted(CONTROLLER, founder, abi.encodeCall(GrantVault.cancel, ())),
            abi.encodeWithSelector(G.FounderCannotCancel.selector)
        );
        assertEq(real.balanceOf(BENEFICIARY), ALLOCATION);
    }

    function testCCIPTokenCustodyAndContractCallerCompatibility() public {
        ContractCaller caller = new ContractCaller();
        AGTMAICCIPToken real =
            new AGTMAICCIPToken(ALLOCATION, _one(address(caller), ALLOCATION), address(0xCC1F));
        GrantVault target = _deploy(
            real,
            BENEFICIARY,
            address(caller),
            address(caller),
            _terms(ALLOCATION, G.Kind.TeamService)
        );
        caller.approve(real, address(target), ALLOCATION);
        caller.fund(target);
        vm.warp(130);
        assertEq(caller.cancel(target), 180);
        vm.prank(BENEFICIARY);
        assertEq(target.release(), 180);
        assertEq(real.balanceOf(address(caller)), 180);
        assertEq(real.balanceOf(BENEFICIARY), 180);
        assertEq(real.totalSupply(), ALLOCATION);
    }

    function testReleaseBoundariesAuthorizationAndFixedDestination() public {
        _approveAndFund(token, vault, RESERVE);
        _assertError(
            _reverted(STRANGER, vault, abi.encodeCall(GrantVault.release, ())),
            abi.encodeWithSelector(GrantVault.Unauthorized.selector, STRANGER, BENEFICIARY)
        );
        vm.warp(CLIFF);
        _assertError(
            _reverted(BENEFICIARY, vault, abi.encodeCall(GrantVault.release, ())),
            abi.encodeWithSelector(G.InvalidRelease.selector)
        );
        vm.warp(130);
        vm.prank(BENEFICIARY);
        assertEq(vault.release(), 180);
        _assertError(
            _reverted(BENEFICIARY, vault, abi.encodeCall(GrantVault.release, ())),
            abi.encodeWithSelector(G.InvalidRelease.selector)
        );
        vm.warp(END - 1);
        vm.prank(BENEFICIARY);
        assertEq(vault.release(), 170);
        vm.warp(END);
        vm.prank(BENEFICIARY);
        assertEq(vault.release(), 10);
        assertEq(token.balanceOf(BENEFICIARY), ALLOCATION);
        assertEq(token.balanceOf(STRANGER), 0);
    }

    function testTeamCancellationBoundariesDuplicateAndFrozenDebt() public {
        HostileToken futureToken = new HostileToken();
        futureToken.mint(RESERVE, ALLOCATION);
        G.Terms memory future = _terms(ALLOCATION, G.Kind.TeamService);
        future.start += 10;
        future.cliff += 10;
        future.end += 10;
        GrantVault beforeStart = _deploy(futureToken, BENEFICIARY, RESERVE, CONTROLLER, future);
        _approveAndFund(futureToken, beforeStart, RESERVE);
        vm.prank(CONTROLLER);
        assertEq(beforeStart.cancel(), ALLOCATION);

        uint64[4] memory times = [uint64(START), CLIFF, 130, END];
        uint256[4] memory vested = [uint256(0), 0, 180, ALLOCATION];
        for (uint256 i; i < times.length; ++i) {
            HostileToken asset = new HostileToken();
            asset.mint(RESERVE, ALLOCATION);
            GrantVault target = _deploy(
                asset, BENEFICIARY, RESERVE, CONTROLLER, _terms(ALLOCATION, G.Kind.TeamService)
            );
            _approveAndFund(asset, target, RESERVE);
            vm.warp(times[i]);
            vm.prank(CONTROLLER);
            assertEq(target.cancel(), ALLOCATION - vested[i]);
            assertEq(target.available(), vested[i]);
            _assertError(
                _reverted(CONTROLLER, target, abi.encodeCall(GrantVault.cancel, ())),
                abi.encodeWithSelector(G.AlreadyCancelled.selector)
            );
            if (vested[i] > 0) {
                vm.warp(END + 100);
                vm.prank(BENEFICIARY);
                assertEq(target.release(), vested[i]);
            }
            assertEq(asset.balanceOf(address(target)), 0);
            vm.warp(START);
        }

        HostileToken paid = new HostileToken();
        paid.mint(RESERVE, ALLOCATION);
        GrantVault exhausted =
            _deploy(paid, BENEFICIARY, RESERVE, CONTROLLER, _terms(ALLOCATION, G.Kind.TeamService));
        _approveAndFund(paid, exhausted, RESERVE);
        vm.warp(END);
        vm.prank(BENEFICIARY);
        exhausted.release();
        vm.prank(CONTROLLER);
        assertEq(exhausted.cancel(), 0);
    }

    function testSameTimestampOrderingProducesEquivalentRights() public {
        HostileToken asset = new HostileToken();
        address reserveA = address(0xA001);
        address reserveB = address(0xB001);
        address beneficiaryA = address(0xA002);
        address beneficiaryB = address(0xB002);
        asset.mint(reserveA, ALLOCATION);
        asset.mint(reserveB, ALLOCATION);
        GrantVault first = _deploy(
            asset, beneficiaryA, reserveA, CONTROLLER, _terms(ALLOCATION, G.Kind.TeamService)
        );
        GrantVault second = _deploy(
            asset, beneficiaryB, reserveB, CONTROLLER, _terms(ALLOCATION, G.Kind.TeamService)
        );
        _approveAndFund(asset, first, reserveA);
        _approveAndFund(asset, second, reserveB);
        vm.warp(130);
        vm.prank(beneficiaryA);
        first.release();
        vm.prank(CONTROLLER);
        first.cancel();
        vm.prank(CONTROLLER);
        second.cancel();
        vm.prank(beneficiaryB);
        second.release();
        assertEq(asset.balanceOf(beneficiaryA), asset.balanceOf(beneficiaryB));
        assertEq(asset.balanceOf(reserveA), asset.balanceOf(reserveB));
        assertEq(_digest(first), _digest(second));
    }

    function testAtomicFundingRejectsUnsupportedTokenBehavior() public {
        HostileToken.Mode[8] memory modes = [
            HostileToken.Mode.RevertCall,
            HostileToken.Mode.FalseAfterMutation,
            HostileToken.Mode.EmptyReturn,
            HostileToken.Mode.ShortReturn,
            HostileToken.Mode.InvalidBoolReturn,
            HostileToken.Mode.TrueNoMovement,
            HostileToken.Mode.WrongDebit,
            HostileToken.Mode.WrongCredit
        ];
        for (uint256 i; i < modes.length; ++i) {
            HostileToken asset = new HostileToken();
            asset.mint(RESERVE, ALLOCATION);
            GrantVault target = _deploy(
                asset, BENEFICIARY, RESERVE, CONTROLLER, _terms(ALLOCATION, G.Kind.TeamService)
            );
            vm.prank(RESERVE);
            asset.approve(address(target), ALLOCATION);
            asset.configure(modes[i], address(0), "");
            _reverted(RESERVE, target, abi.encodeCall(GrantVault.fund, ()));
            assertFalse(target.funded());
            assertEq(asset.balanceOf(RESERVE), ALLOCATION);
            assertEq(asset.balanceOf(address(target)), 0);
            assertEq(asset.allowance(RESERVE, address(target)), ALLOCATION);
        }
    }

    function testAtomicReleaseAndRefundFailuresRestoreLedgerAndBalances() public {
        _approveAndFund(token, vault, RESERVE);
        vm.warp(130);
        bytes32 beforeRelease = _digest(vault);
        token.configure(HostileToken.Mode.FalseAfterMutation, address(0), "");
        _assertError(
            _reverted(BENEFICIARY, vault, abi.encodeCall(GrantVault.release, ())),
            abi.encodeWithSelector(GrantVault.ERC20TransferFailed.selector)
        );
        assertEq(_digest(vault), beforeRelease);
        assertEq(token.balanceOf(address(vault)), ALLOCATION);
        assertEq(token.balanceOf(BENEFICIARY), 0);

        token.configure(HostileToken.Mode.Normal, address(0), "");
        vm.prank(BENEFICIARY);
        vault.release();
        bytes32 beforeCancel = _digest(vault);
        uint256 vaultBalance = token.balanceOf(address(vault));
        uint256 reserveBalance = token.balanceOf(RESERVE);
        token.configure(HostileToken.Mode.FalseAfterMutation, address(0), "");
        _assertError(
            _reverted(CONTROLLER, vault, abi.encodeCall(GrantVault.cancel, ())),
            abi.encodeWithSelector(GrantVault.ERC20TransferFailed.selector)
        );
        assertEq(_digest(vault), beforeCancel);
        assertEq(token.balanceOf(address(vault)), vaultBalance);
        assertEq(token.balanceOf(RESERVE), reserveBalance);
    }

    function testReleaseRejectsInexactOutboundMovementAndRestoresLedgerAndBalances() public {
        HostileToken.Mode[3] memory modes = [
            HostileToken.Mode.TrueNoMovement,
            HostileToken.Mode.WrongDebit,
            HostileToken.Mode.WrongCredit
        ];
        for (uint256 i; i < modes.length; ++i) {
            vm.warp(START);
            HostileToken asset = new HostileToken();
            asset.mint(RESERVE, ALLOCATION);
            GrantVault target = _deploy(
                asset, BENEFICIARY, RESERVE, CONTROLLER, _terms(ALLOCATION, G.Kind.TeamService)
            );
            _approveAndFund(asset, target, RESERVE);
            vm.warp(130);
            bytes32 beforeState = _digest(target);
            uint256 vaultBalance = asset.balanceOf(address(target));
            uint256 beneficiaryBalance = asset.balanceOf(BENEFICIARY);
            asset.configure(modes[i], address(0), "");

            _assertError(
                _reverted(BENEFICIARY, target, abi.encodeCall(GrantVault.release, ())),
                abi.encodeWithSelector(GrantVault.TokenDeltaMismatch.selector)
            );
            assertEq(_digest(target), beforeState);
            assertEq(asset.balanceOf(address(target)), vaultBalance);
            assertEq(asset.balanceOf(BENEFICIARY), beneficiaryBalance);
        }
    }

    function testPositiveRefundRejectsInexactOutboundMovementAndRestoresLedgerAndBalances() public {
        HostileToken.Mode[3] memory modes = [
            HostileToken.Mode.TrueNoMovement,
            HostileToken.Mode.WrongDebit,
            HostileToken.Mode.WrongCredit
        ];
        for (uint256 i; i < modes.length; ++i) {
            vm.warp(START);
            HostileToken asset = new HostileToken();
            asset.mint(RESERVE, ALLOCATION);
            GrantVault target = _deploy(
                asset, BENEFICIARY, RESERVE, CONTROLLER, _terms(ALLOCATION, G.Kind.TeamService)
            );
            _approveAndFund(asset, target, RESERVE);
            vm.warp(130);
            bytes32 beforeState = _digest(target);
            uint256 vaultBalance = asset.balanceOf(address(target));
            uint256 reserveBalance = asset.balanceOf(RESERVE);
            asset.configure(modes[i], address(0), "");

            _assertError(
                _reverted(CONTROLLER, target, abi.encodeCall(GrantVault.cancel, ())),
                abi.encodeWithSelector(GrantVault.TokenDeltaMismatch.selector)
            );
            assertEq(_digest(target), beforeState);
            assertEq(asset.balanceOf(address(target)), vaultBalance);
            assertEq(asset.balanceOf(RESERVE), reserveBalance);
        }
    }

    function testEveryTokenCallbackSeesCommonReentrancyGuard() public {
        bytes[3] memory calls = [
            abi.encodeCall(GrantVault.fund, ()),
            abi.encodeCall(GrantVault.release, ()),
            abi.encodeCall(GrantVault.cancel, ())
        ];
        bytes32 expected = keccak256(abi.encodeWithSelector(GrantVault.ReentrantCall.selector));
        for (uint256 phase; phase < 3; ++phase) {
            for (uint256 attempt; attempt < calls.length; ++attempt) {
                HostileToken asset = new HostileToken();
                asset.mint(RESERVE, ALLOCATION);
                GrantVault target = _deploy(
                    asset, BENEFICIARY, RESERVE, CONTROLLER, _terms(ALLOCATION, G.Kind.TeamService)
                );
                if (phase == 0) {
                    vm.prank(RESERVE);
                    asset.approve(address(target), ALLOCATION);
                    asset.configure(HostileToken.Mode.Reenter, address(target), calls[attempt]);
                    vm.prank(RESERVE);
                    target.fund();
                } else {
                    _approveAndFund(asset, target, RESERVE);
                    asset.configure(HostileToken.Mode.Reenter, address(target), calls[attempt]);
                    if (phase == 1) {
                        vm.warp(END);
                        vm.prank(BENEFICIARY);
                        target.release();
                    } else {
                        vm.prank(CONTROLLER);
                        target.cancel();
                    }
                }
                assertEq(keccak256(asset.callbackResult()), expected);
                vm.warp(START);
            }
        }
    }

    function testTimeBackdatingOverflowAndPastLedgerQueriesReject() public {
        vm.warp(START + 1);
        _assertError(
            _deploymentReverted(
                token, BENEFICIARY, RESERVE, CONTROLLER, _terms(ALLOCATION, G.Kind.TeamService)
            ),
            abi.encodeWithSelector(GrantVault.StartInPast.selector, START, START + 1)
        );

        vm.warp(START);
        G.Terms memory latest = G.Terms(
            1,
            type(uint64).max - 2,
            type(uint64).max - 1,
            type(uint64).max,
            G.Kind.Founder,
            bytes32("latest")
        );
        GrantVault overflow = _deploy(token, BENEFICIARY, RESERVE, CONTROLLER, latest);
        vm.prank(RESERVE);
        token.approve(address(overflow), 1);
        vm.warp(uint256(type(uint64).max) + 1);
        _assertError(
            _reverted(RESERVE, overflow, abi.encodeCall(GrantVault.fund, ())),
            abi.encodeWithSelector(
                GrantVault.TimestampOverflow.selector, uint256(type(uint64).max) + 1
            )
        );
        _assertError(
            _deploymentReverted(
                token,
                BENEFICIARY,
                RESERVE,
                CONTROLLER,
                G.Terms(
                    1,
                    type(uint64).max,
                    type(uint64).max - 2,
                    type(uint64).max - 1,
                    G.Kind.Founder,
                    bytes32("x")
                )
            ),
            abi.encodeWithSelector(
                GrantVault.TimestampOverflow.selector, uint256(type(uint64).max) + 1
            )
        );

        vm.warp(START);
        _approveAndFund(token, vault, RESERVE);
        vm.warp(130);
        vm.prank(BENEFICIARY);
        vault.release();
        vm.warp(129);
        (bool ok, bytes memory result) =
            address(vault).staticcall(abi.encodeCall(GrantVault.available, ()));
        assertFalse(ok);
        _assertError(result, abi.encodeWithSelector(G.PastTime.selector));
        _assertError(
            _reverted(BENEFICIARY, vault, abi.encodeCall(GrantVault.release, ())),
            abi.encodeWithSelector(G.PastTime.selector)
        );
        _assertError(
            _reverted(CONTROLLER, vault, abi.encodeCall(GrantVault.cancel, ())),
            abi.encodeWithSelector(G.PastTime.selector)
        );
    }

    function testTwoGrantsRemainIsolatedAcrossSchedulesAndReserves() public {
        address secondReserve = address(0x2222);
        address secondBeneficiary = address(0x2223);
        token.mint(secondReserve, 720);
        G.Terms memory later =
            G.Terms(720, START + 10, CLIFF + 10, END + 10, G.Kind.TeamService, bytes32("second"));
        GrantVault second = _deploy(token, secondBeneficiary, secondReserve, CONTROLLER, later);
        _approveAndFund(token, vault, RESERVE);
        _approveAndFund(token, second, secondReserve);
        bytes32 secondBefore = _digest(second);
        vm.warp(130);
        vm.prank(BENEFICIARY);
        assertEq(vault.release(), 180);
        assertEq(_digest(second), secondBefore);
        vm.prank(CONTROLLER);
        assertEq(second.cancel(), 560);
        assertEq(vault.available(), 0);
        assertEq(second.available(), 160);
        assertEq(token.balanceOf(RESERVE), ALLOCATION * 9);
        assertEq(token.balanceOf(secondReserve), 560);
    }

    function _canonical(bool ccip, uint256 supply) internal returns (AGTMAIToken) {
        return ccip
            ? new AGTMAICCIPToken(supply, _one(RESERVE, supply), address(0xCC1F))
            : new AGTMAIToken(supply, _one(RESERVE, supply));
    }

    function _fundingSnapshot(IERC20 asset, GrantVault target) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                target.grant(),
                target.funded(),
                asset.totalSupply(),
                asset.balanceOf(RESERVE),
                asset.balanceOf(address(target)),
                asset.balanceOf(BENEFICIARY),
                asset.allowance(RESERVE, address(target))
            )
        );
    }

    function testBothCanonicalTokensFundingFailuresRestoreAllowanceAndCustody() public {
        for (uint256 variant; variant < 2; ++variant) {
            for (uint256 failure; failure < 2; ++failure) {
                AGTMAIToken real =
                    _canonical(variant == 1, failure == 0 ? ALLOCATION - 1 : ALLOCATION);
                GrantVault target = _deploy(
                    real, BENEFICIARY, RESERVE, CONTROLLER, _terms(ALLOCATION, G.Kind.TeamService)
                );
                uint256 allowance = failure == 0 ? ALLOCATION : ALLOCATION - 1;
                vm.prank(RESERVE);
                assertTrue(real.approve(address(target), allowance));
                bytes32 beforeState = _fundingSnapshot(real, target);
                bytes memory reason =
                    _reverted(RESERVE, target, abi.encodeCall(GrantVault.fund, ()));
                _assertError(
                    reason,
                    failure == 0
                        ? abi.encodeWithSignature(
                            "ERC20InsufficientBalance(address,uint256,uint256)",
                            RESERVE,
                            ALLOCATION - 1,
                            ALLOCATION
                        )
                        : abi.encodeWithSignature(
                            "ERC20InsufficientAllowance(address,uint256,uint256)",
                            address(target),
                            ALLOCATION - 1,
                            ALLOCATION
                        )
                );
                assertEq(_fundingSnapshot(real, target), beforeState);
                assertFalse(target.funded());
                // A completed approval survives a failed funding transaction.
                assertEq(real.allowance(RESERVE, address(target)), allowance);
            }
        }
    }

    function testBothCanonicalTokensExactFundingDonationDeadlineAndDuplicate() public {
        for (uint256 variant; variant < 2; ++variant) {
            vm.warp(START - 1);
            AGTMAIToken real = _canonical(variant == 1, ALLOCATION * 2 + 7);
            GrantVault target = _deploy(
                real, BENEFICIARY, RESERVE, CONTROLLER, _terms(ALLOCATION, G.Kind.TeamService)
            );
            GrantVault late = _deploy(
                real, BENEFICIARY, RESERVE, CONTROLLER, _terms(ALLOCATION, G.Kind.TeamService)
            );
            vm.prank(RESERVE);
            assertTrue(real.transfer(address(target), 7));
            assertFalse(target.funded());
            assertEq(target.available(), 0);
            vm.prank(RESERVE);
            assertTrue(real.approve(address(target), ALLOCATION));
            vm.prank(RESERVE);
            assertTrue(real.approve(address(late), ALLOCATION));
            vm.warp(START);
            vm.recordLogs();
            vm.prank(RESERVE);
            target.fund();
            Vm.Log[] memory logs = vm.getRecordedLogs();
            assertEq(logs.length, 2);
            assertEq(logs[0].emitter, address(real));
            assertEq(logs[0].topics[0], keccak256("Transfer(address,address,uint256)"));
            assertEq(logs[0].topics[1], bytes32(uint256(uint160(RESERVE))));
            assertEq(logs[0].topics[2], bytes32(uint256(uint160(address(target)))));
            assertEq(abi.decode(logs[0].data, (uint256)), ALLOCATION);
            assertEq(logs[1].emitter, address(target));
            assertEq(logs[1].topics[0], keccak256("GrantFunded(uint256,uint64)"));
            assertEq(keccak256(logs[1].data), keccak256(abi.encode(ALLOCATION, START)));
            assertTrue(target.funded());
            assertEq(real.balanceOf(RESERVE), ALLOCATION);
            assertEq(real.balanceOf(address(target)), ALLOCATION + 7);
            assertEq(real.allowance(RESERVE, address(target)), 0);
            assertEq(real.totalSupply(), ALLOCATION * 2 + 7);
            bytes32 beforeState = _fundingSnapshot(real, target);
            _assertError(
                _reverted(RESERVE, target, abi.encodeCall(GrantVault.fund, ())),
                abi.encodeWithSelector(GrantVault.AlreadyFunded.selector)
            );
            assertEq(_fundingSnapshot(real, target), beforeState);
            vm.warp(START + 1);
            beforeState = _fundingSnapshot(real, late);
            _assertError(
                _reverted(RESERVE, late, abi.encodeCall(GrantVault.fund, ())),
                abi.encodeWithSelector(GrantVault.StartInPast.selector, START, START + 1)
            );
            assertEq(_fundingSnapshot(real, late), beforeState);
            assertFalse(late.funded());
        }
    }

    function testWalletControlCanChangeWithoutChangingBeneficiaryOrEntitlement() public {
        ControlledBeneficiary wallet = new ControlledBeneficiary(BENEFICIARY);
        AGTMAIToken real = _canonical(false, ALLOCATION);
        GrantVault target = _deploy(
            real, address(wallet), RESERVE, CONTROLLER, _terms(ALLOCATION, G.Kind.TeamService)
        );
        _fundReal(real, target, RESERVE);
        vm.warp(130);
        bytes32 beforeState = _digest(target);
        uint256 entitlement = target.available();
        vm.prank(BENEFICIARY);
        wallet.rotate(STRANGER);
        assertEq(_digest(target), beforeState);
        assertEq(target.available(), entitlement);
        assertEq(target.BENEFICIARY(), address(wallet));
        _assertError(
            _reverted(STRANGER, target, abi.encodeCall(GrantVault.release, ())),
            abi.encodeWithSelector(GrantVault.Unauthorized.selector, STRANGER, address(wallet))
        );
        vm.prank(BENEFICIARY);
        (bool oldOwner,) =
            address(wallet).call(abi.encodeCall(ControlledBeneficiary.release, (target)));
        assertFalse(oldOwner);
        vm.prank(STRANGER);
        assertEq(wallet.release(target), entitlement);
        assertEq(real.balanceOf(address(wallet)), entitlement);
        assertEq(real.balanceOf(STRANGER), 0);
        assertEq(real.balanceOf(BENEFICIARY), 0);
    }

    function testReassignmentAttemptsAcrossLifecycleCannotRedirectTrailingCalldata() public {
        address[5] memory callers = [RESERVE, CONTROLLER, BENEFICIARY, STRANGER, address(this)];
        bytes4[4] memory selectors = [
            bytes4(keccak256("setBeneficiary(address)")),
            bytes4(keccak256("transferOwnership(address)")),
            bytes4(keccak256("migrate(address)")),
            bytes4(keccak256("release(address,uint256)"))
        ];
        bytes32 terms = keccak256(abi.encode(vault.grant().terms));
        for (uint256 phase; phase < 5; ++phase) {
            if (phase == 1) _approveAndFund(token, vault, RESERVE);
            if (phase == 2) vm.warp(130);
            if (phase == 3) {
                vm.prank(CONTROLLER);
                vault.cancel();
            }
            if (phase == 4) {
                vm.warp(END + 1);
                vm.prank(BENEFICIARY);
                (bool ok,) = address(vault)
                    .call(
                        abi.encodePacked(
                            GrantVault.release.selector, abi.encode(STRANGER, ALLOCATION)
                        )
                    );
                assertTrue(ok);
                assertEq(token.balanceOf(BENEFICIARY), 180);
                assertEq(token.balanceOf(STRANGER), 0);
            }
            bytes32 beforeState = _digest(vault);
            for (uint256 i; i < callers.length; ++i) {
                for (uint256 j; j < selectors.length; ++j) {
                    _reverted(
                        callers[i],
                        vault,
                        abi.encodeWithSelector(selectors[j], STRANGER, ALLOCATION)
                    );
                }
            }
            assertEq(_digest(vault), beforeState);
            assertEq(keccak256(abi.encode(vault.grant().terms)), terms);
            assertEq(vault.BENEFICIARY(), BENEFICIARY);
        }
    }

    function testRefundFailureRetryUsesLaterSuccessfulTimeAndDebtSurvivesEnd() public {
        _approveAndFund(token, vault, RESERVE);
        vm.warp(118);
        vm.prank(BENEFICIARY);
        assertEq(vault.release(), 60);
        vm.warp(130);
        token.configure(HostileToken.Mode.FalseAfterMutation, address(0), "");
        bytes32 beforeState = _fundingSnapshot(token, vault);
        _assertError(
            _reverted(CONTROLLER, vault, abi.encodeCall(GrantVault.cancel, ())),
            abi.encodeWithSelector(GrantVault.ERC20TransferFailed.selector)
        );
        assertEq(_fundingSnapshot(token, vault), beforeState);
        vm.warp(131);
        token.configure(HostileToken.Mode.Normal, address(0), "");
        vm.expectEmit(true, false, false, true);
        emit TeamGrantCancelled(bytes32("contributors"), 190, 170, 131);
        vm.prank(CONTROLLER);
        assertEq(vault.cancel(), 170);
        vm.warp(END + 100);
        assertEq(vault.available(), 130);
        vm.prank(BENEFICIARY);
        assertEq(vault.release(), 130);
        assertEq(vault.grant().frozenEntitlement, 190);
        assertEq(vault.grant().lastTransition, END + 100);
        assertEq(token.balanceOf(BENEFICIARY), 190);
        assertEq(token.balanceOf(RESERVE), ALLOCATION * 9 + 170);
        _assertError(
            _reverted(RESERVE, vault, abi.encodeCall(GrantVault.fund, ())),
            abi.encodeWithSelector(GrantVault.AlreadyFunded.selector)
        );
    }

    function testFullyVestedCancellationEmitsZeroRefundWithoutTokenCall() public {
        _approveAndFund(token, vault, RESERVE);
        vm.warp(END);
        token.configure(HostileToken.Mode.RevertCall, address(0), "");
        vm.recordLogs();
        vm.prank(CONTROLLER);
        assertEq(vault.cancel(), 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(vault));
        assertEq(logs[0].topics[0], keccak256("TeamGrantCancelled(bytes32,uint256,uint256,uint64)"));
        assertEq(logs[0].topics[1], bytes32("contributors"));
        assertEq(keccak256(logs[0].data), keccak256(abi.encode(ALLOCATION, uint256(0), END)));
        assertTrue(vault.grant().cancelled);
        assertEq(vault.grant().frozenEntitlement, ALLOCATION);
        assertEq(vault.available(), ALLOCATION);
    }

    function testFuzzExactEndReleaseHasNoRoundingDust(uint128 amountSeed) public {
        uint256 amount = uint256(amountSeed) + 1;
        HostileToken asset = new HostileToken();
        address reserve = address(0xF00D);
        address beneficiary = address(0xF00E);
        asset.mint(reserve, amount);
        GrantVault target =
            _deploy(asset, beneficiary, reserve, CONTROLLER, _terms(amount, G.Kind.TeamService));
        _approveAndFund(asset, target, reserve);
        vm.warp(END - 1);
        uint256 beforeEnd = target.available();
        if (beforeEnd > 0) {
            vm.prank(beneficiary);
            target.release();
        }
        vm.warp(END);
        vm.prank(beneficiary);
        target.release();
        assertEq(asset.balanceOf(beneficiary), amount);
        assertEq(asset.balanceOf(address(target)), 0);
    }
}
