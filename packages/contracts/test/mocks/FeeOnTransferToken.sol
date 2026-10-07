// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MockStockToken} from "./MockStockToken.sol";

/// @notice A stock-like token that skims `feeBps` of every transfer to FEE_SINK, so the receiver gets less than
///         the amount sent. 10,000 bps means the receiver gets nothing.
contract FeeOnTransferToken is MockStockToken {
    address public constant FEE_SINK = address(0xFEE5);

    uint256 public feeBps;

    constructor(address compliance_, uint256 feeBps_) MockStockToken("Fee Stock", "FEEB", compliance_) {
        feeBps = feeBps_;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = value * feeBps / 10_000;
        super._update(from, FEE_SINK, fee);
        super._update(from, to, value - fee);
    }
}
