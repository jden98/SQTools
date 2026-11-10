import { InstanceBase, InstanceStatus, Regex, runEntrypoint } from '@companion-module/base'
import { MDController, channelNumber } from './core.js'

const DEFAULTS = [{input:3,output:47},{input:2,output:48}]
const INPUT_CHANNELS = Array.from({length:48},(_,i)=>i+1)
class SQMDControl extends InstanceBase {
  constructor(internal) { super(internal); this.mixer=null;this.generation=0;this.controller=null;this.connected=false;this.channelNames=Array(48).fill('');this.nameRefreshTimer=null }
  channelName(ch) { return this.channelNames[ch-1] || `CH${ch}` }
  channelLabel(ch) { return this.channelNames[ch-1] ? `${this.channelNames[ch-1]} (CH${ch})` : `CH${ch}` }
  channelChoices() { return INPUT_CHANNELS.map(ch=>({id:String(ch),label:this.channelLabel(ch)})) }
  channelOption(label, defaultChannel) { return {type:'dropdown',id:'channel',label,default:String(defaultChannel),choices:this.channelChoices(),allowCustom:true,minChoicesForSearch:0,tooltip:'Select a channel by board label, or enter a channel number / Companion variable as a custom value.'} }
  refreshChannelNames() {
    clearTimeout(this.nameRefreshTimer);this.nameRefreshTimer=null
    this.setActionDefinitions(this.actions())
    this.publish('Channel labels updated')
  }
  getConfigFields() { return [
    {type:'textinput',id:'host',label:'SQ console IP',width:8,default:'192.168.0.5',regex:Regex.IP},
    ...[1,2].flatMap(md=>[
      {type:'dropdown',id:`input${md}`,label:`Initial MDInput${md}`,width:3,default:DEFAULTS[md-1].input,choices:this.channelChoices().map(choice=>({...choice,id:Number(choice.id)}))},
      {type:'dropdown',id:`output${md}`,label:`Initial MDOutput${md}`,width:3,default:DEFAULTS[md-1].output,choices:this.channelChoices().map(choice=>({...choice,id:Number(choice.id)}))},
    ]),
    ...INPUT_CHANNELS.map(ch=>({type:'textinput',id:`physical${ch}`,label:`${this.channelLabel(ch)} LOCAL socket (blank = unknown)`,width:3,default:'',regex:'/^(?:[1-9]|[1-3][0-9]|4[0-8])?$/' })),
  ] }
  async init(config) {
    this.config=config
    this.setVariableDefinitions([
      ...['MDInput1','MDOutput1','MDInput2','MDOutput2'].map(id=>({variableId:id,name:id})),
      {variableId:'MD1Active',name:'MD1 pedal active (0/1)'},
      {variableId:'MD2Active',name:'MD2 pedal active (0/1)'},
      {variableId:'last_action',name:'Last MD action'},
      {variableId:'connection_status',name:'Connection status'},
      ...INPUT_CHANNELS.map(ch=>({variableId:`InputPhysical${ch}`,name:`CH${ch} mapped LOCAL socket (blank = unknown)`})),
      ...INPUT_CHANNELS.map(ch=>({variableId:`InputName${ch}`,name:`CH${ch} board name (CH${ch} until received)`})),
      ...[1,2].flatMap(md=>[
        {variableId:`MDSource${md}`,name:`MD${md} selected vocal LOCAL socket (blank = unknown)`},
        {variableId:`MDPhysicalInput${md}`,name:`MD${md} talk channel LOCAL socket (configured/last sent; blank = unknown)`},
        {variableId:`MDInputName${md}`,name:`MD${md} selected vocal board name`},
        {variableId:`MDOutputName${md}`,name:`MD${md} talk channel board name`},
      ]),
    ])
    this.controller = new MDController(this.adapter(), [
      {input:config.input1 ?? DEFAULTS[0].input,output:config.output1 ?? DEFAULTS[0].output},
      {input:config.input2 ?? DEFAULTS[1].input,output:config.output2 ?? DEFAULTS[1].output},
    ], this.physicalMappings(config))
    this.setActionDefinitions(this.actions())
    this.publish('Initialized')
    void this.openConnection()
  }
  adapter() { return {
    readMute: (ch)=>this.requireConnection().inputs[ch-1].muted,
    setMute: (ch,on)=>this.requireConnection().inputs[ch-1].setMute(on),
    patchLocal: (source,dest)=>this.requireConnection().setInputPatch(0x01,source-1,dest-1),
  } }
  requireConnection() { if(!this.connected || !this.mixer?.connected) throw new Error('SQ native connection not ready'); return this.mixer }
  physicalMappings(config) { return INPUT_CHANNELS.map(ch=>config[`physical${ch}`]??null) }
  savePhysicalMappings() {
    this.config = {...this.config,...Object.fromEntries(INPUT_CHANNELS.map(ch=>[`physical${ch}`,this.controller.getPhysicalInput(ch)??'']))}
    this.saveConfig(this.config)
  }
  publish(last) {
    if(!this.controller) return
    const a=this.controller.get(1),b=this.controller.get(2)
    this.setVariableValues({...Object.fromEntries(INPUT_CHANNELS.map(ch=>[`InputPhysical${ch}`,this.controller.getPhysicalInput(ch)??''])),
      ...Object.fromEntries(INPUT_CHANNELS.map(ch=>[`InputName${ch}`,this.channelName(ch)])),
      MDInputName1:this.channelName(a.input),MDInputName2:this.channelName(b.input),
      MDOutputName1:this.channelName(a.output),MDOutputName2:this.channelName(b.output),
      MDSource1:this.controller.getPhysicalInput(a.input)??'',MDSource2:this.controller.getPhysicalInput(b.input)??'',
      MDPhysicalInput1:this.controller.getPhysicalInput(a.output)??'',MDPhysicalInput2:this.controller.getPhysicalInput(b.output)??'',
      MDInput1:a.input,MDOutput1:a.output,MDInput2:b.input,MDOutput2:b.output,
      MD1Active:a.active?1:0,MD2Active:b.active?1:0,
      last_action:last,connection_status:this.connected?'Connected':'Disconnected'})
  }
  async resolve(value) { const expanded=await this.parseVariablesInString(String(value));return channelNumber(expanded) }
  async invoke(name,fn) {try {const msg=await fn();this.publish(`${name}: ${msg||'OK'}`);this.log('info',`${name}: ${msg||'OK'}`)}catch(e){this.publish(`ERROR ${name}: ${e.message}`);this.log('error',`${name}: ${e.stack||e}`)}}
  actions() {
    const mdChoices=[{id:'1',label:'MD1'},{id:'2',label:'MD2'}]
    const mdOption={type:'dropdown',id:'md',label:'MD',default:'1',choices:mdChoices}
    return {
      set_physical_input: {name:'Set processing channel LOCAL physical input mapping',options:[
        this.channelOption('Processing channel',3),
        {type:'textinput',id:'source',label:'LOCAL socket (blank = clear mapping; number or variable)',default:'',useVariables:true}],
        callback: async ev=>this.invoke('Set physical input',async()=>{
          const ch=await this.resolve(ev.options.channel)
          const raw=await this.parseVariablesInString(String(ev.options.source??''))
          const source=raw.trim()?channelNumber(raw,'LOCAL source'):null
          this.controller.setPhysicalInput(ch,source)
          this.savePhysicalMappings()
          return `CH${ch} LOCAL source ${source??'unknown'} (mapping only; no console patch sent)`
        })},
      assign_input: {name:'Set MD input processing channel',options:[mdOption,
        this.channelOption('Vocal input processing channel',3)],
        callback: async ev=>this.invoke('Assign input',async()=>{const ch=await this.resolve(ev.options.channel);const m=this.controller.assign(ev.options.md,'input',ch);return `MD${ev.options.md} input CH${m.input}`})},
      assign_input_and_patch: {name:'Assign MD input AND patch LOCAL source (one action)',options:[mdOption,
        this.channelOption('Vocal input processing channel',3),
        {type:'textinput',id:'source',label:'LOCAL source socket (blank = stored vocal mapping)',default:'',useVariables:true}],
        callback: async ev=>this.invoke('Assign and patch',async()=>{
          const ch=await this.resolve(ev.options.channel)
          const raw=String(ev.options.source??'').trim()
          const source=raw?await this.resolve(raw):null
          if(!this.connected || !this.mixer?.connected) {
            const m=this.controller.get(ev.options.md)
            if(ch===m.output)throw new Error('Vocal and talk channels must differ')
            this.controller.assign(ev.options.md,'input',ch)
            const message=`MD${ev.options.md} selected ${this.channelLabel(ch)}; PATCH NOT SENT: SQ disconnected. Select again or run Patch after connecting.`
            this.log('warn',message)
            return message
          }
          const result=this.controller.assignInputAndPatch(ev.options.md,ch,source)
          this.savePhysicalMappings()
          return `MD${ev.options.md} input CH${result.input}; LOCAL ${result.source} -> CH${result.output} (sent; verify on SQ)`
        })},
      assign_output: {name:'Set MD talk processing channel',options:[mdOption,
        this.channelOption('MD talk processing channel',47)],
        callback: async ev=>this.invoke('Assign output',async()=>{const ch=await this.resolve(ev.options.channel);const m=this.controller.assign(ev.options.md,'output',ch);return `MD${ev.options.md} talk CH${m.output}`})},
      patch: {name:'Patch LOCAL source to assigned MD talk channel',options:[mdOption,
        {type:'textinput',id:'source',label:'LOCAL socket (blank = stored vocal mapping)',default:'',useVariables:true}],
        callback: async ev=>this.invoke('Patch',async()=>{const raw=String(ev.options.source??'').trim();const source=raw?await this.resolve(raw):null;const p=this.controller.patch(ev.options.md,source);this.savePhysicalMappings();return `LOCAL ${p.source} -> CH${p.output} (sent; no readback)`})},
      pedal_down: {name:'MD pedal DOWN (snapshot vocal mute; mute vocal; open talk)',options:[mdOption],
        callback: async ev=>this.invoke('Pedal down',()=>{const changed=this.controller.down(ev.options.md);return changed?`MD${ev.options.md} down`:'Already down'})},
      pedal_press: {name:'MD pedal PRESS (activate; release if already active)',options:[mdOption],
        callback: async ev=>this.invoke('Pedal press',()=>`MD${ev.options.md} ${this.controller.press(ev.options.md)}`)},
      pedal_up: {name:'MD pedal UP (close talk; restore prior vocal mute)',options:[mdOption],
        callback: async ev=>this.invoke('Pedal up',()=>{const changed=this.controller.up(ev.options.md);return changed?`MD${ev.options.md} up`:'Already up'})},
      set_mute: {name:'Set arbitrary SQ input mute (variable-capable)',options:[
        this.channelOption('Input processing channel',47),
        {type:'dropdown',id:'mute',label:'Mute',default:'1',choices:[{id:'1',label:'Mute'},{id:'0',label:'Unmute'}]}],
        callback: async ev=>this.invoke('Set mute',async()=>{const ch=await this.resolve(ev.options.channel);this.requireConnection().inputs[ch-1].setMute(ev.options.mute==='1');return `CH${ch} mute=${ev.options.mute}`})},
    }
  }
  async configUpdated(config) {
    try { this.controller.setPhysicalInputs(this.physicalMappings(config)) }
    catch(e) { this.publish(`ERROR configuration: ${e.message}`);this.log('error',e.message);this.savePhysicalMappings();return }
    this.config=config
    this.publish('Configuration updated')
    // Initial assignment fields are only applied on initialization; changing config while running requires a restart.
    void this.openConnection()
  }
  async openConnection() {
    const generation=++this.generation
    this.connected=false
    const old=this.mixer;this.mixer=null
    clearTimeout(this.nameRefreshTimer);this.nameRefreshTimer=null
    this.channelNames=Array(48).fill('')
    this.refreshChannelNames()
    if(old)try{old.disconnect()}catch(e){this.log('warn',`SQ disconnect: ${e.message}`)}
    if(!this.config?.host){this.updateStatus(InstanceStatus.BadConfig,'Set the SQ console IP in connection settings');this.publish('SQ console IP not configured');return}
    this.updateStatus(InstanceStatus.Connecting)
    this.publish('Connecting')
    try {
      const {SQMixer}=await import('@allen-heath-sq-tools/api')
      if(generation!==this.generation)return
      const mixer=new SQMixer({host:this.config.host,model:'SQ6'})
      this.mixer=mixer
      for(const ch of INPUT_CHANNELS) {
        mixer.inputs[ch-1].on('name',name=>{
          if(generation!==this.generation || this.mixer!==mixer)return
          const label=name.trim()
          if(this.channelNames[ch-1]===label)return
          this.channelNames[ch-1]=label
          if(!this.nameRefreshTimer)this.nameRefreshTimer=setTimeout(()=>this.refreshChannelNames(),50)
        })
      }
      mixer.on('initialState',()=>{if(generation!==this.generation || this.mixer!==mixer)return;this.refreshChannelNames();this.log('info','SQ initial state received (mute states and channel names; input routing is not decoded)');if(this.connected)this.publish('Connected; initial mute state received')})
      mixer.on('disconnect',()=>{if(generation!==this.generation || this.mixer!==mixer)return;this.connected=false;this.controller.resetAfterReconnect();this.updateStatus(InstanceStatus.ConnectionFailure);this.publish('Disconnected; pedal state discarded')})
      mixer.on('error',e=>{if(generation===this.generation && this.mixer===mixer)this.log('warn',`SQ transport: ${e.message}`)})
      await mixer.connect()
      if(generation!==this.generation){mixer.disconnect();return}
      this.connected=true
      this.controller.resetAfterReconnect()
      this.updateStatus(InstanceStatus.Ok)
      this.publish('Connected; wait for mute-state feedback before pedal DOWN')
    } catch(e){
      if(generation!==this.generation)return
      this.connected=false
      this.updateStatus(InstanceStatus.ConnectionFailure,e.message)
      this.publish(`Connection error: ${e.message}`)
      this.log('error',String(e))
      const failed=this.mixer;this.mixer=null
      if(failed)try{failed.disconnect()}catch(err){this.log('warn',`SQ disconnect: ${err.message}`)}
    }
  }
  async destroy() {++this.generation;this.connected=false;clearTimeout(this.nameRefreshTimer);this.nameRefreshTimer=null;if(this.mixer)try{this.mixer.disconnect()}catch(e){this.log('warn',`SQ disconnect: ${e.message}`)};this.mixer=null}
}
runEntrypoint(SQMDControl,[])
