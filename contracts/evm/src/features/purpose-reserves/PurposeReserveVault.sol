// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Immutable, purpose-labeled custody with a rolling gross transfer limit.
/// @dev The controller chooses recipients. Tokens leaving this vault have no downstream
/// restrictions.
contract PurposeReserveVault {
    error InvalidPolicy();
    error Unauthorized();
    error ReentrantCall();
    error NotOpen();
    error InvalidOutflow();
    error CapExceeded();
    error InsufficientInventory();
    error TransferFailed();
    error IncorrectTransfer();

    event Configured(
        address indexed token,
        address indexed controller,
        bytes32 indexed purpose,
        uint64 opensAt,
        uint64 windowSeconds,
        uint256 rollingCap
    );
    event Outflow(
        address indexed recipient,
        uint256 amount,
        uint256 grossOutflow,
        uint256 rollingOutflow,
        uint256 timestamp
    );

    IERC20 public immutable TOKEN;
    address public immutable CONTROLLER;
    bytes32 public immutable PURPOSE;
    uint64 public immutable OPENS_AT;
    uint64 public immutable WINDOW_SECONDS;
    uint256 public immutable ROLLING_CAP;

    struct Checkpoint {
        uint256 timestamp;
        uint256 cumulative;
    }

    Checkpoint[] private _outflows;
    bool private _entered;

    constructor(
        IERC20 token,
        address controller,
        bytes32 purpose,
        uint64 opensAt,
        uint64 windowSeconds,
        uint256 rollingCap
    ) {
        if (
            address(token).code.length == 0 || controller.code.length == 0
                || address(token) == controller || address(token) == address(this)
                || controller == address(this) || purpose == bytes32(0) || opensAt == 0
                || windowSeconds == 0 || rollingCap == 0
        ) revert InvalidPolicy();
        TOKEN = token;
        CONTROLLER = controller;
        PURPOSE = purpose;
        OPENS_AT = opensAt;
        WINDOW_SECONDS = windowSeconds;
        ROLLING_CAP = rollingCap;
        emit Configured(address(token), controller, purpose, opensAt, windowSeconds, rollingCap);
    }

    function transferOut(address recipient, uint256 amount) external {
        if (msg.sender != CONTROLLER) revert Unauthorized();
        if (_entered) revert ReentrantCall();
        _entered = true;
        if (block.timestamp < OPENS_AT) revert NotOpen();
        if (
            amount == 0 || recipient == address(0) || recipient == address(this)
                || recipient == address(TOKEN)
        ) revert InvalidOutflow();

        uint256 used = rollingOutflow();
        if (amount > ROLLING_CAP - used) revert CapExceeded();
        uint256 beforeVault = TOKEN.balanceOf(address(this));
        if (amount > beforeVault) revert InsufficientInventory();
        uint256 beforeRecipient = TOKEN.balanceOf(recipient);

        uint256 count = _outflows.length;
        uint256 cumulative = amount + (count == 0 ? 0 : _outflows[count - 1].cumulative);
        if (count != 0 && _outflows[count - 1].timestamp == block.timestamp) {
            _outflows[count - 1].cumulative = cumulative;
        } else {
            _outflows.push(Checkpoint(block.timestamp, cumulative));
        }

        if (!TOKEN.transfer(recipient, amount)) revert TransferFailed();
        uint256 afterVault = TOKEN.balanceOf(address(this));
        uint256 afterRecipient = TOKEN.balanceOf(recipient);
        if (
            afterVault > beforeVault || beforeVault - afterVault != amount
                || afterRecipient < beforeRecipient || afterRecipient - beforeRecipient != amount
        ) revert IncorrectTransfer();
        emit Outflow(recipient, amount, cumulative, used + amount, block.timestamp);
        _entered = false;
    }

    function grossOutflow() public view returns (uint256) {
        uint256 count = _outflows.length;
        return count == 0 ? 0 : _outflows[count - 1].cumulative;
    }

    /// @notice Outflows in (now - WINDOW_SECONDS, now], including today's full burst.
    function rollingOutflow() public view returns (uint256) {
        uint256 count = _outflows.length;
        if (count == 0) return 0;
        uint256 total = _outflows[count - 1].cumulative;
        if (block.timestamp < WINDOW_SECONDS) return total;
        uint256 cutoff = block.timestamp - WINDOW_SECONDS;
        uint256 low;
        uint256 high = count;
        while (low < high) {
            uint256 middle = low + (high - low) / 2;
            if (_outflows[middle].timestamp <= cutoff) low = middle + 1;
            else high = middle;
        }
        return total - (low == 0 ? 0 : _outflows[low - 1].cumulative);
    }

    function availableOutflow() external view returns (uint256) {
        if (block.timestamp < OPENS_AT) return 0;
        uint256 remaining = ROLLING_CAP - rollingOutflow();
        uint256 inventory = TOKEN.balanceOf(address(this));
        return inventory < remaining ? inventory : remaining;
    }
}
