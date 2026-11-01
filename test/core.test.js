import test from 'node:test'
import assert from 'node:assert/strict'
import {MDController,channelNumber} from '../core.js'
function setup(states={2:false,3:false,47:true,48:true}) {
 const mute=new Map(Object.entries(states).map(([k,v])=>[Number(k),v]));const calls=[]
 const adapter={readMute(ch){return mute.has(ch)?mute.get(ch):null},setMute(ch,v){calls.push(['mute',ch,v]);mute.set(ch,v)},patchLocal(s,d){calls.push(['patch',s,d])}}
 return {c:new MDController(adapter),calls,mute}
}
test('variable channels accept any 1-48 input',()=>{const {c,calls}=setup();c.assign(1,'input',22);c.assign(1,'output',45);c.patch(1);assert.deepEqual(calls,[['patch',22,45]])})
test('down/up restores originally unmuted vocal',()=>{const {c,calls}=setup();c.down(1);c.up(1);assert.deepEqual(calls,[['mute',3,true],['mute',47,false],['mute',47,true],['mute',3,false]])})
test('down/up leaves FOH-muted vocal muted',()=>{const {c,calls}=setup({3:true,47:true});c.down(1);c.up(1);assert.deepEqual(calls,[['mute',3,true],['mute',47,false],['mute',47,true]])})
test('unknown mute state refuses to open talk',()=>{const {c,calls}=setup({47:true});assert.throws(()=>c.down(1),/unknown/);assert.deepEqual(calls,[])})
test('duplicate down is idempotent',()=>{const {c,calls}=setup();c.down(1);c.down(1);assert.equal(calls.length,2)})
test('duplicate up always closes talk but never unmutes vocal again',()=>{const {c,calls}=setup();c.up(1);assert.deepEqual(calls,[['mute',47,true]])})
test('MDs operate independently',()=>{const {c,calls}=setup();c.down(1);c.down(2);c.up(1);c.up(2);assert.equal(calls.length,8)})
test('active assignment changes rejected',()=>{const {c}=setup();c.down(1);assert.throws(()=>c.assign(1,'input',4),/held/)})
test('same input and talk channel rejected',()=>{const {c}=setup();c.assign(1,'output',3);assert.throws(()=>c.down(1),/differ/)})
test('reconnect invalidates previous snapshot',()=>{const {c,calls}=setup();c.down(1);c.resetAfterReconnect();c.up(1);assert.deepEqual(calls.slice(-1),[['mute',47,true]])})
for(const x of [0,49,'1.5','abc','-1',''])test(`reject invalid channel ${JSON.stringify(x)}`,()=>assert.throws(()=>channelNumber(x)))
test('combined assignment patches before committing selected input',()=>{const {c,calls}=setup();const result=c.assignInputAndPatch(1,10);assert.deepEqual(result,{input:10,source:10,output:47});assert.deepEqual(calls,[['patch',10,47]]);assert.equal(c.get(1).input,10)})
test('combined assignment supports distinct LOCAL socket',()=>{const {c,calls}=setup();c.assignInputAndPatch(2,5,9);assert.deepEqual(calls,[['patch',9,48]]);assert.equal(c.get(2).input,5)})
test('combined assignment does not change state when patch throws',()=>{const {c}=setup();c.adapter.patchLocal=()=>{throw Error('transport')};assert.throws(()=>c.assignInputAndPatch(1,10),/transport/);assert.equal(c.get(1).input,3)})
test('combined assignment rejects invalid channel before sending patch',()=>{const {c,calls}=setup();assert.throws(()=>c.assignInputAndPatch(1,49));assert.deepEqual(calls,[])})
