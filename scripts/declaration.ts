/**
 * Print the `spawn` declaration a dsh composition registers: the tool description
 * and every parameter description, as the model reads them.
 *
 * The plugin resolves the running installation's host packages when it loads.
 * Set `DSH_BIN` to that installation's `lib/bin.js` for the full composition
 * (jobs + sandbox); without it the profile anchor composes the sandbox-free one.
 */
if (process.env.DSH_BIN !== undefined) process.argv[1] = process.env.DSH_BIN

const mod: any = await import(new URL('../dist/index.js', import.meta.url).href)

const fakeJobs = {
  start: () => 'job-1',
  kill: () => {},
  wait: async () => ({ status: 'completed' }),
  remove: () => {},
  read: () => ({ chunks: [], lossy: false, job: { output: { spillPaths: [] } } }),
}

function compose(sandboxed: boolean): { tool: any; composition: string } {
  let captured: any
  const ctx: any = {
    shell: sandboxed ? { sandboxMode: 'workspace-write' } : {},
    get: (name: string) => (name === 'jobs' ? fakeJobs : name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write' }) } : undefined),
    logger: { warn: () => {} },
    systemPrompt: { section: () => {}, getSectionOrder: () => 0 },
    tools: { register: (definition: any) => { captured = definition; return () => {} } },
    inject: (names: string[], apply: (ctx: any) => void) => {
      if (names.includes('jobs')) apply({ jobs: fakeJobs, effect: () => () => {} })
    },
  }
  mod.apply(ctx)
  if (captured === undefined) throw new Error('spawn did not register')
  return { tool: captured, composition: sandboxed ? 'jobs + sandbox' : 'sandbox-free' }
}

let composed: { tool: any; composition: string }
try {
  composed = compose(true)
} catch {
  console.error('note: the resolved host packages lack the sandbox helpers; set DSH_BIN to the running installation to see every parameter.')
  composed = compose(false)
}

const spec = composed.tool.parameters
const required: string[] = spec.required ?? []
console.log('composition: ' + composed.composition)
console.log('description: ' + composed.tool.description.length + ' chars')
console.log(composed.tool.description)
console.log('')
for (const [name, property] of Object.entries(spec.properties as Record<string, any>)) {
  const shape = property.items !== undefined ? property.type + '<' + property.items.type + '>' : property.enum !== undefined ? 'enum(' + property.enum.join('|') + ')' : property.type
  console.log('- ' + name + (required.includes(name) ? ' [required]' : '') + ' ' + shape)
  console.log('  ' + property.description)
}
