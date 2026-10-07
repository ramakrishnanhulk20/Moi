// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ICompliance} from "../../src/GiftVault.sol";

/// @notice Behaves like a bStock (SecuritiesToken at 0xCFEd6c46...4e46): every transfer, mint and burn first
///         checks the pause switch, then asks the compliance contract about the third-party spender (only when
///         the caller is neither side), the sender and the receiver. Unlike the real token, a zero compliance
///         address skips the checks, so a test can model a token whose compliance() returns zero.
contract MockStockToken is ERC20 {
    error TokenPaused();

    address public compliance;
    bool public paused;

    constructor(string memory name_, string memory symbol_, address compliance_) ERC20(name_, symbol_) {
        compliance = compliance_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setPaused(bool paused_) external {
        paused = paused_;
    }

    function setCompliance(address compliance_) external {
        compliance = compliance_;
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (paused) revert TokenPaused();
        if (compliance != address(0)) {
            if (from != msg.sender && to != msg.sender) {
                ICompliance(compliance).checkIsCompliant(address(this), msg.sender);
            }
            if (from != address(0)) ICompliance(compliance).checkIsCompliant(address(this), from);
            if (to != address(0)) ICompliance(compliance).checkIsCompliant(address(this), to);
        }
        super._update(from, to, value);
    }
}
