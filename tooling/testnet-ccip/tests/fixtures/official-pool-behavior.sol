// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;
import {LockReleaseTokenPool} from "@chainlink/contracts-ccip/contracts/pools/LockReleaseTokenPool.sol";
import {TokenPool} from "@chainlink/contracts-ccip/contracts/pools/TokenPool.sol";
import {Pool} from "@chainlink/contracts-ccip/contracts/libraries/Pool.sol";
import {RateLimiter} from "@chainlink/contracts-ccip/contracts/libraries/RateLimiter.sol";
import {IERC20} from "@chainlink/contracts/src/v0.8/vendor/openzeppelin-solidity/v4.8.3/contracts/token/ERC20/IERC20.sol";

// TEST doubles only: upstream pool and repository token execute their actual compiled code.
contract PoolTestRouter {
    address public ramp;
    function setRamp(address a) external { ramp = a; }
    function getOnRamp(uint64) external view returns (address) { return ramp; }
    function isOffRamp(uint64, address a) external view returns (bool) { return a == ramp; }
}
contract PoolTestRMN {
    bool public cursed;
    function setCursed(bool b) external { cursed = b; }
    function isCursed(bytes16) external view returns (bool) { return cursed; }
}
contract PoolTestActor {
    function invoke(address target, bytes calldata data) external returns (bool, bytes memory) { return target.call(data); }
}
contract OfficialPoolBehavior {
    uint64 constant CHAIN = 16423721717087811551;
    uint256 constant UNIT = 1e9;
    address constant RECEIVER = address(0xbeef);
    LockReleaseTokenPool public p;
    IERC20 t;
    PoolTestRMN rmn;
    PoolTestActor public actor = new PoolTestActor();
    constructor(address pool) { p = LockReleaseTokenPool(pool); t = IERC20(p.getToken()); rmn = PoolTestRMN(p.getRmnProxy()); }
    function accept() external { p.acceptOwnership(); }
    function configure(LockReleaseTokenPool pool, uint128 capacity) internal {
        uint64[] memory removes = new uint64[](pool.isSupportedChain(CHAIN) ? 1 : 0);
        if (removes.length == 1) removes[0] = CHAIN;
        bytes[] memory peers = new bytes[](1); peers[0] = hex"1234";
        TokenPool.ChainUpdate[] memory adds = new TokenPool.ChainUpdate[](1);
        adds[0] = TokenPool.ChainUpdate(CHAIN, peers, hex"abcd", RateLimiter.Config(true, capacity, uint128(UNIT)), RateLimiter.Config(true, capacity, uint128(UNIT)));
        pool.applyChainUpdates(removes, adds);
    }
    function lockInput(uint256 amount) internal view returns (Pool.LockOrBurnInV1 memory) {
        return Pool.LockOrBurnInV1(hex"11", CHAIN, address(this), amount, address(t));
    }
    function releaseInput(uint256 amount) internal view returns (Pool.ReleaseOrMintInV1 memory) {
        return Pool.ReleaseOrMintInV1(hex"11", CHAIN, RECEIVER, amount, address(t), hex"1234", abi.encode(uint8(9)), hex"");
    }
    function reject(address target, bytes memory data, bytes4 selector) internal {
        (bool ok, bytes memory reason) = target.call(data);
        require(!ok && reason.length >= 4 && bytes4(reason) == selector, "expected precise revert");
    }
    function unauthorized(bytes memory data) internal {
        (bool ok, bytes memory reason) = actor.invoke(address(p), data);
        require(!ok && bytes4(reason) == bytes4(keccak256("OnlyCallableByOwner()")), "owner boundary");
    }
    function testNoPullAndConservation() external {
        configure(p, uint128(10 * UNIT));
        uint256 balance = t.balanceOf(address(p)); uint256 held = t.balanceOf(address(this)); uint256 received = t.balanceOf(RECEIVER);
        Pool.LockOrBurnOutV1 memory out = p.lockOrBurn(lockInput(UNIT));
        require(keccak256(out.destTokenAddress) == keccak256(hex"abcd") && abi.decode(out.destPoolData, (uint8)) == 9, "lock output");
        require(t.balanceOf(address(p)) == balance && t.balanceOf(address(this)) == held, "lock does not pull or burn");
        require(p.releaseOrMint(releaseInput(UNIT)).destinationAmount == UNIT, "release output");
        require(t.balanceOf(address(p)) == balance - UNIT && t.balanceOf(RECEIVER) == received + UNIT, "prefunded conservation");
        require(t.totalSupply() == 100 * UNIT, "fixed supply");
    }
    function testRejections() external {
        configure(p, uint128(10 * UNIT));
        Pool.LockOrBurnInV1 memory l = lockInput(UNIT); l.localToken = address(1);
        reject(address(p), abi.encodeCall(p.lockOrBurn, (l)), TokenPool.InvalidToken.selector);
        l = lockInput(UNIT); l.remoteChainSelector = CHAIN + 1;
        reject(address(p), abi.encodeCall(p.lockOrBurn, (l)), TokenPool.ChainNotAllowed.selector);
        (bool ok, bytes memory reason) = actor.invoke(address(p), abi.encodeCall(p.lockOrBurn, (lockInput(UNIT))));
        require(!ok && bytes4(reason) == TokenPool.CallerIsNotARampOnRouter.selector, "onramp");
        (ok, reason) = actor.invoke(address(p), abi.encodeCall(p.releaseOrMint, (releaseInput(UNIT))));
        require(!ok && bytes4(reason) == TokenPool.CallerIsNotARampOnRouter.selector, "offramp");
        Pool.ReleaseOrMintInV1 memory r = releaseInput(UNIT); r.sourcePoolAddress = hex"123400";
        reject(address(p), abi.encodeCall(p.releaseOrMint, (r)), TokenPool.InvalidSourcePoolAddress.selector);
        r = releaseInput(UNIT); r.localToken = address(1);
        reject(address(p), abi.encodeCall(p.releaseOrMint, (r)), TokenPool.InvalidToken.selector);
        r = releaseInput(UNIT); r.remoteChainSelector = CHAIN + 1;
        reject(address(p), abi.encodeCall(p.releaseOrMint, (r)), TokenPool.ChainNotAllowed.selector);
        rmn.setCursed(true);
        reject(address(p), abi.encodeCall(p.lockOrBurn, (lockInput(UNIT))), TokenPool.CursedByRMN.selector);
        reject(address(p), abi.encodeCall(p.releaseOrMint, (releaseInput(UNIT))), TokenPool.CursedByRMN.selector);
        rmn.setCursed(false);
        require(p.getCurrentOutboundRateLimiterState(CHAIN).tokens == 10 * UNIT && p.getCurrentInboundRateLimiterState(CHAIN).tokens == 10 * UNIT, "rejection preserves buckets");
    }
    function testDepletion() external {
        configure(p, uint128(10 * UNIT));
        reject(address(p), abi.encodeCall(p.lockOrBurn, (lockInput(11 * UNIT))), RateLimiter.TokenMaxCapacityExceeded.selector);
        reject(address(p), abi.encodeCall(p.releaseOrMint, (releaseInput(11 * UNIT))), RateLimiter.TokenMaxCapacityExceeded.selector);
        p.lockOrBurn(lockInput(10 * UNIT)); p.releaseOrMint(releaseInput(10 * UNIT));
        reject(address(p), abi.encodeCall(p.lockOrBurn, (lockInput(UNIT))), RateLimiter.TokenRateLimitReached.selector);
        reject(address(p), abi.encodeCall(p.releaseOrMint, (releaseInput(UNIT))), RateLimiter.TokenRateLimitReached.selector);
        require(p.getCurrentOutboundRateLimiterState(CHAIN).tokens == 0 && p.getCurrentInboundRateLimiterState(CHAIN).tokens == 0, "depleted");
    }
    function testRefill() external {
        require(p.getCurrentOutboundRateLimiterState(CHAIN).tokens >= 2 * UNIT && p.getCurrentInboundRateLimiterState(CHAIN).tokens >= 2 * UNIT, "time refill");
        p.lockOrBurn(lockInput(2 * UNIT)); p.releaseOrMint(releaseInput(2 * UNIT));
        require(t.totalSupply() == 100 * UNIT, "refill conserves supply");
    }
    function testRollbackAndDecimals() external {
        configure(p, uint128(100 * UNIT));
        uint256 balance = t.balanceOf(address(p)); uint256 received = t.balanceOf(RECEIVER);
        reject(address(p), abi.encodeCall(p.releaseOrMint, (releaseInput(balance + UNIT))), bytes4(keccak256("ERC20InsufficientBalance(address,uint256,uint256)")));
        require(p.getCurrentInboundRateLimiterState(CHAIN).tokens == 100 * UNIT && t.balanceOf(address(p)) == balance && t.balanceOf(RECEIVER) == received, "failed transfer rolls limiter and balances back");
        Pool.ReleaseOrMintInV1 memory r = releaseInput(1); r.sourcePoolData = hex"09";
        reject(address(p), abi.encodeCall(p.releaseOrMint, (r)), TokenPool.InvalidRemoteChainDecimals.selector);
        r.sourcePoolData = abi.encode(uint256(256));
        reject(address(p), abi.encodeCall(p.releaseOrMint, (r)), TokenPool.InvalidRemoteChainDecimals.selector);
        r.sourcePoolData = abi.encode(uint8(8)); require(p.releaseOrMint(r).destinationAmount == 10, "decimal scale");
        r.sourcePoolData = hex""; require(p.releaseOrMint(r).destinationAmount == 1, "legacy decimals");
        require(t.totalSupply() == 100 * UNIT, "decimal conservation");
    }
    function testAllowlist(bytes calldata creation) external {
        address[] memory list = new address[](1); list[0] = address(this);
        bytes memory code = bytes.concat(creation, abi.encode(address(t), uint8(9), list, address(rmn), p.getRouter()));
        address deployed; assembly { deployed := create(0, add(code, 32), mload(code)) }
        require(deployed != address(0), "official nonempty allowlist deployment");
        LockReleaseTokenPool allowed = LockReleaseTokenPool(deployed); configure(allowed, uint128(10 * UNIT));
        Pool.LockOrBurnInV1 memory l = lockInput(UNIT); l.originalSender = address(actor);
        reject(address(allowed), abi.encodeCall(allowed.lockOrBurn, (l)), TokenPool.SenderNotAllowed.selector);
        allowed.lockOrBurn(lockInput(UNIT));
        address[] memory adds = new address[](1); adds[0] = address(actor); allowed.applyAllowListUpdates(list, adds);
        allowed.lockOrBurn(l);
        reject(address(allowed), abi.encodeCall(allowed.lockOrBurn, (lockInput(UNIT))), TokenPool.SenderNotAllowed.selector);
        reject(address(p), abi.encodeCall(p.applyAllowListUpdates, (new address[](0), adds)), TokenPool.AllowListNotEnabled.selector);
        // Inbound permissioning does not check originalSender; liquidity here is an explicit prior ERC20 transfer.
        require(t.transfer(address(allowed), 1), "prefund allowlisted pool");
        allowed.releaseOrMint(releaseInput(1));
    }
    function testAuthorities() external {
        configure(p, uint128(10 * UNIT));
        unauthorized(abi.encodeCall(p.setRouter, (address(actor))));
        unauthorized(abi.encodeCall(p.setRebalancer, (address(actor))));
        unauthorized(abi.encodeCall(p.setRateLimitAdmin, (address(actor))));
        unauthorized(abi.encodeCall(p.applyChainUpdates, (new uint64[](0), new TokenPool.ChainUpdate[](0))));
        unauthorized(abi.encodeCall(p.applyAllowListUpdates, (new address[](0), new address[](0))));
        RateLimiter.Config memory config = RateLimiter.Config(true, uint128(5 * UNIT), 0);
        (bool ok,) = actor.invoke(address(p), abi.encodeCall(p.setChainRateLimiterConfig, (CHAIN, config, config))); require(!ok, "rate admin denied");
        p.setRateLimitAdmin(address(actor));
        (ok,) = actor.invoke(address(p), abi.encodeCall(p.setChainRateLimiterConfig, (CHAIN, config, config))); require(ok, "rate admin allowed");
        p.setChainRateLimiterConfig(CHAIN, config, config); require(p.getRateLimitAdmin() == address(actor), "owner and rate admin remain distinct");
        RateLimiter.Config memory invalid = RateLimiter.Config(true, 1, 2);
        reject(address(p), abi.encodeCall(p.setChainRateLimiterConfig, (CHAIN, invalid, config)), RateLimiter.InvalidRateLimitRate.selector);
        require(p.getCurrentOutboundRateLimiterState(CHAIN).capacity == 5 * UNIT, "invalid config rolls back");
        unauthorized(abi.encodeCall(p.setRateLimitAdmin, (address(this))));
        p.transferOwnership(address(actor)); require(p.owner() == address(this), "proposal retains owner");
        reject(address(p), abi.encodeCall(p.acceptOwnership, ()), bytes4(keccak256("MustBeProposedOwner()")));
        (ok,) = actor.invoke(address(p), abi.encodeCall(p.acceptOwnership, ())); require(ok && p.owner() == address(actor), "two step acceptance");
        reject(address(p), abi.encodeCall(p.setRebalancer, (address(this))), bytes4(keccak256("OnlyCallableByOwner()")));
        (ok,) = actor.invoke(address(p), abi.encodeCall(p.transferOwnership, (address(this)))); require(ok, "transfer back"); p.acceptOwnership();
        p.setRouter(address(actor)); require(p.getRouter() == address(actor), "owner router change");
        // Restore the test router for later fixtures.
        p.setRouter(0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59);
    }
    function testRebalancerBypass() external {
        configure(p, uint128(10 * UNIT)); p.lockOrBurn(lockInput(10 * UNIT));
        rmn.setCursed(true); uint256 backing = t.balanceOf(address(p)); uint256 before = t.balanceOf(address(actor));
        (bool ok,) = actor.invoke(address(p), abi.encodeCall(p.withdrawLiquidity, (backing))); require(!ok, "rebalancer initially disabled");
        p.setRebalancer(address(actor));
        (ok,) = actor.invoke(address(p), abi.encodeCall(p.withdrawLiquidity, (backing))); require(ok, "owner enabled withdrawal bypass");
        require(t.balanceOf(address(p)) == 0 && t.balanceOf(address(actor)) == before + backing && p.getCurrentOutboundRateLimiterState(CHAIN).tokens == 0, "no backing liability limiter");
        require(p.getCurrentInboundRateLimiterState(CHAIN).tokens == 10 * UNIT, "withdrawal bypasses inbound limiter too");
        require(rmn.cursed() && t.totalSupply() == 100 * UNIT, "curse bypass and supply");
    }
}
