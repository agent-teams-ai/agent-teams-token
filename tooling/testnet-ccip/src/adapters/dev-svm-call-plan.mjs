import { createHash } from 'node:crypto';
import { REVERSE, reverseInstructions, deriveReverseAccounts, BURNMINT_PROGRAM } from '../domain/solana-reverse.mjs';
import { SYSTEM_PROGRAM, SPL_TOKEN_PROGRAM, solanaPublicKeyBytes } from '../domain/solana-mint.ts';
import { ROUTER_PROGRAM } from '../domain/solana-registration.ts';
import { ALT_PROGRAM, FEE_QUOTER_PROGRAM, SEPOLIA_SELECTOR } from '../domain/solana-pool-config.ts';
import { inspectSendData } from './solana-spl-fee-cap-proof.mjs';
import { loadDevProvider } from './dev-provider-admission.mjs';
import { REPAIRED_CHAIN_SLACK } from './solana-pool-config-state.mjs';

const U64_MAX = (1n << 64n) - 1n;
const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const IDENTITY_FIELDS = ['routerConfig', 'destChain', 'nonce', 'spender', 'sourceAta', 'feeReceiver',
  'feeConfig', 'feeDest', 'nativeFeeConfig', 'linkFeeConfig', 'curses', 'rmnConfig', 'perTokenConfig',
  'pool', 'signer', 'ata', 'registry', 'chain', 'feeTokenConfig', 'routerPoolSigner'];
const fail = reason => { throw new Error('DEV SVM unsigned call: ' + reason); };
const hash = data => createHash('sha256').update(data).digest('hex');
const disc = name => createHash('sha256').update('account:' + name).digest().subarray(0, 8);
function shape(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== fields.length ||
      fields.some(f => !Object.hasOwn(value, f))) { fail(label + ' fields'); }
  return value;
}
function integer(value, label, positive = false) {
  if ((typeof value !== 'bigint' && (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))) ||
      String(value).length > 20) { fail(label + ' canonical u64 required'); }
  const n = BigInt(value);
  if (n < 0n || n > U64_MAX || positive && n === 0n) { fail(label + ' u64 range'); }
  return n;
}
function key(value) {
  if (value === SYSTEM_PROGRAM) { fail('nonzero actor/derived public key required'); }
  return solanaPublicKeyBytes(value);
}
function bytes(value, label, max = 1232) {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4) { fail(label + ' byte bound'); }
  const b = Buffer.from(value, 'base64');
  if (b.toString('base64') !== value || b.length > max) { fail(label + ' noncanonical bytes'); }
  return b;
}
function evm(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/.test(value) || /^0x0{40}$/.test(value)) {
    fail(label + ' requires normalized nonzero EVM address');
  }
}
const equal = (a, b, label) => { if (JSON.stringify(a) !== JSON.stringify(b)) { fail(label + ' mismatch'); } };
function validateLane(route) {
  if (integer(route.selector, 'destination selector').toString() !== SEPOLIA_SELECTOR || integer(route.solanaSelector, 'source selector').toString() !== '16423721717087811551' || route.cluster !== 'solana-devnet' ||
      route.genesisHash !== GENESIS || route.routerProgram !== ROUTER_PROGRAM || route.feeQuoterProgram !== FEE_QUOTER_PROGRAM ||
      route.poolProgram !== BURNMINT_PROGRAM || route.tokenProgram !== SPL_TOKEN_PROGRAM || route.rmn !== REVERSE.rmn ||
      route.nativeMint !== REVERSE.nativeMint || route.payer !== route.sender || route.sender !== route.forwardRecipient) { fail('selected Sepolia/Devnet lane or sender binding'); }
}
function limiterConfig(enabled, capacity, rate, label) {
  if (typeof enabled !== 'boolean' || !enabled && (capacity !== 0n || rate !== 0n) ||
      enabled && (rate > capacity || (capacity === 0n) !== (rate === 0n))) { fail(label + ' invalid limiter config'); }
  return { enabled, capacity, rate };
}
function selectedLimiters(route) {
  // Absence/null is unknown, never a policy inferred from mutable captured bytes.
  if (!Object.hasOwn(route, 'limiters') || route.limiters === null) { return null; }
  shape(route.limiters, ['inbound', 'outbound'], 'selected limiters');
  return Object.fromEntries(Object.entries(route.limiters).map(([direction, value]) => {
    if (value === null) { return [direction, null]; }
    shape(value, ['enabled', 'capacity', 'rate'], direction + ' limiter policy');
    return [direction, limiterConfig(value.enabled, integer(value.capacity, direction + ' limiter capacity'),
      integer(value.rate, direction + ' limiter rate'), direction + ' selected')];
  }));
}
function limiterState(chain, route) {
  const expected = selectedLimiters(route), missing = [], observations = {};
  // BaseChain's retained IDL orders inbound then outbound, each 33 live bytes.
  for (const [direction, offset] of [['inbound', 73], ['outbound', 106]]) {
    const flag = chain[offset + 16];
    if (flag !== 0 && flag !== 1) { fail(direction + ' limiter noncanonical Borsh bool'); }
    const config = limiterConfig(flag === 1, chain.readBigUInt64LE(offset + 17), chain.readBigUInt64LE(offset + 25), direction + ' captured');
    const tokens = chain.readBigUInt64LE(offset);
    if (tokens > config.capacity) { fail(direction + ' limiter tokens exceed capacity'); }
    observations[direction] = { tokens: tokens.toString(), lastUpdatedUnixSeconds: chain.readBigUInt64LE(offset + 8).toString(),
      enabled: config.enabled, capacity: config.capacity.toString(), rate: config.rate.toString() };
    const policy = expected?.[direction];
    if (!policy) { missing.push(direction + ' limiter selected policy unknown'); }
    else if (policy.enabled !== config.enabled || policy.capacity !== config.capacity || policy.rate !== config.rate) {
      missing.push(direction + ' limiter captured config differs from selected policy');
    }
    if (!config.enabled) { missing.push(direction + ' limiter disabled/unlimited; bounded active policy required'); }
    else if (config.capacity === 0n) { missing.push(direction + ' limiter paused'); }
    // Captured tokens are a conservative lower bound. Unix seconds are NOT slots;
    // no refill, wall clock or chain-time authority is inferred from lastUpdated.
    else if (tokens < integer(route.amount, 'amount')) {
      missing.push(direction + ' limiter insufficient captured tokens=' + tokens + '; availability without valid independent time context unknown');
    }
  }
  return { missing, observations };
}
export function validateDevSvmRoute(route) {
  shape(route, ['profile', 'fixedSupplyBaseUnits', 'decimals', 'selector', 'solanaSelector', 'cluster', 'genesisHash',
    'routerProgram', 'feeQuoterProgram', 'poolProgram', 'tokenProgram', 'rmn', 'nativeMint', 'mint', 'evmToken', 'evmPool',
    'payer', 'sender', 'forwardRecipient', 'recipient', 'amount', 'linkMint', 'roles', 'alt', 'lookupTableAuthority', 'identities',
    ...(Object.hasOwn(route ?? {}, 'limiters') ? ['limiters'] : [])], 'selected route');
  selectedLimiters(route);
  validateLane(route);
  const fixed = { fixture100: 100000000000n, product100M: 100000000000000000n }[route.profile];
  if (!fixed || integer(route.fixedSupplyBaseUnits, 'fixed supply', true) !== fixed || route.decimals !== 9) {
    fail('selected fixed-supply profile/decimals');
  }
  if (integer(route.amount, 'amount', true) > fixed) { fail('amount exceeds selected fixed supply'); }
  evm(route.recipient, 'return recipient'); evm(route.evmToken, 'remote token'); evm(route.evmPool, 'remote pool');
  for (const field of ['payer', 'mint', 'linkMint', 'alt']) { key(route[field]); }
  if (route.lookupTableAuthority !== null) { key(route.lookupTableAuthority); }
  shape(route.roles, ['poolOwner', 'pendingPoolOwner', 'rateAdmin', 'registryAdmin', 'pendingRegistryAdmin'], 'roles');
  for (const [name, address] of Object.entries(route.roles)) {
    if (address === null && name.startsWith('pending')) { continue; }
    key(address);
    if (address === route.payer) { fail('administrative role must remain separate from transfer payer'); }
  }
  shape(route.identities, IDENTITY_FIELDS, 'selected identities');
  Object.values(route.identities).forEach(key);
  if (route.mint === route.linkMint || route.mint === route.nativeMint || route.mint === route.payer ||
      new Set(Object.values(route.identities)).size !== IDENTITY_FIELDS.length) { fail('conflicting route identities'); }
  // One slot cannot describe these differently typed accounts at the same key.
  // Authorities and intentionally repeated program metas are outside this finite set.
  const capturedAddresses = [route.mint, route.identities.sourceAta, route.identities.ata, route.identities.routerConfig,
    route.identities.registry, route.identities.pool, route.identities.chain, route.alt];
  if (new Set(capturedAddresses).size !== capturedAddresses.length) { fail('conflicting captured account identities'); }
  return route;
}
function raw(facts, name, address, owner, [length, accountName]) {
  const account = shape(facts.state[name], ['address', 'owner', 'executable', 'slot', 'dataBase64', 'sha256'], name);
  if (account.address !== address || account.owner !== owner || account.executable !== false ||
      integer(account.slot, name + ' slot', true) !== integer(facts.snapshotSlot, 'snapshot slot', true)) {
    fail(name + ' capture identity, owner or snapshot');
  }
  const data = bytes(account.dataBase64, name);
  if (data.length !== length || hash(data) !== account.sha256 || accountName && !data.subarray(0, 8).equals(disc(accountName))) {
    fail(name + ' captured layout or integrity');
  }
  return data;
}
const keyAt = (data, offset, address, label) => {
  if (!data.subarray(offset, offset + 32).equals(solanaPublicKeyBytes(address ?? SYSTEM_PROGRAM))) { fail(label + ' binding'); }
};
function token(facts, name, address, mint, owner) {
  const data = raw(facts, name, address, SPL_TOKEN_PROGRAM, [165]);
  keyAt(data, 0, mint, name + ' mint'); keyAt(data, 32, owner, name + ' owner');
  if (data[108] !== 1 || data.readUInt32LE(109) !== 0 || data.readUInt32LE(129) !== 0 || data.readUInt32LE(72) > 1) {
    fail(name + ' must be initialized unfrozen, non-native, classic with no close authority');
  }
  return { data, balance: data.readBigUInt64LE(64), delegation: data.readBigUInt64LE(121), hasDelegate: data.readUInt32LE(72) === 1 };
}
function commonBeforeState(before) {
  if (before === null) { return null; }
  shape(before, ['mintSupply', 'sourceBalance', 'poolBalance', 'delegate', 'delegatedAmount'], 'before state');
  const state = { mintSupply: integer(before.mintSupply, 'mint supply'), sourceBalance: integer(before.sourceBalance, 'source balance'),
    poolBalance: integer(before.poolBalance, 'pool balance'), delegate: before.delegate, delegatedAmount: integer(before.delegatedAmount, 'delegated amount') };
  if (state.delegate !== null) { key(state.delegate); }
  return state;
}
function delegationPolicy(source, before, spender, amount) {
  const delegated = source.delegation;
  if (before !== null) {
    if (before.delegatedAmount !== delegated || source.hasDelegate !== (before.delegate !== null)) { fail('unknown/inconsistent delegation'); }
    if (source.hasDelegate) { keyAt(source.data, 76, before.delegate, 'captured delegate'); }
  }
  if (source.hasDelegate) {
    if (!source.data.subarray(76, 108).equals(solanaPublicKeyBytes(spender))) { fail('foreign delegate requires reconciliation, including zero'); }
    if (delegated !== 0n && delegated !== amount) { fail('partial/excess delegation requires reconciliation'); }
  } else if (delegated !== 0n) { fail('None delegate with nonzero amount'); }
  return delegated === 0n;
}
function capturedMintState(route, facts, e) {
  const mint = raw(facts, 'mint', route.mint, SPL_TOKEN_PROGRAM, [82]);
  if (mint.readUInt32LE(0) !== 1 || mint[44] !== 9 || mint[45] !== 1 || mint.readUInt32LE(46) !== 0) { fail('mint authority/decimals/freeze layout'); }
  keyAt(mint, 4, e.signer, 'derived pool mint authority');
  const supply = mint.readBigUInt64LE(36);
  if (supply > integer(route.fixedSupplyBaseUnits, 'fixed supply')) { fail('overissuance incident: captured SPL supply=' + supply); }
  return supply;
}
function capturedSplState(route, facts, e, partial) {
  const supply = !partial || facts.state.mint !== null ? capturedMintState(route, facts, e) : null;
  if (e.sourceAta === e.ata) { fail('source and pool ATA must differ'); }
  const source = !partial || facts.state.sourceAta !== null ? token(facts, 'sourceAta', e.sourceAta, route.mint, route.payer) : null;
  const pool = !partial || facts.state.poolAta !== null ? token(facts, 'poolAta', e.ata, route.mint, e.signer) : null;
  return { supply, source, pool };
}
function validateCapturedBalances(supply, source, pool, amount) {
  // Check each known balance without substituting zero for a missing capture.
  if (source && source.balance < amount || pool && (pool.balance + amount > U64_MAX || pool.hasDelegate || pool.delegation !== 0n) ||
      supply !== null && (supply < amount || source && source.balance > supply || pool && pool.balance > supply ||
        source && pool && source.balance + pool.balance > supply)) {
    fail('captured source/pool balances or pool delegation');
  }
}
function beforeState(route, facts, e, partial, before) {
  const { supply, source, pool } = capturedSplState(route, facts, e, partial), amount = integer(route.amount, 'amount');
  if (before !== null) {
    if (supply !== null && supply !== before.mintSupply) { fail('captured mint supply'); }
    if (source && source.balance !== before.sourceBalance || pool && pool.balance !== before.poolBalance) {
      fail('captured source/pool balances or pool delegation');
    }
  }
  validateCapturedBalances(supply, source, pool, amount);
  const approval = source ? delegationPolicy(source, before, e.spender, amount) : null;
  // Missing raw records or common before-state never produce a modelled complete state.
  if (before === null || supply === null || source === null || pool === null) { return null; }
  return { approval, modelledAfter: { qualification: 'hypothetical-success-only',
    mintSupply: (supply - amount).toString(), sourceBalance: (source.balance - amount).toString(),
    poolBalance: pool.balance.toString(), delegate: null, delegatedAmount: '0' } };
}
function routerState(route, facts, e) {
  const config = raw(facts, 'routerConfig', e.routerConfig, ROUTER_PROGRAM, [210, 'Config']);
  if (config[8] !== 1 || config[9] !== 1 || config.readBigUInt64LE(10) !== integer(route.solanaSelector, 'source selector')) { fail('Router config version/selector'); }
  keyAt(config, 82, FEE_QUOTER_PROGRAM, 'Router Fee Quoter'); keyAt(config, 114, route.rmn, 'Router RMN');
  keyAt(config, 146, route.linkMint, 'Router LINK mint');
}
function registryState(route, facts, e) {
  const registry = raw(facts, 'registry', e.registry, ROUTER_PROGRAM, [170, 'TokenAdminRegistry']);
  if (registry[8] !== 2 || registry[169] !== 0) { fail('registry version/auto derivation'); }
  keyAt(registry, 9, route.roles.registryAdmin, 'registry admin'); keyAt(registry, 41, route.roles.pendingRegistryAdmin, 'pending registry admin');
  keyAt(registry, 73, route.alt, 'registered ALT'); keyAt(registry, 137, route.mint, 'registry mint');
  const bitmap = Buffer.alloc(32); bitmap[15] = 0x19;
  if (!registry.subarray(105, 137).equals(bitmap)) { fail('registry writable bitmap must select pool, pool ATA and mint'); }
}
function poolState(route, facts, e) {
  const pool = raw(facts, 'pool', e.pool, BURNMINT_PROGRAM, [368, 'State']);
  if (pool[8] !== 1 || pool[73] !== 9 || pool[330] !== 0 || pool[331] !== 0 || pool.readUInt32LE(332) !== 0) { fail('pool state layout'); }
  for (const [offset, address] of [[9, SPL_TOKEN_PROGRAM], [41, route.mint], [74, e.signer], [106, e.ata],
    [138, route.roles.poolOwner], [170, route.roles.pendingPoolOwner], [202, route.roles.rateAdmin], [234, e.routerPoolSigner],
    [266, ROUTER_PROGRAM], [298, SYSTEM_PROGRAM], [336, route.rmn]]) { keyAt(pool, offset, address, 'pool state'); }
}
function routeState(route, facts, e, partial) {
  for (const [name, validate] of [['routerConfig', routerState], ['registry', registryState], ['pool', poolState]]) {
    if (!partial || facts.state[name] !== null) { validate(route, facts, e); }
  }
  return chainState(route, facts, e);
}
function chainState(route, facts, e) {
  if (facts.state.chain === null) { return { missing: ['ChainConfig capture missing; limiter state unknown'], observations: null }; }
  const chain = raw(facts, 'chain', e.chain, BURNMINT_PROGRAM, [171, 'ChainConfig']);
  // Bounded one-pool raw20 / ABI32 remote token profile.
  if (chain.readUInt32LE(8) !== 1 || chain.readUInt32LE(12) !== 20 ||
      !chain.subarray(16, 36).equals(Buffer.from(route.evmPool.slice(2), 'hex')) || chain.readUInt32LE(36) !== 32 ||
      !chain.subarray(40, 72).equals(Buffer.from(route.evmToken.slice(2).padStart(64, '0'), 'hex')) || chain[72] !== 9) {
    fail('remote pool raw20/token ABI32 pair');
  }
  // The last 32 bytes are allocation tail, not live fields. Matching the retained
  // pattern proves format consistency only, never repair history or chain truth.
  const tail = chain.subarray(139);
  if (!tail.equals(Buffer.alloc(32)) && !tail.equals(REPAIRED_CHAIN_SLACK)) { fail('unsupported ChainConfig allocation tail'); }
  return limiterState(chain, route);
}
export function validateDevSvmLookupTable(route, facts, e) {
  const data = raw(facts, 'alt', route.alt, ALT_PROGRAM, [376]);
  const authority = route.lookupTableAuthority;
  if (data.readUInt32LE(0) !== 1 || data.readBigUInt64LE(4) !== U64_MAX || data[21] !== (authority === null ? 0 : 1) ||
      data.readUInt16LE(54) !== 0 || data[20] > 10 || data.readBigUInt64LE(12) >= integer(facts.snapshotSlot, 'snapshot slot') ||
      data.readBigUInt64LE(12) > BigInt(Number.MAX_SAFE_INTEGER)) { fail('ALT active metadata/extension activation'); }
  if (authority !== null) { keyAt(data, 22, authority, 'ALT authority independently selected from payer'); }
  // None uses a shorter Option layout: all unused metadata/padding must be zero.
  else if (!data.subarray(22, 56).equals(Buffer.alloc(34))) { fail('ALT None authority padding'); }
  const addresses = [route.alt, e.registry, BURNMINT_PROGRAM, e.pool, e.ata, e.signer, SPL_TOKEN_PROGRAM, route.mint, e.feeTokenConfig, e.routerPoolSigner];
  addresses.forEach((address, i) => keyAt(data, 56 + 32 * i, address, 'ALT ordered address ' + i));
  return { key: route.alt, dataBase64: data.toString('base64') };
}
function costObservation(route, facts, name, fact) {
  const fields = ['lamports', 'payer', 'snapshotSlot', 'validThroughSlot', 'source'];
  shape(fact, name === 'quote' ? [...fields, 'selector', 'mint', 'amount', 'feeToken'] : fields, name);
  if (fact.payer !== route.payer || integer(fact.snapshotSlot, name + ' snapshot') !== integer(facts.snapshotSlot, 'snapshot') ||
      typeof fact.source !== 'string' || !fact.source.length || fact.source.length > 256 ||
      integer(fact.validThroughSlot, name + ' validity') < integer(facts.snapshotSlot, 'snapshot')) { fail(name + ' inconsistent captured fact'); }
  // A missing monetary amount cannot erase the quote's known route binding.
  if (name === 'quote' && (integer(fact.selector, 'quote selector') !== integer(route.selector, 'destination selector') ||
      fact.mint !== route.mint || integer(fact.amount, 'quoted amount') !== integer(route.amount, 'amount') || fact.feeToken !== SYSTEM_PROGRAM)) {
    fail('native quote bound/route/amount');
  }
  if (fact.lamports === null) { return { missing: name + ' amount unknown' }; }
  const amount = integer(fact.lamports, name + ' lamports', name === 'quote');
  if (name === 'quote' && amount > 100000000n) { fail('native quote bound/route/amount'); }
  return { amount, missing: integer(fact.validThroughSlot, name + ' expiry') < integer(facts.observedSlot, 'observed slot') ? name + ' expired' : null };
}
function blockhashPrerequisite(facts) {
  const block = facts.blockhash;
  if (block === null) { return 'recent blockhash missing'; }
  shape(block, ['value', 'snapshotSlot', 'validThroughSlot', 'lastValidBlockHeight', 'observedBlockHeight', 'source'], 'blockhash');
  if (integer(block.snapshotSlot, 'blockhash snapshot') !== integer(facts.snapshotSlot, 'snapshot') ||
      typeof block.source !== 'string' || !block.source.length || block.source.length > 256 ||
      integer(block.validThroughSlot, 'blockhash validity') < integer(facts.snapshotSlot, 'snapshot')) { fail('inconsistent blockhash fact'); }
  // Validate every supplied value before classifying a missing companion as unknown.
  if (block.value !== null) { solanaPublicKeyBytes(block.value); }
  const lastValid = block.lastValidBlockHeight === null ? null : integer(block.lastValidBlockHeight, 'last valid block height');
  const observed = block.observedBlockHeight === null ? null : integer(block.observedBlockHeight, 'observed block height');
  if (integer(block.validThroughSlot, 'blockhash expiry') < integer(facts.observedSlot, 'observed slot') ||
      lastValid !== null && observed !== null && lastValid < observed) { return 'recent blockhash expired'; }
  if (block.value === null || lastValid === null || observed === null) { return 'recent blockhash validity unknown'; }
  return null;
}
function costFacts(route, facts) {
  const limit = integer(facts.maxExposureLamports, 'explicit exposure limit', true);
  if (limit > 10000000000n) { fail('exposure limit exceeds DEV bound'); }
  const missing = [], amounts = {};
  shape(facts.fees, ['quote', 'networkFee', 'rent'], 'fees');
  for (const [name, fact] of Object.entries({ ...facts.fees, payerBalance: facts.payerBalance })) {
    if (fact === null) { missing.push(name + ' missing'); continue; }
    const observation = costObservation(route, facts, name, fact);
    if (observation.amount !== undefined) { amounts[name] = observation.amount; }
    if (observation.missing) { missing.push(observation.missing); }
  }
  const lowerBound = (amounts.quote ?? 0n) + (amounts.networkFee ?? 0n) + (amounts.rent ?? 0n);
  // Zero is used only to SUM known components; missing components retain prerequisites.
  if (lowerBound > limit) { fail('known cost lower bound exceeds explicit limit'); }
  if (amounts.payerBalance !== undefined && lowerBound > amounts.payerBalance) { fail('known cost lower bound exceeds captured payer balance'); }
  const blockMissing = blockhashPrerequisite(facts);
  if (blockMissing) { missing.push(blockMissing); }
  return { missing, quotedFee: amounts.quote?.toString(), sourceLamports: amounts.payerBalance?.toString(),
    knownCostLowerBoundLamports: lowerBound.toString() };
}
/** Provider-free admission tests use independently retained derived identities, not native codec stubs. */
function admitCallFacts(route, facts, derived, partial) {
  validateDevSvmRoute(route);
  shape(facts, ['schema', 'testOnly', 'broadcastAllowed', 'evidenceClass', 'snapshotSlot', 'observedSlot', 'validThroughSlot',
    'state', 'before', 'fees', 'payerBalance', 'blockhash', 'maxExposureLamports'], 'captured input');
  if (facts.schema !== 'agtmai-dev-svm-call-input-v1' || facts.testOnly !== true || facts.broadcastAllowed !== false ||
      !['fixture-only', 'capture-consistency-only'].includes(facts.evidenceClass)) { fail('DEV non-executable evidence scope'); }
  const snapshot = integer(facts.snapshotSlot, 'snapshot slot', true), observed = integer(facts.observedSlot, 'observed slot', true);
  const valid = integer(facts.validThroughSlot, 'valid through slot', true);
  if (observed < snapshot || valid < snapshot || valid - snapshot > 32n) { fail('inconsistent snapshot window'); }
  for (const field of IDENTITY_FIELDS) {
    if (derived[field] !== route.identities[field]) { fail('derived identity ' + field); }
  }
  const commonBefore = commonBeforeState(facts.before);
  const cost = costFacts(route, facts);
  if (observed > valid || observed - snapshot > 32n) { cost.missing.push('snapshot expired'); }
  if (facts.state === null || facts.before === null) { cost.missing.push('common captured before-state missing'); }
  let limiterObservations = null, before = null, lookupTable = null;
  // Known malformed captures stay invalid even when fees/common before-state are unknown.
  if (facts.state !== null) {
    shape(facts.state, ['mint', 'sourceAta', 'poolAta', 'routerConfig', 'registry', 'pool', 'chain', 'alt'], 'state');
    const limits = routeState(route, facts, derived, partial);
    before = beforeState(route, facts, derived, partial, commonBefore);
    lookupTable = !partial || facts.state.alt !== null ? validateDevSvmLookupTable(route, facts, derived) : null;
    cost.missing.push(...limits.missing); limiterObservations = limits.observations;
    if (partial) {
      cost.missing.push(...Object.entries(facts.state).filter(([, value]) => value === null).map(([name]) => 'Raw ' + name + ' missing'));
    }
  }
  if (cost.missing.length) { return { status: 'prerequisites', reasons: cost.missing, knownCostLowerBoundLamports: cost.knownCostLowerBoundLamports, limiterObservations, broadcastAllowed: false }; }
  return { status: 'admitted', ...before, ...cost, lookupTable, limiterObservations };
}
export function admitDevSvmCallFacts(route, facts, derived) {
  return admitCallFacts(route, facts, derived, false);
}
/** Consumer admission checks every present raw record while retaining missing captures. */
export function admitPartialDevSvmCallFacts(route, facts, derived) {
  return admitCallFacts(route, facts, derived, true);
}
function expectedAccounts(route, e) {
  // Independent account-order policy, from Router IDL + the registered pool list.
  const addresses = [e.routerConfig, e.destChain, e.nonce, route.payer, SYSTEM_PROGRAM, SPL_TOKEN_PROGRAM,
    route.nativeMint, SYSTEM_PROGRAM, e.feeReceiver, e.spender, FEE_QUOTER_PROGRAM, e.feeConfig, e.feeDest,
    e.nativeFeeConfig, e.linkFeeConfig, route.rmn, e.curses, e.rmnConfig, e.sourceAta, e.perTokenConfig, e.chain,
    route.alt, e.registry, BURNMINT_PROGRAM, e.pool, e.ata, e.signer, SPL_TOKEN_PROGRAM, route.mint, e.feeTokenConfig, e.routerPoolSigner];
  const writable = new Set([1, 2, 3, 7, 8, 18, 20, 24, 25, 28]);
  return addresses.map((address, i) => ({ address, isWritable: writable.has(i), isSigner: i === 3 }));
}
export function verifyDevSvmInstructions(route, e, approval, instructions) {
  if (!Array.isArray(instructions) || instructions.length !== (approval ? 2 : 1)) { fail('exact approval/send instruction count'); }
  if (approval) {
    const ix = shape(instructions[0], ['programId', 'accounts', 'dataBase64'], 'approval');
    const data = bytes(ix.dataBase64, 'approval');
    if (ix.programId !== SPL_TOKEN_PROGRAM || data.length !== 9 || data[0] !== 4 || data.readBigUInt64LE(1) !== integer(route.amount, 'amount')) { fail('bounded classic approval only'); }
    equal(ix.accounts, [{ address: e.sourceAta, isWritable: true, isSigner: false },
      { address: e.spender, isWritable: false, isSigner: false }, { address: route.payer, isWritable: false, isSigner: true }], 'approval accounts');
  }
  const send = shape(instructions.at(-1), ['programId', 'accounts', 'dataBase64'], 'send');
  if (send.programId !== ROUTER_PROGRAM) { fail('send Router'); }
  equal(send.accounts, expectedAccounts(route, e), 'send account order/permissions');
  inspectSendData(null, bytes(send.dataBase64, 'send'), route.mint, SYSTEM_PROGRAM,
    { amount: integer(route.amount, 'amount'), selector: route.selector, nativeExpected: { receiver: Buffer.from(route.recipient.slice(2).padStart(64, '0'), 'hex') } });
}
function verifyPacketHeader(decoded, route, facts, packet) {
  if (decoded.version !== 0 || decoded.payer !== route.payer || decoded.header.numRequiredSignatures !== 1 ||
      decoded.header.numReadonlySignedAccounts !== 0 || decoded.recentBlockhash !== facts.blockhash.value ||
      decoded.messageBase64 !== packet.messageBase64 || packet.requiredSignatures !== 1 || packet.broadcastAllowed !== false ||
      decoded.signaturesBase64.length !== 1 || !bytes(decoded.signaturesBase64[0], 'signature').equals(Buffer.alloc(64))) { fail('v0 payer/signature/blockhash/message'); }
}
function verifyPacket(primitives, route, facts, admission, packet) {
  const instructions = packet.instructions;
  const rawPacket = bytes(packet.transactionBase64, 'transaction');
  if (!rawPacket.length) { fail('empty transaction'); }
  const decoded = primitives.inspectUnsignedV0({ transactionBase64: packet.transactionBase64, lookupTable: admission.lookupTable });
  verifyPacketHeader(decoded, route, facts, packet);
  if (decoded.lookups.length !== 1 || decoded.lookups[0].key !== route.alt) { fail('exact registered ALT count/key'); }
  const lookup = decoded.lookups[0];
  if (lookup.writableIndexes.length !== 3 || ![3, 4, 7].every(i => lookup.writableIndexes.includes(i)) ||
      new Set([...lookup.writableIndexes, ...lookup.readonlyIndexes]).size !== lookup.writableIndexes.length + lookup.readonlyIndexes.length) { fail('loaded writable indexes'); }
  const union = new Map([[route.payer, { pubkey: route.payer, isSigner: true, isWritable: true }]]);
  for (const ix of instructions) {
    if (!union.has(ix.programId)) { union.set(ix.programId, { pubkey: ix.programId, isSigner: false, isWritable: false }); }
    for (const a of ix.accounts) {
      const old = union.get(a.address) ?? { pubkey: a.address, isSigner: false, isWritable: false };
      union.set(a.address, { pubkey: a.address, isSigner: old.isSigner || a.isSigner, isWritable: old.isWritable || a.isWritable });
    }
  }
  if (decoded.accounts.length !== union.size || new Set(decoded.accounts.map(a => a.pubkey)).size !== union.size) { fail('unexpected/duplicate global account'); }
  decoded.accounts.forEach((a, i) => {
    equal(a, union.get(a.pubkey), 'global permissions');
    if (i >= decoded.staticAccountCount && a.isSigner) { fail('loaded signer'); }
  });
  if (decoded.instructions.length !== instructions.length) { fail('compiled instruction count'); }
  decoded.instructions.forEach((ix, i) => {
    if (ix.programId !== instructions[i].programId || ix.data !== '0x' + bytes(instructions[i].dataBase64, 'instruction').toString('hex')) { fail('compiled program/data'); }
    equal(ix.keys, instructions[i].accounts.map(a => union.get(a.address)), 'compiled order/global permissions');
  });
}
/** Shared independent wire oracle for the fixed public TESTNET transaction adapter. */
export function verifySvmWirePacket(primitives, route, expected, packet, lookupTable) {
  const selected = { ...route, alt: expected.alt };
  verifyDevSvmInstructions(selected, expected, expected.approval, packet.instructions);
  verifyPacket(primitives, selected, { blockhash: { value: packet.blockhash } }, { lookupTable },
    { ...packet, transactionBase64: packet.bytesBase64, requiredSignatures: 1, broadcastAllowed: false });
}
/** No RPC, factory instance, SDK send/getFee, key, signing or execution capability. */
export function buildDevSvmCallPlan(primitives, route, facts) {
  validateDevSvmRoute(route);
  const e = deriveReverseAccounts(primitives, { alt: route.alt }, route.linkMint, route);
  const admission = admitDevSvmCallFacts(route, facts, e);
  if (admission.status !== 'admitted') { return admission; }
  const instructions = reverseInstructions({ ...e, testOnly: true, cluster: 'solana-devnet', approval: admission.approval,
    quotedFee: admission.quotedFee, sourceLamports: admission.sourceLamports }, route);
  verifyDevSvmInstructions(route, e, admission.approval, instructions);
  const packet = primitives.compileUnsignedV0({ payer: route.payer, recentBlockhash: facts.blockhash.value, lookupTable: admission.lookupTable,
    instructions: instructions.map(ix => ({ programId: ix.programId, keys: ix.accounts.map(a => ({ pubkey: a.address, isSigner: a.isSigner, isWritable: a.isWritable })),
      data: '0x' + bytes(ix.dataBase64, 'instruction').toString('hex') })) });
  verifyPacket(primitives, route, facts, admission, { ...packet, instructions });
  return { schema: 'agtmai-dev-svm-call-plan-v1', status: 'built', qualification: 'DEV-unsigned-captured-consistency-only',
    evidenceClass: facts.evidenceClass, broadcastAllowed: false, instructions, ...packet,
    modelledAfter: admission.modelledAfter, knownCostLowerBoundLamports: admission.knownCostLowerBoundLamports };
}
export function verifyDevSvmCallPlan(primitives, route, facts, candidate) {
  shape(candidate, ['schema', 'status', 'qualification', 'evidenceClass', 'broadcastAllowed', 'instructions',
    'messageBase64', 'transactionBase64', 'requiredSignatures', 'modelledAfter', 'knownCostLowerBoundLamports'], 'candidate');
  const e = deriveReverseAccounts(primitives, { alt: route.alt }, route.linkMint, validateDevSvmRoute(route));
  const admission = admitDevSvmCallFacts(route, facts, e);
  if (admission.status !== 'admitted') { fail('candidate has unresolved prerequisites'); }
  if (candidate.schema !== 'agtmai-dev-svm-call-plan-v1' || candidate.status !== 'built' || candidate.qualification !== 'DEV-unsigned-captured-consistency-only' ||
      candidate.evidenceClass !== facts.evidenceClass || candidate.knownCostLowerBoundLamports !== admission.knownCostLowerBoundLamports) { fail('candidate DEV envelope'); }
  equal(candidate.modelledAfter, admission.modelledAfter, 'hypothetical post-state');
  verifyDevSvmInstructions(route, e, admission.approval, candidate.instructions);
  verifyPacket(primitives, route, facts, admission, candidate);
  return candidate;
}
/** Existing provider admission is named loadDevProvider at this checkpoint.
 * Accepts its exact {root, archives} public authority inputs; admission is unchanged. */
export async function createPinnedDevSvmCallPlan(options) {
  const { primitives, evidence } = await loadDevProvider(options);
  return Object.freeze({ evidence, build: (route, facts) => buildDevSvmCallPlan(primitives, route, facts),
    verify: (route, facts, candidate) => verifyDevSvmCallPlan(primitives, route, facts, candidate) });
}
