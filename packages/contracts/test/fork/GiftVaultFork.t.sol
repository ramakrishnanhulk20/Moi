// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// GiftVault against Binance's real Nvidia bStock (NVDAB) on a copy of BSC mainnet. The issuer's own accounts,
// confirmed with hasRole in setUp, flip the real blocklist and pause switches, so every refusal below comes from
// Binance's SecuritiesToken, Compliance and PauseManager code, not from a mock. It also runs the deploy script's
// chain and token checks against the real chain.
// Does NOT cover: the deploy script's broadcast (proven by the anvil rehearsal), the eight other gift bStocks
// (same implementation, Compliance and PauseManager; the deploy script checks the last two for each token), the
// global sanctions list or pauseAllTokens (other inputs to the same checkIsCompliant and isTokenPaused calls
// driven here), a beacon upgrade after FORK_BLOCK or the issuer burning vault tokens (threat model N3), a
// uiMultiplier change while a gift is open (the vault stores raw units only), mainnet gas prices, or the relayer
// and claim page off chain.

import {Test, console} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IBeacon} from "@openzeppelin/contracts/proxy/beacon/IBeacon.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GiftVault} from "../../src/GiftVault.sol";
import {Deploy} from "../../script/Deploy.s.sol";

/// @dev Latest BSC block when this suite was written: 2026-10-07 11:47:40 UTC.
uint256 constant FORK_BLOCK = 126_246_601;

/// @dev The parts of Binance's bStock Compliance contract these tests drive.
interface IBStockCompliance {
    error UserBlocked();

    function addToBlocklist(address token, address[] calldata addresses) external;
    function removeFromBlocklist(address token, address[] calldata addresses) external;
    function blockedAddresses(address token, address user) external view returns (bool);
}

/// @dev The parts of Binance's bStock PauseManager these tests drive.
interface IBStockPauseManager {
    function pauseToken(address token) external;
    function unpauseToken(address token) external;
    function isTokenPaused(address token) external view returns (bool);
}

/// @dev The SecuritiesToken views and pause error these tests read.
interface IBStock {
    error TokenPaused();

    function compliance() external view returns (address);
    function pauseManager() external view returns (address);
    function uiMultiplier() external view returns (uint256);
    function balanceOfUI(address account) external view returns (uint256);
}

contract GiftVaultForkTest is Test {
    address internal constant NVDAB = 0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436;
    address internal constant COMPLIANCE = 0x53dBa7AaBDe774787A1F57236B235567dA8e14F4;
    address internal constant PAUSE_MANAGER = 0x9fc74Be63f3589485B2423984a7a0557e0CF700a;
    /// @dev Venus vNVDAB market. It held about 1,480 NVDAB at FORK_BLOCK. bStocks keep balances in namespaced
    ///      storage, so tests fund senders with real transfers from it instead of deal.
    address internal constant VNVDAB = 0xEb8Ca841cBe1BC4832A10b15c7dAB1081eDaD371;
    /// @dev Holds OPS_ROLE on Compliance, the role allowed to edit the blocklist.
    address internal constant BLOCKLIST_OPS = 0xA4E4975433038361eDc07D726022cb29A6aABC3e;
    /// @dev Holds OPS_ROLE on PauseManager, the role allowed to pause a token.
    address internal constant PAUSE_OPS = 0x6A8ba4A89E6877Be3170a559C4Cec29A4cF77F46;
    /// @dev Real tokens that must fail the deploy script's checks: one without a B symbol, one without compliance().
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address internal constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    bytes32 internal constant OPS_ROLE = keccak256("OPS_ROLE");
    bytes32 internal constant BEACON_SLOT = bytes32(uint256(keccak256("eip1967.proxy.beacon")) - 1);

    uint256 internal constant FUNDING = 1 ether;
    /// @dev About 20 USD of NVDAB at FORK_BLOCK.
    uint256 internal constant AMOUNT = 0.0832 ether;
    bytes internal constant NOTE = hex"a1b2c3d4e5f60718293a4b5c6d7e8f90";

    IERC20 internal nvdab = IERC20(NVDAB);
    GiftVault internal vault;
    address internal owner;
    address internal relayer;
    address internal sender;
    address internal friend;
    uint256 private _keyNonce;

    function setUp() public {
        vm.createSelectFork("bsc_archive", FORK_BLOCK);
        assertEq(block.chainid, 56);
        assertEq(IBStock(NVDAB).compliance(), COMPLIANCE);
        assertEq(IBStock(NVDAB).pauseManager(), PAUSE_MANAGER);
        assertTrue(IAccessControl(COMPLIANCE).hasRole(OPS_ROLE, BLOCKLIST_OPS));
        assertTrue(IAccessControl(PAUSE_MANAGER).hasRole(OPS_ROLE, PAUSE_OPS));
        assertFalse(IBStockPauseManager(PAUSE_MANAGER).isTokenPaused(NVDAB));
        assertGe(nvdab.balanceOf(VNVDAB), FUNDING);

        owner = makeAddr("owner");
        relayer = makeAddr("relayer");
        sender = makeAddr("sender");
        friend = makeAddr("friend");

        address[] memory tokens = new address[](1);
        tokens[0] = NVDAB;
        vault = new GiftVault(owner, relayer, tokens);
        assertEq(nvdab.balanceOf(address(vault)), 0);

        vm.prank(VNVDAB);
        assertTrue(nvdab.transfer(sender, FUNDING));
        assertEq(nvdab.balanceOf(sender), FUNDING);
    }

    function _newKey() internal returns (address key, uint256 pk) {
        _keyNonce++;
        (key, pk) = makeAddrAndKey(string.concat("fork-claim-key-", vm.toString(_keyNonce)));
    }

    /// @dev Approves exactly AMOUNT, as Moi's sender flow does (threat model C21), then locks it.
    function _createGift(uint256 lifetime) internal returns (uint256 giftId, uint256 pk) {
        address key;
        (key, pk) = _newKey();
        bytes memory proof = _keyProof(pk);
        vm.startPrank(sender);
        nvdab.approve(address(vault), AMOUNT);
        giftId = vault.createGift(NVDAB, AMOUNT, key, uint64(block.timestamp + lifetime), NOTE, proof);
        vm.stopPrank();
    }

    /// @dev The claim key's consent for `sender` to create a gift with it (C32).
    function _keyProof(uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, vault.registerDigest(sender));
        return abi.encodePacked(r, s, v);
    }

    function _sig(uint256 pk, uint256 giftId, address recipient) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, vault.claimDigest(giftId, recipient));
        return abi.encodePacked(r, s, v);
    }

    function _claim(uint256 giftId, address recipient, bytes memory signature) internal {
        vm.prank(relayer);
        vault.claim(giftId, recipient, signature);
    }

    function _setBlocked(address who, bool blocked) internal {
        address[] memory list = new address[](1);
        list[0] = who;
        vm.prank(BLOCKLIST_OPS);
        if (blocked) IBStockCompliance(COMPLIANCE).addToBlocklist(NVDAB, list);
        else IBStockCompliance(COMPLIANCE).removeFromBlocklist(NVDAB, list);
        assertEq(IBStockCompliance(COMPLIANCE).blockedAddresses(NVDAB, who), blocked);
    }

    function _setPaused(bool paused) internal {
        vm.prank(PAUSE_OPS);
        if (paused) IBStockPauseManager(PAUSE_MANAGER).pauseToken(NVDAB);
        else IBStockPauseManager(PAUSE_MANAGER).unpauseToken(NVDAB);
        assertEq(IBStockPauseManager(PAUSE_MANAGER).isTokenPaused(NVDAB), paused);
    }

    function _assertStillOpen(uint256 giftId, uint256 owed) internal view {
        assertEq(uint8(vault.getGift(giftId).state), uint8(GiftVault.State.Open));
        assertEq(vault.liabilities(NVDAB), owed);
        assertEq(nvdab.balanceOf(address(vault)), owed);
    }

    // Happy path

    function test_happyPath_realNVDABGiftPaysFreshRecipientExactRawAmount() public {
        uint256 vaultBefore = nvdab.balanceOf(address(vault));
        (uint256 giftId, uint256 pk) = _createGift(7 days);

        uint256 received = nvdab.balanceOf(address(vault)) - vaultBefore;
        assertEq(received, AMOUNT);
        assertEq(vault.getGift(giftId).amount, received);
        assertEq(vault.liabilities(NVDAB), received);
        assertEq(nvdab.balanceOf(sender), FUNDING - AMOUNT);
        assertEq(nvdab.allowance(sender, address(vault)), 0);
        assertTrue(vault.senderIsCompliant(giftId));
        assertEq(nvdab.balanceOf(friend), 0);

        _claim(giftId, friend, _sig(pk, giftId, friend));

        assertEq(nvdab.balanceOf(friend), received);
        assertEq(nvdab.balanceOf(address(vault)), vaultBefore);
        assertEq(vault.liabilities(NVDAB), 0);
        assertEq(uint8(vault.getGift(giftId).state), uint8(GiftVault.State.Claimed));

        uint256 multiplier = IBStock(NVDAB).uiMultiplier();
        uint256 shares = IBStock(NVDAB).balanceOfUI(friend);
        assertEq(shares, received * multiplier / 1e18);
        console.log("NVDAB uiMultiplier: %18e (raw %d)", multiplier, multiplier);
        console.log("recipient raw NVDAB: %18e (raw %d)", received, received);
        console.log("recipient share figure, balanceOfUI: %18e (raw %d)", shares, shares);
    }

    // C7: the token's own compliance contract judges the original sender at release

    function test_C7_realBlocklistOnSenderBlocksClaimAndRefundUntilRemoved() public {
        (uint256 claimable, uint256 claimPk) = _createGift(7 days);
        (uint256 refundable,) = _createGift(1 hours);
        bytes memory sig = _sig(claimPk, claimable, friend);
        _setBlocked(sender, true);

        assertFalse(vault.senderIsCompliant(claimable));
        assertFalse(vault.senderIsCompliant(refundable));
        vm.prank(relayer);
        vm.expectRevert(GiftVault.SenderNotCompliant.selector);
        vault.claim(claimable, friend, sig);

        vm.warp(vault.getGift(refundable).expiry);
        vm.expectRevert(IBStockCompliance.UserBlocked.selector);
        vault.refund(refundable);
        assertEq(uint8(vault.getGift(refundable).state), uint8(GiftVault.State.Open));
        _assertStillOpen(claimable, 2 * AMOUNT);

        _setBlocked(sender, false);
        assertTrue(vault.senderIsCompliant(claimable));
        _claim(claimable, friend, sig);
        assertEq(nvdab.balanceOf(friend), AMOUNT);

        vault.refund(refundable);
        assertEq(nvdab.balanceOf(sender), FUNDING - AMOUNT);
        assertEq(vault.liabilities(NVDAB), 0);
    }

    // C6: an issuer refusal reverts the whole call, the gift stays open, and it works once allowed again

    function test_C6_realPauseRevertsClaimAndGiftStaysOpenUntilUnpaused() public {
        (uint256 giftId, uint256 pk) = _createGift(7 days);
        bytes memory sig = _sig(pk, giftId, friend);
        _setPaused(true);

        vm.prank(relayer);
        vm.expectRevert(IBStock.TokenPaused.selector);
        vault.claim(giftId, friend, sig);
        _assertStillOpen(giftId, AMOUNT);

        _setPaused(false);
        _claim(giftId, friend, sig);
        assertEq(nvdab.balanceOf(friend), AMOUNT);
        assertEq(vault.liabilities(NVDAB), 0);
    }

    function test_C6_realBlocklistOnVaultRevertsClaimAndCreateGiftUntilRemoved() public {
        (uint256 giftId, uint256 pk) = _createGift(7 days);
        bytes memory sig = _sig(pk, giftId, friend);
        _setBlocked(address(vault), true);
        assertTrue(vault.senderIsCompliant(giftId));

        vm.prank(relayer);
        vm.expectRevert(IBStockCompliance.UserBlocked.selector);
        vault.claim(giftId, friend, sig);
        _assertStillOpen(giftId, AMOUNT);

        (address key, uint256 keyPk) = _newKey();
        uint64 expiry = uint64(block.timestamp + 7 days);
        bytes memory proof = _keyProof(keyPk);
        vm.startPrank(sender);
        nvdab.approve(address(vault), AMOUNT);
        vm.expectRevert(IBStockCompliance.UserBlocked.selector);
        vault.createGift(NVDAB, AMOUNT, key, expiry, NOTE, proof);
        vm.stopPrank();
        assertEq(vault.nextGiftId(), giftId + 1);
        assertFalse(vault.claimKeyUsed(key));
        assertEq(nvdab.balanceOf(sender), FUNDING - AMOUNT);

        _setBlocked(address(vault), false);
        _claim(giftId, friend, sig);
        assertEq(nvdab.balanceOf(friend), AMOUNT);
        vm.prank(sender);
        uint256 next = vault.createGift(NVDAB, AMOUNT, key, expiry, NOTE, proof);
        assertEq(vault.getGift(next).amount, AMOUNT);
        assertEq(vault.liabilities(NVDAB), AMOUNT);
    }

    function test_C6_realBlocklistOnRecipientRevertsClaimAndGiftStaysOpen() public {
        (uint256 giftId, uint256 pk) = _createGift(7 days);
        address blockedFriend = makeAddr("blocked-friend");
        _setBlocked(blockedFriend, true);
        assertTrue(vault.senderIsCompliant(giftId));

        bytes memory sig = _sig(pk, giftId, blockedFriend);
        vm.prank(relayer);
        vm.expectRevert(IBStockCompliance.UserBlocked.selector);
        vault.claim(giftId, blockedFriend, sig);
        _assertStillOpen(giftId, AMOUNT);
        assertEq(nvdab.balanceOf(blockedFriend), 0);

        _claim(giftId, friend, _sig(pk, giftId, friend));
        assertEq(nvdab.balanceOf(friend), AMOUNT);
    }

    // C8: claim only strictly before expiry, refund only at or after it, through the real token

    function test_C8_expiryBoundaryHoldsOnRealNVDAB() public {
        (uint256 early, uint256 earlyPk) = _createGift(1 hours);
        (uint256 late, uint256 latePk) = _createGift(1 hours);
        uint64 expiry = vault.getGift(early).expiry;
        assertEq(vault.getGift(late).expiry, expiry);

        vm.warp(expiry - 1);
        vm.expectRevert(GiftVault.GiftNotExpired.selector);
        vault.refund(late);
        _claim(early, friend, _sig(earlyPk, early, friend));
        assertEq(nvdab.balanceOf(friend), AMOUNT);

        vm.warp(expiry);
        bytes memory lateSig = _sig(latePk, late, friend);
        vm.prank(relayer);
        vm.expectRevert(GiftVault.GiftExpired.selector);
        vault.claim(late, friend, lateSig);

        uint256 senderBefore = nvdab.balanceOf(sender);
        vm.prank(makeAddr("anyone"));
        vault.refund(late);
        assertEq(nvdab.balanceOf(sender), senderBefore + AMOUNT);
        assertEq(uint8(vault.getGift(late).state), uint8(GiftVault.State.Refunded));
        assertEq(vault.liabilities(NVDAB), 0);
        assertEq(nvdab.balanceOf(address(vault)), 0);
    }

    // C31: only the relayer may submit a claim, even with a valid claim-key signature

    function test_C31_onlyRelayerClaimsRealGift() public {
        (uint256 giftId, uint256 pk) = _createGift(7 days);
        bytes memory sig = _sig(pk, giftId, friend);
        address[5] memory callers = [friend, sender, owner, VNVDAB, BLOCKLIST_OPS];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(GiftVault.NotRelayer.selector);
            vault.claim(giftId, friend, sig);
        }
        _assertStillOpen(giftId, AMOUNT);

        _claim(giftId, friend, sig);
        assertEq(nvdab.balanceOf(friend), AMOUNT);
    }

    // Deploy script: every check runs on the real chain, and any failure aborts run() before it broadcasts

    function test_deployScript_failsClosedOnWrongChainOrAnyTokenMismatch() public {
        Deploy deploy = new Deploy();
        address[] memory tokens = deploy.giftTokens();
        assertEq(tokens.length, 9);
        for (uint256 i = 0; i < tokens.length; ++i) {
            deploy.checkToken(tokens[i]);
        }

        address noCode = makeAddr("not-a-token");
        vm.expectRevert(abi.encodeWithSelector(Deploy.TokenHasNoCode.selector, noCode));
        deploy.checkToken(noCode);

        vm.expectRevert(abi.encodeWithSelector(Deploy.TokenSymbolNotB.selector, USDT, "USDT"));
        deploy.checkToken(USDT);

        // WBNB's symbol ends in B, but it has no compliance(): the call lands in its payable fallback.
        vm.expectRevert(abi.encodeWithSelector(Deploy.TokenComplianceUnreadable.selector, WBNB));
        deploy.checkToken(WBNB);

        address otherCompliance = makeAddr("other-compliance");
        vm.mockCall(NVDAB, abi.encodeCall(IBStock.compliance, ()), abi.encode(otherCompliance));
        vm.expectRevert(abi.encodeWithSelector(Deploy.TokenComplianceMismatch.selector, NVDAB, otherCompliance));
        deploy.run();
        vm.clearMockedCalls();

        vm.chainId(97);
        vm.expectRevert(abi.encodeWithSelector(Deploy.UnsupportedChain.selector, 97));
        deploy.run();
    }

    function test_deployScript_refusesMainnetDeployWithoutOwnerHandover() public {
        Deploy deploy = new Deploy();
        (, uint256 throwawayKey) = makeAddrAndKey("throwaway-deployer");
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(bytes32(throwawayKey)));
        vm.setEnv("MOI_RELAYER_ADDRESS", vm.toString(makeAddr("throwaway-relayer")));
        vm.setEnv("MOI_OWNER_ADDRESS", "");
        assertEq(block.chainid, 56);
        vm.expectRevert(Deploy.NoOwnerHandover.selector);
        deploy.run();
    }

    // Gas

    /// @dev Decoded by hand because forge 1.8.1 returns five words while the pinned forge-std 1.17 Vm.Gas struct
    ///      declares six, so the typed cheatcode call cannot decode. Extra trailing words would be ignored.
    function _lastFrameGas() internal view returns (uint256 used, uint256 refunded) {
        (bool ok, bytes memory data) = address(vm).staticcall(abi.encodeWithSignature("lastFrameGas()"));
        assertTrue(ok);
        (, uint64 gasUsed,, int64 gasRefunded,) = abi.decode(data, (uint64, uint64, uint64, int64, uint64));
        assertGe(gasRefunded, 0);
        return (gasUsed, uint256(int256(gasRefunded)));
    }

    /// @dev Every account a call touches is cooled first, so each figure is a first touch as in a real
    ///      transaction. The figures are execution gas inside the call: add the 21,000 base and calldata for a
    ///      whole transaction.
    function test_gas_createGiftAndClaimOnRealNVDAB() public {
        address beacon = address(uint160(uint256(vm.load(NVDAB, BEACON_SLOT))));
        address implementation = IBeacon(beacon).implementation();
        address[6] memory touched = [address(vault), NVDAB, beacon, implementation, COMPLIANCE, PAUSE_MANAGER];

        (address key, uint256 pk) = _newKey();
        uint64 expiry = uint64(block.timestamp + 7 days);
        bytes memory proof = _keyProof(pk);
        vm.prank(sender);
        nvdab.approve(address(vault), AMOUNT);

        for (uint256 i = 0; i < touched.length; ++i) {
            vm.cool(touched[i]);
        }
        vm.prank(sender);
        uint256 giftId = vault.createGift(NVDAB, AMOUNT, key, expiry, "", proof);
        (uint256 createUsed, uint256 createRefunded) = _lastFrameGas();

        bytes memory sig = _sig(pk, giftId, friend);
        for (uint256 i = 0; i < touched.length; ++i) {
            vm.cool(touched[i]);
        }
        vm.prank(relayer);
        vault.claim(giftId, friend, sig);
        (uint256 claimUsed, uint256 claimRefunded) = _lastFrameGas();

        assertEq(nvdab.balanceOf(friend), AMOUNT);
        assertGt(createUsed, 0);
        assertGt(claimUsed, 0);
        console.log("createGift, empty note: %d gas used, %d refunded", createUsed, createRefunded);
        console.log("claim: %d gas used, %d refunded", claimUsed, claimRefunded);
    }
}
