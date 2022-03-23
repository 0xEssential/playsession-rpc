import 'dotenv/config';
import rpc from 'json-rpc2';
import { JsonRpcProvider } from '@ethersproject/providers';
import { BigNumber, Contract, utils, Wallet } from 'ethers';

import EssentialForwarder from './abis/EssentialForwarder.json';

const OWNER_ABI = [
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'tokenId',
        type: 'uint256',
      },
    ],
    name: 'ownerOf',
    outputs: [
      {
        internalType: 'address',
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
];

const server = rpc.Server.$create({
  headers: {
    'Access-Control-Allow-Origin': '*',
  },
});

function decodeCalldata(calldata: string): Record<string, any> {
  const abi = new utils.AbiCoder();
  const [from, nonce, nftContract, tokenId, tokenNonce] = abi.decode(
    ['address', 'uint256', 'address', 'uint256', 'uint256'],
    calldata,
  );

  return { from, nonce, nftContract, tokenId, tokenNonce };
}

async function fetchCurrentOwner(
  nftContract: string,
  tokenId: BigNumber,
): Promise<string> {
  const mainnetProvider = new JsonRpcProvider(process.env.MAINNET_RPC_URL, 1);
  const Erc721 = new Contract(nftContract, OWNER_ABI, mainnetProvider);
  return Erc721.ownerOf(tokenId);
}

async function generateProof({
  owner,
  nonce,
  nftContract,
  tokenId,
  to,
  tokenNonce
  // abi,
}): Promise<string> {
  // This EOA won't have any assets, and can be easily changed on the Forwarding
  // contract, so the risk profile is pretty low. We use this on the L2 to fetch
  // the message to sign.

  const altnetProvider = new JsonRpcProvider(process.env.ALTNET_RPC_URL);
  const ownershipSigner = new Wallet(
    process.env.OWNERSHIP_SIGNER_PRIVATE_KEY,
    altnetProvider,
  );

  const forwarder = new Contract(to, EssentialForwarder.abi, ownershipSigner);

  const message = await forwarder.createMessage(
    owner,
    nonce,
    nftContract,
    tokenId,
    tokenNonce
  );

  return ownershipSigner.signMessage(utils.arrayify(message));
}

async function durinCall({ callData, to, abi: _abi }, _opt, callback) {
  const { from, nonce, nftContract, tokenId, tokenNonce } = decodeCalldata(callData);

  // lookup current owner on mainnet
  let owner: string;
  try {
    owner = await fetchCurrentOwner(
      nftContract,
      tokenId,
    );
  } catch (e) {
    return callback(new rpc.Error.InternalError('Error fetching owner'));
  }

  // generate proof for owner or authorized
  let proof: string;
  try {
    proof = await generateProof({
      owner,
      nonce,
      nftContract,
      tokenId,
      to,
      tokenNonce
      // abi,
    });
  } catch (e) {
    console.warn(e);
    return callback(new rpc.Error.InternalError('Error generating proof'));
  }

  callback(null, proof);
}

server.expose('durin_call', durinCall);
server.listen(process.env.PORT);
