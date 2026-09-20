// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { GrantAccounting } from "./GrantAccounting.sol";
import { GrantVault } from "./GrantVault.sol";
import { GrantCalendar } from "./GrantCalendar.sol";

/// @notice Purpose-bound reserve that commits funds only into immutable contributor vaults.
/// @dev Caps count gross funding in (now - 365 days, now]. Refunds never erase commitments.
/// Calendar schedules are enforced here; production allocation approval remains offline.
contract ReserveController {
    error InvalidPolicy();
    error Unauthorized();
    error InvalidGrant();
    error CapExceeded();
    error ApprovalFailed();
    error ReentrantCall();

    event GrantCommitted(address indexed vault, address indexed beneficiary, uint256 amount);

    uint256 public constant WINDOW = 365 days;
    IERC20 public immutable TOKEN;
    address public immutable CONTROLLER;
    bytes32 public immutable PURPOSE;
    uint256 public immutable ROLLING_CAP;
    uint256 public immutable PER_GRANT_CAP;

    struct Checkpoint {
        uint256 timestamp;
        uint256 cumulative;
    }

    Checkpoint[] private _commitments;
    bool private _entered;

    constructor(
        IERC20 token,
        address controller,
        bytes32 purpose,
        uint256 rollingCap,
        uint256 perGrantCap
    ) {
        if (
            address(token).code.length == 0 || controller == address(0)
                || controller == address(this) || purpose == bytes32(0) || perGrantCap == 0
                || perGrantCap > rollingCap
        ) revert InvalidPolicy();
        TOKEN = token;
        CONTROLLER = controller;
        PURPOSE = purpose;
        ROLLING_CAP = rollingCap;
        PER_GRANT_CAP = perGrantCap;
    }

    /// @notice Atomically create, fully fund and account for one revocable contributor grant.
    /// @dev No arbitrary call, transfer, allowance, policy replacement or refund-credit path.
    function commit(address beneficiary, GrantAccounting.Terms calldata terms)
        external
        returns (GrantVault vault)
    {
        if (msg.sender != CONTROLLER) revert Unauthorized();
        if (_entered) revert ReentrantCall();
        _entered = true;
        if (
            terms.kind != GrantAccounting.Kind.TeamService || terms.originalPurpose != PURPOSE
                || beneficiary == address(this) || beneficiary == address(TOKEN)
                || terms.allocation == 0
        ) revert InvalidGrant();
        GrantCalendar.validate(terms.start, terms.cliff, terms.end);
        uint256 amount = terms.allocation;
        if (amount > PER_GRANT_CAP || amount > ROLLING_CAP - rollingCommitted()) {
            revert CapExceeded();
        }
        uint256 count = _commitments.length;
        uint256 cumulative = amount + (count == 0 ? 0 : _commitments[count - 1].cumulative);
        if (count > 0 && _commitments[count - 1].timestamp == block.timestamp) {
            _commitments[count - 1].cumulative = cumulative;
        } else {
            _commitments.push(Checkpoint(block.timestamp, cumulative));
        }
        vault = new GrantVault(TOKEN, beneficiary, address(this), CONTROLLER, terms);
        if (!TOKEN.approve(address(vault), amount)) revert ApprovalFailed();
        vault.fund();
        if (!TOKEN.approve(address(vault), 0)) revert ApprovalFailed();
        emit GrantCommitted(address(vault), beneficiary, amount);
        _entered = false;
    }

    /// @notice Gross commitments still inside the exact rolling window; no calendar resets.
    function rollingCommitted() public view returns (uint256) {
        uint256 count = _commitments.length;
        if (count == 0) return 0;
        uint256 total = _commitments[count - 1].cumulative;
        if (block.timestamp < WINDOW) return total;
        uint256 cutoff = block.timestamp - WINDOW;
        // Upper bound selects the last expired prefix in logarithmic time, without cleanup.
        uint256 low;
        uint256 high = count;
        while (low < high) {
            uint256 middle = low + (high - low) / 2;
            if (_commitments[middle].timestamp <= cutoff) low = middle + 1;
            else high = middle;
        }
        return total - (low == 0 ? 0 : _commitments[low - 1].cumulative);
    }

    function grossCommitted() external view returns (uint256) {
        uint256 count = _commitments.length;
        return count == 0 ? 0 : _commitments[count - 1].cumulative;
    }
}
