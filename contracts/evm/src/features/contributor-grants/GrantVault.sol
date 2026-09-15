// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { GrantAccounting } from "./GrantAccounting.sol";

/// @notice Immutable, fully funded custody for one founder or team contributor grant.
/// @dev The bound controller is intended to be a Safe 2-of-3. This contract verifies only the
/// calling address; Safe ownership, thresholds, timelocks and reserve budgets are deployment
/// requirements outside this contract.
contract GrantVault {
    using GrantAccounting for GrantAccounting.Grant;

    error InvalidBinding();
    error Unauthorized(address caller, address expected);
    error AlreadyFunded();
    error NotFunded();
    error StartInPast(uint64 start, uint64 currentTime);
    error TimestampOverflow(uint256 timestamp);
    error ReentrantCall();
    error ERC20TransferFailed();
    error TokenDeltaMismatch();

    event GrantConfigured(
        address indexed token,
        address indexed beneficiary,
        address indexed originalReserve,
        address controller,
        GrantAccounting.Terms terms
    );
    event GrantFunded(uint256 amount, uint64 timestamp);
    event TokensReleased(uint256 amount, uint256 totalReleased, uint64 timestamp);
    event TeamGrantCancelled(
        bytes32 indexed originalPurpose, uint256 frozenEntitlement, uint256 refund, uint64 timestamp
    );

    IERC20 public immutable TOKEN;
    address public immutable BENEFICIARY;
    address public immutable ORIGINAL_RESERVE;
    address public immutable CONTROLLER;

    GrantAccounting.Grant private _grant;
    bool public funded;
    bool private _entered;

    modifier nonReentrant() {
        if (_entered) revert ReentrantCall();
        _entered = true;
        _;
        _entered = false;
    }

    constructor(
        IERC20 token,
        address beneficiary,
        address originalReserve,
        address controller,
        GrantAccounting.Terms memory terms
    ) {
        if (
            address(token) == address(0) || beneficiary == address(0)
                || originalReserve == address(0) || controller == address(0)
                || address(token).code.length == 0 || beneficiary == address(this)
                || originalReserve == address(this) || controller == address(this)
        ) revert InvalidBinding();

        uint64 currentTime = _currentTime();
        if (terms.start < currentTime) revert StartInPast(terms.start, currentTime);

        TOKEN = token;
        BENEFICIARY = beneficiary;
        ORIGINAL_RESERVE = originalReserve;
        CONTROLLER = controller;
        _grant.initialize(terms);

        emit GrantConfigured(address(token), beneficiary, originalReserve, controller, terms);
    }

    /// @notice Pull the complete allocation from the immutable originating reserve exactly once.
    function fund() external nonReentrant {
        if (msg.sender != ORIGINAL_RESERVE) revert Unauthorized(msg.sender, ORIGINAL_RESERVE);
        if (funded) revert AlreadyFunded();

        uint64 currentTime = _currentTime();
        GrantAccounting.Terms storage terms = _grant.terms;
        if (currentTime > terms.start) revert StartInPast(terms.start, currentTime);

        uint256 amount = terms.allocation;
        uint256 fromBefore = TOKEN.balanceOf(ORIGINAL_RESERVE);
        uint256 toBefore = TOKEN.balanceOf(address(this));
        funded = true;
        if (!TOKEN.transferFrom(ORIGINAL_RESERVE, address(this), amount)) {
            revert ERC20TransferFailed();
        }
        _requireMovement(
            fromBefore,
            TOKEN.balanceOf(ORIGINAL_RESERVE),
            toBefore,
            TOKEN.balanceOf(address(this)),
            amount
        );

        emit GrantFunded(amount, currentTime);
    }

    /// @notice Pay all entitlement currently available to the immutable beneficiary.
    function release() external nonReentrant returns (uint256 amount) {
        if (msg.sender != BENEFICIARY) revert Unauthorized(msg.sender, BENEFICIARY);
        if (!funded) revert NotFunded();

        uint64 currentTime = _currentTime();
        amount = _grant.available(currentTime);
        _grant.release(currentTime, amount);
        uint256 fromBefore = TOKEN.balanceOf(address(this));
        uint256 toBefore = TOKEN.balanceOf(BENEFICIARY);
        if (!TOKEN.transfer(BENEFICIARY, amount)) revert ERC20TransferFailed();
        _requireMovement(
            fromBefore,
            TOKEN.balanceOf(address(this)),
            toBefore,
            TOKEN.balanceOf(BENEFICIARY),
            amount
        );

        emit TokensReleased(amount, _grant.released, currentTime);
    }

    /// @notice Freeze a team grant and immediately return only its unvested tokens.
    function cancel() external nonReentrant returns (uint256 refund) {
        if (msg.sender != CONTROLLER) revert Unauthorized(msg.sender, CONTROLLER);
        if (!funded) revert NotFunded();

        uint64 currentTime = _currentTime();
        bytes32 originalPurpose;
        (refund, originalPurpose) = _grant.cancel(currentTime);
        if (refund > 0) {
            uint256 fromBefore = TOKEN.balanceOf(address(this));
            uint256 toBefore = TOKEN.balanceOf(ORIGINAL_RESERVE);
            if (!TOKEN.transfer(ORIGINAL_RESERVE, refund)) revert ERC20TransferFailed();
            _requireMovement(
                fromBefore,
                TOKEN.balanceOf(address(this)),
                toBefore,
                TOKEN.balanceOf(ORIGINAL_RESERVE),
                refund
            );
        }

        emit TeamGrantCancelled(originalPurpose, _grant.frozenEntitlement, refund, currentTime);
    }

    function grant() external view returns (GrantAccounting.Grant memory) {
        return _grant;
    }

    function available() external view returns (uint256) {
        if (!funded) return 0;
        return _grant.available(_currentTime());
    }

    function _currentTime() private view returns (uint64) {
        uint256 timestamp = block.timestamp;
        if (timestamp > type(uint64).max) revert TimestampOverflow(timestamp);
        return uint64(timestamp);
    }

    function _requireMovement(
        uint256 fromBefore,
        uint256 fromAfter,
        uint256 toBefore,
        uint256 toAfter,
        uint256 amount
    ) private pure {
        if (
            fromAfter > fromBefore || fromBefore - fromAfter != amount || toAfter < toBefore
                || toAfter - toBefore != amount
        ) revert TokenDeltaMismatch();
    }
}
