import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {authenticatedSolanaEffect, type NativeStatusLane} from '../src/adapters/transfer-status-native.mjs';
import {validateReplacementFixture} from '../src/domain/replacement-fixture.ts';
const capture=JSON.parse(readFileSync(new URL('./fixtures/replacement-mint-repeated-authority.json',import.meta.url),'utf8'));
const fixture=validateReplacementFixture(capture.fixture);
const signer='6NHJ67wzJYjKFKuxuuTLkYPiPW99Gk61SS643U4dS6LJ';
const ata='Bm55TQK6steDnuhm7Zm5dCTA4rwZ2CSgyqMRttVs22Nr';
const lane:NativeStatusLane={fixture,solanaPool:fixture.solanaPool,solanaSigner:signer,recipientAtas:{[fixture.recipient]:ata}};
type NativeTransaction={meta:{innerInstructions:{instructions:{parsed?:{type:string,info:Record<string,unknown>}}[]}[]}};
function original():NativeTransaction{return structuredClone(capture.response.result);}
function mintInfo(tx:NativeTransaction):Record<string,unknown>{
 const ix=tx.meta.innerInstructions.flatMap(g=>g.instructions).find(candidate=>candidate.parsed?.type==='mintTo');
 assert.ok(ix?.parsed);return ix.parsed.info;
}
const prove=(tx:NativeTransaction)=>authenticatedSolanaEffect(tx,'mint',fixture.recipient,ata,{lane,event:capture.event});
test('actual finalized Devnet mint with repeated pool PDA authority reconciles native CPI and balance delta',()=>{
 assert.equal(capture.signature,'5cBwjXGsMHsFtKouisdj8xMqRPd167MN6LKhNyZVfcnRqrJUnq1noTuxVpczWYYBvYk8HqUZBfEsMPMuuRjN8PZ9');
 assert.equal(capture.response.result.meta.err,null);
 assert.deepEqual(mintInfo(original()).signers,[signer]);
 assert.equal(prove(original()),5);
});
test('ordinary direct mint authority retains the same exact native proof',()=>{
 const tx=original(),info=mintInfo(tx);delete info.multisigMintAuthority;delete info.signers;info.mintAuthority=signer;
 assert.equal(prove(tx),5);
});
const rejects:[string,(info:Record<string,unknown>)=>void][]=[
 ['wrong repeated authority',i=>{i.multisigMintAuthority=fixture.recipient;}],
 ['wrong repeated signer',i=>{i.signers=[fixture.recipient];}],
 ['empty repeated signers',i=>{i.signers=[];}],
 ['multiple repeated signers',i=>{i.signers=[signer,signer];}],
 ['missing repeated signers',i=>{delete i.signers;}],
 ['scalar repeated signer',i=>{i.signers=signer;}],
 ['mixed direct and repeated authority',i=>{i.mintAuthority=signer;}],
 ['mixed authority alias',i=>{i.authority=signer;}],
 ['wrong mint amount',i=>{i.amount='1000000001';}],
 ['no authority proof',i=>{delete i.multisigMintAuthority;delete i.signers;}],
 ['direct authority with repeated signer array',i=>{delete i.multisigMintAuthority;i.mintAuthority=signer;}],
];
for(const [name,mutate] of rejects){test(name+' cannot qualify a mint',()=>{
 const tx=original();mutate(mintInfo(tx));assert.throws(()=>prove(tx),/mint amount\/authority\/decimals/);
});}
