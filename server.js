"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const json_rpc2_1 = __importDefault(require("json-rpc2"));
const providers_1 = require("@ethersproject/providers");
const ethers_1 = require("ethers");
const OWNER_ABI = [
    'function ownerOf(uint256 tokenId) public view returns (address)',
];
const server = json_rpc2_1.default.Server.$create({
    headers: {
        'Access-Control-Allow-Origin': '*',
    },
});
function decodeCalldata(calldata) {
    const abi = new ethers_1.utils.AbiCoder();
    const [from, nonce, nftContract, tokenId] = abi.decode(['address', 'uint256', 'address', 'uint256'], calldata);
    return { from, nonce, nftContract, tokenId };
}
async function fetchCurrentOwner(nftContract, tokenId) {
    const mainnetProvider = new providers_1.JsonRpcProvider(process.env.MAINNET_RPC_URL);
    const Erc721 = new ethers_1.Contract(nftContract, OWNER_ABI, mainnetProvider);
    return Erc721.ownerOf(tokenId);
}
async function generateProof({ from, nonce, nftContract, tokenId, to, abi, }) {
    // This EOA won't have any assets, and can be easily changed on the Forwarding
    // contract, so the risk profile is pretty low. We use this on the L2 to fetch
    // the message to sign. This step may be unnecessary? Must we call the contract
    // per spec, or can we just make the L1 call with the calldata provided?
    const altnetProvider = new providers_1.JsonRpcProvider(process.env.ALTNET_RPC_URL);
    const ownershipSigner = new ethers_1.Wallet(process.env.OWNERSHIP_SIGNER_PRIVATE_KEY, altnetProvider);
    const forwarder = new ethers_1.Contract(to, abi, ownershipSigner);
    const message = await forwarder.createMessage(from, nonce, nftContract, tokenId);
    return ownershipSigner.signMessage(ethers_1.utils.arrayify(message));
}
async function durinCall({ callData, to, abi }, _opt, callback) {
    // decode the callData
    const { from, nonce, nftContract, tokenId } = decodeCalldata(callData);
    // lookup current owner on mainnet
    const owner = await fetchCurrentOwner(nftContract, tokenId);
    // return an error if the current owner does not match the from address
    if (ethers_1.utils.getAddress(owner) !== ethers_1.utils.getAddress(from)) {
        return callback(new json_rpc2_1.default.Error.InternalError());
    }
    const proof = await generateProof({
        from,
        nonce,
        nftContract,
        tokenId,
        to,
        abi,
    });
    callback(null, proof);
}
server.expose('durin_call', durinCall);
server.listen(process.env.PORT, 'localhost');
