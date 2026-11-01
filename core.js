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
  constructor(adapter, initial = [{input:3,output:47},{input:2,output:48}]) {
    this.adapter = adapter
    this.md = initial.map(x=>({ input: channelNumber(x.input), output: channelNumber(x.output), active:false, wasMuted:null }))
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
    const source=sourceSocket===null ? m.input : channelNumber(sourceSocket,'LOCAL source')
    this.adapter.patchLocal(source,m.output)
    return {source,output:m.output}
  }
  assignInputAndPatch(which, inputChannel, sourceSocket = null) {
    const idx = mdNumber(which)-1
    const m = this.md[idx]
    if (m.active) throw new Error(`MD${which} pedal is held; release before changing assignment`)
    const input = channelNumber(inputChannel, 'input channel')
    const source = sourceSocket === null ? input : channelNumber(sourceSocket, 'LOCAL source')
    if (input === m.output) throw new Error('Vocal and talk channels must differ')
    // Only commit the new assignment after the patch command has been issued successfully.
    // The SQ protocol does not acknowledge application of the patch: verify on the console.
    this.adapter.patchLocal(source, m.output)
    m.input = input
    return {input, source, output:m.output}
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
