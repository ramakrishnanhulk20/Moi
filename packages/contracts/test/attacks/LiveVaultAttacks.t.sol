// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Attacks every vault rule in docs/security/threat-model.md section C against the real GiftVault on BSC mainnet,
// on a fork of the latest block. The real owner, the real relayer, Binance's own pause and blocklist operators and
// the Venus vNVDAB market (for funding) are impersonated on the fork only, so every refusal below comes from the
// live bytecode and its live state. Nothing here signs or sends a mainnet transaction.
// Run: forge test --match-path "test/attacks/*" --fork-url https://bsc-dataseed.bnbchain.org -vvv
// Without --fork-url, setUp forks the [rpc_endpoints] bsc node itself, so the full suite runs it too.
// Does NOT cover: a hostile token calling back into the vault (real bStocks make no callbacks; test/Reentrancy.t.sol
// covers it with a mock), the relayer and claim page off chain (packages/core/scripts/attacks), a real mempool race
// (C32 replays the victim's exact arguments from another address instead), mainnet gas prices, or anything that
// changes on mainnet after the fork block. Judges may claim gifts 3 to 10 at any time, so each test reads which
// live gifts are still open.

import {Test, console} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IBeacon} from "@openzeppelin/contracts/proxy/beacon/IBeacon.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {GiftVault} from "../../src/GiftVault.sol";

/// @dev The parts of Binance's bStock Compliance contract these attacks drive.
interface ILiveCompliance {
    function addToBlocklist(address token, address[] calldata addresses) external;
    function removeFromBlocklist(address token, address[] calldata addresses) external;
}

/// @dev The parts of Binance's bStock PauseManager these attacks drive.
interface ILivePauseManager {
    function pauseToken(address token) external;
    function unpauseToken(address token) external;
    function isTokenPaused(address token) external view returns (bool);
}

/// @dev The SecuritiesToken views and pause error these attacks read.
interface ILiveBStock {
    error TokenPaused();

    function compliance() external view returns (address);
    function pauseManager() external view returns (address);
}

contract LiveVaultAttacksTest is Test {
    /// @dev The vault Moi runs on BSC mainnet (STATE.md, README).
    GiftVault internal constant VAULT = GiftVault(0x808EB6B3dC1ad50Ca114F5eA9d053BEAd958975C);
    address internal constant NVDAB = 0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436;
    address internal constant TSLAB = 0x5b1910eAaD6450E50f816082Aa078C41F10C292f;
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    /// @dev Venus vNVDAB market, about 1,484 NVDAB on 2026-10-08. bStocks keep balances in namespaced storage, so
    ///      deal cannot fund a sender; a real transfer from this market does.
    address internal constant VNVDAB = 0xEb8Ca841cBe1BC4832A10b15c7dAB1081eDaD371;
    address internal constant COMPLIANCE = 0x53dBa7AaBDe774787A1F57236B235567dA8e14F4;
    address internal constant PAUSE_MANAGER = 0x9fc74Be63f3589485B2423984a7a0557e0CF700a;
    /// @dev Holds OPS_ROLE on Compliance (blocklist edits) and on PauseManager (token pause), checked in setUp.
    address internal constant BLOCKLIST_OPS = 0xA4E4975433038361eDc07D726022cb29A6aABC3e;
    address internal constant PAUSE_OPS = 0x6A8ba4A89E6877Be3170a559C4Cec29A4cF77F46;
    bytes32 internal constant OPS_ROLE = keccak256("OPS_ROLE");
    bytes32 internal constant IMPLEMENTATION_SLOT = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);
    bytes32 internal constant ADMIN_SLOT = bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1);
    bytes32 internal constant BEACON_SLOT = bytes32(uint256(keccak256("eip1967.proxy.beacon")) - 1);
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    /// @dev Highest gift id the scans read. setUp fails loudly if mainnet outgrows it.
    uint256 internal constant MAX_SCAN = 256;
    uint256 internal constant FUNDING = 0.01 ether;
    uint256 internal constant AMOUNT = 0.001 ether;
    uint256 internal constant DONATION = 0.0005 ether;

    IERC20 internal nvdab = IERC20(NVDAB);
    address internal owner;
    address internal relayer;
    address internal sender;
    address internal friend;
    address internal attacker;
    address internal stranger;
    uint256 internal attackerPk;
    uint256 internal liveNextGiftId;
    uint256 private _keyNonce;

    function setUp() public {
        if (block.chainid != 56) vm.createSelectFork("bsc");
        assertEq(block.chainid, 56);
        assertGt(address(VAULT).code.length, 0, "no code at the live vault address");
        owner = VAULT.owner();
        relayer = VAULT.relayer();
        liveNextGiftId = VAULT.nextGiftId();
        assertLe(liveNextGiftId - 1, MAX_SCAN, "mainnet has more gifts than this suite scans; raise MAX_SCAN");
        assertEq(uint8(VAULT.getGift(1).state), uint8(GiftVault.State.Claimed));
        assertEq(uint8(VAULT.getGift(2).state), uint8(GiftVault.State.Claimed));
        assertTrue(VAULT.isListed(NVDAB));
        assertTrue(VAULT.isListed(TSLAB));
        assertEq(ILiveBStock(NVDAB).compliance(), COMPLIANCE);
        assertEq(ILiveBStock(NVDAB).pauseManager(), PAUSE_MANAGER);
        assertEq(ILiveBStock(TSLAB).pauseManager(), PAUSE_MANAGER);
        assertTrue(IAccessControl(COMPLIANCE).hasRole(OPS_ROLE, BLOCKLIST_OPS));
        assertTrue(IAccessControl(PAUSE_MANAGER).hasRole(OPS_ROLE, PAUSE_OPS));

        sender = makeAddr("attack-sender");
        friend = makeAddr("attack-friend");
        stranger = makeAddr("attack-stranger");
        (attacker, attackerPk) = makeAddrAndKey("attack-attacker");
        vm.prank(VNVDAB);
        assertTrue(nvdab.transfer(sender, FUNDING));
    }

    function _newKey() internal returns (address key, uint256 pk) {
        _keyNonce++;
        (key, pk) = makeAddrAndKey(string.concat("live-attack-key-", vm.toString(_keyNonce)));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Locks AMOUNT of real NVDAB in the live vault from `sender`, approving exactly that amount (C21).
    function _newGift(uint256 lifetime) internal returns (uint256 giftId, uint256 pk) {
        address key;
        (key, pk) = _newKey();
        bytes memory proof = _sign(pk, VAULT.registerDigest(sender));
        uint64 expiry = uint64(block.timestamp + lifetime);
        vm.startPrank(sender);
        nvdab.approve(address(VAULT), AMOUNT);
        giftId = VAULT.createGift(NVDAB, AMOUNT, key, expiry, "", proof);
        vm.stopPrank();
    }

    /// @dev Every live gift still Open at the fork block. Bounded by MAX_SCAN.
    function _openLiveGifts() internal view returns (uint256[] memory open) {
        uint256[] memory found = new uint256[](liveNextGiftId);
        uint256 count;
        for (uint256 id = 1; id < liveNextGiftId; ++id) {
            if (VAULT.getGift(id).state == GiftVault.State.Open) found[count++] = id;
        }
        open = new uint256[](count);
        for (uint256 i = 0; i < count; ++i) {
            open[i] = found[i];
        }
    }

    /// @dev The first live gift still Open, or a fresh one if judges have claimed them all since this was written.
    function _aRealOpenGift() internal returns (uint256 giftId) {
        uint256[] memory open = _openLiveGifts();
        if (open.length > 0) return open[0];
        console.log("no live gift is open at this block, so a fresh gift on the live vault stands in");
        (giftId,) = _newGift(7 days);
    }

    function _setIssuerPause(address token, bool paused) internal {
        vm.prank(PAUSE_OPS);
        if (paused) ILivePauseManager(PAUSE_MANAGER).pauseToken(token);
        else ILivePauseManager(PAUSE_MANAGER).unpauseToken(token);
        assertEq(ILivePauseManager(PAUSE_MANAGER).isTokenPaused(token), paused);
    }

    function _setBlocked(address who, bool blocked) internal {
        address[] memory list = new address[](1);
        list[0] = who;
        vm.prank(BLOCKLIST_OPS);
        if (blocked) ILiveCompliance(COMPLIANCE).addToBlocklist(NVDAB, list);
        else ILiveCompliance(COMPLIANCE).removeFromBlocklist(NVDAB, list);
    }

    function _assertOpen(uint256 giftId) internal view {
        assertEq(uint8(VAULT.getGift(giftId).state), uint8(GiftVault.State.Open));
    }

    function _openSum(address token) internal view returns (uint256 sum) {
        for (uint256 id = 1; id < liveNextGiftId; ++id) {
            GiftVault.Gift memory gift = VAULT.getGift(id);
            if (gift.state == GiftVault.State.Open && gift.token == token) sum += gift.amount;
        }
    }

    function _coolEverything() internal {
        address beacon = address(uint160(uint256(vm.load(NVDAB, BEACON_SLOT))));
        vm.cool(address(VAULT));
        vm.cool(NVDAB);
        vm.cool(beacon);
        vm.cool(IBeacon(beacon).implementation());
        vm.cool(COMPLIANCE);
        vm.cool(PAUSE_MANAGER);
    }

    // C1: a gift pays out at most once

    function test_attack_C1_claimAgainOnGiftsAlreadyClaimedOnMainnet() public {
        console.log("fork of BSC block %d, live vault %s, %d gifts made", block.number, address(VAULT), liveNextGiftId - 1);
        uint256 vaultBefore = nvdab.balanceOf(address(VAULT));
        for (uint256 id = 1; id <= 2; ++id) {
            bytes memory sig = _sign(attackerPk, VAULT.claimDigest(id, attacker));
            vm.prank(relayer);
            vm.expectRevert(GiftVault.GiftNotOpen.selector);
            VAULT.claim(id, attacker, sig);
        }
        assertEq(nvdab.balanceOf(address(VAULT)), vaultBefore);
        assertEq(nvdab.balanceOf(attacker), 0);
        console.log("C1 claim live gifts 1 and 2 again through the real relayer: REFUSED GiftNotOpen");
    }

    function test_attack_C1_refundAfterClaimAndSecondPayoutAfterRefund() public {
        vm.warp(VAULT.getGift(1).expiry);
        vm.prank(stranger);
        vm.expectRevert(GiftVault.GiftNotOpen.selector);
        VAULT.refund(1);
        console.log("C1 refund live gift 1 after its expiry, though it was claimed: REFUSED GiftNotOpen");

        uint256 g = _aRealOpenGift();
        GiftVault.Gift memory gift = VAULT.getGift(g);
        if (block.timestamp < gift.expiry) vm.warp(gift.expiry);
        uint256 senderBefore = nvdab.balanceOf(gift.sender);
        vm.prank(stranger);
        VAULT.refund(g);
        assertEq(nvdab.balanceOf(gift.sender), senderBefore + gift.amount);

        bytes memory sig = _sign(attackerPk, VAULT.claimDigest(g, attacker));
        vm.prank(stranger);
        vm.expectRevert(GiftVault.GiftNotOpen.selector);
        VAULT.refund(g);
        vm.prank(relayer);
        vm.expectRevert(GiftVault.GiftNotOpen.selector);
        VAULT.claim(g, attacker, sig);
        assertEq(nvdab.balanceOf(gift.sender), senderBefore + gift.amount);
        assertEq(nvdab.balanceOf(attacker), 0);
        console.log("C1 refund then refund again and claim a live gift: REFUSED GiftNotOpen, paid once to its sender");
    }

    // C2: a claim needs the stored claim key's signature over this vault, this chain, this gift and this recipient

    function test_attack_C2_wrongKeyAndMalformedSignaturesOnRealOpenGifts() public {
        uint256[] memory open = _openLiveGifts();
        if (open.length == 0) {
            open = new uint256[](1);
            open[0] = _aRealOpenGift();
        }
        uint256 vaultBefore = nvdab.balanceOf(address(VAULT));
        for (uint256 i = 0; i < open.length; ++i) {
            bytes memory sig = _sign(attackerPk, VAULT.claimDigest(open[i], attacker));
            vm.prank(relayer);
            vm.expectRevert(GiftVault.BadSigner.selector);
            VAULT.claim(open[i], attacker, sig);
        }
        console.log("C2 claim each open live gift with a key that is not its own: REFUSED BadSigner on %d gifts", open.length);

        uint256 g = open[0];
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attackerPk, VAULT.claimDigest(g, attacker));
        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));
        vm.startPrank(relayer);
        vm.expectRevert(ECDSA.ECDSAInvalidSignature.selector);
        VAULT.claim(g, attacker, new bytes(65));
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 0));
        VAULT.claim(g, attacker, "");
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 64));
        VAULT.claim(g, attacker, abi.encodePacked(r, vs));
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 66));
        VAULT.claim(g, attacker, abi.encodePacked(r, s, v, uint8(0)));
        vm.stopPrank();
        for (uint256 i = 0; i < open.length; ++i) {
            _assertOpen(open[i]);
        }
        assertEq(nvdab.balanceOf(address(VAULT)), vaultBefore);
        assertEq(nvdab.balanceOf(attacker), 0);
        console.log("C2 claim a live gift with 65 zero bytes, no bytes, 64 and 66 bytes: REFUSED ECDSAInvalidSignature and ECDSAInvalidSignatureLength");
    }

    /// @dev The same claim key's signature for (giftId, friend), but under a fresh vault's domain and under chain 97.
    function _foreignSignatures(uint256 pk, uint256 giftId)
        internal
        returns (bytes memory otherVaultSig, bytes memory otherChainSig)
    {
        address[] memory tokens = new address[](1);
        tokens[0] = NVDAB;
        GiftVault otherVault = new GiftVault(owner, relayer, tokens);
        otherVaultSig = _sign(pk, otherVault.claimDigest(giftId, friend));
        vm.chainId(97);
        otherChainSig = _sign(pk, VAULT.claimDigest(giftId, friend));
        vm.chainId(56);
    }

    /// @dev The malleated twin of a valid signature: s flipped to the high half and v flipped, so ecrecover still
    ///      returns the claim key. Returns the twin and its high s.
    function _highSTwin(uint256 pk, bytes32 digest) internal pure returns (bytes memory twin, bytes32 highS) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        highS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        assertEq(ecrecover(digest, flippedV, r, highS), vm.addr(pk));
        twin = abi.encodePacked(r, highS, flippedV);
    }

    function test_attack_C2_validSignatureMovedToAnotherRecipientGiftVaultOrChain() public {
        (uint256 giftA, uint256 pkA) = _newGift(7 days);
        (uint256 giftB,) = _newGift(7 days);
        bytes32 digest = VAULT.claimDigest(giftA, friend);
        bytes memory forFriend = _sign(pkA, digest);
        (bytes memory twin, bytes32 highS) = _highSTwin(pkA, digest);
        (bytes memory otherVaultSig, bytes memory otherChainSig) = _foreignSignatures(pkA, giftA);

        vm.startPrank(relayer);
        vm.expectRevert(GiftVault.BadSigner.selector);
        VAULT.claim(giftA, attacker, forFriend);
        vm.expectRevert(GiftVault.BadSigner.selector);
        VAULT.claim(giftB, friend, forFriend);
        vm.expectRevert(GiftVault.BadSigner.selector);
        VAULT.claim(giftA, friend, otherVaultSig);
        vm.expectRevert(GiftVault.BadSigner.selector);
        VAULT.claim(giftA, friend, otherChainSig);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, highS));
        VAULT.claim(giftA, friend, twin);
        vm.stopPrank();
        _assertOpen(giftA);
        _assertOpen(giftB);
        assertEq(nvdab.balanceOf(attacker), 0);
        console.log("C2 a real claim signature moved to another recipient, gift, vault or chain: REFUSED BadSigner");
        console.log("C2 the same signature malleated to high s: REFUSED ECDSAInvalidSignatureS");

        vm.prank(relayer);
        VAULT.claim(giftA, friend, forFriend);
        assertEq(nvdab.balanceOf(friend), AMOUNT);
    }

    // C3: no keyless, shared-key, empty, unlisted, out-of-window or oversized gift

    function test_attack_C3_createGiftBreakingEachRuleReverts() public {
        (address key, uint256 pk) = _newKey();
        bytes memory proof = _sign(pk, VAULT.registerDigest(sender));
        uint64 good = uint64(block.timestamp + 7 days);
        uint64 tooSoon = uint64(block.timestamp + 1 hours - 1);
        uint64 inMilliseconds = uint64((block.timestamp + 7 days) * 1000);
        address usedKey = VAULT.getGift(1).claimKey;
        bytes memory longNote = new bytes(513);
        uint256 nextBefore = VAULT.nextGiftId();
        uint256 vaultBefore = nvdab.balanceOf(address(VAULT));

        vm.startPrank(sender);
        nvdab.approve(address(VAULT), AMOUNT);
        vm.expectRevert(GiftVault.ZeroClaimKey.selector);
        VAULT.createGift(NVDAB, AMOUNT, address(0), good, "", proof);
        vm.expectRevert(GiftVault.ClaimKeyAlreadyUsed.selector);
        VAULT.createGift(NVDAB, AMOUNT, usedKey, good, "", proof);
        vm.expectRevert(GiftVault.ZeroAmount.selector);
        VAULT.createGift(NVDAB, 0, key, good, "", proof);
        vm.expectRevert(GiftVault.TokenNotListed.selector);
        VAULT.createGift(USDT, AMOUNT, key, good, "", proof);
        vm.expectRevert(GiftVault.ExpiryOutOfRange.selector);
        VAULT.createGift(NVDAB, AMOUNT, key, tooSoon, "", proof);
        vm.expectRevert(GiftVault.ExpiryOutOfRange.selector);
        VAULT.createGift(NVDAB, AMOUNT, key, inMilliseconds, "", proof);
        vm.expectRevert(GiftVault.NoteTooLong.selector);
        VAULT.createGift(NVDAB, AMOUNT, key, good, longNote, proof);
        vm.stopPrank();

        assertEq(VAULT.nextGiftId(), nextBefore);
        assertFalse(VAULT.claimKeyUsed(key));
        assertEq(nvdab.balanceOf(address(VAULT)), vaultBefore);
        assertEq(nvdab.balanceOf(sender), FUNDING);
        console.log("C3 createGift with a zero key, live gift 1's key, zero amount, USDT, a too-short or millisecond expiry, a 513-byte note:");
        console.log("C3   REFUSED ZeroClaimKey, ClaimKeyAlreadyUsed, ZeroAmount, TokenNotListed, ExpiryOutOfRange x2, NoteTooLong");
    }

    // C4: every token's balance covers its open gifts, and a gift records what actually arrived

    function test_attack_C4_liabilitiesEqualOpenGiftsAndDonationsAddNone() public {
        address[] memory tokens = VAULT.listedTokens();
        for (uint256 i = 0; i < tokens.length; ++i) {
            uint256 owed = VAULT.liabilities(tokens[i]);
            assertEq(owed, _openSum(tokens[i]), "liabilities differ from the sum of open live gifts");
            assertGe(IERC20(tokens[i]).balanceOf(address(VAULT)), owed, "a live token balance is below its open gifts");
        }
        console.log("C4 live liabilities equal the open gifts and balances cover them for all %d listed tokens", tokens.length);

        uint256 owedBefore = VAULT.liabilities(NVDAB);
        uint256 balanceBefore = nvdab.balanceOf(address(VAULT));
        vm.prank(VNVDAB);
        assertTrue(nvdab.transfer(address(VAULT), DONATION));
        assertEq(VAULT.liabilities(NVDAB), owedBefore);
        assertEq(nvdab.balanceOf(address(VAULT)), balanceBefore + DONATION);

        (uint256 giftId,) = _newGift(7 days);
        assertEq(VAULT.getGift(giftId).amount, nvdab.balanceOf(address(VAULT)) - balanceBefore - DONATION);
        assertEq(VAULT.getGift(giftId).amount, AMOUNT);
        assertEq(VAULT.liabilities(NVDAB), owedBefore + AMOUNT);
        console.log("C4 a stray NVDAB donation to the live vault: REFUSED as debt, liabilities unchanged; next gift records what arrived");
    }

    // C5: nobody, the owner included, can move, redirect or freeze escrowed tokens

    function test_attack_C5_ownerUsesEveryPowerAndMovesNoGift() public {
        uint256[] memory open = _openLiveGifts();
        uint256 g = _aRealOpenGift();
        uint256 vaultBefore = nvdab.balanceOf(address(VAULT));
        uint256 owed = VAULT.liabilities(NVDAB);
        uint256 ownerBefore = nvdab.balanceOf(owner);
        (, uint256 ownerMadePk) = makeAddrAndKey("owner-made-key");
        bytes memory ownerSig = _sign(ownerMadePk, VAULT.claimDigest(g, owner));
        bool surplus = vaultBefore > owed;

        vm.startPrank(owner);
        VAULT.pause();
        VAULT.unpause();
        VAULT.setTokenListed(NVDAB, false);
        VAULT.setTokenListed(NVDAB, true);
        if (!surplus) vm.expectRevert(GiftVault.NothingToRescue.selector);
        VAULT.rescueSurplus(NVDAB, owner);
        vm.expectRevert(GiftVault.NotRelayer.selector);
        VAULT.claim(g, owner, ownerSig);
        VAULT.setRelayer(owner);
        vm.expectRevert(GiftVault.BadSigner.selector);
        VAULT.claim(g, owner, ownerSig);
        vm.expectRevert(GiftVault.GiftNotExpired.selector);
        VAULT.refund(g);
        vm.stopPrank();

        assertEq(nvdab.balanceOf(address(VAULT)), owed);
        assertEq(VAULT.liabilities(NVDAB), owed);
        assertEq(nvdab.balanceOf(owner), ownerBefore + (vaultBefore - owed));
        _assertOpen(g);
        for (uint256 i = 0; i < open.length; ++i) {
            _assertOpen(open[i]);
        }
        console.log("C5 live owner pauses, delists, rescues, claims, makes itself relayer and claims, refunds early:");
        console.log("C5   REFUSED NothingToRescue, NotRelayer, BadSigner, GiftNotExpired; every open gift still Open");
    }

    function test_attack_C5_rescueSurplusNeverReachesGiftBalances() public {
        address[] memory tokens = VAULT.listedTokens();
        for (uint256 i = 0; i < tokens.length; ++i) {
            uint256 owed = VAULT.liabilities(tokens[i]);
            uint256 held = IERC20(tokens[i]).balanceOf(address(VAULT));
            vm.prank(owner);
            if (held <= owed) vm.expectRevert(GiftVault.NothingToRescue.selector);
            VAULT.rescueSurplus(tokens[i], owner);
            assertEq(IERC20(tokens[i]).balanceOf(address(VAULT)), owed);
        }
        console.log("C5 live owner rescues every listed token with no stray balance: REFUSED NothingToRescue");

        uint256 ownerBefore = nvdab.balanceOf(owner);
        uint256 owedNvdab = VAULT.liabilities(NVDAB);
        vm.prank(VNVDAB);
        assertTrue(nvdab.transfer(address(VAULT), DONATION));
        vm.prank(owner);
        VAULT.rescueSurplus(NVDAB, owner);
        assertEq(nvdab.balanceOf(owner), ownerBefore + DONATION);
        assertEq(nvdab.balanceOf(address(VAULT)), owedNvdab);
        vm.startPrank(owner);
        vm.expectRevert(GiftVault.NothingToRescue.selector);
        VAULT.rescueSurplus(NVDAB, owner);
        vm.expectRevert(GiftVault.ZeroAddress.selector);
        VAULT.rescueSurplus(NVDAB, address(0));
        vm.stopPrank();
        console.log("C5 rescue after a stray donation: takes exactly the donation, then REFUSED NothingToRescue at the gifts");
    }

    function test_attack_C5_renounceOwnershipReverts() public {
        vm.prank(owner);
        vm.expectRevert(GiftVault.RenounceDisabled.selector);
        VAULT.renounceOwnership();
        vm.prank(stranger);
        vm.expectRevert(GiftVault.RenounceDisabled.selector);
        VAULT.renounceOwnership();
        assertEq(VAULT.owner(), owner);
        console.log("C5 renounceOwnership by the live owner and by a stranger: REFUSED RenounceDisabled");
    }

    function test_attack_C5_pauseAndDelistNeverBlockRefundsOrExistingClaims() public {
        uint256 g = _aRealOpenGift();
        (uint256 fresh, uint256 pk) = _newGift(7 days);
        bytes memory sig = _sign(pk, VAULT.claimDigest(fresh, friend));
        (address key, uint256 keyPk) = _newKey();
        bytes memory proof = _sign(keyPk, VAULT.registerDigest(sender));
        uint64 expiry = uint64(block.timestamp + 7 days);

        vm.prank(owner);
        VAULT.setTokenListed(NVDAB, false);
        vm.prank(relayer);
        VAULT.claim(fresh, friend, sig);
        assertEq(nvdab.balanceOf(friend), AMOUNT);
        vm.startPrank(sender);
        nvdab.approve(address(VAULT), AMOUNT);
        vm.expectRevert(GiftVault.TokenNotListed.selector);
        VAULT.createGift(NVDAB, AMOUNT, key, expiry, "", proof);
        vm.stopPrank();

        vm.prank(owner);
        VAULT.pause();
        GiftVault.Gift memory gift = VAULT.getGift(g);
        vm.warp(gift.expiry);
        uint256 senderBefore = nvdab.balanceOf(gift.sender);
        vm.prank(stranger);
        VAULT.refund(g);
        assertEq(nvdab.balanceOf(gift.sender), senderBefore + gift.amount);
        console.log("C5 live owner delists NVDAB then pauses: a claim and an expired live gift's refund still pay out");
    }

    function test_attack_C5_upgradeCallsFailAndNoProxySlotsAreSet() public {
        assertEq(vm.load(address(VAULT), IMPLEMENTATION_SLOT), bytes32(0));
        assertEq(vm.load(address(VAULT), ADMIN_SLOT), bytes32(0));
        assertEq(vm.load(address(VAULT), BEACON_SLOT), bytes32(0));
        bytes32 codeHash = address(VAULT).codehash;
        address fake = address(new GiftVault(owner, relayer, new address[](0)));

        vm.startPrank(owner);
        (bool upgradeAndCall,) = address(VAULT).call(abi.encodeWithSignature("upgradeToAndCall(address,bytes)", fake, ""));
        (bool upgradeTo,) = address(VAULT).call(abi.encodeWithSignature("upgradeTo(address)", fake));
        vm.stopPrank();
        assertFalse(upgradeAndCall);
        assertFalse(upgradeTo);
        assertEq(address(VAULT).codehash, codeHash);
        console.log("C5 live owner calls upgradeToAndCall and upgradeTo: REFUSED, no such functions and no proxy slots");
    }

    // C6: an issuer refusal reverts the whole call and the gift stays open until the issuer allows it again

    function test_attack_C6_issuerPauseRevertsClaimAndRefundAndGiftsStayOpen() public {
        uint256 g = _aRealOpenGift();
        (uint256 fresh, uint256 pk) = _newGift(7 days);
        bytes memory sig = _sign(pk, VAULT.claimDigest(fresh, friend));
        uint256 owed = VAULT.liabilities(NVDAB);

        _setIssuerPause(NVDAB, true);
        vm.prank(relayer);
        vm.expectRevert(ILiveBStock.TokenPaused.selector);
        VAULT.claim(fresh, friend, sig);
        _assertOpen(fresh);
        assertEq(VAULT.liabilities(NVDAB), owed);
        _setIssuerPause(NVDAB, false);
        vm.prank(relayer);
        VAULT.claim(fresh, friend, sig);
        assertEq(nvdab.balanceOf(friend), AMOUNT);

        GiftVault.Gift memory gift = VAULT.getGift(g);
        vm.warp(gift.expiry);
        _setIssuerPause(NVDAB, true);
        vm.prank(stranger);
        vm.expectRevert(ILiveBStock.TokenPaused.selector);
        VAULT.refund(g);
        _assertOpen(g);
        _setIssuerPause(NVDAB, false);
        uint256 senderBefore = nvdab.balanceOf(gift.sender);
        vm.prank(stranger);
        VAULT.refund(g);
        assertEq(nvdab.balanceOf(gift.sender), senderBefore + gift.amount);
        console.log("C6 Binance pauses NVDAB: claim and a live gift's refund REFUSED TokenPaused, gifts stay Open, both pay after unpause");
    }

    // C7: a sender the token now refuses cannot exit through claim

    function test_attack_C7_issuerBlockedSenderCannotExitThroughClaim() public {
        uint256 g = _aRealOpenGift();
        address liveSender = VAULT.getGift(g).sender;
        (uint256 fresh, uint256 pk) = _newGift(7 days);
        address freshWallet = makeAddr("blocked-sender-fresh-wallet");
        bytes memory sig = _sign(pk, VAULT.claimDigest(fresh, freshWallet));

        _setBlocked(sender, true);
        _setBlocked(liveSender, true);
        assertFalse(VAULT.senderIsCompliant(fresh));
        assertFalse(VAULT.senderIsCompliant(g));
        vm.prank(relayer);
        vm.expectRevert(GiftVault.SenderNotCompliant.selector);
        VAULT.claim(fresh, freshWallet, sig);
        _assertOpen(fresh);
        assertEq(nvdab.balanceOf(freshWallet), 0);

        _setBlocked(sender, false);
        _setBlocked(liveSender, false);
        assertTrue(VAULT.senderIsCompliant(g));
        vm.prank(relayer);
        VAULT.claim(fresh, freshWallet, sig);
        assertEq(nvdab.balanceOf(freshWallet), AMOUNT);
        console.log("C7 Binance blocklists the sender, who claims its own gift to a fresh wallet: REFUSED SenderNotCompliant");
    }

    // C8: one time boundary, and no dead-end recipients

    function test_attack_C8_expiryBoundaryAndDeadEndRecipients() public {
        uint256 g = _aRealOpenGift();
        GiftVault.Gift memory gift = VAULT.getGift(g);
        vm.prank(gift.sender);
        vm.expectRevert(GiftVault.GiftNotExpired.selector);
        VAULT.refund(g);
        vm.prank(stranger);
        vm.expectRevert(GiftVault.GiftNotExpired.selector);
        VAULT.refund(g);

        (uint256 fresh, uint256 pk) = _newGift(1 hours);
        bytes memory toZero = _sign(pk, VAULT.claimDigest(fresh, address(0)));
        bytes memory toVault = _sign(pk, VAULT.claimDigest(fresh, address(VAULT)));
        bytes memory toFriend = _sign(pk, VAULT.claimDigest(fresh, friend));
        vm.startPrank(relayer);
        vm.expectRevert(GiftVault.BadRecipient.selector);
        VAULT.claim(fresh, address(0), toZero);
        vm.expectRevert(GiftVault.BadRecipient.selector);
        VAULT.claim(fresh, address(VAULT), toVault);
        vm.stopPrank();

        vm.warp(VAULT.getGift(fresh).expiry);
        vm.prank(relayer);
        vm.expectRevert(GiftVault.GiftExpired.selector);
        VAULT.claim(fresh, friend, toFriend);

        vm.warp(gift.expiry - 1);
        vm.prank(gift.sender);
        vm.expectRevert(GiftVault.GiftNotExpired.selector);
        VAULT.refund(g);
        vm.prank(stranger);
        vm.expectRevert(GiftVault.GiftNotExpired.selector);
        VAULT.refund(g);
        _assertOpen(g);
        _assertOpen(fresh);
        console.log("C8 refund a live gift now and one second before expiry, by its sender and a stranger: REFUSED GiftNotExpired");
        console.log("C8 claim to the zero address and to the vault: REFUSED BadRecipient; claim at expiry: REFUSED GiftExpired");
    }

    // C9: only ciphertext reaches the chain

    function test_attack_C9_everyLiveNoteIsSealedCiphertext() public view {
        uint256 sealedCount;
        for (uint256 id = 1; id < liveNextGiftId; ++id) {
            bytes memory note = VAULT.getGift(id).sealedNote;
            if (note.length == 0) continue;
            // Version byte 0x01, a 12-byte IV, at least one byte of ciphertext and a 16-byte tag (gift.ts sealNote).
            assertEq(uint8(note[0]), 1, "a live note is not in the sealed format");
            assertGe(note.length, 30);
            assertLe(note.length, VAULT.MAX_NOTE_BYTES());
            sealedCount++;
        }
        console.log("C9 read every live note straight from the chain: %d sealed blobs, no plain text", sealedCount);
    }

    // C10: a misbehaving token can affect only its own gifts

    function test_attack_C10_brokenTokenCannotTouchNvdabGifts() public {
        uint256 g = _aRealOpenGift();
        (uint256 fresh, uint256 pk) = _newGift(7 days);
        bytes memory sig = _sign(pk, VAULT.claimDigest(fresh, friend));
        (address key, uint256 keyPk) = _newKey();
        bytes memory proof = _sign(keyPk, VAULT.registerDigest(sender));
        uint64 expiry = uint64(block.timestamp + 7 days);

        _setIssuerPause(TSLAB, true);
        // TSLAB's code replaced by PUSH1 0 PUSH1 0 REVERT: every call to it reverts, as after a bad beacon upgrade.
        vm.etch(TSLAB, hex"60006000fd");
        uint256 nextBefore = VAULT.nextGiftId();
        vm.prank(sender);
        vm.expectRevert();
        VAULT.createGift(TSLAB, AMOUNT, key, expiry, "", proof);
        assertEq(VAULT.nextGiftId(), nextBefore);

        vm.prank(relayer);
        VAULT.claim(fresh, friend, sig);
        assertEq(nvdab.balanceOf(friend), AMOUNT);
        GiftVault.Gift memory gift = VAULT.getGift(g);
        vm.warp(gift.expiry);
        uint256 senderBefore = nvdab.balanceOf(gift.sender);
        vm.prank(stranger);
        VAULT.refund(g);
        assertEq(nvdab.balanceOf(gift.sender), senderBefore + gift.amount);
        assertEq(VAULT.liabilities(TSLAB), 0);
        console.log("C10 TSLAB paused and every call to it reverting: NVDAB claim and live refund still pay; TSLAB gift REFUSED");
    }

    // C28: no gift outlives the 90 days Moi commits to keep its domain

    function test_attack_C28_expiryBeyondNinetyDaysReverts() public {
        assertEq(VAULT.MAX_LIFETIME(), 90 days);
        (address key, uint256 pk) = _newKey();
        bytes memory proof = _sign(pk, VAULT.registerDigest(sender));
        uint64 tooLate = uint64(block.timestamp + 90 days + 1);
        vm.startPrank(sender);
        nvdab.approve(address(VAULT), AMOUNT);
        vm.expectRevert(GiftVault.ExpiryOutOfRange.selector);
        VAULT.createGift(NVDAB, AMOUNT, key, tooLate, "", proof);
        uint256 giftId = VAULT.createGift(NVDAB, AMOUNT, key, uint64(block.timestamp + 90 days), "", proof);
        vm.stopPrank();
        assertEq(VAULT.getGift(giftId).expiry, block.timestamp + 90 days);
        console.log("C28 createGift on the live vault 90 days and one second out: REFUSED ExpiryOutOfRange (90 days exactly is accepted)");
    }

    // C31: only the relayer the owner sets may call claim, even with a valid claim-key signature

    function test_attack_C31_nonRelayerCannotClaimEvenWithValidSignature() public {
        uint256 g = _aRealOpenGift();
        (uint256 fresh, uint256 pk) = _newGift(7 days);
        bytes memory sig = _sign(pk, VAULT.claimDigest(fresh, friend));
        bytes memory liveSig = _sign(attackerPk, VAULT.claimDigest(g, friend));
        address[7] memory callers = [owner, sender, friend, stranger, attacker, vm.addr(pk), VNVDAB];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(GiftVault.NotRelayer.selector);
            VAULT.claim(fresh, friend, sig);
            vm.prank(callers[i]);
            vm.expectRevert(GiftVault.NotRelayer.selector);
            VAULT.claim(g, friend, liveSig);
        }
        _assertOpen(fresh);
        _assertOpen(g);
        console.log("C31 claim from the owner, sender, friend, link holder and others, with a valid signature: REFUSED NotRelayer");

        _coolEverything();
        uint256 gasBefore = gasleft();
        vm.prank(relayer);
        VAULT.claim(fresh, friend, sig);
        uint256 claimGas = gasBefore - gasleft();
        assertEq(nvdab.balanceOf(friend), AMOUNT);
        console.log("gas: claim on the live vault through the real relayer, cold, about %d", claimGas);
    }

    // C32: a key proof binds the sender, so nobody can register a pending gift's key first

    function test_attack_C32_copiedKeyProofFromAnotherAddressReverts() public {
        (address key, uint256 pk) = _newKey();
        bytes memory proof = _sign(pk, VAULT.registerDigest(sender));
        bytes memory proofForAttacker = _sign(pk, VAULT.registerDigest(attacker));
        uint64 expiry = uint64(block.timestamp + 7 days);
        vm.prank(VNVDAB);
        assertTrue(nvdab.transfer(attacker, FUNDING));

        vm.startPrank(attacker);
        nvdab.approve(address(VAULT), AMOUNT);
        vm.expectRevert(GiftVault.BadKeyProof.selector);
        VAULT.createGift(NVDAB, AMOUNT, key, expiry, "", proof);
        vm.stopPrank();
        vm.startPrank(sender);
        nvdab.approve(address(VAULT), AMOUNT);
        vm.expectRevert(GiftVault.BadKeyProof.selector);
        VAULT.createGift(NVDAB, AMOUNT, key, expiry, "", proofForAttacker);
        vm.stopPrank();
        assertFalse(VAULT.claimKeyUsed(key));
        assertEq(nvdab.balanceOf(attacker), FUNDING);
        console.log("C32 a pending createGift copied and sent from another address, and a proof for another sender: REFUSED BadKeyProof");

        _coolEverything();
        uint256 gasBefore = gasleft();
        vm.prank(sender);
        uint256 giftId = VAULT.createGift(NVDAB, AMOUNT, key, expiry, "", proof);
        uint256 createGas = gasBefore - gasleft();
        assertEq(VAULT.getGift(giftId).sender, sender);
        console.log("gas: createGift on the live vault, empty note, cold, about %d", createGas);
    }
}
