const fail = reason => { throw new Error('DEV unsigned primitive: ' + reason); };
// Selected SDK Router.ts authority is independently pinned by admission. approve is ERC20.
const ABI = [
  'function approve(address spender,uint256 amount) returns(bool)',
  'function ccipSend(uint64 destinationChainSelector,(bytes receiver,bytes data,(address token,uint256 amount)[] tokenAmounts,address feeToken,bytes extraArgs) message) payable returns(bytes32)',
];
// Data selected from the lock-authenticated SDK 1.13.0 archive, never SDK evaluation.
// Exact source/member hashes and complete external byte vectors live in dev-evm-event-goldens.json.
export const DEV_EVM_EVENT_FRAGMENTS = Object.freeze([
  'event CCIPMessageSent(uint64 indexed destChainSelector,uint64 indexed sequenceNumber,((bytes32 messageId,uint64 sourceChainSelector,uint64 destChainSelector,uint64 sequenceNumber,uint64 nonce) header,address sender,bytes data,bytes receiver,bytes extraArgs,address feeToken,uint256 feeTokenAmount,uint256 feeValueJuels,(address sourcePoolAddress,bytes destTokenAddress,bytes extraData,uint256 amount,bytes destExecData)[] tokenAmounts) message)',
  'event ExecutionStateChanged(uint64 indexed sourceChainSelector,uint64 indexed sequenceNumber,bytes32 indexed messageId,bytes32 messageHash,uint8 state,bytes returnData,uint256 gasUsed)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const EVENT_TOPICS = Object.freeze({
  '0x192442a2b2adb6a7948f097023cb6b57d29d3a7a5dd33e6666d33c39cc456f32': ['CCIPMessageSent', 3],
  '0x05665fe9ad095383d018353f4cbcba77e84db27dd215081bbf7cdf9ae6fbe48b': ['ExecutionStateChanged', 4],
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef': ['Transfer', 3],
});
function eventWord(data, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset % 32 || 2 + (offset + 32) * 2 > data.length) {
    fail('event word outside bounded data');
  }
  return BigInt('0x' + data.slice(2 + offset * 2, 2 + (offset + 32) * 2));
}
function singleEventToken(data) {
  // Bound the only array before ethers allocates decoded values. The exact tuple has
  // thirteen head words (five header words); the token array is head word twelve.
  if (eventWord(data, 0) !== 32n) { fail('noncanonical event tuple offset'); }
  const offset = eventWord(data, 32 + 12 * 32);
  if (offset > 65536n || offset % 32n) { fail('event array offset bound'); }
  if (eventWord(data, 32 + Number(offset)) !== 1n) { fail('exact single event token required'); }
}
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
  let events;
  const key = value => {
    if (typeof value !== 'string' || value.length < 32 || value.length > 44) { fail('invalid public key'); }
    return new web3.PublicKey(value);
  };
  const canonicalBase64 = value => {
    if (typeof value !== 'string' || value.length > 4096) { fail('invalid base64'); }
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) { fail('noncanonical base64'); }
    return bytes;
  };
  const table = value => {
    record(value, ['key', 'dataBase64']);
    return new web3.AddressLookupTableAccount({ key: key(value.key),
      state: web3.AddressLookupTableAccount.deserialize(canonicalBase64(value.dataBase64)) });
  };
  return Object.freeze({
    // Public web3 primitives only. No SPL/Anchor/SDK entry evaluation. EVM additions
    // can extend this record independently; existing EVM and three-field v0 outputs stay stable.
    derivePda(program, seeds) {
      if (!Array.isArray(seeds) || seeds.length > 16 || seeds.some(s => typeof s !== 'string' || !/^(?:[0-9a-f]{2}){0,32}$/.test(s))) {
        fail('invalid PDA seeds');
      }
      return web3.PublicKey.findProgramAddressSync(seeds.map(s => Buffer.from(s, 'hex')), key(program))[0].toBase58();
    },
    deriveAta(mint, owner, allowOffCurve = false) {
      if (typeof allowOffCurve !== 'boolean' || !allowOffCurve && !web3.PublicKey.isOnCurve(key(owner).toBytes())) { fail('ATA owner off curve'); }
      return web3.PublicKey.findProgramAddressSync([key(owner).toBuffer(),
        key('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(), key(mint).toBuffer()],
      key('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'))[0].toBase58();
    },
    deserializeLookupTable(dataBase64) {
      const state = web3.AddressLookupTableAccount.deserialize(canonicalBase64(dataBase64));
      return { deactivationSlot: state.deactivationSlot.toString(), lastExtendedSlot: String(state.lastExtendedSlot),
        lastExtendedSlotStartIndex: state.lastExtendedSlotStartIndex, authority: state.authority?.toBase58() ?? null,
        addresses: state.addresses.map(k => k.toBase58()) };
    },
    inspectUnsignedV0(input) {
      record(input, ['transactionBase64', 'lookupTable']);
      const raw = canonicalBase64(input.transactionBase64);
      if (raw.length > 1232) { fail('packet exceeds 1232 bytes'); }
      const transaction = web3.VersionedTransaction.deserialize(raw), message = transaction.message;
      if (message.version !== 0 || !Buffer.from(transaction.serialize()).equals(raw)) { fail('noncanonical v0 packet'); }
      const keys = message.getAccountKeys({ addressLookupTableAccounts: [table(input.lookupTable)] });
      const meta = index => ({ pubkey: keys.get(index).toBase58(), isSigner: message.isAccountSigner(index), isWritable: message.isAccountWritable(index) });
      return { version: message.version, payer: keys.get(0).toBase58(), header: { ...message.header },
        recentBlockhash: message.recentBlockhash, messageBase64: Buffer.from(message.serialize()).toString('base64'),
        signaturesBase64: transaction.signatures.map(s => Buffer.from(s).toString('base64')),
        accounts: Array.from({ length: keys.length }, (_, i) => meta(i)), staticAccountCount: message.staticAccountKeys.length,
        lookups: message.addressTableLookups.map(l => ({ key: l.accountKey.toBase58(),
          writableIndexes: Array.from(l.writableIndexes), readonlyIndexes: Array.from(l.readonlyIndexes) })),
        instructions: message.compiledInstructions.map(ix => ({ programId: keys.get(ix.programIdIndex).toBase58(),
          keys: Array.from(ix.accountKeyIndexes, meta), data: '0x' + Buffer.from(ix.data).toString('hex') })) };
    },
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
    decodeEvmEvent(input) {
      const value = record(input, ['topics', 'data']);
      if (!Array.isArray(value.topics) || !value.topics.length || value.topics.length > 4) { fail('event topic bound'); }
      const topics = value.topics.map(item => {
        const result = hex(item, 32);
        if (result.length !== 66) { fail('event topic width'); }
        return result.toLowerCase();
      });
      const data = hex(value.data, 65536).toLowerCase(), selected = EVENT_TOPICS[topics[0]];
      if (!selected) { fail('unknown event'); }
      if (topics.length !== selected[1]) { fail('event topic cardinality'); }
      if (selected[0] === 'CCIPMessageSent') { singleEventToken(data); }
      events ??= new abi.Interface(DEV_EVM_EVENT_FRAGMENTS);
      const decoded = events.parseLog({ topics, data });
      if (!decoded || decoded.name !== selected[0]) { fail('unknown event layout'); }
      // parseLog alone permits trailing bytes, aliased offsets and masked uint bits.
      // Re-encoding forces all lazy values and compares every original wire byte.
      const canonical = events.encodeEventLog(decoded.fragment, decoded.args);
      if (canonical.data.toLowerCase() !== data || canonical.topics.length !== topics.length ||
          canonical.topics.some((item, index) => item.toLowerCase() !== topics[index])) {
        fail('noncanonical event encoding');
      }
      return Object.freeze({ name: decoded.name, args: decoded.args });
    },
    compileUnsignedV0(input) {
      const value = record(input, Object.hasOwn(input ?? {}, 'lookupTable') ? ['payer', 'recentBlockhash', 'instructions', 'lookupTable'] : ['payer', 'recentBlockhash', 'instructions']);
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
        recentBlockhash: key(value.recentBlockhash).toBase58(), instructions }).compileToV0Message(value.lookupTable === undefined ? [] : [table(value.lookupTable)]);
      const transaction = new web3.VersionedTransaction(message);
      return Object.freeze({ messageBase64: Buffer.from(message.serialize()).toString('base64'),
        transactionBase64: Buffer.from(transaction.serialize()).toString('base64'),
        requiredSignatures: message.header.numRequiredSignatures, broadcastAllowed: false });
    },
  });
}
