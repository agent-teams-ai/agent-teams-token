// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.36;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { GrantAccounting } from "../../../src/features/contributor-grants/GrantAccounting.sol";
import { GrantVault } from "../../../src/features/contributor-grants/GrantVault.sol";

contract VaultDeployer {
    function deploy(
        IERC20 token,
        address beneficiary,
        address reserve,
        address controller,
        GrantAccounting.Terms memory terms
    ) external returns (GrantVault) {
        return new GrantVault(token, beneficiary, reserve, controller, terms);
    }
}

contract ContractCaller {
    function approve(IERC20 token, address spender, uint256 amount) external {
        if (!token.approve(spender, amount)) revert();
    }

    function fund(GrantVault vault) external {
        vault.fund();
    }

    function cancel(GrantVault vault) external returns (uint256) {
        return vault.cancel();
    }
}

/// @dev Test-only ERC-20 failure and callback fixture. It deliberately permits inconsistent token
/// accounting so the vault's exact-delta checks can reject unsupported behavior.
contract HostileToken is IERC20 {
    enum Mode {
        Normal,
        RevertCall,
        FalseAfterMutation,
        EmptyReturn,
        ShortReturn,
        InvalidBoolReturn,
        TrueNoMovement,
        WrongDebit,
        WrongCredit,
        Reenter
    }

    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;
    uint256 private _supply;
    Mode public mode;
    address public callbackTarget;
    bytes public callbackData;
    bytes public callbackResult;

    function totalSupply() external view returns (uint256) {
        return _supply;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return _allowances[owner][spender];
    }

    function mint(address recipient, uint256 amount) external {
        _balances[recipient] += amount;
        _supply += amount;
    }

    function configure(Mode newMode, address target, bytes calldata data) external {
        mode = newMode;
        callbackTarget = target;
        callbackData = data;
        delete callbackResult;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, recipient, amount);
    }

    function transferFrom(address sender, address recipient, uint256 amount)
        external
        returns (bool)
    {
        uint256 approved = _allowances[sender][msg.sender];
        require(approved >= amount, "allowance");
        _allowances[sender][msg.sender] = approved - amount;
        emit Approval(sender, msg.sender, approved - amount);
        return _transfer(sender, recipient, amount);
    }

    function _transfer(address sender, address recipient, uint256 amount) private returns (bool) {
        if (mode == Mode.RevertCall) revert("hostile");
        if (mode == Mode.TrueNoMovement) return true;

        uint256 debit = amount;
        uint256 credit = amount;
        if (mode == Mode.WrongDebit && amount > 0) debit = amount - 1;
        if (mode == Mode.WrongCredit && amount > 0) credit = amount - 1;
        require(_balances[sender] >= debit, "balance");
        _balances[sender] -= debit;
        _balances[recipient] += credit;
        emit Transfer(sender, recipient, credit);

        if (mode == Mode.Reenter) {
            (, callbackResult) = callbackTarget.call(callbackData);
        }
        if (mode == Mode.FalseAfterMutation) return false;
        if (mode == Mode.EmptyReturn) {
            assembly ("memory-safe") {
                return(0, 0)
            }
        }
        if (mode == Mode.ShortReturn) {
            assembly ("memory-safe") {
                mstore(0, 1)
                return(31, 1)
            }
        }
        if (mode == Mode.InvalidBoolReturn) {
            assembly ("memory-safe") {
                mstore(0, 2)
                return(0, 32)
            }
        }
        return true;
    }
}
