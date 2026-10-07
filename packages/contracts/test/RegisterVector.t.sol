// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Writes test/vectors/register.json, the one fixed key-proof digest case the TypeScript side must reproduce
// (threat model C32, and standard 2: one encoding, checked by both sides). The vault sits at the same fixed CREATE
// address on chain id 56 as in claim.json, and every hash is recomputed here from the EIP-712 spec, independently
// of the vault.
// Does NOT cover: signing (the vector holds no key or signature), other chain ids or vault addresses, or the
// TypeScript assertion itself, which lives in packages/core.

import {Test} from "forge-std/Test.sol";
import {GiftVault} from "../src/GiftVault.sol";

contract RegisterVectorTest is Test {
    string internal constant VECTOR_PATH = "./test/vectors/register.json";
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function test_writesRegisterVectorMatchingVault() public {
        vm.chainId(56);
        address deployer = makeAddr("moi-vector-deployer");
        address sender = makeAddr("moi-vector-sender");
        vm.prank(deployer);
        GiftVault vault = new GiftVault(deployer, makeAddr("moi-vector-relayer"), new address[](0));
        assertEq(address(vault), vm.computeCreateAddress(deployer, 0));

        bytes32 domainSeparator =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Moi"), keccak256("1"), uint256(56), address(vault)));
        bytes32 structHash = keccak256(abi.encode(keccak256("RegisterGift(address sender)"), sender));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        assertEq(vault.REGISTER_TYPEHASH(), keccak256("RegisterGift(address sender)"));
        assertEq(vault.registerDigest(sender), digest);

        string memory json = string.concat(
            "{\n",
            '  "vault": "', vm.toString(address(vault)), '",\n',
            '  "chainId": 56,\n',
            '  "sender": "', vm.toString(sender), '",\n',
            '  "domainSeparator": "', vm.toString(domainSeparator), '",\n',
            '  "structHash": "', vm.toString(structHash), '",\n',
            '  "digest": "', vm.toString(digest), '"\n',
            "}\n"
        );
        vm.writeFile(VECTOR_PATH, json);

        string memory written = vm.readFile(VECTOR_PATH);
        assertEq(vm.parseJsonKeys(written, "$").length, 6);
        assertEq(vm.parseJsonAddress(written, ".vault"), address(vault));
        assertEq(vm.parseJsonUint(written, ".chainId"), 56);
        assertEq(vm.parseJsonAddress(written, ".sender"), sender);
        assertEq(vm.parseJsonBytes32(written, ".domainSeparator"), domainSeparator);
        assertEq(vm.parseJsonBytes32(written, ".structHash"), structHash);
        assertEq(vm.parseJsonBytes32(written, ".digest"), digest);
    }
}
