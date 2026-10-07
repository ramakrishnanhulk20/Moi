// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {GiftVault} from "../src/GiftVault.sol";
import {MockCompliance} from "./mocks/MockCompliance.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";

/// @notice Shared deployment for the GiftVault suites: a blocklist compliance contract, one bStock-like token
///         listed in the vault, a funded sender who has approved the vault, and signing shortcuts.
abstract contract GiftVaultFixture is Test {
    uint256 internal constant START_TIME = 1_760_000_000;
    uint256 internal constant AMOUNT = 0.05 ether;
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    bytes internal constant NOTE = hex"a1b2c3d4e5f60718293a4b5c6d7e8f90";

    GiftVault internal vault;
    MockCompliance internal compliance;
    MockStockToken internal stock;

    address internal owner;
    address internal relayer;
    address internal sender;
    address internal friend;
    uint256 private _keyNonce;

    function setUp() public virtual {
        vm.warp(START_TIME);
        owner = makeAddr("owner");
        relayer = makeAddr("relayer");
        sender = makeAddr("sender");
        friend = makeAddr("friend");

        compliance = new MockCompliance();
        stock = new MockStockToken("Nvidia bStock", "NVDAB", address(compliance));
        vault = _deployVault(address(stock));
        _fund(stock, sender, 1_000 ether);
    }

    function _deployVault(address token) internal returns (GiftVault deployed) {
        address[] memory tokens = new address[](1);
        tokens[0] = token;
        deployed = new GiftVault(owner, relayer, tokens);
    }

    function _fund(MockStockToken token, address who, uint256 amount) internal {
        token.mint(who, amount);
        vm.prank(who);
        token.approve(address(vault), type(uint256).max);
    }

    function _newKey() internal returns (address key, uint256 pk) {
        _keyNonce++;
        (key, pk) = makeAddrAndKey(string.concat("claim-key-", vm.toString(_keyNonce)));
    }

    function _expiry() internal view returns (uint64) {
        return uint64(block.timestamp + 7 days);
    }

    function _createGift(address token, uint256 amount) internal returns (uint256 giftId, uint256 pk) {
        address key;
        (key, pk) = _newKey();
        bytes memory proof = _keyProof(pk, sender);
        vm.prank(sender);
        giftId = vault.createGift(token, amount, key, _expiry(), NOTE, proof);
    }

    function _createGift() internal returns (uint256 giftId, uint256 pk) {
        return _createGift(address(stock), AMOUNT);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Reads the vault, so call it before vm.prank or vm.expectRevert, never inside the pranked call's arguments.
    function _keyProof(uint256 pk, address who) internal view returns (bytes memory) {
        return _sign(pk, vault.registerDigest(who));
    }

    function _claimSig(uint256 pk, uint256 giftId, address recipient) internal view returns (bytes memory) {
        return _sign(pk, vault.claimDigest(giftId, recipient));
    }

    function _claim(uint256 giftId, address recipient, bytes memory signature) internal {
        vm.prank(relayer);
        vault.claim(giftId, recipient, signature);
    }

    function _state(uint256 giftId) internal view returns (GiftVault.State) {
        return vault.getGift(giftId).state;
    }
}
