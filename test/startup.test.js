import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const modulePath = fileURLToPath(new URL('../main.js', import.meta.url))
const manifestPath = fileURLToPath(new URL('../companion/manifest.json', import.meta.url))

// Replace only the console transport; exercise the real Companion entrypoint and IPC.
const mixerSource = `
import { EventEmitter } from 'node:events'
export class SQMixer extends EventEmitter {
  connected = false
  inputs = Array.from({ length: 48 }, (_, i) => Object.assign(new EventEmitter(),{
    name: 'IP' + (i + 1),
    muted: i >= 46,
    setMute: on => process.send({ testEvent: 'mute', channel: i + 1, on })
  }))
  constructor() {
    super()
    process.on('message', message => {
      if (!message.testRename) return
      const input = this.inputs[message.testRename.channel - 1]
      input.name = message.testRename.name
      input.emit('name', input.name)
    })
  }
  setInputPatch(source, socket, destination) {
    process.send({ testEvent: 'patch', source, socket, destination })
  }
  connect() {
    process.send({ testEvent: 'handshake-started' })
    if (process.env.TEST_CONNECTED === '1') {
      this.connected = true
      for (const [channel, name] of [[3,'V_Lead'],[2,'V_Lead'],[47,'MD_One']]) {
        this.inputs[channel-1].name=name
        this.inputs[channel-1].emit('name',name)
      }
      this.emit('initialState')
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      this.reject = reject
      this.timer = setTimeout(() => reject(new Error('Simulated handshake timeout')), 500)
    })
  }
  disconnect() {
    clearTimeout(this.timer)
    this.reject?.(new Error('Disconnected'))
    process.send({ testEvent: 'transport-closed' })
    this.emit('disconnect')
  }
}
`
const mixerUrl = `data:text/javascript,${encodeURIComponent(mixerSource)}`
const loaderSource = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@allen-heath-sq-tools/api') return { url: ${JSON.stringify(mixerUrl)}, shortCircuit: true }
  return nextResolve(specifier, context)
}
`
const loaderUrl = `data:text/javascript,${encodeURIComponent(loaderSource)}`

function startModule(t, connected = false) {
  const child = fork(modulePath, [], {
    execArgv: ['--experimental-loader', loaderUrl],
    env: { ...process.env, MODULE_MANIFEST: manifestPath, CONNECTION_ID: 'startup-test', VERIFICATION_TOKEN: 'test', TEST_CONNECTED: connected ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  t.after(() => child.kill())
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const messages = []
  const waiters = new Set()
  child.on('message', message => {
    messages.push(message)
    if (message.direction === 'call' && message.callbackId) {
      const request = JSON.parse(message.payload)
      const result = message.name === 'parseVariablesInString'
        ? { text: request.text.replace('$(custom:Vocal)', '3').replace('$(custom:Socket)', '9') }
        : {}
      child.send({ direction: 'response', callbackId: message.callbackId, success: true, payload: JSON.stringify(result) })
    }
    for (const notify of waiters) notify()
  })
  function waitFor(predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check)
        reject(new Error(`Timed out waiting for module IPC:\n${output}`))
      }, 4000)
      function check() {
        const message = messages.find(predicate)
        if (!message) return
        clearTimeout(timer)
        waiters.delete(check)
        resolve(message)
      }
      waiters.add(check)
      check()
    })
  }
  let callbackId = 100
  async function call(name, payload = {}) {
    const id = callbackId++
    child.send({ direction: 'call', name, callbackId: id, payload: JSON.stringify(payload) })
    const response = await waitFor(message => message.direction === 'response' && message.callbackId === id)
    assert.equal(response.success, true, response.payload)
    return response.payload === undefined || response.payload === 'undefined' ? undefined : JSON.parse(response.payload)
  }
  async function action(actionId, options) {
    const result = await call('executeAction', { action: { id: 'test-action', actionId, controlId: 'test-button', options } })
    assert.equal(result.success, true, result.errorMessage)
  }
  function variables() {
    return Object.fromEntries(messages.filter(message=>message.name==='setVariableValues')
      .flatMap(message=>JSON.parse(message.payload).newValues.map(variable=>[variable.id,variable.value])))
  }
  function savedConfig() {
    return JSON.parse(messages.filter(message=>message.name==='saveConfig').at(-1).payload).config
  }
  return { child, messages, waitFor, call, action, variables, savedConfig }
}

test('pedal press action releases active MD and publishes feedback state through Companion IPC', async t => {
  const host = startModule(t, true)
  await host.waitFor(message => message.name === 'register')
  await host.call('init', { config: { host: '127.0.0.1' }, label: 'SQ test', isFirstInit: false, lastUpgradeIndex: -1 })
  await host.waitFor(message => message.name === 'setVariableValues' && JSON.parse(message.payload).newValues.some(v => v.id === 'connection_status' && v.value === 'Connected'))
  for (const md of [1,2]) {
    await host.action('pedal_press', { md: String(md) })
    assert.equal(host.variables()[`MD${md}Active`],1)
    await host.action('pedal_press', { md: String(md) })
    assert.equal(host.variables()[`MD${md}Active`],0)
    await host.action('pedal_up', { md: String(md) })
    assert.equal(host.variables()[`MD${md}Active`],0)
  }
  assert.deepEqual(host.messages.filter(m=>m.testEvent==='mute').map(m=>[m.channel,m.on]),
    [[3,true],[47,false],[47,true],[3,false],[47,true],[2,true],[48,false],[48,true],[2,false],[48,true]])
})

test('Companion init and configuration remain responsive during and after a failed SQ handshake', async t => {
  const host = startModule(t)
  await host.waitFor(message => message.name === 'register')
  await host.call('init', { config: { host: '127.0.0.1' }, label: 'SQ test', isFirstInit: false, lastUpgradeIndex: -1 })
  assert.equal(host.messages.some(message => message.testEvent === 'transport-closed'), false)
  await host.waitFor(message => message.testEvent === 'handshake-started')
  const { fields } = await host.call('getConfigFields')
  assert.equal(fields.find(field => field.id === 'host').label, 'SQ console IP')
  assert.deepEqual(fields.filter(field => field.type === 'dropdown').map(field => field.id), ['input1', 'output1', 'input2', 'output2'])
  await host.waitFor(message => message.testEvent === 'transport-closed')
  assert.equal(host.child.exitCode, null)
  const { fields: afterFailure } = await host.call('getConfigFields')
  assert.equal(afterFailure.find(field => field.id === 'host').id, 'host')
  await host.call('updateConfigAndLabel', { config: { host: '' }, label: 'SQ test' })
  await host.call('destroy')
})

test('Companion config updates and destroy do not wait for an in-flight SQ handshake', async t => {
  const host = startModule(t)
  await host.waitFor(message => message.name === 'register')
  await host.call('init', { config: { host: '' }, label: 'SQ test', isFirstInit: false, lastUpgradeIndex: -1 })
  await host.call('updateConfigAndLabel', { config: { host: '127.0.0.1' }, label: 'SQ test' })
  await host.waitFor(message => message.testEvent === 'handshake-started')
  assert.equal(host.messages.some(message => message.testEvent === 'transport-closed'), false)
  await host.call('destroy')
  await host.waitFor(message => message.testEvent === 'transport-closed')
  assert.equal(host.child.exitCode, null)
})

test('physical mappings publish unknowns, accept variables offline, persist and restore', async t => {
  const host = startModule(t)
  await host.waitFor(message=>message.name==='register')
  await host.call('init', { config: { host: '' }, label: 'SQ test', isFirstInit: false, lastUpgradeIndex: -1 })
  const { fields } = await host.call('getConfigFields')
  assert.equal(fields.filter(field=>field.id.startsWith('physical')).length,48)
  assert.equal(fields.find(field=>field.id==='physical3').label,'CH3 LOCAL socket (blank = unknown)')
  assert.equal(host.variables().InputName3,'CH3')
  assert.equal(host.variables().MDInputName1,'CH3')
  for(let ch=1;ch<=48;ch++) assert.equal(host.variables()[`InputPhysical${ch}`],'')
  assert.equal(host.variables().MDPhysicalInput1,'')
  await host.action('set_physical_input',{channel:'$(custom:Vocal)',source:'$(custom:Socket)'})
  assert.equal(host.variables().InputPhysical3,9)
  assert.equal(host.variables().MDSource1,9)
  assert.equal(host.variables().MDPhysicalInput1,'')
  assert.equal(host.savedConfig().physical3,9)
  const restored = startModule(t)
  await restored.waitFor(message=>message.name==='register')
  await restored.call('init', { config: host.savedConfig(), label: 'SQ restored', isFirstInit: false, lastUpgradeIndex: -1 })
  assert.equal(restored.variables().InputPhysical3,9)
  assert.equal(restored.variables().MDSource1,9)
  await host.action('set_physical_input',{channel:'3',source:''})
  assert.equal(host.variables().InputPhysical3,'')
  assert.equal(host.variables().MDSource1,'')
  assert.equal(host.savedConfig().physical3,'')
  assert.equal(host.messages.some(message=>message.testEvent==='patch'),false)
  await host.call('updateConfigAndLabel',{config:{...host.savedConfig(),physical2:'8'},label:'SQ test'})
  assert.equal(host.variables().InputPhysical2,8)
  assert.equal(host.variables().MDSource2,8)
  await host.call('destroy')
  await restored.call('destroy')
})

test('offline combined selections update independent MD feedback without recording or sending a patch', async t => {
  const host=startModule(t)
  await host.waitFor(message=>message.name==='register')
  await host.call('init',{config:{host:'',physical47:'9',physical48:'8'},label:'SQ test',isFirstInit:false,lastUpgradeIndex:-1})
  for(const channel of [2,3,4,5,10]) {
    await host.action('assign_input_and_patch',{md:'1',channel:String(channel),source:''})
    assert.equal(host.variables().MDInput1,channel)
    assert.equal(host.variables().MDInput2,2)
    assert.match(host.variables().last_action,/PATCH NOT SENT/)
  }
  await host.action('assign_input_and_patch',{md:'2',channel:'10',source:''})
  assert.equal(host.variables().MDInput1,10)
  assert.equal(host.variables().MDInput2,10)
  assert.equal(host.variables().MDPhysicalInput1,9)
  assert.equal(host.variables().MDPhysicalInput2,8)
  await host.action('assign_input_and_patch',{md:'1',channel:'49',source:''})
  assert.equal(host.variables().MDInput1,10)
  await host.action('assign_input_and_patch',{md:'1',channel:'47',source:''})
  assert.match(host.variables().last_action,/differ/)
  assert.equal(host.variables().MDInput1,10)
  assert.equal(host.messages.some(message=>message.testEvent==='patch'||message.testEvent==='mute'),false)
  await host.call('destroy')
})

test('only MD talk channels are patched; mapping edits and logical pedal mutes never patch vocals', async t => {
  const host = startModule(t,true)
  await host.waitFor(message=>message.name==='register')
  await host.call('init', { config: { host: '127.0.0.1' }, label: 'SQ test', isFirstInit: false, lastUpgradeIndex: -1 })
  await host.waitFor(message=>message.name==='setVariableValues' && JSON.parse(message.payload).newValues.some(v=>v.id==='connection_status' && v.value==='Connected'))
  await host.action('assign_input_and_patch',{md:'1',channel:'3',source:''})
  assert.match(host.variables().last_action,/physical input unknown/)
  assert.equal(host.messages.some(message=>message.testEvent==='patch'),false)
  await host.action('set_physical_input',{channel:'3',source:'9'})
  await host.action('set_physical_input',{channel:'2',source:'8'})
  await host.action('set_physical_input',{channel:'47',source:'7'})
  assert.equal(host.messages.some(message=>message.testEvent==='patch'),false)
  await host.action('assign_input_and_patch',{md:'1',channel:'3',source:''})
  await host.action('patch',{md:'2',source:''})
  assert.equal(host.variables().MDPhysicalInput1,9)
  assert.equal(host.variables().MDPhysicalInput2,8)
  assert.equal(host.savedConfig().physical47,9)
  assert.equal(host.savedConfig().physical48,8)
  await host.action('pedal_down',{md:'1'})
  await host.action('set_physical_input',{channel:'3',source:'10'})
  assert.match(host.variables().last_action,/held/)
  assert.equal(host.variables().InputPhysical3,9)
  await host.action('pedal_up',{md:'1'})
  assert.deepEqual(host.messages.filter(message=>message.testEvent==='mute').map(({channel,on})=>[channel,on]),
    [[3,true],[47,false],[47,true],[3,false]])
  assert.deepEqual(host.messages.filter(message=>message.testEvent==='patch').map(({source,socket,destination})=>[source,socket,destination]),
    [[1,8,46],[1,7,47]])
  await host.action('assign_input',{md:'1',channel:'2'})
  assert.equal(host.variables().MDSource1,8)
  assert.equal(host.variables().MDPhysicalInput1,9)
  await host.action('assign_output',{md:'1',channel:'46'})
  assert.equal(host.variables().MDPhysicalInput1,'')
  assert.equal(host.messages.filter(message=>message.testEvent==='patch').length,2)
  await host.call('destroy')
})

test('board labels update configuration, action choices and button variables without changing channel identities', async t => {
  const host=startModule(t,true)
  await host.waitFor(message=>message.name==='register')
  await host.call('init',{config:{host:'127.0.0.1',physical3:'9'},label:'SQ test',isFirstInit:false,lastUpgradeIndex:-1})
  await host.waitFor(message=>message.name==='setVariableValues' && JSON.parse(message.payload).newValues.some(v=>v.id==='InputName3' && v.value==='V_Lead'))
  const {fields}=await host.call('getConfigFields')
  assert.equal(fields.find(field=>field.id==='physical3').label,'V_Lead (CH3) LOCAL socket (blank = unknown)')
  const initialChoices=fields.find(field=>field.id==='input1').choices
  assert.deepEqual(initialChoices.find(choice=>choice.id===3),{id:3,label:'V_Lead (CH3)'})
  assert.deepEqual(initialChoices.find(choice=>choice.id===2),{id:2,label:'V_Lead (CH2)'})
  assert.equal(host.variables().MDInputName1,'V_Lead')
  assert.equal(host.variables().MDOutputName1,'MD_One')
  function channelField(actionId) {
    const message=host.messages.filter(message=>message.name==='setActionDefinitions').at(-1)
    return JSON.parse(message.payload).actions.find(action=>action.id===actionId).options.find(option=>option.id==='channel')
  }
  for(const actionId of ['set_physical_input','assign_input','assign_input_and_patch','assign_output','set_mute']) {
    const option=channelField(actionId)
    assert.equal(option.allowCustom,true)
    assert.deepEqual(option.choices.find(choice=>choice.id==='3'),{id:'3',label:'V_Lead (CH3)'})
  }
  host.child.send({testRename:{channel:3,name:'LeadNew'}})
  await host.waitFor(message=>message.name==='setVariableValues' && JSON.parse(message.payload).newValues.some(v=>v.id==='InputName3' && v.value==='LeadNew'))
  assert.equal(host.variables().MDInput1,3)
  assert.equal(host.variables().MDInputName1,'LeadNew')
  assert.equal(host.variables().InputPhysical3,9)
  assert.equal(channelField('assign_input').choices.find(choice=>choice.id==='3').label,'LeadNew (CH3)')
  await host.action('assign_input_and_patch',{md:'1',channel:'$(custom:Vocal)',source:''})
  assert.deepEqual(host.messages.filter(message=>message.testEvent==='patch').map(({socket,destination})=>[socket,destination]),[[8,46]])
  const beforeBlankName=host.messages.length
  host.child.send({testRename:{channel:3,name:'   '}})
  await host.waitFor(message=>host.messages.indexOf(message)>=beforeBlankName && message.name==='setVariableValues' && JSON.parse(message.payload).newValues.some(v=>v.id==='InputName3' && v.value==='CH3'))
  assert.equal(channelField('assign_input').choices.find(choice=>choice.id==='3').label,'CH3')
  await host.call('updateConfigAndLabel',{config:{...host.savedConfig(),host:''},label:'SQ test'})
  assert.equal(host.variables().InputName47,'CH47')
  assert.equal(host.variables().MDOutputName1,'CH47')
  assert.equal(host.variables().InputPhysical3,9)
  await host.call('destroy')
})
