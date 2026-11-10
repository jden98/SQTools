/** Testable MD state machine. Channels are one-based SQ processing channel numbers. */
export function channelNumber(value, label = 'channel') {
  const text = String(value).trim()
  if (!/^[0-9]+$/.test(text)) throw new Error(`${label}: expected integer 1–48, got ${value}`)
  const n = Number(text)
  if (!Number.isInteger(n) || n < 1 || n > 48) throw new Error(`${label}: expected 1–48, got ${value}`)
  return n
}
export function mdNumber(value) {
  const n = Number(value)
  if (n !== 1 && n !== 2) throw new Error('MD must be 1 or 2')
  return n
}
export class MDController {
  constructor(adapter, initial = [{input:3,output:47},{input:2,output:48}], physicalInputs = Array(48).fill(null)) {
    this.adapter = adapter
    this.md = initial.map(x=>({ input: channelNumber(x.input), output: channelNumber(x.output), active:false, wasMuted:null }))
    this.physicalInputs = Array(48).fill(null)
    this.setPhysicalInputs(physicalInputs)
  }
  getPhysicalInput(channel) { return this.physicalInputs[channelNumber(channel)-1] }
  setPhysicalInputs(values) {
    if (!Array.isArray(values) || values.length !== 48) throw new Error('Expected physical mappings for all 48 input channels')
    const next = values.map(value=>value===null || value===undefined || String(value).trim()==='' ? null : channelNumber(value,'LOCAL source'))
    for (let i=0;i<48;i++) {
      if (next[i]!==this.physicalInputs[i]) this.requireMappingEditable(i+1)
    }
    this.physicalInputs = next
  }
  requireMappingEditable(channel) {
    if (this.md.some(m=>m.active && (m.input===channel || m.output===channel))) throw new Error(`CH${channel} is in use by a held MD pedal; release before changing its physical mapping`)
  }
  setPhysicalInput(channel, sourceSocket) {
    const ch = channelNumber(channel)
    const source = sourceSocket===null ? null : channelNumber(sourceSocket,'LOCAL source')
    this.requireMappingEditable(ch)
    this.physicalInputs[ch-1] = source
    return source
  }
  sourceFor(input, sourceSocket) {
    const source = sourceSocket===null ? this.getPhysicalInput(input) : channelNumber(sourceSocket,'LOCAL source')
    if (source===null) throw new Error(`CH${input} physical input unknown; set its LOCAL mapping or enter an explicit source socket`)
    return source
  }
  assign(which, field, value) {
    const idx = mdNumber(which)-1, n=channelNumber(value, field)
    if (field !== 'input' && field !== 'output') throw new Error('field must be input or output')
    if (this.md[idx].active) throw new Error(`MD${which} pedal is held; release before changing assignment`)
    this.md[idx][field] = n
    return {...this.md[idx]}
  }
  get(which) { return {...this.md[mdNumber(which)-1]} }
  patch(which, sourceSocket = null) {
    const m=this.md[mdNumber(which)-1]
    if (m.active) throw new Error('Cannot repatch while pedal is held')
    if (m.input===m.output) throw new Error('Vocal and talk channels must differ')
    this.requireMappingEditable(m.output)
    const source=this.sourceFor(m.input,sourceSocket)
    this.adapter.patchLocal(source,m.output)
    this.physicalInputs[m.output-1] = source
    return {source,output:m.output}
  }
  assignInputAndPatch(which, inputChannel, sourceSocket = null) {
    const idx = mdNumber(which)-1
    const m = this.md[idx]
    if (m.active) throw new Error(`MD${which} pedal is held; release before changing assignment`)
    const input = channelNumber(inputChannel, 'input channel')
    const source = this.sourceFor(input, sourceSocket)
    if (input === m.output) throw new Error('Vocal and talk channels must differ')
    this.requireMappingEditable(m.output)
    // Only commit the new assignment after the patch command has been issued successfully.
    // The SQ protocol does not acknowledge application of the patch: verify on the console.
    this.adapter.patchLocal(source, m.output)
    m.input = input
    this.physicalInputs[m.output-1] = source
    return {input, source, output:m.output}
  }
  press(which) {
    if (this.get(which).active) {
      this.up(which)
      return 'released'
    }
    this.down(which)
    return 'activated'
  }
  down(which) {
    const m=this.md[mdNumber(which)-1]
    if (m.active) return false
    if (m.input===m.output) throw new Error('Vocal and talk channels must differ')
    if (this.md.some((other)=>other!==m && other.active && (other.input===m.input || other.output===m.output))) throw new Error('Channel is in use by the other MD')
    const was=this.adapter.readMute(m.input)
    if (typeof was !== 'boolean') throw new Error(`CH${m.input} mute state unknown; refusing pedal down`)
    // Mark active before sending commands, so retry won't capture our own mute.
    m.active=true; m.wasMuted=was
    try {
      this.adapter.setMute(m.input,true)
      this.adapter.setMute(m.output,false)
      return true
    } catch(err) {
      // Attempt to silence talk path; do not unmute vocal after an uncertain failure.
      try { this.adapter.setMute(m.output,true) } catch {}
      throw err
    }
  }
  up(which) {
    const m=this.md[mdNumber(which)-1]
    // Always silence talk on an Up event, including duplicate Up events.
    this.adapter.setMute(m.output,true)
    if (!m.active) return false
    // Only unmute if the vocal was known to be unmuted before pressing.
    if (m.wasMuted === false) this.adapter.setMute(m.input,false)
    m.active=false; m.wasMuted=null
    return true
  }
  resetAfterReconnect() {
    // Unknown mixer state after a network failure. Don't automatically unmute vocals.
    for(const m of this.md) {m.active=false;m.wasMuted=null}
  }
}
