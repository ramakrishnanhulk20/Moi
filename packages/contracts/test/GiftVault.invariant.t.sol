// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Stateful invariant suite. A handler drives random sequences of createGift, claim (with the right key and
// with a wrong one), refund, list, delist, pause, unpause, rescue, stray donations, time jumps, issuer pauses
// and issuer blocklisting over two tokens, one of which takes a 1 percent fee. After every call the
// invariants check C1 and C4 against the vault's real storage and the handler's own ledger.
// Runs and depth come from foundry.toml ([invariant] runs = 512, depth = 128).
// Does NOT cover: hostile callbacks (test/Reentrancy.t.sol), signature encoding edge cases
// (test/GiftVault.t.sol), the real bStock (WO-2b), or more than 48 gifts per sequence.

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {GiftVault} from "../src/GiftVault.sol";
import {MockCompliance} from "./mocks/MockCompliance.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";
import {FeeOnTransferToken} from "./mocks/FeeOnTransferToken.sol";

contract GiftVaultHandler is Test {
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 public constant MAX_GIFTS = 48;

    GiftVault public immutable vault;
    MockCompliance public immutable compliance;
    address public immutable owner;
    address public immutable relayer;
    MockStockToken[2] internal _tokens;
    address[3] internal _senders;
    address[3] internal _recipients;
    address internal immutable _donor;
    address internal immutable _rescueSink;

    uint256[] public giftIds;
    mapping(uint256 giftId => uint256) internal _keyOf;
    mapping(uint256 giftId => GiftVault.State) public expectedState;
    mapping(address token => uint256) public totalReceived;
    mapping(address token => uint256) public totalPaidOut;
    mapping(address token => uint256) public totalDonated;
    mapping(address token => uint256) public totalRescued;
    bool public finalStateLeft;
    bool public wrongKeyClaimSucceeded;
    uint256 internal _keyNonce;

    constructor(GiftVault vault_, MockCompliance compliance_, MockStockToken[2] memory tokens_, address owner_) {
        vault = vault_;
        compliance = compliance_;
        owner = owner_;
        relayer = vault_.relayer();
        _tokens = tokens_;
        _donor = makeAddr("donor");
        _rescueSink = makeAddr("rescue-sink");
        for (uint256 i = 0; i < 3; ++i) {
            _senders[i] = makeAddr(string.concat("sender-", vm.toString(i)));
            _recipients[i] = makeAddr(string.concat("recipient-", vm.toString(i)));
            for (uint256 t = 0; t < 2; ++t) {
                vm.prank(_senders[i]);
                _tokens[t].approve(address(vault_), type(uint256).max);
            }
        }
    }

    function giftCount() external view returns (uint256) {
        return giftIds.length;
    }

    function createGift(uint256 tokenSeed, uint256 senderSeed, uint256 amount, uint256 lifetime) external {
        MockStockToken token = _tokens[tokenSeed % 2];
        if (giftIds.length >= MAX_GIFTS || token.paused()) return;
        address from = _senders[senderSeed % 3];
        amount = bound(amount, 1, 1e24);
        lifetime = bound(lifetime, 1 hours, 90 days);
        _keyNonce++;
        uint256 pk = uint256(keccak256(abi.encode("handler-key", _keyNonce))) % (SECP256K1_N - 1) + 1;
        address key = vm.addr(pk);
        token.mint(from, amount);
        bytes memory proof = _sign(pk, vault.registerDigest(from));

        vm.prank(from);
        try vault.createGift(address(token), amount, key, uint64(block.timestamp + lifetime), "", proof) returns (
            uint256 giftId
        ) {
            giftIds.push(giftId);
            _keyOf[giftId] = pk;
            expectedState[giftId] = GiftVault.State.Open;
            totalReceived[address(token)] += vault.getGift(giftId).amount;
        } catch {}
    }

    function claim(uint256 giftSeed, uint256 recipientSeed) external {
        if (giftIds.length == 0) return;
        uint256 giftId = giftIds[giftSeed % giftIds.length];
        address recipient = _recipients[recipientSeed % 3];
        bytes memory signature = _sign(_keyOf[giftId], vault.claimDigest(giftId, recipient));
        GiftVault.Gift memory gift = vault.getGift(giftId);

        vm.prank(relayer);
        try vault.claim(giftId, recipient, signature) {
            _recordFinal(giftId, GiftVault.State.Claimed);
            totalPaidOut[gift.token] += gift.amount;
        } catch {}
    }

    function claimWithWrongKey(uint256 giftSeed, uint256 wrongPk) external {
        if (giftIds.length == 0) return;
        uint256 giftId = giftIds[giftSeed % giftIds.length];
        wrongPk = bound(wrongPk, 1, SECP256K1_N - 1);
        if (wrongPk == _keyOf[giftId]) return;
        address recipient = _recipients[0];
        bytes memory signature = _sign(wrongPk, vault.claimDigest(giftId, recipient));

        vm.prank(relayer);
        try vault.claim(giftId, recipient, signature) {
            wrongKeyClaimSucceeded = true;
        } catch {}
    }

    function refund(uint256 giftSeed) external {
        if (giftIds.length == 0) return;
        uint256 giftId = giftIds[giftSeed % giftIds.length];
        GiftVault.Gift memory gift = vault.getGift(giftId);

        try vault.refund(giftId) {
            _recordFinal(giftId, GiftVault.State.Refunded);
            totalPaidOut[gift.token] += gift.amount;
        } catch {}
    }

    function warp(uint256 secondsAhead) external {
        vm.warp(block.timestamp + bound(secondsAhead, 1, 30 days));
    }

    // Disruptions act one time in four so sequences also spend long stretches in the healthy state.
    function setListed(uint256 tokenSeed, uint256 seed) external {
        vm.prank(owner);
        vault.setTokenListed(address(_tokens[tokenSeed % 2]), seed % 4 != 0);
    }

    function togglePause(uint256 seed) external {
        bool paused = vault.paused();
        if (!paused && seed % 4 != 0) return;
        vm.prank(owner);
        if (paused) vault.unpause();
        else vault.pause();
    }

    function rescue(uint256 tokenSeed) external {
        MockStockToken token = _tokens[tokenSeed % 2];
        uint256 before = token.balanceOf(address(vault));
        vm.prank(owner);
        try vault.rescueSurplus(address(token), _rescueSink) {
            totalRescued[address(token)] += before - token.balanceOf(address(vault));
        } catch {}
    }

    function donate(uint256 tokenSeed, uint256 amount) external {
        MockStockToken token = _tokens[tokenSeed % 2];
        if (token.paused()) return;
        amount = bound(amount, 1, 1e24);
        token.mint(_donor, amount);
        uint256 before = token.balanceOf(address(vault));
        vm.prank(_donor);
        try token.transfer(address(vault), amount) {
            totalDonated[address(token)] += token.balanceOf(address(vault)) - before;
        } catch {}
    }

    function setIssuerPaused(uint256 tokenSeed, uint256 seed) external {
        _tokens[tokenSeed % 2].setPaused(seed % 4 == 0);
    }

    function setSenderBlocked(uint256 tokenSeed, uint256 senderSeed, uint256 seed) external {
        compliance.setBlocked(address(_tokens[tokenSeed % 2]), _senders[senderSeed % 3], seed % 4 == 0);
    }

    function _recordFinal(uint256 giftId, GiftVault.State finalState) internal {
        if (expectedState[giftId] != GiftVault.State.Open) finalStateLeft = true;
        expectedState[giftId] = finalState;
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}

contract GiftVaultInvariantTest is StdInvariant, Test {
    GiftVault internal vault;
    GiftVaultHandler internal handler;
    MockStockToken[2] internal tokens;

    function setUp() public {
        vm.warp(1_760_000_000);
        address owner = makeAddr("owner");
        MockCompliance compliance = new MockCompliance();
        tokens[0] = new MockStockToken("Nvidia bStock", "NVDAB", address(compliance));
        tokens[1] = new FeeOnTransferToken(address(compliance), 100);
        address[] memory listed = new address[](2);
        listed[0] = address(tokens[0]);
        listed[1] = address(tokens[1]);
        vault = new GiftVault(owner, makeAddr("relayer"), listed);
        handler = new GiftVaultHandler(vault, compliance, tokens, owner);

        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = GiftVaultHandler.createGift.selector;
        selectors[1] = GiftVaultHandler.claim.selector;
        selectors[2] = GiftVaultHandler.claimWithWrongKey.selector;
        selectors[3] = GiftVaultHandler.refund.selector;
        selectors[4] = GiftVaultHandler.warp.selector;
        selectors[5] = GiftVaultHandler.setListed.selector;
        selectors[6] = GiftVaultHandler.togglePause.selector;
        selectors[7] = GiftVaultHandler.rescue.selector;
        selectors[8] = GiftVaultHandler.donate.selector;
        selectors[9] = GiftVaultHandler.setIssuerPaused.selector;
        selectors[10] = GiftVaultHandler.setSenderBlocked.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// C4: the vault always holds at least what its open gifts owe, per token.
    function invariant_C4_balanceCoversLiabilities() public view {
        for (uint256 t = 0; t < 2; ++t) {
            assertGe(tokens[t].balanceOf(address(vault)), vault.liabilities(address(tokens[t])));
        }
    }

    /// C4: liabilities are exactly the sum of open gift amounts, read from the vault's own records.
    function invariant_C4_liabilitiesEqualOpenGiftSum() public view {
        uint256[2] memory openSum;
        uint256 count = handler.giftCount();
        for (uint256 i = 0; i < count; ++i) {
            GiftVault.Gift memory gift = vault.getGift(handler.giftIds(i));
            if (gift.state != GiftVault.State.Open) continue;
            openSum[gift.token == address(tokens[0]) ? 0 : 1] += gift.amount;
        }
        assertEq(vault.liabilities(address(tokens[0])), openSum[0]);
        assertEq(vault.liabilities(address(tokens[1])), openSum[1]);
    }

    /// C1 and C4: per token, gifts never pay out more than they took in, and every unit is accounted for.
    function invariant_C1_paidOutNeverExceedsReceived() public view {
        for (uint256 t = 0; t < 2; ++t) {
            address token = address(tokens[t]);
            uint256 received = handler.totalReceived(token);
            uint256 paidOut = handler.totalPaidOut(token);
            assertLe(paidOut, received);
            assertEq(received - paidOut, vault.liabilities(token));
            assertLe(handler.totalRescued(token), handler.totalDonated(token));
            assertEq(
                tokens[t].balanceOf(address(vault)),
                vault.liabilities(token) + handler.totalDonated(token) - handler.totalRescued(token)
            );
        }
    }

    /// C1: no gift ever leaves Claimed or Refunded, and no claim ever succeeds without the stored key (C2).
    function invariant_C1_noGiftLeavesFinalState() public view {
        assertFalse(handler.finalStateLeft());
        assertFalse(handler.wrongKeyClaimSucceeded());
        uint256 count = handler.giftCount();
        for (uint256 i = 0; i < count; ++i) {
            uint256 giftId = handler.giftIds(i);
            assertEq(uint8(vault.getGift(giftId).state), uint8(handler.expectedState(giftId)));
        }
    }
}
