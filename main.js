import { InstanceBase, InstanceStatus, Regex, runEntrypoint } from '@companion-module/base'
import { MDController, channelNumber } from './core.js'

const DEFAULTS = [{input:3,output:47},{input:2,output:48}]
class SQMDControl extends InstanceBase {
  constructor(internal) { super(internal); this.mixer=null;this.generation=0;this.controller=null;this.connected=false }
  getConfigFields() { return [
    {type:'textinput',id:'host',label:'SQ console IP',width:8,default:'192.168.0.5',regex:Regex.IP},
    {type:'number',id:'input1',label:'Initial MDInput1',width:3,min:1,max:48,default:3},
    {type:'number',id:'output1',label:'Initial MDOutput1',width:3,min:1,max:48,default:47},
    {type:'number',id:'input2',label:'Initial MDInput2',width:3,min:1,max:48,default:2},
    {type:'number',id:'output2',label:'Initial MDOutput2',width:3,min:1,max:48,default:48},
  ] }
  async init(config) {
    this.config=config
    this.setVariableDefinitions([
      ...['MDInput1','MDOutput1','MDInput2','MDOutput2'].map(id=>({variableId:id,name:id})),
      {variableId:'MD1Active',name:'MD1 pedal active (0/1)'},
      {variableId:'MD2Active',name:'MD2 pedal active (0/1)'},
      {variableId:'last_action',name:'Last MD action'},
      {variableId:'connection_status',name:'Connection status'},
    ])
    this.controller = new MDController(this.adapter(), [
      {input:config.input1 ?? DEFAULTS[0].input,output:config.output1 ?? DEFAULTS[0].output},
      {input:config.input2 ?? DEFAULTS[1].input,output:config.output2 ?? DEFAULTS[1].output},
    ])
    this.setActionDefinitions(this.actions())
    this.publish('Initialized')
    await this.openConnection()
  }
  adapter() { return {
    readMute: (ch)=>this.requireConnection().inputs[ch-1].muted,
    setMute: (ch,on)=>this.requireConnection().inputs[ch-1].setMute(on),
    patchLocal: (source,dest)=>this.requireConnection().setInputPatch(0x01,source-1,dest-1),
  } }
  requireConnection() { if(!this.connected || !this.mixer?.connected) throw new Error('SQ native connection not ready'); return this.mixer }
  publish(last) {
    if(!this.controller) return
    const a=this.controller.get(1),b=this.controller.get(2)
    this.setVariableValues({MDInput1:a.input,MDOutput1:a.output,MDInput2:b.input,MDOutput2:b.output,
      MD1Active:a.active?1:0,MD2Active:b.active?1:0,
      last_action:last,connection_status:this.connected?'Connected':'Disconnected'})
  }
  async resolve(value) { const expanded=await this.parseVariablesInString(String(value));return channelNumber(expanded) }
  async invoke(name,fn) {try {const msg=await fn();this.publish(`${name}: ${msg||'OK'}`);this.log('info',`${name}: ${msg||'OK'}`)}catch(e){this.publish(`ERROR ${name}: ${e.message}`);this.log('error',`${name}: ${e.stack||e}`)}}
  actions() {
    const mdChoices=[{id:'1',label:'MD1'},{id:'2',label:'MD2'}]
    const mdOption={type:'dropdown',id:'md',label:'MD',default:'1',choices:mdChoices}
    return {
      assign_input: {name:'Set MD input processing channel',options:[mdOption,
        {type:'textinput',id:'channel',label:'Input CH (number or Companion variable)',default:'3',useVariables:true}],
        callback: async ev=>this.invoke('Assign input',async()=>{const ch=await this.resolve(ev.options.channel);const m=this.controller.assign(ev.options.md,'input',ch);return `MD${ev.options.md} input CH${m.input}`})},
      assign_input_and_patch: {name:'Assign MD input AND patch LOCAL source (one action)',options:[mdOption,
        {type:'textinput',id:'channel',label:'Vocal input processing CH (1–48 or variable)',default:'3',useVariables:true},
        {type:'textinput',id:'source',label:'LOCAL source socket (blank = vocal CH)',default:'',useVariables:true}],
        callback: async ev=>this.invoke('Assign and patch',async()=>{
          this.requireConnection()
          const ch=await this.resolve(ev.options.channel)
          const raw=String(ev.options.source??'').trim()
          const source=raw?await this.resolve(raw):null
          const result=this.controller.assignInputAndPatch(ev.options.md,ch,source)
          return `MD${ev.options.md} input CH${result.input}; LOCAL ${result.source} -> CH${result.output} (sent; verify on SQ)`
        })},
      assign_output: {name:'Set MD talk processing channel',options:[mdOption,
        {type:'textinput',id:'channel',label:'Talk CH (number or Companion variable)',default:'47',useVariables:true}],
        callback: async ev=>this.invoke('Assign output',async()=>{const ch=await this.resolve(ev.options.channel);const m=this.controller.assign(ev.options.md,'output',ch);return `MD${ev.options.md} talk CH${m.output}`})},
      patch: {name:'Patch LOCAL source to assigned MD talk channel',options:[mdOption,
        {type:'textinput',id:'source',label:'LOCAL socket (blank = MDInput number)',default:'',useVariables:true}],
        callback: async ev=>this.invoke('Patch',async()=>{const raw=String(ev.options.source??'').trim();const source=raw?await this.resolve(raw):null;const p=this.controller.patch(ev.options.md,source);return `LOCAL ${p.source} -> CH${p.output} (sent; no readback)`})},
      pedal_down: {name:'MD pedal DOWN (snapshot vocal mute; mute vocal; open talk)',options:[mdOption],
        callback: async ev=>this.invoke('Pedal down',()=>{const changed=this.controller.down(ev.options.md);return changed?`MD${ev.options.md} down`:'Already down'})},
      pedal_up: {name:'MD pedal UP (close talk; restore prior vocal mute)',options:[mdOption],
        callback: async ev=>this.invoke('Pedal up',()=>{const changed=this.controller.up(ev.options.md);return changed?`MD${ev.options.md} up`:'Already up'})},
      set_mute: {name:'Set arbitrary SQ input mute (variable-capable)',options:[
        {type:'textinput',id:'channel',label:'Input CH (1–48 or variable)',default:'47',useVariables:true},
        {type:'dropdown',id:'mute',label:'Mute',default:'1',choices:[{id:'1',label:'Mute'},{id:'0',label:'Unmute'}]}],
        callback: async ev=>this.invoke('Set mute',async()=>{const ch=await this.resolve(ev.options.channel);this.requireConnection().inputs[ch-1].setMute(ev.options.mute==='1');return `CH${ch} mute=${ev.options.mute}`})},
    }
  }
  async configUpdated(config) {
    this.config=config
    // Initial assignment fields are only applied on initialization; changing config while running requires a restart.
    await this.openConnection()
  }
  async openConnection() {
    const generation=++this.generation
    this.connected=false
    const old=this.mixer;this.mixer=null
    if(old)try{old.disconnect()}catch{}
    if(!this.config?.host){this.updateStatus(InstanceStatus.BadConfig);return}
    this.updateStatus(InstanceStatus.Connecting)
    this.publish('Connecting')
    try {
      const {SQMixer}=await import('@allen-heath-sq-tools/api')
      if(generation!==this.generation)return
      const mixer=new SQMixer({host:this.config.host,model:'SQ6'})
      this.mixer=mixer
      mixer.on('disconnect',()=>{if(generation!==this.generation)return;this.connected=false;this.controller.resetAfterReconnect();this.updateStatus(InstanceStatus.ConnectionFailure);this.publish('Disconnected; pedal state discarded')})
      mixer.on('error',e=>{if(generation===this.generation)this.log('warn',`SQ transport: ${e.message}`)})
      await mixer.connect()
      if(generation!==this.generation){mixer.disconnect();return}
      this.connected=true
      this.controller.resetAfterReconnect()
      this.updateStatus(InstanceStatus.Ok)
      this.publish('Connected; wait for mute-state feedback before pedal DOWN')
    } catch(e){if(generation!==this.generation)return;this.connected=false;this.updateStatus(InstanceStatus.ConnectionFailure);this.publish(`Connection error: ${e.message}`);this.log('error',String(e))}
  }
  async destroy() {++this.generation;this.connected=false;if(this.mixer)try{this.mixer.disconnect()}catch{};this.mixer=null}
}
runEntrypoint(SQMDControl,[])
