// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GiftVault} from "../src/GiftVault.sol";

/// @dev The ERC-8056 view bStocks use to show a balance in shares. The standard fixes the name.
interface IScaledBalance {
    // forge-lint: disable-next-line(mixed-case-function)
    function balanceOfUI(address account) external view returns (uint256);
}

/// @title RehearseGift
/// @notice One real gift on a local anvil fork of BSC: the Venus vNVDAB market funds the sender, a fresh claim key
///         signs its consent for that sender (C32), the sender locks the gift, the claim key signs for a fresh
///         recipient, and the vault's own relayer claims it.
/// @dev Anvil fork only. It sends as vNVDAB, the sender and the relayer without their keys, which only an anvil
///      started with --auto-impersonate accepts, and each of them needs BNB for gas on the fork:
///      forge script script/RehearseGift.s.sol:RehearseGift --sig "run(address,address)" <vault> <sender>
///      --rpc-url <anvil> --broadcast --unlocked --slow --legacy
contract RehearseGift is Script {
    address internal constant NVDAB = 0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436;
    address internal constant VNVDAB = 0xEb8Ca841cBe1BC4832A10b15c7dAB1081eDaD371;
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    /// @dev About 20 USD of NVDAB on 2026-10-07.
    uint256 internal constant AMOUNT = 0.0832 ether;

    error TokenCallFailed();

    /// @notice Runs one gift end to end against `vault` and prints the balances it touched.
    /// @param vault A GiftVault on this fork with NVDAB listed.
    /// @param sender A fresh address with BNB for gas and no NVDAB.
    function run(GiftVault vault, address sender) external {
        IERC20 nvdab = IERC20(NVDAB);
        address relayer = vault.relayer();
        uint256 claimKeyPk = vm.randomUint(1, SECP256K1_N - 1);
        address claimKey = vm.addr(claimKeyPk);
        address recipient = vm.randomAddress();
        // Unix time plus a week stays far below 2^64.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 expiry = uint64(block.timestamp + 7 days);
        bytes memory keyProof = _sign(claimKeyPk, vault.registerDigest(sender));

        vm.broadcast(VNVDAB);
        if (!nvdab.transfer(sender, AMOUNT)) revert TokenCallFailed();

        vm.startBroadcast(sender);
        if (!nvdab.approve(address(vault), AMOUNT)) revert TokenCallFailed();
        uint256 giftId = vault.createGift(NVDAB, AMOUNT, claimKey, expiry, "", keyProof);
        vm.stopBroadcast();

        bytes memory claimSignature = _sign(claimKeyPk, vault.claimDigest(giftId, recipient));
        vm.broadcast(relayer);
        vault.claim(giftId, recipient, claimSignature);

        console.log("gift id:", giftId);
        console.log("sender:", sender);
        console.log("claim key:", claimKey);
        console.log("relayer:", relayer);
        console.log("recipient:", recipient);
        console.log("sender NVDAB: %18e", nvdab.balanceOf(sender));
        console.log("vault NVDAB: %18e", nvdab.balanceOf(address(vault)));
        console.log("vault liabilities: %18e", vault.liabilities(NVDAB));
        console.log("recipient NVDAB: %18e", nvdab.balanceOf(recipient));
        console.log("recipient shares (balanceOfUI): %18e", IScaledBalance(NVDAB).balanceOfUI(recipient));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
