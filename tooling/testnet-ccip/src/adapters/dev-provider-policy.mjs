// New DEV-only identity from the 2026-10-03 recovery addendum; legacy pins stay immutable.
// Literal package-level admission, selected from retained archive source, never installed bytes.
export const DEV_PROVIDER_AUTHORITY = 'agtmai-public-only-dev-provider-v1';
export const ROOT_HASHES = Object.freeze({
  'package.json': '9bc50499bd486b1457bb2efb85951ed8b90d15faf13b39d36d3bb97a2338ccc4',
  'package-lock.json': 'f65db5bc0003f0cfe4545ab853a991cea43ec7b172ad52e5002e7f25dd7ce8c1',
});
// SHA256 locates each retained archive; pinned lock SHA512 independently authenticates it.
// SDK is a DATA/resolution owner only. ws7 is also admitted for its dormant optional policy.
export const SELECTED_PACKAGES = Object.freeze([
  Object.freeze(["tslib", "70d057c311c797b234d8868f33330af39a977da94e92264257736b0b88d57e4c"]),
  Object.freeze(["@chainlink/ccip-sdk", "caed2fefa8ccd9e31d0920dbdd7622ae8cb87d63efd178fe6a67425f9db709f6"]),
  Object.freeze(["ethers", "17355f81284ba8431953c77af803b122baf4670cdbf84907adf7cafcd745052b"]),
  Object.freeze(["ethers/node_modules/@noble/curves", "b8deefbef49216803efff80fcf7f164ccbb1fa4888eed571678535710af1d0a3"]),
  Object.freeze(["ethers/node_modules/@noble/hashes", "f4b71760b6da6d251392c06c56f49cf12134a20b04e31980e2a59704505d8b0b"]),
  Object.freeze(["@adraffy/ens-normalize", "7578f2dbf456f0f602e18c478886a579ed657d246f51417df1033b894fbab389"]),
  Object.freeze(["@solana/web3.js", "410ea26b7625ff7dea7e138de9d3a63eb0aaf3e1c04ba936feab9224b4be8a82"]),
  Object.freeze(["@noble/curves", "c4c5545645b8d58a080d2faf84982f6fe5dc3a0516e11de8dc571b38cab565e9"]),
  Object.freeze(["@noble/curves/node_modules/@noble/hashes", "e8a765d92c04faaccba8776411c5038cb195f812ee629fce07e1d2e6aec80ea0"]),
  Object.freeze(["@solana/web3.js/node_modules/@noble/hashes", "e8a765d92c04faaccba8776411c5038cb195f812ee629fce07e1d2e6aec80ea0"]),
  Object.freeze(["@solana/web3.js/node_modules/@solana/codecs-numbers", "71a58b39610269b413f969abc56cd5cd90e27b3ad121aee3b027d4b313309f7b"]),
  Object.freeze(["@solana/web3.js/node_modules/@solana/codecs-core", "b2b054171618f8c3045ffb423541097df68cb42c8b52dafe8ffedb231cc10510"]),
  Object.freeze(["@solana/web3.js/node_modules/@solana/errors", "74e35a882ed274b2551771a381b7e2cd1250c91f4bf569cb49b25a342661adfc"]),
  Object.freeze(["@solana/buffer-layout", "dfeaf275ddb98b02017f6516b4c4dd8943e62995fd4a8dc029f1b86c63d3593f"]),
  Object.freeze(["bn.js", "795da38a01160f7c7d48f77a02f381ae95164b1b96dcb3b9b06990851eba7e7d"]),
  Object.freeze(["@solana/web3.js/node_modules/bs58", "f704235cff9fb87cbf9ce9a6677a30e6bf5eadc34d722938fe6817662e48e837"]),
  Object.freeze(["@solana/web3.js/node_modules/base-x", "b458d3c13a727ee97e44a49d5b634bd1dc9c94b5d7ceb8a34d10a7dc6b5f830a"]),
  Object.freeze(["@solana/web3.js/node_modules/borsh", "e6f1438a1b4f994cb0b3392ef67cb772a57aa1de6b62ae42805ea7ca9715edb1"]),
  Object.freeze(["text-encoding-utf-8", "6a32754af512ac53c3cbab5e8ec7d2931e43105ee4514a431f76d0e015654e72"]),
  Object.freeze(["safe-buffer", "5d181804516c4a693a384272a7bd0e42d17e0d4b301ccfbe408669ccafdcb3e8"]),
  Object.freeze(["@solana/web3.js/node_modules/superstruct", "8b02b0ddf37ed32a62c80f03d5c21ed170f605800ab2ad1064f8499391f15f06"]),
  Object.freeze(["jayson", "0403fc8cf5de8a2c19591890eb7090f96a421f319aa6ee1e8044c40a47acd2b2"]),
  Object.freeze(["uuid", "f630703647a5821c735a542edcf8d26c989724efe9d9912ab6f6836a1e79924a"]),
  Object.freeze(["node-fetch", "a70348669b01db602faf140e984e61b01c4380f9b4bf5e460b7960902412832b"]),
  Object.freeze(["whatwg-url", "b09dc471f573a876eeac3902b8c1da62af5cdbbca2c6fba4a06f119f89cb7ed3"]),
  Object.freeze(["webidl-conversions", "e4dfc34b40947c2cf0038cd95fa6de21f4dac93224a7ad8e169205f5c2e22da8"]),
  Object.freeze(["tr46", "164ae1eb32cea353551bbc7f9358dcaae4ffabbe65ec37a92ca464a9570a2a0a"]),
  Object.freeze(["rpc-websockets", "bb21465e865d4598608b6c4620278e72a144620a6dff1e8dc9adbbdc8089d6c5"]),
  Object.freeze(["rpc-websockets/node_modules/uuid", "30e122d0715991b19b98043ea8eb275e9083315c8b9cb9e9ba66c249ef936c6b"]),
  Object.freeze(["eventemitter3", "21d4a36175672b9e6640c39a68613af73f9a4c47a4a4da39993e8cd085564eb6"]),
  Object.freeze(["ws", "d08b726b3aae3a0fed5218a0d9a4b2ac8d75d4ad453a9271db55fe38e94eb4cf"]),
  Object.freeze(["jayson/node_modules/ws", "f2d229b958dd0849a9001ebc207130711ca80d3fbe1353a97fde80c186fe02b7"]),
]);

// Reviewed Node require/default exports. abi -> utils/address/hash/crypto/transaction
// is internal ethers CJS; geturl imports tslib and inert built-in HTTP functions.
// No ethers root/providers/wallet entry, SDK, Anchor, SPL, bigint-buffer is imported.
// web3's Babel/HTTP-agent/stable-stringify helpers and rpc's SWC helpers are inlined;
// package metadata dependencies and declaration-only peers are not runtime edges.
const n = path => 'node_modules/' + path;
const e = 'ethers/lib.commonjs/', w = '@solana/web3.js/', wn = w + 'node_modules/';
const eh = 'ethers/node_modules/@noble/hashes/', ec = 'ethers/node_modules/@noble/curves/';
const nc = '@noble/curves/', nh = nc + 'node_modules/@noble/hashes/';
const edge = (owner, specifier, target) => Object.freeze([n(owner), specifier, n(target)]);
export const RESOLUTION_EDGES = Object.freeze([
  edge('@chainlink/ccip-sdk/package.json', '@chainlink/ccip-sdk', '@chainlink/ccip-sdk/dist/index.js'),
  edge('@chainlink/ccip-sdk/dist/index.js', 'ethers/abi', e + 'abi/index.js'),
  edge('@chainlink/ccip-sdk/dist/index.js', '@solana/web3.js', w + 'lib/index.cjs.js'),
  edge(e + 'utils/geturl.js', 'tslib', 'tslib/tslib.js'),
  edge(e + 'crypto/keccak.js', '@noble/hashes/sha3', eh + 'sha3.js'),
  edge(e + 'crypto/ripemd160.js', '@noble/hashes/ripemd160', eh + 'ripemd160.js'),
  edge(e + 'crypto/scrypt.js', '@noble/hashes/scrypt', eh + 'scrypt.js'),
  edge(e + 'crypto/signing-key.js', '@noble/curves/secp256k1', ec + 'secp256k1.js'),
  edge(e + 'hash/namehash.js', '@adraffy/ens-normalize', '@adraffy/ens-normalize/dist/index.cjs'),
  edge(ec + 'secp256k1.js', '@noble/hashes/sha256', eh + 'sha256.js'),
  edge(ec + 'secp256k1.js', '@noble/hashes/utils', eh + 'utils.js'),
  edge(ec + '_shortw_utils.js', '@noble/hashes/hmac', eh + 'hmac.js'),
  edge(ec + '_shortw_utils.js', '@noble/hashes/utils', eh + 'utils.js'),
  edge(eh + 'utils.js', '@noble/hashes/crypto', eh + 'cryptoNode.js'),
  edge(w + 'lib/index.cjs.js', '@noble/curves/ed25519', nc + 'ed25519.js'),
  edge(w + 'lib/index.cjs.js', '@noble/curves/secp256k1', nc + 'secp256k1.js'),
  edge(w + 'lib/index.cjs.js', '@noble/hashes/sha256', wn + '@noble/hashes/sha256.js'),
  edge(w + 'lib/index.cjs.js', '@noble/hashes/sha3', wn + '@noble/hashes/sha3.js'),
  edge(nc + 'ed25519.js', '@noble/hashes/sha2.js', nh + 'sha2.js'),
  edge(nc + 'ed25519.js', '@noble/hashes/utils.js', nh + 'utils.js'),
  edge(nc + 'secp256k1.js', '@noble/hashes/sha2.js', nh + 'sha2.js'),
  edge(nc + 'secp256k1.js', '@noble/hashes/utils.js', nh + 'utils.js'),
  edge(nc + 'utils.js', '@noble/hashes/utils', nh + 'utils.js'),
  edge(nh + 'utils.js', '@noble/hashes/crypto', nh + 'cryptoNode.js'),
  edge(wn + '@noble/hashes/utils.js', '@noble/hashes/crypto', wn + '@noble/hashes/cryptoNode.js'),
  edge(w + 'lib/index.cjs.js', 'bn.js', 'bn.js/lib/bn.js'),
  edge(w + 'lib/index.cjs.js', 'bs58', wn + 'bs58/index.js'),
  edge(w + 'lib/index.cjs.js', 'borsh', wn + 'borsh/lib/index.js'),
  edge(wn + 'borsh/lib/index.js', 'bn.js', 'bn.js/lib/bn.js'),
  edge(wn + 'borsh/lib/index.js', 'bs58', wn + 'bs58/index.js'),
  edge(wn + 'borsh/lib/index.js', 'text-encoding-utf-8', 'text-encoding-utf-8/lib/encoding.lib.js'),
  edge(wn + 'bs58/index.js', 'base-x', wn + 'base-x/src/index.js'),
  edge(wn + 'base-x/src/index.js', 'safe-buffer', 'safe-buffer/index.js'),
  edge(w + 'lib/index.cjs.js', '@solana/buffer-layout', '@solana/buffer-layout/lib/Layout.js'),
  edge(w + 'lib/index.cjs.js', '@solana/codecs-numbers', wn + '@solana/codecs-numbers/dist/index.node.cjs'),
  edge(wn + '@solana/codecs-numbers/dist/index.node.cjs', '@solana/codecs-core', wn + '@solana/codecs-core/dist/index.node.cjs'),
  edge(wn + '@solana/codecs-numbers/dist/index.node.cjs', '@solana/errors', wn + '@solana/errors/dist/index.node.cjs'),
  edge(wn + '@solana/codecs-core/dist/index.node.cjs', '@solana/errors', wn + '@solana/errors/dist/index.node.cjs'),
  edge(w + 'lib/index.cjs.js', 'superstruct', wn + 'superstruct/dist/index.cjs'),
  edge(w + 'lib/index.cjs.js', 'jayson/lib/client/browser', 'jayson/lib/client/browser/index.js'),
  edge('jayson/lib/client/browser/index.js', 'uuid', 'uuid/dist/index.js'),
  edge('jayson/lib/generateRequest.js', 'uuid', 'uuid/dist/index.js'),
  edge(w + 'lib/index.cjs.js', 'node-fetch', 'node-fetch/lib/index.js'),
  edge('node-fetch/lib/index.js', 'whatwg-url', 'whatwg-url/lib/public-api.js'),
  edge('whatwg-url/lib/URL.js', 'webidl-conversions', 'webidl-conversions/lib/index.js'),
  edge('whatwg-url/lib/url-state-machine.js', 'tr46', 'tr46/index.js'),
  edge(w + 'lib/index.cjs.js', 'rpc-websockets', 'rpc-websockets/dist/index.cjs'),
  edge('rpc-websockets/dist/index.cjs', 'ws', 'ws/index.js'),
  edge('rpc-websockets/dist/index.cjs', 'eventemitter3', 'eventemitter3/index.js'),
  // uuid14's node/default ESM dist-node index and relative exports work with Node24 require(esm).
  edge('rpc-websockets/dist/index.cjs', 'uuid', 'rpc-websockets/node_modules/uuid/dist-node/index.js'),
]);
export const OPTIONAL_BRANCHES = Object.freeze([
  Object.freeze([n('ws/lib/buffer-util.js'), 'bufferutil']),
  Object.freeze([n('ws/lib/validation.js'), 'utf-8-validate']),
  Object.freeze([n('jayson/node_modules/ws/lib/buffer-util.js'), 'bufferutil']),
  Object.freeze([n('jayson/node_modules/ws/lib/validation.js'), 'utf-8-validate']),
  Object.freeze([n('node-fetch/lib/index.js'), 'encoding']),
]);
export const SOURCE_AUTHORITIES = Object.freeze([
  Object.freeze([n('@chainlink/ccip-sdk/src/evm/abi/BurnMintERC677Token.ts'), '8f75c70bc227345474ce526b43349a2d04d671d41b7f090676672c7be74ffa62']),
  Object.freeze([n('@chainlink/ccip-sdk/src/evm/abi/Router.ts'), '070c65ae34d53dde59bc5c6720de54b19d69eb62eb62399295d3b6f10d7ae03f']),
  Object.freeze([n('@chainlink/ccip-sdk/dist/evm/abi/Router.js'), '54fd27a7bba868b1f3c1b27f5d5a7b3676259ce9c332ef5718a7a5f99759b927']),
  Object.freeze([n('@chainlink/ccip-sdk/dist/solana/idl/1.6.0/CCIP_ROUTER.js'), '01c560fecef86ae86615dcd77dd1a8048e1a1373248f76781db4716d57aaa10f']),
]);
