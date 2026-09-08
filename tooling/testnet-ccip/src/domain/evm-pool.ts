const word = (value: string): string => value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
/** Official LockReleaseTokenPool1.6.1 constructor: token,decimals,allowlist,RMN,router. */
export function lockReleaseConstructor(token: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(token) || /^0x0+$/.test(token)) { throw new Error("Invalid canonical token address"); }
  return "0x" + [word(token), word("9"), word("a0"),
    word("0xba3f6251de62dED61Ff98590cB2fDf6871FbB991"),
    word("0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59"), word("0")].join("");
}
