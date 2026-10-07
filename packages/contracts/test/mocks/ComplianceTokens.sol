// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MockERC20} from "./MockERC20.sol";

/// @notice compliance() always reverts.
contract ComplianceRevertsToken is MockERC20 {
    constructor() MockERC20("Reverts", "REV") {}

    function compliance() external pure returns (address) {
        revert("compliance unavailable");
    }
}

/// @notice compliance() succeeds but returns no bytes: the selector falls through to an empty fallback.
contract EmptyReturnToken is MockERC20 {
    constructor() MockERC20("Empty", "EMP") {}

    fallback() external {}
}

/// @notice compliance() returns a real compliance contract's address with non-zero upper bits set.
contract DirtyAddressToken is MockERC20 {
    uint256 public immutable dirtyWord;

    constructor(address compliance_) MockERC20("Dirty", "DRT") {
        dirtyWord = (uint256(1) << 160) | uint256(uint160(compliance_));
    }

    function compliance() external view returns (uint256) {
        return dirtyWord;
    }
}

/// @notice compliance() returns 64 bytes: a real compliance contract's address followed by an extra word.
contract LongReturnToken is MockERC20 {
    address public immutable realCompliance;

    constructor(address compliance_) MockERC20("Long", "LNG") {
        realCompliance = compliance_;
    }

    function compliance() external view returns (address, uint256) {
        return (realCompliance, 1);
    }
}

/// @notice compliance() returns 1 MB of zeros, to prove the vault copies at most 64 bytes of it.
contract ReturnBombToken is MockERC20 {
    constructor() MockERC20("Bomb", "BMB") {}

    fallback() external {
        assembly ("memory-safe") {
            return(0, 1000000)
        }
    }
}
