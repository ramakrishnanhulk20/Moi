// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// C1 under a hostile listed token: the token calls back into claim, refund, createGift and rescueSurplus from
// inside its own transfer, and every reentry must revert while the outer call pays exactly once.
// Does NOT cover: callbacks fired after the balance moves (the guard does not depend on timing, so one
// position is enough), read-only reentrancy by a third contract reading vault views mid-transfer (the vault
// updates state before every transfer), or a token that breaks its own accounting (threat model N3).

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {GiftVault} from "../src/GiftVault.sol";
import {GiftVaultFixture} from "./GiftVaultFixture.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";

contract ReentrancyTest is GiftVaultFixture {
    ReentrantToken internal hostile;

    function setUp() public override {
        super.setUp();
        hostile = new ReentrantToken(address(compliance));
        vm.prank(owner);
        vault.setTokenListed(address(hostile), true);
        _fund(hostile, sender, 1_000 ether);
    }

    function _assertReentryBlocked() internal view {
        assertTrue(hostile.reentryAttempted());
        assertFalse(hostile.reentrySucceeded());
        assertEq(
            hostile.reentryReturnData(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
        );
    }

    function test_C1_reentryIntoClaimDuringClaimReverts() public {
        (uint256 giftId, uint256 pk) = _createGift(address(hostile), AMOUNT);
        bytes memory sig = _claimSig(pk, giftId, friend);
        hostile.arm(address(vault), abi.encodeCall(GiftVault.claim, (giftId, friend, sig)));

        _claim(giftId, friend, sig);

        _assertReentryBlocked();
        assertEq(hostile.balanceOf(friend), AMOUNT);
        assertEq(hostile.balanceOf(address(vault)), 0);
        assertEq(vault.liabilities(address(hostile)), 0);
        assertEq(uint8(_state(giftId)), uint8(GiftVault.State.Claimed));
    }

    function test_C1_reentryIntoRefundDuringClaimReverts() public {
        (uint256 giftId, uint256 pk) = _createGift(address(hostile), AMOUNT);
        hostile.arm(address(vault), abi.encodeCall(GiftVault.refund, (giftId)));

        _claim(giftId, friend, _claimSig(pk, giftId, friend));

        _assertReentryBlocked();
        assertEq(hostile.balanceOf(friend), AMOUNT);
        assertEq(hostile.balanceOf(sender), 1_000 ether - AMOUNT);
    }

    function test_C1_reentryIntoAnotherGiftsClaimDuringClaimReverts() public {
        (uint256 first, uint256 firstPk) = _createGift(address(hostile), AMOUNT);
        (uint256 second, uint256 secondPk) = _createGift(address(hostile), AMOUNT);
        bytes memory secondSig = _claimSig(secondPk, second, friend);
        hostile.arm(address(vault), abi.encodeCall(GiftVault.claim, (second, friend, secondSig)));

        _claim(first, friend, _claimSig(firstPk, first, friend));

        _assertReentryBlocked();
        assertEq(hostile.balanceOf(friend), AMOUNT);
        assertEq(uint8(_state(second)), uint8(GiftVault.State.Open));
        assertEq(vault.liabilities(address(hostile)), AMOUNT);

        _claim(second, friend, secondSig);
        assertEq(hostile.balanceOf(friend), 2 * AMOUNT);
        assertEq(vault.liabilities(address(hostile)), 0);
    }

    function test_C1_reentryIntoClaimDuringRefundReverts() public {
        (uint256 giftId, uint256 pk) = _createGift(address(hostile), AMOUNT);
        bytes memory sig = _claimSig(pk, giftId, friend);
        vm.warp(vault.getGift(giftId).expiry);
        hostile.arm(address(vault), abi.encodeCall(GiftVault.claim, (giftId, friend, sig)));

        vault.refund(giftId);

        _assertReentryBlocked();
        assertEq(hostile.balanceOf(sender), 1_000 ether);
        assertEq(hostile.balanceOf(friend), 0);
        assertEq(uint8(_state(giftId)), uint8(GiftVault.State.Refunded));
    }

    function test_C1_reentryIntoRefundDuringRefundReverts() public {
        (uint256 giftId,) = _createGift(address(hostile), AMOUNT);
        vm.warp(vault.getGift(giftId).expiry);
        hostile.arm(address(vault), abi.encodeCall(GiftVault.refund, (giftId)));

        vault.refund(giftId);

        _assertReentryBlocked();
        assertEq(hostile.balanceOf(sender), 1_000 ether);
        assertEq(hostile.balanceOf(address(vault)), 0);
    }

    function test_C1_reentryIntoCreateGiftDuringCreateGiftReverts() public {
        (address innerKey, uint256 innerPk) = _newKey();
        (address outerKey, uint256 outerPk) = _newKey();
        uint64 expiry = _expiry();
        // The inner proof names the hostile token, the real caller of the reentrant call, so only the guard can
        // stop it.
        bytes memory innerProof = _keyProof(innerPk, address(hostile));
        bytes memory outerProof = _keyProof(outerPk, sender);
        hostile.arm(
            address(vault),
            abi.encodeCall(GiftVault.createGift, (address(hostile), AMOUNT, innerKey, expiry, NOTE, innerProof))
        );

        vm.prank(sender);
        uint256 giftId = vault.createGift(address(hostile), AMOUNT, outerKey, expiry, NOTE, outerProof);

        _assertReentryBlocked();
        assertEq(giftId, 1);
        assertEq(vault.nextGiftId(), 2);
        assertFalse(vault.claimKeyUsed(innerKey));
        assertEq(vault.getGift(giftId).amount, AMOUNT);
        assertEq(vault.liabilities(address(hostile)), AMOUNT);
        assertEq(hostile.balanceOf(address(vault)), AMOUNT);
    }

    function test_C1_reentryIntoClaimDuringCreateGiftReverts() public {
        (uint256 existing, uint256 pk) = _createGift(address(hostile), AMOUNT);
        bytes memory sig = _claimSig(pk, existing, friend);
        hostile.arm(address(vault), abi.encodeCall(GiftVault.claim, (existing, friend, sig)));

        (uint256 created,) = _createGift(address(hostile), AMOUNT);

        _assertReentryBlocked();
        assertEq(uint8(_state(existing)), uint8(GiftVault.State.Open));
        assertEq(uint8(_state(created)), uint8(GiftVault.State.Open));
        assertEq(hostile.balanceOf(friend), 0);
        assertEq(vault.liabilities(address(hostile)), 2 * AMOUNT);
    }

    function test_C1_reentryIntoRescueDuringClaimReverts() public {
        (uint256 giftId, uint256 pk) = _createGift(address(hostile), AMOUNT);
        hostile.arm(address(vault), abi.encodeCall(GiftVault.rescueSurplus, (address(hostile), address(hostile))));

        _claim(giftId, friend, _claimSig(pk, giftId, friend));

        _assertReentryBlocked();
        assertEq(hostile.balanceOf(address(hostile)), 0);
        assertEq(hostile.balanceOf(friend), AMOUNT);
    }
}
