// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICompliance} from "../../src/GiftVault.sol";

/// @notice The bStock compliance contract reduced to its per-token blocklist (Compliance at 0x53dBa7Aa...14F4).
contract MockCompliance is ICompliance {
    error UserBlocked();

    mapping(address token => mapping(address user => bool)) public blocked;

    function setBlocked(address token, address user, bool isBlocked) external {
        blocked[token][user] = isBlocked;
    }

    function checkIsCompliant(address token, address user) external view {
        if (blocked[token][user]) revert UserBlocked();
    }
}

/// @notice A compliance contract that reverts with a 1 MB payload, to prove the vault does not copy it.
contract RevertBombCompliance is ICompliance {
    function checkIsCompliant(address, address) external pure {
        assembly ("memory-safe") {
            revert(0, 1000000)
        }
    }
}
