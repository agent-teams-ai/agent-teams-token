import { createHash } from 'node:crypto';
import { REVERSE, BURNMINT_PROGRAM } from '../domain/solana-reverse.mjs';
import { ROUTER_PROGRAM } from '../domain/solana-registration.ts';
import { POOL_GLOBAL } from '../domain/solana-pool-init.ts';
import { ALT_PROGRAM, FEE_QUOTER_PROGRAM, altAddresses, REMOTE_POOL, REMOTE_TOKEN, remoteBytes } from '../domain/solana-pool-config.ts';
  function layout(b, name, size) {
    if (b.length !== size || !b.subarray(0,8).equals(createHash('sha256').update('account:' + name).digest().subarray(0,8))) {
      throw new Error('Wrong reverse ' + name + ' layout');
    }
  }
  async function read(rpc, addresses) {
    const result = await rpc('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'finalized' }]);
    if (!Number.isSafeInteger(result?.context?.slot) || result.context.slot < 1 || result.value?.length !== addresses.length) {
      throw new Error('Incomplete finalized reverse snapshot');
    }
    return result;
  }

  function payer(payerRaw,maximumLamports) {
    if (payerRaw?.owner !== '11111111111111111111111111111111' || payerRaw.executable !== false || !Number.isSafeInteger(payerRaw.lamports) ||
      payerRaw.lamports <= 0 || BigInt(payerRaw.lamports) > BigInt(maximumLamports)) { throw new Error('Native balance exceeds authorized test exposure'); }
  }

  function validateMint(mint,e) {
    if (!mint.isInitialized || mint.decimals !== 9 || mint.supply !== REVERSE.amount || mint.mintAuthority?.toBase58() !== e.signer || mint.freezeAuthority !== null) { throw new Error('Wrong mint authority or supply'); }
  }

export function createReverseState(provider, poolSdk) {
  const { PublicKey, AddressLookupTableAccount } = provider.web3;
  const { TOKEN_PROGRAM_ID, unpackMint, unpackAccount } = provider.spl;
  const key = (b, n) => new PublicKey(b.subarray(n, n + 32)).toBase58();
  function account(raw, owner) {
    if (!raw || raw.owner !== owner || raw.executable !== false || raw.data?.[1] !== 'base64') { throw new Error('Wrong reverse prerequisite owner'); }
    const data = Buffer.from(raw.data[0], 'base64');
    if (data.toString('base64') !== raw.data[0]) { throw new Error('Wrong prerequisite encoding'); }
    return { ...raw, data, owner: new PublicKey(owner) };
  }
  async function config(rpc, routerConfig) {
    const snapshot = await read(rpc, [routerConfig]);
    const b = account(snapshot.value[0], ROUTER_PROGRAM).data; layout(b, 'Config', 210);
    if (b[8] !== 1 || b[9] !== 1 || b.readBigUInt64LE(10) !== 16423721717087811551n || key(b,82) !== FEE_QUOTER_PROGRAM || key(b,114) !== REVERSE.rmn) {
      throw new Error('Wrong finalized router config');
    }
    return key(b,146);
  }
  function tokens(mintRaw,sourceRaw,e) {
    const mintInfo = account(mintRaw,TOKEN_PROGRAM_ID.toBase58()), sourceInfo = account(sourceRaw,TOKEN_PROGRAM_ID.toBase58());
    if (mintInfo.data.length !== 82 || sourceInfo.data.length !== 165) { throw new Error('Wrong SPL account shape'); }
    const mint = unpackMint(new PublicKey(e.mint),mintInfo), source = unpackAccount(new PublicKey(e.sourceAta),sourceInfo);
    validateMint(mint,e);
    if (source.mint.toBase58() !== e.mint || source.owner.toBase58() !== e.payer || !source.isInitialized || source.isFrozen || source.isNative ||
      source.closeAuthority !== null || source.amount !== REVERSE.amount || source.delegatedAmount > REVERSE.amount ||
      source.delegate !== null && source.delegate.toBase58() !== e.spender || source.delegate === null && source.delegatedAmount !== 0n) {
      throw new Error('Wrong source token balance, authority or bounded delegation');
    }
    return source;
  }
  function poolAccount(poolAtaRaw,e) {
    const poolAta = unpackAccount(new PublicKey(e.ata),account(poolAtaRaw,TOKEN_PROGRAM_ID.toBase58()));
    if (poolAta.mint.toBase58() !== e.mint || poolAta.owner.toBase58() !== e.signer || poolAta.amount !== 0n || poolAta.delegate !== null ||
      poolAta.delegatedAmount !== 0n || poolAta.isFrozen || poolAta.isNative || poolAta.closeAuthority !== null) { throw new Error('Wrong pool token account'); }
  }
  function registry(registryRaw,e) {
    const reg = account(registryRaw,ROUTER_PROGRAM).data; layout(reg,'TokenAdminRegistry',170);
    const bitmap = Buffer.alloc(32); bitmap[15] = 0x19;
    if (reg[8] !== 2 || key(reg,9) !== e.payer || key(reg,41) !== '11111111111111111111111111111111' || key(reg,73) !== e.alt ||
      !reg.subarray(105,137).equals(bitmap) || key(reg,137) !== e.mint || reg[169] !== 0) { throw new Error('Wrong registered pool/ALT'); }
  }
  function remote(chainRaw) {
    const chain = account(chainRaw,BURNMINT_PROGRAM).data; layout(chain,'ChainConfig',151);
    if (chain.readUInt32LE(8) !== 1 || chain.readUInt32LE(12) !== 32 || !chain.subarray(16,48).equals(remoteBytes(REMOTE_POOL)) ||
      chain.readUInt32LE(48) !== 32 || !chain.subarray(52,84).equals(remoteBytes(REMOTE_TOKEN)) || chain[84] !== 9) { throw new Error('Wrong remote peers'); }
    for (const offset of [85,118]) {
      if (chain[offset+16] !== 1 || chain.readBigUInt64LE(offset+17) !== 10000000000n || chain.readBigUInt64LE(offset+25) !== REVERSE.amount ||
        chain.readBigUInt64LE(offset) > 10000000000n) { throw new Error('Wrong remote rate limits'); }
    }
  }
  function lookup(altRaw,e,slot) {
    const alt = account(altRaw,ALT_PROGRAM).data;
    if (alt.length !== 376 || alt.readUInt32LE(0) !== 1 || alt.readBigUInt64LE(4) !== (1n<<64n)-1n || alt[21] !== 1 ||
      key(alt,22) !== e.payer || alt.readBigUInt64LE(12) >= BigInt(slot) ||
      altAddresses(e).some((a,i) => key(alt,56+32*i) !== a)) { throw new Error('Wrong finalized active ALT contents'); }
    return new AddressLookupTableAccount({ key: new PublicKey(e.alt), state: AddressLookupTableAccount.deserialize(alt) });
  }
  async function before(rpc, e, maximumLamports) {
    if (!/^[1-9][0-9]*$/.test(maximumLamports) || BigInt(maximumLamports) > 10000000000n) { throw new Error('Explicit bounded test SOL exposure required'); }
    const result = await read(rpc, [e.mint,e.sourceAta,e.pool,e.ata,e.registry,e.chain,e.alt,POOL_GLOBAL,e.payer]);
    const [mintRaw,sourceRaw,poolRaw,poolAtaRaw,registryRaw,chainRaw,altRaw,globalRaw,payerRaw] = result.value;
    const source = tokens(mintRaw,sourceRaw,e);
    poolAccount(poolAtaRaw,e);
    poolSdk.verifyState(account(poolRaw,BURNMINT_PROGRAM).data.toString('base64'),e);
    poolSdk.verifyGlobal(account(globalRaw,BURNMINT_PROGRAM).data.toString('base64'));
    registry(registryRaw,e);
    remote(chainRaw);
    const lookupTable = lookup(altRaw,e,result.context.slot);
    payer(payerRaw,maximumLamports);
    return { approval: source.delegate === null || source.delegatedAmount < REVERSE.amount,
      sourceLamports: String(payerRaw.lamports), lookupTable };
  }
  return { config, before };
}
