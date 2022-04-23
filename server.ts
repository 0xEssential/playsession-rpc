import 'dotenv/config';
import rpc from 'json-rpc2';
import { InfuraProvider, JsonRpcProvider } from '@ethersproject/providers';
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

type RawCalldata = {
  from: string, 
  authorizer: string, 
  nonce: BigNumber, 
  nftChainId: BigNumber,
  nftContract: string,
  nftTokenId: BigNumber,
  targetChainId: BigNumber,
  timestamp: BigNumber,
}

const server = rpc.Server.$create({
  headers: {
    'Access-Control-Allow-Origin': '*',
  },
});

function decodeCalldata(calldata: string): RawCalldata {
  const abi = new utils.AbiCoder();
  const [from, authorizer, nonce, nftChainId, nftContract, nftTokenId, targetChainId, timestamp] = abi.decode(
    ['address', 'address', 'uint256', 'uint256', 'address', 'uint256', 'uint256', 'uint256'],
    calldata
  );

  return {from, authorizer, nonce, nftChainId, nftContract, nftTokenId, targetChainId, timestamp}
}

async function fetchCurrentOwner(
  nftChainId: BigNumber,
  nftContract: string,
  tokenId: BigNumber,
): Promise<string> {
  const nftChainProvider = new InfuraProvider(nftChainId.toNumber(), process.env.INFURA_API_KEY);
  const Erc721 = new Contract(nftContract, OWNER_ABI, nftChainProvider);
  return Erc721.ownerOf(tokenId);
}

async function generateProof(
  owner: string,
  to: string,
  decodedCallData: RawCalldata,
): Promise<string> {
  // This EOA won't have any assets, and can be easily changed on the Forwarding
  // contract, so the risk profile is pretty low. We use this on the L2 to fetch
  // the message to sign.

  const altnetProvider = new JsonRpcProvider(process.env.ALTNET_RPC_URL);
  const ownershipSigner = new Wallet(
    process.env.OWNERSHIP_SIGNER_PRIVATE_KEY,
    altnetProvider,
  );

  const forwarder = new Contract(to, EssentialForwarder.abi, ownershipSigner);

  const nonce = await forwarder.getNonce(decodedCallData.from);

  if (!nonce.eq(decodedCallData.nonce)) throw Error('Invalid nonce');

  const message = await forwarder.createMessage(
    decodedCallData.from,
    owner,
    decodedCallData.nonce,
    decodedCallData.nftChainId,
    decodedCallData.nftContract,
    decodedCallData.tokenId,
    decodedCallData.timestamp,
  );

  return ownershipSigner.signMessage(utils.arrayify(message));
}

async function durinCall({ callData, to, abi: _abi }, _opt, callback) {
  const decodedCallData = decodeCalldata(callData);
  
  console.warn(decodedCallData);
  
  // lookup current owner on mainnet
  let owner: string;
  try {
    owner = await fetchCurrentOwner(
      decodedCallData.nftChainId,
      decodedCallData.nftContract,
      decodedCallData.tokenId,
    );
  } catch (e) {
    return callback(new rpc.Error.InternalError('Error fetching owner'));
  }

  // generate proof for owner or authorized
  let proof: string;
  try {
    proof = await generateProof(owner, to, decodedCallData);
  } catch (e) {
    console.warn(e);
    return callback(new rpc.Error.InternalError('Error generating proof'));
  }

  callback(null, proof);
}

server.expose('durin_call', durinCall);
server.listen(process.env.PORT);
