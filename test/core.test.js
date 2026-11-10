import test from 'node:test'
import assert from 'node:assert/strict'
import {MDController,channelNumber} from '../core.js'
function setup(states={2:false,3:false,47:true,48:true}) {
 const mute=new Map(Object.entries(states).map(([k,v])=>[Number(k),v]));const calls=[]
 const adapter={readMute(ch){return mute.has(ch)?mute.get(ch):null},setMute(ch,v){calls.push(['mute',ch,v]);mute.set(ch,v)},patchLocal(s,d){calls.push(['patch',s,d])}}
 return {c:new MDController(adapter),calls,mute}
}
test('variable channels accept any 1-48 input',()=>{const {c,calls}=setup();c.setPhysicalInput(22,9);c.assign(1,'input',22);c.assign(1,'output',45);c.patch(1);assert.deepEqual(calls,[['patch',9,45]])})
test('down/up restores originally unmuted vocal',()=>{const {c,calls}=setup();c.down(1);c.up(1);assert.deepEqual(calls,[['mute',3,true],['mute',47,false],['mute',47,true],['mute',3,false]])})
test('down/up leaves FOH-muted vocal muted',()=>{const {c,calls}=setup({3:true,47:true});c.down(1);c.up(1);assert.deepEqual(calls,[['mute',3,true],['mute',47,false],['mute',47,true]])})
test('unknown mute state refuses to open talk',()=>{const {c,calls}=setup({47:true});assert.throws(()=>c.down(1),/unknown/);assert.deepEqual(calls,[])})
test('duplicate down is idempotent',()=>{const {c,calls}=setup();c.down(1);c.down(1);assert.equal(calls.length,2)})
for(const md of [1,2])test(`MD${md} second press releases and later pedal up does not reopen talk`,()=>{
 const {c,calls}=setup(),{input,output}=c.get(md)
 assert.equal(c.press(md),'activated')
 assert.equal(c.get(md).active,true)
 assert.equal(c.press(md),'released')
 assert.equal(c.get(md).active,false)
 assert.equal(c.up(md),false)
 assert.deepEqual(calls,[['mute',input,true],['mute',output,false],['mute',output,true],['mute',input,false],['mute',output,true]])
 assert.equal(c.get(3-md).active,false)
})
test('press override preserves originally FOH-muted vocal',()=>{
 const {c,calls}=setup({3:true,47:true})
 c.press(1);c.press(1);c.up(1)
 assert.deepEqual(calls,[['mute',3,true],['mute',47,false],['mute',47,true],['mute',47,true]])
})
test('failed press release retains active snapshot for retry',()=>{
 const {c}=setup()
 c.press(1)
 const setMute=c.adapter.setMute
 c.adapter.setMute=()=>{throw Error('transport')}
 assert.throws(()=>c.press(1),/transport/)
 assert.equal(c.get(1).active,true)
 assert.equal(c.get(1).wasMuted,false)
 c.adapter.setMute=setMute
 assert.equal(c.press(1),'released')
})
test('duplicate up always closes talk but never unmutes vocal again',()=>{const {c,calls}=setup();c.up(1);assert.deepEqual(calls,[['mute',47,true]])})
test('MDs operate independently',()=>{const {c,calls}=setup();c.down(1);c.down(2);c.up(1);c.up(2);assert.equal(calls.length,8)})
test('active assignment changes rejected',()=>{const {c}=setup();c.down(1);assert.throws(()=>c.assign(1,'input',4),/held/)})
test('same input and talk channel rejected',()=>{const {c}=setup();c.assign(1,'output',3);assert.throws(()=>c.down(1),/differ/)})
test('reconnect invalidates previous snapshot',()=>{const {c,calls}=setup();c.down(1);c.resetAfterReconnect();c.up(1);assert.deepEqual(calls.slice(-1),[['mute',47,true]])})
for(const x of [0,49,'1.5','abc','-1',''])test(`reject invalid channel ${JSON.stringify(x)}`,()=>assert.throws(()=>channelNumber(x)))
test('combined assignment patches before committing selected input',()=>{const {c,calls}=setup();c.setPhysicalInput(10,9);const result=c.assignInputAndPatch(1,10);assert.deepEqual(result,{input:10,source:9,output:47});assert.deepEqual(calls,[['patch',9,47]]);assert.equal(c.get(1).input,10);assert.equal(c.getPhysicalInput(47),9)})
test('combined assignment supports distinct LOCAL socket',()=>{const {c,calls}=setup();c.assignInputAndPatch(2,5,9);assert.deepEqual(calls,[['patch',9,48]]);assert.equal(c.get(2).input,5)})
test('combined assignment does not change state when patch throws',()=>{const {c}=setup();c.setPhysicalInput(10,9);c.setPhysicalInput(47,8);c.adapter.patchLocal=()=>{throw Error('transport')};assert.throws(()=>c.assignInputAndPatch(1,10),/transport/);assert.equal(c.get(1).input,3);assert.equal(c.getPhysicalInput(47),8)})
test('combined assignment rejects invalid channel before sending patch',()=>{const {c,calls}=setup();assert.throws(()=>c.assignInputAndPatch(1,49));assert.deepEqual(calls,[])})
test('all physical mappings start unknown and blank-source patches fail without side effects',()=>{
 const {c,calls}=setup()
 assert.deepEqual(c.physicalInputs,Array(48).fill(null))
 assert.throws(()=>c.patch(1),/physical input unknown/)
 assert.throws(()=>c.assignInputAndPatch(1,10),/physical input unknown/)
 assert.equal(c.get(1).input,3)
 assert.deepEqual(calls,[])
})
test('mapping can be configured offline, cleared, and restored without sending console commands',()=>{
 const {c,calls}=setup()
 c.setPhysicalInput(3,9)
 assert.equal(c.getPhysicalInput(3),9)
 c.setPhysicalInput(3,null)
 assert.equal(c.getPhysicalInput(3),null)
 const mappings=Array(48).fill(null);mappings[2]=9;mappings[46]=9
 const restored=new MDController(c.adapter,undefined,mappings)
 assert.equal(restored.getPhysicalInput(3),9)
 assert.equal(restored.getPhysicalInput(47),9)
 assert.deepEqual(calls,[])
})
test('patch targets talk mapping but mutes always target logical channels',()=>{
 const {c,calls}=setup()
 c.setPhysicalInput(3,9);c.patch(1);c.down(1);c.up(1)
 assert.equal(c.getPhysicalInput(47),9)
 assert.deepEqual(calls,[['patch',9,47],['mute',3,true],['mute',47,false],['mute',47,true],['mute',3,false]])
})
test('explicit source overrides unknown mapping and records only the destination',()=>{
 const {c}=setup()
 c.assignInputAndPatch(1,5,9)
 assert.equal(c.getPhysicalInput(5),null)
 assert.equal(c.getPhysicalInput(47),9)
 c.patch(1,8)
 assert.equal(c.getPhysicalInput(47),8)
})
test('mapping edits do not implicitly repatch MD outputs',()=>{
 const {c,calls}=setup()
 c.setPhysicalInput(3,9);c.patch(1);c.setPhysicalInput(3,8)
 assert.equal(c.getPhysicalInput(47),9)
 assert.deepEqual(calls,[['patch',9,47]])
})
test('held pedals reject vocal/talk mapping edits and patches from the other MD',()=>{
 const {c,calls}=setup()
 c.down(1)
 assert.throws(()=>c.setPhysicalInput(3,9),/held/)
 assert.throws(()=>c.setPhysicalInput(47,9),/held/)
 c.assign(2,'output',47)
 assert.throws(()=>c.patch(2,9),/held/)
 assert.throws(()=>c.assignInputAndPatch(2,5,9),/held/)
 assert.equal(c.get(2).input,2)
 assert.equal(calls.length,2)
})
test('invalid or conflicting bulk mappings leave all previous mappings intact',()=>{
 const {c}=setup()
 c.setPhysicalInput(2,8);c.down(1)
 const values=Array(48).fill(null);values[1]=9;values[2]=9
 assert.throws(()=>c.setPhysicalInputs(values),/held/)
 assert.equal(c.getPhysicalInput(2),8)
 values[2]=null;values[47]=49
 assert.throws(()=>c.setPhysicalInputs(values),/LOCAL source/)
 assert.equal(c.getPhysicalInput(2),8)
 assert.throws(()=>c.setPhysicalInputs([]),/48/)
})
test('mappings survive connection snapshot invalidation',()=>{
 const {c}=setup()
 c.setPhysicalInput(3,9);c.patch(1);c.resetAfterReconnect()
 assert.equal(c.getPhysicalInput(3),9)
 assert.equal(c.getPhysicalInput(47),9)
})
for(const x of [0,49,'1.5','abc','-1',''])test(`reject invalid physical socket ${JSON.stringify(x)}`,()=>{
 const {c}=setup()
 assert.throws(()=>c.setPhysicalInput(3,x))
 assert.equal(c.getPhysicalInput(3),null)
})
