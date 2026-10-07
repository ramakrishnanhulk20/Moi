// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MockStockToken} from "./MockStockToken.sol";

/// @notice A stock-like token that, once armed, calls `target` with `payload` from inside its next transfer,
///         before any balance moves, the way a hostile beacon upgrade could. It records how the call ended
///         instead of bubbling it, so the outer call can finish and the test can inspect both.
contract ReentrantToken is MockStockToken {
    address public target;
    bytes public payload;
    bool public armed;
    bool public reentryAttempted;
    bool public reentrySucceeded;
    bytes public reentryReturnData;

    constructor(address compliance_) MockStockToken("Reentrant", "RENT", compliance_) {}

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        armed = true;
        reentryAttempted = false;
        reentrySucceeded = false;
        delete reentryReturnData;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (armed && from != address(0)) {
            armed = false;
            reentryAttempted = true;
            (bool ok, bytes memory returned) = target.call(payload);
            reentrySucceeded = ok;
            reentryReturnData = returned;
        }
        super._update(from, to, value);
    }
}
