// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {GiftVault, ITokenCompliance} from "../src/GiftVault.sol";

/// @title Deploy
/// @notice Deploys GiftVault with the nine gift bStocks listed, after proving each one is a live bStock judged by
///         Binance's Compliance contract. Any failed check aborts before anything is broadcast. Run it through
///         deploy.sh, which loads the environment from the repo-root .env.
/// @dev Environment: DEPLOYER_PRIVATE_KEY and MOI_RELAYER_ADDRESS are required. MOI_OWNER_ADDRESS is required on BSC
///      mainnet (optional on a local chain): ownership is offered to it with Ownable2Step and Ram accepts with one signature.
contract Deploy is Script {
    /// @notice The bStock Compliance contract every gift token must name.
    address public constant BSTOCK_COMPLIANCE = 0x53dBa7AaBDe774787A1F57236B235567dA8e14F4;

    error UnsupportedChain(uint256 chainId);
    error TokenHasNoCode(address token);
    error TokenSymbolNotB(address token, string symbol);
    error TokenComplianceUnreadable(address token);
    error TokenComplianceMismatch(address token, address compliance);
    error OwnerIsZero();
    error NoOwnerHandover();
    error RelayerIsAnOwner(address relayer);

    /// @notice The nine gift bStocks, read on BSC on 2026-10-07.
    /// @return tokens The token addresses in listing order.
    function giftTokens() public pure returns (address[] memory tokens) {
        tokens = new address[](9);
        tokens[0] = 0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A; // AAPLB
        tokens[1] = 0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436; // NVDAB
        tokens[2] = 0x5b1910eAaD6450E50f816082Aa078C41F10C292f; // TSLAB
        tokens[3] = 0x80106cb3EAD06659A5ad19DF39D9b4733863B9b0; // MSFTB
        tokens[4] = 0x1a4b499833A79A09ad7Cf1D42D7DacF71e92eb00; // AMZNB
        tokens[5] = 0x3F53De71c126BdaBAe20f9cD64848d317f6C3238; // GOOGLB
        tokens[6] = 0x7425889FE94F9d693E8daefE88BCCed6AcFEf4c0; // METAB
        tokens[7] = 0x7138b48df7D98D7e3cc221BfE7192D0a178182D8; // SPYB
        tokens[8] = 0x205812CdBed920aFf76C6580abD681a46D11efc7; // QQQB
    }

    /// @notice Reverts unless the current chain is BSC mainnet (56) or a local anvil chain (31337).
    function checkChain() public view {
        if (block.chainid != 56 && block.chainid != 31337) revert UnsupportedChain(block.chainid);
    }

    /// @notice Reverts unless `token` has code, a symbol ending in "B", and a compliance() that returns exactly
    ///         BSTOCK_COMPLIANCE.
    /// @param token The token to check.
    /// @dev Fails closed: a reverting, short, long or dirty compliance() answer counts as a mismatch. compliance()
    ///      is read with a low-level call so each of those gets a named error instead of a bare revert. The script
    ///      loops over nine fixed tokens off chain before broadcasting, so calls inside that loop cost nothing.
    function checkToken(address token) public view {
        if (token.code.length == 0) revert TokenHasNoCode(token);
        // forge-lint: disable-next-line(calls-loop)
        string memory symbol = IERC20Metadata(token).symbol();
        bytes memory symbolBytes = bytes(symbol);
        if (symbolBytes.length == 0 || symbolBytes[symbolBytes.length - 1] != "B") {
            revert TokenSymbolNotB(token, symbol);
        }
        // forge-lint: disable-next-line(low-level-calls, calls-loop)
        (bool ok, bytes memory answer) = token.staticcall(abi.encodeCall(ITokenCompliance.compliance, ()));
        if (!ok || answer.length != 32) revert TokenComplianceUnreadable(token);
        address tokenCompliance = abi.decode(answer, (address));
        if (tokenCompliance != BSTOCK_COMPLIANCE) revert TokenComplianceMismatch(token, tokenCompliance);
    }

    /// @notice Checks the chain and every gift token, then deploys the vault and offers ownership to
    ///         MOI_OWNER_ADDRESS when it is set.
    /// @return vault The deployed vault.
    /// @dev Reverts UnsupportedChain, any checkToken error, OwnerIsZero, RelayerIsAnOwner, or the vault
    ///      constructor's own errors. Every check runs before the broadcast starts.
    function run() external returns (GiftVault vault) {
        checkChain();
        address[] memory tokens = giftTokens();
        for (uint256 i = 0; i < tokens.length; ++i) {
            checkToken(tokens[i]);
        }

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address relayer = vm.envAddress("MOI_RELAYER_ADDRESS");
        // An empty value means "keep the deployer as owner"; a malformed one reverts in parseAddress.
        string memory ownerText = vm.envOr("MOI_OWNER_ADDRESS", string(""));
        bool handOver = bytes(ownerText).length != 0;
        address newOwner = handOver ? vm.parseAddress(ownerText) : address(0);
        if (handOver && newOwner == address(0)) revert OwnerIsZero();
        // On BSC mainnet the script key must never stay owner: it also funds judge gifts as the sponsor.
        if (block.chainid == 56 && !handOver) revert NoOwnerHandover();
        // Threat model C17: the relayer key signs claims only and must never hold the owner's powers.
        if (relayer == deployer || (handOver && relayer == newOwner)) revert RelayerIsAnOwner(relayer);

        vm.startBroadcast(deployerKey);
        vault = new GiftVault(deployer, relayer, tokens);
        if (handOver) vault.transferOwnership(newOwner);
        vm.stopBroadcast();

        console.log("chain id:", block.chainid);
        console.log("GiftVault:", address(vault));
        console.log("owner:", vault.owner());
        console.log("pendingOwner:", vault.pendingOwner());
        console.log("relayer:", vault.relayer());
        address[] memory listed = vault.listedTokens();
        console.log("listedTokens:", listed.length);
        for (uint256 i = 0; i < listed.length; ++i) {
            // forge-lint: disable-next-line(calls-loop)
            console.log("  %s %s", IERC20Metadata(listed[i]).symbol(), listed[i]);
        }
    }
}
