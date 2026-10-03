const fail = reason => { throw new Error('DEV unsigned primitive: ' + reason); };
// Selected SDK Router.ts authority is independently pinned by admission. approve is ERC20.
const ABI = [
  'function approve(address spender,uint256 amount) returns(bool)',
  'function ccipSend(uint64 destinationChainSelector,(bytes receiver,bytes data,(address token,uint256 amount)[] tokenAmounts,address feeToken,bytes extraArgs) message) payable returns(bytes32)',
];
function record(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) { fail('invalid fields'); }
  return value;
}
function uint(value, bits) {
  if ((typeof value !== 'bigint' && (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))) ||
      String(value).length > 78) { fail('integer must be bigint or canonical decimal string'); }
  const integer = BigInt(value);
  if (integer < 0n || integer >= 1n << BigInt(bits)) { fail('integer range'); }
  return integer;
}
function hex(value, max = 1024) {
  if (typeof value !== 'string' || !/^0x(?:[a-fA-F0-9]{2})*$/.test(value) || value.length > 2 + max * 2) { fail('invalid bytes'); }
  return value;
}
function address(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) { fail('invalid EVM address'); }
  return value;
}

/** Feature-private assembly of only data codecs. No clients, fees, signer or secret APIs. */
export function unsignedDevPrimitives(abi, web3) {
  const iface = new abi.Interface(ABI);
  const key = value => {
    if (typeof value !== 'string' || value.length < 32 || value.length > 44) { fail('invalid public key'); }
    return new web3.PublicKey(value);
  };
  return Object.freeze({
    encodeApprove(spender, amount) {
      return iface.encodeFunctionData('approve', [address(spender), uint(amount, 256)]);
    },
    encodeCcipSend(selector, input) {
      const message = record(input, ['receiver', 'data', 'tokenAmounts', 'feeToken', 'extraArgs']);
      if (!Array.isArray(message.tokenAmounts) || message.tokenAmounts.length > 8) { fail('token amount bound'); }
      const tokens = message.tokenAmounts.map(value => {
        const token = record(value, ['token', 'amount']);
        return [address(token.token), uint(token.amount, 256)];
      });
      return iface.encodeFunctionData('ccipSend', [uint(selector, 64),
        [hex(message.receiver), hex(message.data), tokens, address(message.feeToken), hex(message.extraArgs)]]);
    },
    decodeEvmCall(data) {
      const decoded = iface.parseTransaction({ data: hex(data, 16384) });
      if (!decoded) { fail('unknown operation'); }
      return Object.freeze({ name: decoded.name, args: decoded.args });
    },
    compileUnsignedV0(input) {
      const value = record(input, ['payer', 'recentBlockhash', 'instructions']);
      if (!Array.isArray(value.instructions) || !value.instructions.length || value.instructions.length > 16) { fail('instruction bound'); }
      const instructions = value.instructions.map(item => {
        const instruction = record(item, ['programId', 'keys', 'data']);
        if (!Array.isArray(instruction.keys) || instruction.keys.length > 64) { fail('account bound'); }
        const keys = instruction.keys.map(itemKey => {
          const meta = record(itemKey, ['pubkey', 'isSigner', 'isWritable']);
          if (typeof meta.isSigner !== 'boolean' || typeof meta.isWritable !== 'boolean') { fail('invalid account permissions'); }
          return { pubkey: key(meta.pubkey), isSigner: meta.isSigner, isWritable: meta.isWritable };
        });
        return new web3.TransactionInstruction({ programId: key(instruction.programId), keys,
          data: Buffer.from(hex(instruction.data, 1024).slice(2), 'hex') });
      });
      const message = new web3.TransactionMessage({ payerKey: key(value.payer),
        recentBlockhash: key(value.recentBlockhash).toBase58(), instructions }).compileToV0Message();
      const transaction = new web3.VersionedTransaction(message);
      return Object.freeze({ messageBase64: Buffer.from(message.serialize()).toString('base64'),
        transactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
        requiredSignatures: message.header.numRequiredSignatures, broadcastAllowed: false });
    },
  });
}
