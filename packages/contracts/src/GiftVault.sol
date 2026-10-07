// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LowLevelCall} from "@openzeppelin/contracts/utils/LowLevelCall.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title ITokenCompliance
/// @notice The bStock getter that names the compliance contract judging the token's transfers.
interface ITokenCompliance {
    /// @notice Returns the compliance contract the token asks on every transfer.
    /// @return The compliance contract address.
    function compliance() external view returns (address);
}

/// @title ICompliance
/// @notice The bStock compliance contract.
interface ICompliance {
    /// @notice Reverts when `user` is blocked for `token` or sanctioned, and returns nothing otherwise.
    /// @param token The token being moved.
    /// @param user The address being judged.
    function checkIsCompliant(address token, address user) external view;
}

/// @title GiftVault
/// @notice Holds a gifted stock token until whoever holds the gift link claims it through Moi's relayer,
///         or the sender takes it back after expiry. No one else, the owner included, can move a gift.
/// @dev Threat model references (C1 to C32) point to docs/security/threat-model.md section C.
///      Amounts are raw token units. Share figures are a display concern and never stored here.
contract GiftVault is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    enum State {
        None,
        Open,
        Claimed,
        Refunded
    }

    struct Gift {
        address token;
        address sender;
        address claimKey;
        uint64 expiry;
        State state;
        uint256 amount;
        bytes sealedNote;
    }

    /// @notice Largest sealed note createGift accepts, in bytes.
    uint256 public constant MAX_NOTE_BYTES = 512;
    /// @notice Shortest allowed gift lifetime from creation to expiry.
    uint64 public constant MIN_LIFETIME = 1 hours;
    /// @notice Longest allowed gift lifetime from creation to expiry.
    uint64 public constant MAX_LIFETIME = 90 days;
    /// @notice Most tokens the list can hold at once.
    /// @dev Delisting searches the list, so the worst case is 32 cold storage reads, about 70,000 gas.
    ///      That is 0.1 percent of the 70,000,000 gas BSC block limit (read at block 126,241,740), so
    ///      list edits and listedTokens() can never approach a block's capacity.
    uint256 public constant MAX_TOKENS = 32;
    /// @notice EIP-712 type hash of the claim message a claim key signs.
    bytes32 public constant CLAIM_TYPEHASH = keccak256("Claim(uint256 giftId,address recipient)");
    /// @notice EIP-712 type hash of the message a claim key signs to let one sender create a gift with it.
    bytes32 public constant REGISTER_TYPEHASH = keccak256("RegisterGift(address sender)");

    /// @notice The only address allowed to call claim.
    address public relayer;
    /// @notice The id the next gift will get. Starts at 1, so id 0 never exists.
    uint256 public nextGiftId = 1;
    /// @notice Whether a claim key address has ever been used by a gift.
    mapping(address => bool) public claimKeyUsed;
    /// @notice Whether new gifts may use a token.
    mapping(address => bool) public isListed;
    /// @notice Sum of open gift amounts per token, in raw token units.
    mapping(address => uint256) public liabilities;

    mapping(uint256 => Gift) private _gifts;
    address[] private _listedTokens;

    /// @notice A gift was locked; `amount` is what the vault actually received, in raw token units.
    event GiftCreated(
        uint256 indexed giftId,
        address indexed token,
        address indexed sender,
        address claimKey,
        uint256 amount,
        uint64 expiry
    );
    /// @notice A gift was paid to the recipient its claim key signed for.
    event GiftClaimed(uint256 indexed giftId, address indexed recipient, uint256 amount);
    /// @notice An expired gift went back to its sender.
    event GiftRefunded(uint256 indexed giftId, address indexed sender, uint256 amount);
    /// @notice A token was added to or removed from the list new gifts may use.
    event TokenListed(address indexed token, bool listed);
    /// @notice The address allowed to submit claims changed.
    event RelayerSet(address indexed previousRelayer, address indexed newRelayer);
    /// @notice Tokens above what open gifts owe were sent out.
    event SurplusRescued(address indexed token, address indexed to, uint256 amount);

    error NotRelayer();
    error TokenNotListed();
    error ZeroAmount();
    error ZeroAddress();
    error ZeroClaimKey();
    error ClaimKeyAlreadyUsed();
    error ExpiryOutOfRange();
    error NoteTooLong();
    error NoAmountReceived();
    error GiftNotOpen();
    error GiftExpired();
    error GiftNotExpired();
    error BadRecipient();
    error BadSigner();
    error BadKeyProof();
    error SenderNotCompliant();
    error TooManyTokens();
    error NothingToRescue();
    error RenounceDisabled();

    /// @notice Deploys the vault with its owner, relayer and starting token list.
    /// @param initialOwner Owner of the admin powers. Reverts OwnableInvalidOwner if zero.
    /// @param initialRelayer The only address allowed to submit claims. Reverts ZeroAddress if zero.
    /// @param initialTokens Tokens to list, under the same rules as setTokenListed (ZeroAddress, TooManyTokens).
    /// @dev Emits OwnershipTransferred, RelayerSet and one TokenListed per newly listed token.
    constructor(address initialOwner, address initialRelayer, address[] memory initialTokens)
        Ownable(initialOwner)
        EIP712("Moi", "1")
    {
        if (initialRelayer == address(0)) revert ZeroAddress();
        relayer = initialRelayer;
        emit RelayerSet(address(0), initialRelayer);
        for (uint256 i = 0; i < initialTokens.length; ++i) {
            _setTokenListed(initialTokens[i], true);
        }
    }

    /// @notice Locks `amount` of a listed `token` from the caller as a new gift that the holder of `claimKey`
    ///         can claim before `expiry`, or the caller can take back from `expiry` on.
    /// @param token A listed token. The caller must have approved this vault for `amount`.
    /// @param amount Raw token units to pull from the caller.
    /// @param claimKey The address of the one-time key carried in the gift link. Never reused.
    /// @param expiry Unix time in seconds, from now + MIN_LIFETIME to now + MAX_LIFETIME inclusive.
    /// @param sealedNote The note, already encrypted by the sender, at most MAX_NOTE_BYTES bytes.
    /// @param keyProof A 65-byte signature by `claimKey` over registerDigest(caller).
    /// @return giftId The new gift's id. Ids start at 1.
    /// @dev Reverts EnforcedPause, TokenNotListed, ZeroAmount, ZeroClaimKey, ClaimKeyAlreadyUsed,
    ///      ExpiryOutOfRange, NoteTooLong, an OpenZeppelin ECDSA error for a malformed, wrong-length or high-s
    ///      proof, BadKeyProof, NoAmountReceived, or the token's own transfer error.
    ///      C3: rejects keyless, shared-key, empty and over-long gifts; the expiry window also rejects
    ///      milliseconds passed as seconds. C4: records the amount the vault's own balance actually grew by.
    ///      C32: the proof binds the caller's address, so a copy of a pending createGift sent from another
    ///      address fails BadKeyProof and cannot burn the claim key before the real sender's call lands.
    ///      Emits GiftCreated with that received amount.
    function createGift(
        address token,
        uint256 amount,
        address claimKey,
        uint64 expiry,
        bytes calldata sealedNote,
        bytes calldata keyProof
    ) external nonReentrant whenNotPaused returns (uint256 giftId) {
        if (!isListed[token]) revert TokenNotListed();
        if (amount == 0) revert ZeroAmount();
        if (claimKey == address(0)) revert ZeroClaimKey();
        if (claimKeyUsed[claimKey]) revert ClaimKeyAlreadyUsed();
        if (expiry < block.timestamp + MIN_LIFETIME || expiry > block.timestamp + MAX_LIFETIME) {
            revert ExpiryOutOfRange();
        }
        if (sealedNote.length > MAX_NOTE_BYTES) revert NoteTooLong();
        if (ECDSA.recover(registerDigest(msg.sender), keyProof) != claimKey) revert BadKeyProof();

        giftId = nextGiftId++;
        claimKeyUsed[claimKey] = true;

        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 balanceAfter = IERC20(token).balanceOf(address(this));
        if (balanceAfter <= balanceBefore) revert NoAmountReceived();
        uint256 received = balanceAfter - balanceBefore;

        liabilities[token] += received;
        Gift storage gift = _gifts[giftId];
        gift.token = token;
        gift.sender = msg.sender;
        gift.claimKey = claimKey;
        gift.expiry = expiry;
        gift.state = State.Open;
        gift.amount = received;
        gift.sealedNote = sealedNote;

        emit GiftCreated(giftId, token, msg.sender, claimKey, received, expiry);
    }

    /// @notice Pays an open gift to `recipient`, authorised by the gift's claim key.
    /// @param giftId The gift to claim.
    /// @param recipient The address that receives the tokens. Bound into the signature.
    /// @param signature A 65-byte signature by the gift's claim key over claimDigest(giftId, recipient).
    /// @dev Only the relayer may call (C31). Reverts EnforcedPause, NotRelayer, GiftNotOpen, GiftExpired,
    ///      BadRecipient, an OpenZeppelin ECDSA error for a malformed, wrong-length or high-s signature,
    ///      BadSigner, SenderNotCompliant, or the token's own transfer error.
    ///      C1: the gift is marked Claimed before the transfer, under a reentrancy guard, so it pays once.
    ///      C2: the EIP-712 digest binds this vault, the chain id at call time, the gift id and the recipient.
    ///      C6: a failing transfer reverts the whole call and the gift stays Open.
    ///      C7: the original sender must pass the token's own compliance check at the moment of release.
    ///      C8: works only strictly before expiry; the zero address and this vault are refused as recipients.
    ///      C10: touches only this gift's token and its liability. Emits GiftClaimed.
    function claim(uint256 giftId, address recipient, bytes calldata signature) external nonReentrant whenNotPaused {
        if (msg.sender != relayer) revert NotRelayer();
        Gift storage gift = _gifts[giftId];
        if (gift.state != State.Open) revert GiftNotOpen();
        if (block.timestamp >= gift.expiry) revert GiftExpired();
        if (recipient == address(0) || recipient == address(this)) revert BadRecipient();
        if (ECDSA.recover(claimDigest(giftId, recipient), signature) != gift.claimKey) revert BadSigner();
        address token = gift.token;
        if (!_senderCompliant(token, gift.sender)) revert SenderNotCompliant();

        uint256 amount = gift.amount;
        gift.state = State.Claimed;
        liabilities[token] -= amount;
        IERC20(token).safeTransfer(recipient, amount);
        emit GiftClaimed(giftId, recipient, amount);
    }

    /// @notice Returns an expired, unclaimed gift to its stored sender. Anyone may call.
    /// @param giftId The gift to refund.
    /// @dev Not pausable (C5), so the owner can never hold a sender's tokens hostage. Delisting does not
    ///      affect it either. Reverts GiftNotOpen, GiftNotExpired, or the token's own transfer error.
    ///      C1: the gift is marked Refunded before the transfer, under a reentrancy guard.
    ///      C6: a failing transfer reverts the whole call and the gift stays Open.
    ///      C8: works only at or after expiry. C10: touches only this gift's token. Emits GiftRefunded.
    function refund(uint256 giftId) external nonReentrant {
        Gift storage gift = _gifts[giftId];
        if (gift.state != State.Open) revert GiftNotOpen();
        if (block.timestamp < gift.expiry) revert GiftNotExpired();

        address token = gift.token;
        address sender = gift.sender;
        uint256 amount = gift.amount;
        gift.state = State.Refunded;
        liabilities[token] -= amount;
        IERC20(token).safeTransfer(sender, amount);
        emit GiftRefunded(giftId, sender, amount);
    }

    /// @notice The EIP-712 digest a claim key signs to release `giftId` to `recipient`.
    /// @param giftId The gift being claimed.
    /// @param recipient The address that will receive the tokens.
    /// @return The digest to sign with the gift's claim key.
    /// @dev Domain is name "Moi", version "1", the current chain id and this vault's address (C2).
    ///      The domain is rebuilt if the chain id changes, so a signature never crosses chains.
    function claimDigest(uint256 giftId, address recipient) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, giftId, recipient)));
    }

    /// @notice The EIP-712 digest a claim key signs so that `sender` may create a gift with that key.
    /// @param sender The address that will call createGift.
    /// @return The digest to sign with the claim key, passed to createGift as keyProof.
    /// @dev Same domain as claimDigest, so a proof never crosses vaults or chains. Binding the sender is
    ///      what makes a proof copied out of a pending transaction useless to any other address (C32).
    function registerDigest(address sender) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(REGISTER_TYPEHASH, sender)));
    }

    /// @notice Returns a gift record. An id that was never created returns an empty record with state None.
    /// @param giftId The gift to read.
    /// @return The stored gift.
    function getGift(uint256 giftId) external view returns (Gift memory) {
        return _gifts[giftId];
    }

    /// @notice Returns every listed token. This is the single token list Moi reads (C22).
    /// @return The listed token addresses, in list order.
    function listedTokens() external view returns (address[] memory) {
        return _listedTokens;
    }

    /// @notice Whether the token would currently accept the gift's original sender, the same test claim runs.
    /// @param giftId The gift whose sender to check.
    /// @return True only if claim's compliance check would pass right now.
    /// @dev Never reverts. A gift id that does not exist returns false. See _senderCompliant for the
    ///      exact coverage (C7).
    function senderIsCompliant(uint256 giftId) external view returns (bool) {
        Gift storage gift = _gifts[giftId];
        return _senderCompliant(gift.token, gift.sender);
    }

    /// @notice Adds `token` to or removes it from the list of tokens new gifts may use.
    /// @param token The token to list or delist.
    /// @param listed True to list, false to delist.
    /// @dev Only the owner. Reverts ZeroAddress for the zero token and TooManyTokens past MAX_TOKENS.
    ///      Setting a token to the state it already has is a no-op with no event.
    ///      C5: claim and refund never read the list, so delisting cannot block an existing gift.
    ///      Emits TokenListed when the list changes.
    function setTokenListed(address token, bool listed) external onlyOwner {
        _setTokenListed(token, listed);
    }

    /// @notice Replaces the relayer, the only address allowed to submit claims.
    /// @param newRelayer The new relayer address.
    /// @dev Only the owner. Reverts ZeroAddress. The relayer has no other power, and without a claim-key
    ///      signature it cannot claim anything (C31). Emits RelayerSet.
    function setRelayer(address newRelayer) external onlyOwner {
        if (newRelayer == address(0)) revert ZeroAddress();
        address previousRelayer = relayer;
        relayer = newRelayer;
        emit RelayerSet(previousRelayer, newRelayer);
    }

    /// @notice Stops new gifts and claims. Refunds keep working (C5).
    /// @dev Only the owner. Reverts EnforcedPause if already paused. Emits Paused.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resumes new gifts and claims.
    /// @dev Only the owner. Reverts ExpectedPause if not paused. Emits Unpaused.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Sends `to` only the tokens held above what open gifts owe, such as tokens sent here by mistake.
    /// @param token The token to rescue.
    /// @param to Where the surplus goes.
    /// @dev Only the owner. Reverts ZeroAddress for a zero token or recipient, and NothingToRescue when the
    ///      balance does not exceed liabilities. C5: the amount is balanceOf(vault) minus liabilities[token],
    ///      so no open gift can be touched. Emits SurplusRescued.
    function rescueSurplus(address token, address to) external nonReentrant onlyOwner {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 owed = liabilities[token];
        if (balance <= owed) revert NothingToRescue();
        uint256 surplus = balance - owed;
        IERC20(token).safeTransfer(to, surplus);
        emit SurplusRescued(token, to, surplus);
    }

    /// @notice Always reverts RenounceDisabled. Ownership moves only through the two-step transfer.
    /// @dev C5: an owner-less vault left paused could never unpause, which would freeze every claim.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    function _setTokenListed(address token, bool listed) private {
        if (token == address(0)) revert ZeroAddress();
        if (isListed[token] == listed) return;
        if (listed) {
            if (_listedTokens.length >= MAX_TOKENS) revert TooManyTokens();
            _listedTokens.push(token);
        } else {
            uint256 lastIndex = _listedTokens.length - 1;
            for (uint256 i = 0; i < lastIndex; ++i) {
                if (_listedTokens[i] == token) {
                    _listedTokens[i] = _listedTokens[lastIndex];
                    break;
                }
            }
            _listedTokens.pop();
        }
        isListed[token] = listed;
        emit TokenListed(token, listed);
    }

    /// @dev C7, fail closed. Returns true only when every step holds: the token has code; its compliance()
    ///      call succeeds and returns exactly 32 bytes; those bytes are a non-zero address with clean upper
    ///      bits; that address has code; and its checkIsCompliant(token, sender) returns without reverting.
    ///      Anything else returns false: a revert, a short or long return, a dirty address, a call that runs
    ///      out of the gas it was given, or a missing contract. At most 64 bytes of return data are copied,
    ///      so a token cannot force a revert by returning a huge payload.
    ///      It does not cover a compliance contract that wrongly approves a blocked sender, and it does not
    ///      check the recipient: the token checks the recipient itself during the transfer.
    function _senderCompliant(address token, address sender) internal view returns (bool) {
        if (token.code.length == 0) return false;
        (bool ok, bytes32 word,) =
            LowLevelCall.staticcallReturn64Bytes(token, abi.encodeCall(ITokenCompliance.compliance, ()));
        if (!ok || LowLevelCall.returnDataSize() != 32) return false;
        uint256 raw = uint256(word);
        if (raw == 0 || raw > type(uint160).max) return false;
        // The cast cannot truncate: raw was checked against type(uint160).max just above.
        // forge-lint: disable-next-line(unsafe-typecast)
        address complianceContract = address(uint160(raw));
        if (complianceContract.code.length == 0) return false;
        try ICompliance(complianceContract).checkIsCompliant(token, sender) {
            return true;
        } catch {
            return false;
        }
    }
}
