// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Unit tests for every GiftVault function, error and event, grouped by threat model rule.
// Does NOT cover: the real bStock contracts on BSC (fork tests are WO-2b), reentrancy through a callback
// token (test/Reentrancy.t.sol), random inputs (test/GiftVault.fuzz.t.sol), long random call sequences
// (test/GiftVault.invariant.t.sol), the relayer's off-chain behaviour, how claim keys are generated
// and kept secret off chain, or a real mempool race (C32 replays the victim's exact arguments from another
// address instead).

import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {GiftVault} from "../src/GiftVault.sol";
import {GiftVaultFixture} from "./GiftVaultFixture.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";
import {FeeOnTransferToken} from "./mocks/FeeOnTransferToken.sol";
import {MockCompliance, RevertBombCompliance} from "./mocks/MockCompliance.sol";
import {
    ComplianceRevertsToken,
    EmptyReturnToken,
    DirtyAddressToken,
    LongReturnToken,
    ReturnBombToken
} from "./mocks/ComplianceTokens.sol";

contract GiftVaultTest is GiftVaultFixture {
    address internal stranger;

    function setUp() public override {
        super.setUp();
        stranger = makeAddr("stranger");
    }

    function _listAndFund(MockERC20 token) internal {
        vm.prank(owner);
        vault.setTokenListed(address(token), true);
        token.mint(sender, 1_000 ether);
        vm.prank(sender);
        token.approve(address(vault), type(uint256).max);
    }

    function _assertBlocked(uint256 giftId, uint256 pk) internal {
        assertFalse(vault.senderIsCompliant(giftId));
        bytes memory sig = _claimSig(pk, giftId, friend);
        vm.prank(relayer);
        vm.expectRevert(GiftVault.SenderNotCompliant.selector);
        vault.claim(giftId, friend, sig);
        assertEq(uint8(_state(giftId)), uint8(GiftVault.State.Open));
    }

    // Constructor and views

    function test_constructor_setsStateAndEmits() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(stock);
        vm.expectEmit(true, true, true, true);
        emit Ownable.OwnershipTransferred(address(0), owner);
        vm.expectEmit(true, true, true, true);
        emit GiftVault.RelayerSet(address(0), relayer);
        vm.expectEmit(true, true, true, true);
        emit GiftVault.TokenListed(address(stock), true);
        GiftVault fresh = new GiftVault(owner, relayer, tokens);

        assertEq(fresh.owner(), owner);
        assertEq(fresh.relayer(), relayer);
        assertEq(fresh.nextGiftId(), 1);
        assertTrue(fresh.isListed(address(stock)));
        assertEq(fresh.listedTokens().length, 1);
        assertEq(fresh.MAX_NOTE_BYTES(), 512);
        assertEq(fresh.MIN_LIFETIME(), 1 hours);
        assertEq(fresh.MAX_LIFETIME(), 90 days);
        assertEq(fresh.MAX_TOKENS(), 32);
        assertEq(fresh.CLAIM_TYPEHASH(), keccak256("Claim(uint256 giftId,address recipient)"));
        (, string memory name, string memory version, uint256 chainId, address verifying,,) = fresh.eip712Domain();
        assertEq(name, "Moi");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifying, address(fresh));
    }

    function test_constructor_revertsZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new GiftVault(address(0), relayer, new address[](0));
    }

    function test_constructor_revertsZeroRelayer() public {
        vm.expectRevert(GiftVault.ZeroAddress.selector);
        new GiftVault(owner, address(0), new address[](0));
    }

    function test_constructor_revertsZeroToken() public {
        address[] memory tokens = new address[](1);
        vm.expectRevert(GiftVault.ZeroAddress.selector);
        new GiftVault(owner, relayer, tokens);
    }

    function test_constructor_revertsMoreThanMaxTokens() public {
        address[] memory tokens = new address[](33);
        for (uint256 i = 0; i < tokens.length; ++i) {
            tokens[i] = address(uint160(0x1000 + i));
        }
        vm.expectRevert(GiftVault.TooManyTokens.selector);
        new GiftVault(owner, relayer, tokens);
    }

    function test_constructor_listsDuplicateTokenOnce() public {
        address[] memory tokens = new address[](2);
        tokens[0] = address(stock);
        tokens[1] = address(stock);
        GiftVault fresh = new GiftVault(owner, relayer, tokens);
        assertEq(fresh.listedTokens().length, 1);
    }

    function test_getGift_unknownIdReturnsEmptyRecord() public view {
        GiftVault.Gift memory gift = vault.getGift(0);
        assertEq(uint8(gift.state), uint8(GiftVault.State.None));
        assertEq(gift.token, address(0));
        assertEq(gift.amount, 0);
    }

    // createGift

    function test_createGift_storesGiftPullsTokensAndEmits() public {
        (address key, uint256 pk) = _newKey();
        uint64 expiry = _expiry();
        bytes memory proof = _keyProof(pk, sender);
        vm.expectEmit(true, true, true, true, address(vault));
        emit GiftVault.GiftCreated(1, address(stock), sender, key, AMOUNT, expiry);
        vm.prank(sender);
        uint256 giftId = vault.createGift(address(stock), AMOUNT, key, expiry, NOTE, proof);

        assertEq(giftId, 1);
        assertEq(vault.nextGiftId(), 2);
        GiftVault.Gift memory gift = vault.getGift(giftId);
        assertEq(gift.token, address(stock));
        assertEq(gift.sender, sender);
        assertEq(gift.claimKey, key);
        assertEq(gift.expiry, expiry);
        assertEq(uint8(gift.state), uint8(GiftVault.State.Open));
        assertEq(gift.amount, AMOUNT);
        assertEq(gift.sealedNote, NOTE);
        assertTrue(vault.claimKeyUsed(key));
        assertEq(vault.liabilities(address(stock)), AMOUNT);
        assertEq(stock.balanceOf(address(vault)), AMOUNT);

        (uint256 second,) = _createGift();
        assertEq(second, 2);
        assertEq(vault.liabilities(address(stock)), 2 * AMOUNT);
    }

    // C3: no keyless, shared-key, empty, unlisted, out-of-window or oversized gift

    function test_C3_createGift_revertsUnlistedToken() public {
        MockERC20 other = new MockERC20("Other", "OTH");
        (address key, uint256 pk) = _newKey();
        uint64 expiry = _expiry();
        bytes memory proof = _keyProof(pk, sender);
        vm.prank(sender);
        vm.expectRevert(GiftVault.TokenNotListed.selector);
        vault.createGift(address(other), AMOUNT, key, expiry, NOTE, proof);
    }

    function test_C3_createGift_revertsZeroAmount() public {
        (address key, uint256 pk) = _newKey();
        uint64 expiry = _expiry();
        bytes memory proof = _keyProof(pk, sender);
        vm.prank(sender);
        vm.expectRevert(GiftVault.ZeroAmount.selector);
        vault.createGift(address(stock), 0, key, expiry, NOTE, proof);
    }

    function test_C3_createGift_revertsZeroClaimKey() public {
        uint64 expiry = _expiry();
        vm.prank(sender);
        vm.expectRevert(GiftVault.ZeroClaimKey.selector);
        vault.createGift(address(stock), AMOUNT, address(0), expiry, NOTE, "");
    }

    function test_C3_createGift_revertsReusedClaimKey() public {
        (address key, uint256 pk) = _newKey();
        uint64 expiry = _expiry();
        bytes memory proof = _keyProof(pk, sender);
        vm.prank(sender);
        vault.createGift(address(stock), AMOUNT, key, expiry, NOTE, proof);
        vm.prank(sender);
        vm.expectRevert(GiftVault.ClaimKeyAlreadyUsed.selector);
        vault.createGift(address(stock), AMOUNT, key, expiry, NOTE, proof);
    }

    function test_C3_createGift_revertsExpiryTooSoon() public {
        (address key, uint256 pk) = _newKey();
        uint64 expiry = uint64(block.timestamp + 1 hours - 1);
        bytes memory proof = _keyProof(pk, sender);
        vm.prank(sender);
        vm.expectRevert(GiftVault.ExpiryOutOfRange.selector);
        vault.createGift(address(stock), AMOUNT, key, expiry, NOTE, proof);
    }

    function test_C3_createGift_revertsExpiryTooLate() public {
        (address key, uint256 pk) = _newKey();
        uint64 expiry = uint64(block.timestamp + 90 days + 1);
        bytes memory proof = _keyProof(pk, sender);
        vm.prank(sender);
        vm.expectRevert(GiftVault.ExpiryOutOfRange.selector);
        vault.createGift(address(stock), AMOUNT, key, expiry, NOTE, proof);
    }

    function test_C3_createGift_revertsExpiryInMilliseconds() public {
        (address key, uint256 pk) = _newKey();
        uint64 expiryMs = uint64((block.timestamp + 7 days) * 1000);
        bytes memory proof = _keyProof(pk, sender);
        vm.prank(sender);
        vm.expectRevert(GiftVault.ExpiryOutOfRange.selector);
        vault.createGift(address(stock), AMOUNT, key, expiryMs, NOTE, proof);
    }

    function test_C3_createGift_revertsNoteOf513Bytes() public {
        (address key, uint256 pk) = _newKey();
        uint64 expiry = _expiry();
        bytes memory note = new bytes(513);
        bytes memory proof = _keyProof(pk, sender);
        vm.prank(sender);
        vm.expectRevert(GiftVault.NoteTooLong.selector);
        vault.createGift(address(stock), AMOUNT, key, expiry, note, proof);
    }

    function test_C3_createGift_acceptsWindowEdgesAnd512ByteNote() public {
        (address keyA, uint256 pkA) = _newKey();
        (address keyB, uint256 pkB) = _newKey();
        bytes memory note = new bytes(512);
        for (uint256 i = 0; i < note.length; ++i) {
            note[i] = bytes1(uint8(i % 255) + 1);
        }
        bytes memory proofA = _keyProof(pkA, sender);
        bytes memory proofB = _keyProof(pkB, sender);
        vm.startPrank(sender);
        uint256 shortest =
            vault.createGift(address(stock), AMOUNT, keyA, uint64(block.timestamp + 1 hours), note, proofA);
        uint256 longest = vault.createGift(address(stock), AMOUNT, keyB, uint64(block.timestamp + 90 days), "", proofB);
        vm.stopPrank();
        assertEq(vault.getGift(shortest).sealedNote.length, 512);
        assertEq(vault.getGift(longest).expiry, block.timestamp + 90 days);
    }

    function test_C3_createGift_revertsNoAmountReceived() public {
        FeeOnTransferToken takesAll = new FeeOnTransferToken(address(compliance), 10_000);
        vm.prank(owner);
        vault.setTokenListed(address(takesAll), true);
        _fund(takesAll, sender, 1 ether);
        (address key, uint256 pk) = _newKey();
        uint64 expiry = _expiry();
        bytes memory proof = _keyProof(pk, sender);
        vm.prank(sender);
        vm.expectRevert(GiftVault.NoAmountReceived.selector);
        vault.createGift(address(takesAll), AMOUNT, key, expiry, NOTE, proof);
    }

    // C4: a gift records what the vault actually received

    function test_C4_feeOnTransferRecordsReceivedAmount() public {
        FeeOnTransferToken feeToken = new FeeOnTransferToken(address(compliance), 100);
        vm.prank(owner);
        vault.setTokenListed(address(feeToken), true);
        _fund(feeToken, sender, 1 ether);

        uint256 received = AMOUNT - AMOUNT / 100;
        (address key, uint256 pk) = _newKey();
        uint64 expiry = _expiry();
        bytes memory proof = _keyProof(pk, sender);
        vm.expectEmit(true, true, true, true, address(vault));
        emit GiftVault.GiftCreated(1, address(feeToken), sender, key, received, expiry);
        vm.prank(sender);
        uint256 giftId = vault.createGift(address(feeToken), AMOUNT, key, expiry, NOTE, proof);

        assertEq(vault.getGift(giftId).amount, received);
        assertEq(vault.liabilities(address(feeToken)), received);
        assertEq(feeToken.balanceOf(address(vault)), received);

        _claim(giftId, friend, _claimSig(pk, giftId, friend));
        assertEq(vault.liabilities(address(feeToken)), 0);
        assertEq(feeToken.balanceOf(address(vault)), 0);
    }

    // C32: a claim key registers only for the sender its holder signed for, so nobody can burn it first

    function test_C32_preemptionWithCopiedProofReverts() public {
        (address key, uint256 pk) = _newKey();
        uint64 expiry = _expiry();
        bytes memory proof = _keyProof(pk, sender);
        // The attacker is funded and has approved the vault, so the proof is the only thing that can stop it.
        _fund(stock, stranger, 1_000 ether);

        vm.prank(stranger);
        vm.expectRevert(GiftVault.BadKeyProof.selector);
        vault.createGift(address(stock), AMOUNT, key, expiry, NOTE, proof);
        assertFalse(vault.claimKeyUsed(key));
        assertEq(vault.nextGiftId(), 1);
        assertEq(stock.balanceOf(stranger), 1_000 ether);

        vm.prank(sender);
        uint256 giftId = vault.createGift(address(stock), AMOUNT, key, expiry, NOTE, proof);
        assertEq(vault.getGift(giftId).sender, sender);
        assertTrue(vault.claimKeyUsed(key));
        _claim(giftId, friend, _claimSig(pk, giftId, friend));
        assertEq(stock.balanceOf(friend), AMOUNT);
    }

    function test_C32_proofForOtherSenderReverts() public {
        (address key, uint256 pk) = _newKey();
        uint64 expiry = _expiry();
        bytes memory proofForStranger = _keyProof(pk, stranger);

        vm.prank(sender);
        vm.expectRevert(GiftVault.BadKeyProof.selector);
        vault.createGift(address(stock), AMOUNT, key, expiry, NOTE, proofForStranger);
        assertFalse(vault.claimKeyUsed(key));

        // The same proof is sound: it works for the one address it names.
        _fund(stock, stranger, 1_000 ether);
        vm.prank(stranger);
        uint256 giftId = vault.createGift(address(stock), AMOUNT, key, expiry, NOTE, proofForStranger);
        assertEq(vault.getGift(giftId).sender, stranger);
    }

    function test_C32_proofFromOtherKeyReverts() public {
        (address key,) = _newKey();
        (, uint256 otherPk) = _newKey();
        uint64 expiry = _expiry();
        bytes memory proof = _keyProof(otherPk, sender);

        vm.prank(sender);
        vm.expectRevert(GiftVault.BadKeyProof.selector);
        vault.createGift(address(stock), AMOUNT, key, expiry, NOTE, proof);
        assertFalse(vault.claimKeyUsed(key));
    }

    function test_C32_proofFromOtherVaultOrChainReverts() public {
        GiftVault otherVault = _deployVault(address(stock));
        (address key, uint256 pk) = _newKey();
        uint64 expiry = _expiry();
        bytes32 otherVaultDigest = otherVault.registerDigest(sender);
        assertTrue(otherVaultDigest != vault.registerDigest(sender));
        bytes memory otherVaultProof = _sign(pk, otherVaultDigest);

        uint256 homeChain = block.chainid;
        vm.chainId(97);
        bytes32 foreignDigest = vault.registerDigest(sender);
        bytes memory foreignProof = _sign(pk, foreignDigest);
        vm.chainId(homeChain);
        assertTrue(foreignDigest != vault.registerDigest(sender));

        vm.prank(sender);
        vm.expectRevert(GiftVault.BadKeyProof.selector);
        vault.createGift(address(stock), AMOUNT, key, expiry, NOTE, otherVaultProof);
        vm.prank(sender);
        vm.expectRevert(GiftVault.BadKeyProof.selector);
        vault.createGift(address(stock), AMOUNT, key, expiry, NOTE, foreignProof);

        bytes memory homeProof = _keyProof(pk, sender);
        vm.chainId(56);
        vm.prank(sender);
        vm.expectRevert(GiftVault.BadKeyProof.selector);
        vault.createGift(address(stock), AMOUNT, key, expiry, NOTE, homeProof);
        assertFalse(vault.claimKeyUsed(key));

        vm.chainId(homeChain);
        vm.prank(sender);
        vault.createGift(address(stock), AMOUNT, key, expiry, NOTE, homeProof);
        assertTrue(vault.claimKeyUsed(key));
    }

    function test_C32_malformedProofReverts() public {
        (address key, uint256 pk) = _newKey();
        uint64 expiry = _expiry();
        bytes32 digest = vault.registerDigest(sender);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));
        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        assertEq(ecrecover(digest, flippedV, r, highS), key);

        vm.startPrank(sender);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 64));
        vault.createGift(address(stock), AMOUNT, key, expiry, NOTE, abi.encodePacked(r, vs));
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 66));
        vault.createGift(address(stock), AMOUNT, key, expiry, NOTE, abi.encodePacked(r, s, v, uint8(0)));
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, highS));
        vault.createGift(address(stock), AMOUNT, key, expiry, NOTE, abi.encodePacked(r, highS, flippedV));
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 0));
        vault.createGift(address(stock), AMOUNT, key, expiry, NOTE, "");
        vm.stopPrank();

        assertFalse(vault.claimKeyUsed(key));
        assertEq(stock.balanceOf(address(vault)), 0);
    }

    // claim

    function test_claim_paysRecipientAndEmits() public {
        (uint256 giftId, uint256 pk) = _createGift();
        bytes memory sig = _claimSig(pk, giftId, friend);
        vm.expectEmit(true, true, true, true, address(vault));
        emit GiftVault.GiftClaimed(giftId, friend, AMOUNT);
        _claim(giftId, friend, sig);

        assertEq(uint8(_state(giftId)), uint8(GiftVault.State.Claimed));
        assertEq(stock.balanceOf(friend), AMOUNT);
        assertEq(stock.balanceOf(address(vault)), 0);
        assertEq(vault.liabilities(address(stock)), 0);
    }

    function test_claim_revertsForUnknownGift() public {
        (, uint256 pk) = _newKey();
        bytes memory sig = _claimSig(pk, 0, friend);
        vm.prank(relayer);
        vm.expectRevert(GiftVault.GiftNotOpen.selector);
        vault.claim(0, friend, sig);
        sig = _claimSig(pk, 99, friend);
        vm.prank(relayer);
        vm.expectRevert(GiftVault.GiftNotOpen.selector);
        vault.claim(99, friend, sig);
    }

    // C31: only the relayer submits claims

    function test_C31_claimRevertsUnlessRelayer() public {
        (uint256 giftId, uint256 pk) = _createGift();
        bytes memory sig = _claimSig(pk, giftId, friend);
        address[4] memory callers = [friend, sender, owner, stranger];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(GiftVault.NotRelayer.selector);
            vault.claim(giftId, friend, sig);
        }
        assertEq(uint8(_state(giftId)), uint8(GiftVault.State.Open));
    }

    function test_C31_setRelayerRotatesRelayer() public {
        (uint256 giftId, uint256 pk) = _createGift();
        bytes memory sig = _claimSig(pk, giftId, friend);
        address newRelayer = makeAddr("new-relayer");

        vm.expectEmit(true, true, true, true, address(vault));
        emit GiftVault.RelayerSet(relayer, newRelayer);
        vm.prank(owner);
        vault.setRelayer(newRelayer);
        assertEq(vault.relayer(), newRelayer);

        vm.prank(relayer);
        vm.expectRevert(GiftVault.NotRelayer.selector);
        vault.claim(giftId, friend, sig);

        vm.prank(newRelayer);
        vault.claim(giftId, friend, sig);
        assertEq(stock.balanceOf(friend), AMOUNT);
    }

    function test_C31_setRelayerRevertsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(GiftVault.ZeroAddress.selector);
        vault.setRelayer(address(0));
    }

    // C1: each gift pays once, to one address

    function test_C1_doubleClaimReverts() public {
        (uint256 giftId, uint256 pk) = _createGift();
        bytes memory sig = _claimSig(pk, giftId, friend);
        _claim(giftId, friend, sig);
        vm.prank(relayer);
        vm.expectRevert(GiftVault.GiftNotOpen.selector);
        vault.claim(giftId, friend, sig);
        assertEq(stock.balanceOf(friend), AMOUNT);
    }

    function test_C1_claimAfterRefundReverts() public {
        (uint256 giftId, uint256 pk) = _createGift();
        bytes memory sig = _claimSig(pk, giftId, friend);
        vm.warp(_expiryOf(giftId));
        vault.refund(giftId);
        vm.prank(relayer);
        vm.expectRevert(GiftVault.GiftNotOpen.selector);
        vault.claim(giftId, friend, sig);
        assertEq(stock.balanceOf(friend), 0);
    }

    function test_C1_refundAfterClaimReverts() public {
        (uint256 giftId, uint256 pk) = _createGift();
        _claim(giftId, friend, _claimSig(pk, giftId, friend));
        vm.warp(_expiryOf(giftId));
        uint256 senderBefore = stock.balanceOf(sender);
        vm.expectRevert(GiftVault.GiftNotOpen.selector);
        vault.refund(giftId);
        assertEq(stock.balanceOf(sender), senderBefore);
    }

    function _expiryOf(uint256 giftId) internal view returns (uint256) {
        return vault.getGift(giftId).expiry;
    }

    // C2: a signature works only for this vault, this chain, this gift and this recipient

    function test_C2_signatureForAnotherGiftIdRejected() public {
        (uint256 giftA, uint256 pkA) = _createGift();
        (uint256 giftB,) = _createGift();
        bytes memory sigForA = _claimSig(pkA, giftA, friend);
        vm.prank(relayer);
        vm.expectRevert(GiftVault.BadSigner.selector);
        vault.claim(giftB, friend, sigForA);
    }

    function test_C2_signatureForAnotherRecipientRejected() public {
        (uint256 giftId, uint256 pk) = _createGift();
        bytes memory sigForFriend = _claimSig(pk, giftId, friend);
        vm.prank(relayer);
        vm.expectRevert(GiftVault.BadSigner.selector);
        vault.claim(giftId, stranger, sigForFriend);
    }

    function test_C2_signatureForAnotherVaultRejected() public {
        GiftVault otherVault = _deployVault(address(stock));
        (uint256 giftId, uint256 pk) = _createGift();
        bytes32 otherDigest = otherVault.claimDigest(giftId, friend);
        assertTrue(otherDigest != vault.claimDigest(giftId, friend));
        bytes memory sigForOtherVault = _sign(pk, otherDigest);
        vm.prank(relayer);
        vm.expectRevert(GiftVault.BadSigner.selector);
        vault.claim(giftId, friend, sigForOtherVault);
    }

    function test_C2_signatureForAnotherChainIdRejected() public {
        (uint256 giftId, uint256 pk) = _createGift();
        uint256 homeChain = block.chainid;

        vm.chainId(97);
        bytes32 foreignDigest = vault.claimDigest(giftId, friend);
        bytes memory sigFromOtherChain = _sign(pk, foreignDigest);
        vm.chainId(homeChain);
        assertTrue(foreignDigest != vault.claimDigest(giftId, friend));
        vm.prank(relayer);
        vm.expectRevert(GiftVault.BadSigner.selector);
        vault.claim(giftId, friend, sigFromOtherChain);

        bytes memory sigFromHome = _claimSig(pk, giftId, friend);
        vm.chainId(56);
        vm.prank(relayer);
        vm.expectRevert(GiftVault.BadSigner.selector);
        vault.claim(giftId, friend, sigFromHome);
    }

    function test_C2_highSMalleatedCopyRejected() public {
        (uint256 giftId, uint256 pk) = _createGift();
        bytes32 digest = vault.claimDigest(giftId, friend);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        assertEq(ecrecover(digest, flippedV, r, highS), vm.addr(pk));

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, highS));
        vault.claim(giftId, friend, abi.encodePacked(r, highS, flippedV));
    }

    function test_C2_64ByteSignatureRejected() public {
        (uint256 giftId, uint256 pk) = _createGift();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, vault.claimDigest(giftId, friend));
        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 64));
        vault.claim(giftId, friend, abi.encodePacked(r, vs));
    }

    function test_C2_66ByteSignatureRejected() public {
        (uint256 giftId, uint256 pk) = _createGift();
        bytes memory padded = abi.encodePacked(_claimSig(pk, giftId, friend), uint8(0));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 66));
        vault.claim(giftId, friend, padded);
    }

    function test_C2_junkSignaturesRejected() public {
        (uint256 giftId,) = _createGift();

        vm.prank(relayer);
        vm.expectRevert(ECDSA.ECDSAInvalidSignature.selector);
        vault.claim(giftId, friend, new bytes(65));

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 0));
        vault.claim(giftId, friend, "");

        (, bytes32 r,) = vm.sign(uint256(keccak256("unrelated key")), keccak256("unrelated message"));
        bytes32 s = bytes32(uint256(keccak256("junk s")) >> 2);
        address junkSigner = ecrecover(vault.claimDigest(giftId, friend), 27, r, s);
        assertTrue(junkSigner != address(0));
        vm.prank(relayer);
        vm.expectRevert(GiftVault.BadSigner.selector);
        vault.claim(giftId, friend, abi.encodePacked(r, s, uint8(27)));
        assertEq(uint8(_state(giftId)), uint8(GiftVault.State.Open));
    }

    function test_C2_wrongKeyRejected() public {
        (uint256 giftId,) = _createGift();
        (, uint256 otherPk) = _newKey();
        bytes memory sig = _claimSig(otherPk, giftId, friend);
        vm.prank(relayer);
        vm.expectRevert(GiftVault.BadSigner.selector);
        vault.claim(giftId, friend, sig);
    }

    // C8: one time boundary, and no dead-end recipients

    function test_C8_claimOneSecondBeforeExpirySucceeds() public {
        (uint256 giftId, uint256 pk) = _createGift();
        vm.warp(_expiryOf(giftId) - 1);
        _claim(giftId, friend, _claimSig(pk, giftId, friend));
        assertEq(stock.balanceOf(friend), AMOUNT);
    }

    function test_C8_claimAtExpiryReverts() public {
        (uint256 giftId, uint256 pk) = _createGift();
        bytes memory sig = _claimSig(pk, giftId, friend);
        vm.warp(_expiryOf(giftId));
        vm.prank(relayer);
        vm.expectRevert(GiftVault.GiftExpired.selector);
        vault.claim(giftId, friend, sig);
    }

    function test_C8_refundAtExpirySucceeds() public {
        (uint256 giftId,) = _createGift();
        uint256 senderBefore = stock.balanceOf(sender);
        vm.warp(_expiryOf(giftId));
        vault.refund(giftId);
        assertEq(stock.balanceOf(sender), senderBefore + AMOUNT);
    }

    function test_C8_refundOneSecondBeforeExpiryReverts() public {
        (uint256 giftId,) = _createGift();
        vm.warp(_expiryOf(giftId) - 1);
        vm.expectRevert(GiftVault.GiftNotExpired.selector);
        vault.refund(giftId);
    }

    function test_C8_claimToZeroAddressReverts() public {
        (uint256 giftId, uint256 pk) = _createGift();
        bytes memory sig = _claimSig(pk, giftId, address(0));
        vm.prank(relayer);
        vm.expectRevert(GiftVault.BadRecipient.selector);
        vault.claim(giftId, address(0), sig);
    }

    function test_C8_claimToVaultReverts() public {
        (uint256 giftId, uint256 pk) = _createGift();
        bytes memory sig = _claimSig(pk, giftId, address(vault));
        vm.prank(relayer);
        vm.expectRevert(GiftVault.BadRecipient.selector);
        vault.claim(giftId, address(vault), sig);
    }

    // refund

    function test_refund_anyoneReturnsTokensToSenderAndEmits() public {
        (uint256 giftId,) = _createGift();
        uint256 senderBefore = stock.balanceOf(sender);
        vm.warp(_expiryOf(giftId) + 30 days);
        vm.expectEmit(true, true, true, true, address(vault));
        emit GiftVault.GiftRefunded(giftId, sender, AMOUNT);
        vm.prank(stranger);
        vault.refund(giftId);

        assertEq(uint8(_state(giftId)), uint8(GiftVault.State.Refunded));
        assertEq(stock.balanceOf(sender), senderBefore + AMOUNT);
        assertEq(stock.balanceOf(stranger), 0);
        assertEq(vault.liabilities(address(stock)), 0);
    }

    function test_refund_revertsForUnknownGift() public {
        vm.expectRevert(GiftVault.GiftNotOpen.selector);
        vault.refund(42);
    }

    // C5: the owner cannot move, redirect or freeze a gift

    function test_C5_pauseBlocksCreateGiftAndClaimButNotRefund() public {
        (uint256 claimable, uint256 pk) = _createGift();
        (uint256 refundable,) = _createGift();
        bytes memory sig = _claimSig(pk, claimable, friend);

        vm.expectEmit(true, true, true, true, address(vault));
        emit Pausable.Paused(owner);
        vm.prank(owner);
        vault.pause();

        (address key, uint256 keyPk) = _newKey();
        uint64 expiry = _expiry();
        bytes memory proof = _keyProof(keyPk, sender);
        vm.prank(sender);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.createGift(address(stock), AMOUNT, key, expiry, NOTE, proof);

        vm.prank(relayer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.claim(claimable, friend, sig);

        vm.warp(_expiryOf(refundable));
        vault.refund(refundable);
        assertEq(uint8(_state(refundable)), uint8(GiftVault.State.Refunded));

        vm.expectEmit(true, true, true, true, address(vault));
        emit Pausable.Unpaused(owner);
        vm.prank(owner);
        vault.unpause();
        assertFalse(vault.paused());
    }

    function test_C5_pauseAndUnpauseRejectRepeats() public {
        vm.prank(owner);
        vm.expectRevert(Pausable.ExpectedPause.selector);
        vault.unpause();
        vm.startPrank(owner);
        vault.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.pause();
        vm.stopPrank();
    }

    function test_C5_delistingDoesNotBlockClaimOrRefund() public {
        (uint256 claimable, uint256 pk) = _createGift();
        (uint256 refundable,) = _createGift();
        vm.prank(owner);
        vault.setTokenListed(address(stock), false);

        _claim(claimable, friend, _claimSig(pk, claimable, friend));
        assertEq(stock.balanceOf(friend), AMOUNT);

        vm.warp(_expiryOf(refundable));
        vault.refund(refundable);
        assertEq(uint8(_state(refundable)), uint8(GiftVault.State.Refunded));

        (address key, uint256 keyPk) = _newKey();
        uint64 expiry = _expiry();
        bytes memory proof = _keyProof(keyPk, sender);
        vm.prank(sender);
        vm.expectRevert(GiftVault.TokenNotListed.selector);
        vault.createGift(address(stock), AMOUNT, key, expiry, NOTE, proof);
    }

    function test_C5_rescueSurplusTakesOnlySurplus() public {
        (uint256 giftId, uint256 pk) = _createGift();
        stock.mint(stranger, 7 ether);
        vm.prank(stranger);
        assertTrue(stock.transfer(address(vault), 7 ether));
        address safe = makeAddr("rescue-to");

        vm.expectEmit(true, true, true, true, address(vault));
        emit GiftVault.SurplusRescued(address(stock), safe, 7 ether);
        vm.prank(owner);
        vault.rescueSurplus(address(stock), safe);
        assertEq(stock.balanceOf(safe), 7 ether);
        assertEq(stock.balanceOf(address(vault)), AMOUNT);

        vm.prank(owner);
        vm.expectRevert(GiftVault.NothingToRescue.selector);
        vault.rescueSurplus(address(stock), safe);

        _claim(giftId, friend, _claimSig(pk, giftId, friend));
        assertEq(stock.balanceOf(friend), AMOUNT);
    }

    function test_C5_rescueSurplusRevertsZeroAddresses() public {
        vm.startPrank(owner);
        vm.expectRevert(GiftVault.ZeroAddress.selector);
        vault.rescueSurplus(address(stock), address(0));
        vm.expectRevert(GiftVault.ZeroAddress.selector);
        vault.rescueSurplus(address(0), owner);
        vm.stopPrank();
    }

    function test_C5_ownerHasNoPathToMoveAGift() public {
        (uint256 giftId,) = _createGift();
        uint256 vaultBefore = stock.balanceOf(address(vault));

        vm.startPrank(owner);
        vault.pause();
        vault.unpause();
        vault.setTokenListed(address(stock), false);
        vault.setTokenListed(address(stock), true);
        vm.expectRevert(GiftVault.NothingToRescue.selector);
        vault.rescueSurplus(address(stock), owner);
        vm.expectRevert(GiftVault.NotRelayer.selector);
        vault.claim(giftId, owner, "");
        vault.setRelayer(owner);
        bytes memory ownerSig = _sign(uint256(keccak256("owner key")), vault.claimDigest(giftId, owner));
        vm.expectRevert(GiftVault.BadSigner.selector);
        vault.claim(giftId, owner, ownerSig);
        vm.expectRevert(GiftVault.GiftNotExpired.selector);
        vault.refund(giftId);
        vm.stopPrank();

        assertEq(stock.balanceOf(address(vault)), vaultBefore);
        assertEq(stock.balanceOf(owner), 0);
        assertEq(uint8(_state(giftId)), uint8(GiftVault.State.Open));

        vm.warp(_expiryOf(giftId));
        vm.prank(owner);
        vault.refund(giftId);
        assertEq(stock.balanceOf(owner), 0);
        assertEq(stock.balanceOf(sender), 1_000 ether);
    }

    function test_C5_renounceOwnershipAlwaysReverts() public {
        vm.prank(owner);
        vm.expectRevert(GiftVault.RenounceDisabled.selector);
        vault.renounceOwnership();
        vm.prank(stranger);
        vm.expectRevert(GiftVault.RenounceDisabled.selector);
        vault.renounceOwnership();
        assertEq(vault.owner(), owner);
    }

    function test_ownership_transferIsTwoStep() public {
        address nextOwner = makeAddr("next-owner");
        vm.expectEmit(true, true, true, true, address(vault));
        emit Ownable2Step.OwnershipTransferStarted(owner, nextOwner);
        vm.prank(owner);
        vault.transferOwnership(nextOwner);
        assertEq(vault.owner(), owner);
        assertEq(vault.pendingOwner(), nextOwner);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vault.acceptOwnership();

        vm.expectEmit(true, true, true, true, address(vault));
        emit Ownable.OwnershipTransferred(owner, nextOwner);
        vm.prank(nextOwner);
        vault.acceptOwnership();
        assertEq(vault.owner(), nextOwner);
    }

    function test_ownerFunctionsRejectOthers() public {
        bytes memory notOwner = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);
        vm.startPrank(stranger);
        vm.expectRevert(notOwner);
        vault.setTokenListed(address(stock), false);
        vm.expectRevert(notOwner);
        vault.setRelayer(stranger);
        vm.expectRevert(notOwner);
        vault.pause();
        vm.expectRevert(notOwner);
        vault.unpause();
        vm.expectRevert(notOwner);
        vault.rescueSurplus(address(stock), stranger);
        vm.expectRevert(notOwner);
        vault.transferOwnership(stranger);
        vm.stopPrank();
    }

    // Token list (C5, C22)

    function test_setTokenListed_addsAndRemovesWithSwapAndPop() public {
        address a = address(new MockERC20("A", "A"));
        address b = address(new MockERC20("B", "B"));
        address c = address(new MockERC20("C", "C"));
        vm.startPrank(owner);
        vm.expectEmit(true, true, true, true, address(vault));
        emit GiftVault.TokenListed(a, true);
        vault.setTokenListed(a, true);
        vault.setTokenListed(b, true);
        vault.setTokenListed(c, true);

        vm.expectEmit(true, true, true, true, address(vault));
        emit GiftVault.TokenListed(a, false);
        vault.setTokenListed(a, false);
        address[] memory listed = vault.listedTokens();
        assertEq(listed.length, 3);
        assertEq(listed[0], address(stock));
        assertEq(listed[1], c);
        assertEq(listed[2], b);
        assertFalse(vault.isListed(a));

        vault.setTokenListed(b, false);
        listed = vault.listedTokens();
        assertEq(listed.length, 2);
        assertEq(listed[1], c);
        vm.stopPrank();
    }

    function test_setTokenListed_sameStateIsNoOpWithNoEvent() public {
        address unlisted = address(new MockERC20("U", "U"));
        vm.recordLogs();
        vm.startPrank(owner);
        vault.setTokenListed(address(stock), true);
        vault.setTokenListed(unlisted, false);
        vm.stopPrank();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0);
        assertEq(vault.listedTokens().length, 1);
        assertTrue(vault.isListed(address(stock)));
        assertFalse(vault.isListed(unlisted));
    }

    function test_setTokenListed_revertsZeroToken() public {
        vm.prank(owner);
        vm.expectRevert(GiftVault.ZeroAddress.selector);
        vault.setTokenListed(address(0), true);
    }

    function test_setTokenListed_revertsPastMaxTokens() public {
        vm.startPrank(owner);
        for (uint256 i = 1; i < 32; ++i) {
            vault.setTokenListed(address(uint160(0x1000 + i)), true);
        }
        assertEq(vault.listedTokens().length, 32);
        vm.expectRevert(GiftVault.TooManyTokens.selector);
        vault.setTokenListed(address(0xBEEF), true);
        vault.setTokenListed(address(0x1001), false);
        vault.setTokenListed(address(0xBEEF), true);
        vm.stopPrank();
        assertEq(vault.listedTokens().length, 32);
    }

    // C6: a failed transfer leaves the gift open, and it works again once the issuer allows it

    function test_C6_tokenPauseRevertsClaimThenClaimSucceedsAfterUnpause() public {
        (uint256 giftId, uint256 pk) = _createGift();
        bytes memory sig = _claimSig(pk, giftId, friend);
        stock.setPaused(true);
        vm.prank(relayer);
        vm.expectRevert(MockStockToken.TokenPaused.selector);
        vault.claim(giftId, friend, sig);
        assertEq(uint8(_state(giftId)), uint8(GiftVault.State.Open));
        assertEq(vault.liabilities(address(stock)), AMOUNT);

        stock.setPaused(false);
        _claim(giftId, friend, sig);
        assertEq(stock.balanceOf(friend), AMOUNT);
    }

    function test_C6_tokenPauseRevertsRefundThenRefundSucceedsAfterUnpause() public {
        (uint256 giftId,) = _createGift();
        vm.warp(_expiryOf(giftId));
        stock.setPaused(true);
        vm.expectRevert(MockStockToken.TokenPaused.selector);
        vault.refund(giftId);
        assertEq(uint8(_state(giftId)), uint8(GiftVault.State.Open));

        stock.setPaused(false);
        vault.refund(giftId);
        assertEq(uint8(_state(giftId)), uint8(GiftVault.State.Refunded));
    }

    function test_C6_blockedRecipientRevertsClaimAndGiftStaysOpen() public {
        (uint256 giftId, uint256 pk) = _createGift();
        compliance.setBlocked(address(stock), friend, true);
        bytes memory sig = _claimSig(pk, giftId, friend);
        vm.prank(relayer);
        vm.expectRevert(MockCompliance.UserBlocked.selector);
        vault.claim(giftId, friend, sig);
        assertEq(uint8(_state(giftId)), uint8(GiftVault.State.Open));

        address otherWallet = makeAddr("friend-other-wallet");
        _claim(giftId, otherWallet, _claimSig(pk, giftId, otherWallet));
        assertEq(stock.balanceOf(otherWallet), AMOUNT);
    }

    // C7: the original sender must still pass the token's own compliance check, and every failure blocks

    function test_C7_cleanSenderIsCompliant() public {
        (uint256 giftId,) = _createGift();
        assertTrue(vault.senderIsCompliant(giftId));
    }

    function test_C7_blockedSenderMakesClaimRevert() public {
        (uint256 giftId, uint256 pk) = _createGift();
        compliance.setBlocked(address(stock), sender, true);
        _assertBlocked(giftId, pk);

        compliance.setBlocked(address(stock), sender, false);
        assertTrue(vault.senderIsCompliant(giftId));
        _claim(giftId, friend, _claimSig(pk, giftId, friend));
        assertEq(stock.balanceOf(friend), AMOUNT);
    }

    function test_C7_complianceThatRevertsBlocks() public {
        ComplianceRevertsToken token = new ComplianceRevertsToken();
        _listAndFund(token);
        (uint256 giftId, uint256 pk) = _createGift(address(token), AMOUNT);
        _assertBlocked(giftId, pk);
    }

    function test_C7_tokenWithoutComplianceGetterBlocks() public {
        MockERC20 plain = new MockERC20("Plain", "PLN");
        _listAndFund(plain);
        (uint256 giftId, uint256 pk) = _createGift(address(plain), AMOUNT);
        _assertBlocked(giftId, pk);
    }

    function test_C7_zeroComplianceBlocks() public {
        (uint256 giftId, uint256 pk) = _createGift();
        stock.setCompliance(address(0));
        _assertBlocked(giftId, pk);
    }

    function test_C7_emptyComplianceReturnBlocks() public {
        EmptyReturnToken token = new EmptyReturnToken();
        _listAndFund(token);
        (uint256 giftId, uint256 pk) = _createGift(address(token), AMOUNT);
        _assertBlocked(giftId, pk);
    }

    function test_C7_dirtyComplianceAddressBlocks() public {
        DirtyAddressToken token = new DirtyAddressToken(address(compliance));
        _listAndFund(token);
        (uint256 giftId, uint256 pk) = _createGift(address(token), AMOUNT);
        _assertBlocked(giftId, pk);
    }

    function test_C7_longComplianceReturnBlocks() public {
        LongReturnToken token = new LongReturnToken(address(compliance));
        _listAndFund(token);
        (uint256 giftId, uint256 pk) = _createGift(address(token), AMOUNT);
        _assertBlocked(giftId, pk);
    }

    function test_C7_complianceWithoutCodeBlocks() public {
        (uint256 giftId, uint256 pk) = _createGift();
        stock.setCompliance(makeAddr("compliance-eoa"));
        _assertBlocked(giftId, pk);
    }

    function test_C7_tokenWithoutCodeBlocks() public {
        (uint256 giftId, uint256 pk) = _createGift();
        vm.etch(address(stock), "");
        _assertBlocked(giftId, pk);
        assertFalse(vault.senderIsCompliant(type(uint256).max));
    }

    function test_C7_returnBombTokenBlocksWithoutRunningOutOfGas() public {
        ReturnBombToken token = new ReturnBombToken();
        _listAndFund(token);
        (uint256 giftId, uint256 pk) = _createGift(address(token), AMOUNT);
        uint256 gasBefore = gasleft();
        assertFalse(vault.senderIsCompliant(giftId));
        assertLt(gasBefore - gasleft(), 3_000_000);
        _assertBlocked(giftId, pk);
    }

    function test_C7_revertBombComplianceBlocksWithoutRunningOutOfGas() public {
        (uint256 giftId, uint256 pk) = _createGift();
        stock.setCompliance(address(new RevertBombCompliance()));
        uint256 gasBefore = gasleft();
        assertFalse(vault.senderIsCompliant(giftId));
        assertLt(gasBefore - gasleft(), 3_000_000);
        _assertBlocked(giftId, pk);
    }

    function test_C7_unknownGiftIsNotCompliant() public view {
        assertFalse(vault.senderIsCompliant(0));
        assertFalse(vault.senderIsCompliant(12345));
    }

    // C10: one misbehaving token cannot touch another token's gifts

    function test_C10_revertingTokenDoesNotAffectOtherTokensGifts() public {
        MockStockToken other = new MockStockToken("Apple bStock", "AAPLB", address(compliance));
        vm.prank(owner);
        vault.setTokenListed(address(other), true);
        _fund(other, sender, 1_000 ether);

        (uint256 brokenGift, uint256 brokenPk) = _createGift();
        (uint256 healthyGift, uint256 healthyPk) = _createGift(address(other), AMOUNT);
        (uint256 healthyRefund,) = _createGift(address(other), AMOUNT);
        stock.setPaused(true);

        bytes memory brokenSig = _claimSig(brokenPk, brokenGift, friend);
        vm.prank(relayer);
        vm.expectRevert(MockStockToken.TokenPaused.selector);
        vault.claim(brokenGift, friend, brokenSig);

        _claim(healthyGift, friend, _claimSig(healthyPk, healthyGift, friend));
        assertEq(other.balanceOf(friend), AMOUNT);
        vm.warp(_expiryOf(healthyRefund));
        vault.refund(healthyRefund);

        assertEq(vault.liabilities(address(other)), 0);
        assertEq(vault.liabilities(address(stock)), AMOUNT);
        assertEq(uint8(_state(brokenGift)), uint8(GiftVault.State.Open));
    }
}
