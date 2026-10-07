// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Fuzzes the money and key paths one call at a time: createGift amounts, expiries and fees (C3, C4), createGift
// key proofs from random signatures, which must never register a key (C32), and claim signatures from random
// bytes and random keys, which must never succeed unless signed by the stored claim key (C2). Runs come from
// foundry.toml ([fuzz] runs = 10000).
// Does NOT cover: sequences of calls (test/GiftVault.invariant.t.sol), hostile callbacks
// (test/Reentrancy.t.sol), or the real bStock on BSC (WO-2b fork tests).

import {GiftVault} from "../src/GiftVault.sol";
import {GiftVaultFixture} from "./GiftVaultFixture.sol";
import {FeeOnTransferToken} from "./mocks/FeeOnTransferToken.sol";

contract GiftVaultFuzzTest is GiftVaultFixture {
    uint256 internal constant MAX_AMOUNT = 1e30;

    function _validRecipient(address recipient) internal view {
        vm.assume(recipient != address(0) && recipient != address(vault));
    }

    function testFuzz_createGift_recordsAmountAndExpiryInsideWindow(uint256 amount, uint64 lifetime) public {
        amount = bound(amount, 1, MAX_AMOUNT);
        lifetime = uint64(bound(lifetime, vault.MIN_LIFETIME(), vault.MAX_LIFETIME()));
        stock.mint(sender, amount);
        (address key, uint256 pk) = _newKey();
        uint64 expiry = uint64(block.timestamp) + lifetime;
        bytes memory proof = _keyProof(pk, sender);

        vm.prank(sender);
        uint256 giftId = vault.createGift(address(stock), amount, key, expiry, NOTE, proof);

        GiftVault.Gift memory gift = vault.getGift(giftId);
        assertEq(gift.amount, amount);
        assertEq(gift.expiry, expiry);
        assertEq(vault.liabilities(address(stock)), amount);
        assertEq(stock.balanceOf(address(vault)), amount);
    }

    function testFuzz_createGift_rejectsExpiryOutsideWindow(uint64 expiry) public {
        vm.assume(expiry < block.timestamp + 1 hours || expiry > block.timestamp + 90 days);
        (address key, uint256 pk) = _newKey();
        bytes memory proof = _keyProof(pk, sender);
        vm.prank(sender);
        vm.expectRevert(GiftVault.ExpiryOutOfRange.selector);
        vault.createGift(address(stock), AMOUNT, key, expiry, NOTE, proof);
    }

    function testFuzz_createGift_feeTokenRecordsReceivedAmount(uint256 amount, uint256 feeBps) public {
        amount = bound(amount, 1, MAX_AMOUNT);
        feeBps = bound(feeBps, 0, 10_000);
        FeeOnTransferToken feeToken = new FeeOnTransferToken(address(compliance), feeBps);
        vm.prank(owner);
        vault.setTokenListed(address(feeToken), true);
        _fund(feeToken, sender, amount);
        uint256 received = amount - amount * feeBps / 10_000;
        (address key, uint256 pk) = _newKey();
        uint64 expiry = _expiry();
        bytes memory proof = _keyProof(pk, sender);

        vm.prank(sender);
        if (received == 0) {
            vm.expectRevert(GiftVault.NoAmountReceived.selector);
            vault.createGift(address(feeToken), amount, key, expiry, NOTE, proof);
            return;
        }
        uint256 giftId = vault.createGift(address(feeToken), amount, key, expiry, NOTE, proof);
        assertEq(vault.getGift(giftId).amount, received);
        assertEq(vault.liabilities(address(feeToken)), received);
        assertEq(feeToken.balanceOf(address(vault)), received);
    }

    function testFuzz_C32_randomProofNeverRegistersKey(bytes32 r, bytes32 s, uint8 v) public {
        (address key,) = _newKey();
        uint64 expiry = _expiry();
        uint256 senderBefore = stock.balanceOf(sender);

        vm.prank(sender);
        try vault.createGift(address(stock), AMOUNT, key, expiry, NOTE, abi.encodePacked(r, s, v)) {
            fail();
        } catch {}
        assertFalse(vault.claimKeyUsed(key));
        assertEq(vault.nextGiftId(), 1);
        assertEq(stock.balanceOf(sender), senderBefore);
    }

    function testFuzz_claim_randomBytesNeverSucceed(bytes calldata signature) public {
        (uint256 giftId,) = _createGift();
        vm.prank(relayer);
        try vault.claim(giftId, friend, signature) {
            fail();
        } catch {}
        assertEq(uint8(_state(giftId)), uint8(GiftVault.State.Open));
        assertEq(stock.balanceOf(friend), 0);
    }

    function testFuzz_claim_random65ByteSignatureNeverSucceeds(bytes32 r, bytes32 s, uint8 v) public {
        (uint256 giftId,) = _createGift();
        vm.prank(relayer);
        try vault.claim(giftId, friend, abi.encodePacked(r, s, v)) {
            fail();
        } catch {}
        assertEq(uint8(_state(giftId)), uint8(GiftVault.State.Open));
    }

    function testFuzz_claim_wrongKeyNeverSucceeds(uint256 wrongPk, address recipient) public {
        _validRecipient(recipient);
        (uint256 giftId, uint256 pk) = _createGift();
        wrongPk = bound(wrongPk, 1, SECP256K1_N - 1);
        vm.assume(wrongPk != pk);
        bytes memory sig = _claimSig(wrongPk, giftId, recipient);
        vm.prank(relayer);
        vm.expectRevert(GiftVault.BadSigner.selector);
        vault.claim(giftId, recipient, sig);
    }

    function testFuzz_claim_storedKeySucceedsForAnyRecipient(uint256 pk, address recipient) public {
        _validRecipient(recipient);
        pk = bound(pk, 1, SECP256K1_N - 1);
        address key = vm.addr(pk);
        vm.assume(!vault.claimKeyUsed(key));
        bytes memory proof = _keyProof(pk, sender);
        vm.prank(sender);
        uint256 giftId = vault.createGift(address(stock), AMOUNT, key, _expiry(), NOTE, proof);
        uint256 before = stock.balanceOf(recipient);

        _claim(giftId, recipient, _claimSig(pk, giftId, recipient));

        assertEq(stock.balanceOf(recipient), before + AMOUNT);
        assertEq(uint8(_state(giftId)), uint8(GiftVault.State.Claimed));
        assertEq(vault.liabilities(address(stock)), 0);
    }
}
