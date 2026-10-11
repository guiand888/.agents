// DRAFT -- workflow A: decompose a scope into blocks and produce ONLY the strategy questions that
// evidence cannot answer. Output feeds the inline interview, then workflow B (close-scope).
// args = { scope: {title, brief, acceptance[]}, today }
export const meta = {
  name: 'scope-decompose',
  description: 'Break a scope into parallel-safe blocks and gate strategy questions behind an evidence check (repo decisions, RE, official docs)',
  phases: [
    { title: 'Decompose', detail: 'blocks + candidate questions' },
    { title: 'Evidence gate', detail: 'three lenses answer, a verifier re-opens citations' },
  ],
}

const LENSES = [
  { key: 'repo', how: 'the repo\'s recorded decisions: ADRs (follow Superseded chains), PRDs, specs, feature matrix, CLAUDE.md, memory notes' },
  { key: 're', how: 'the reverse-engineering corpus the repo\'s CLAUDE.md names (args.reCorpus, if any) and its write-ups. Observed competitor/original behavior is PRECEDENT, not requirement: the product may deliberately differ' },
  { key: 'authority', how: 'official vendor/protocol/library documentation and established gold-standard practice, fetched, not recalled' },
]
const TYPES = ['priority', 'risk_appetite', 'external_fact', 'authorization', 'source_conflict']

// Same tool-level rule as HOUSE in close-scope.workflow.js; appended to every agent prompt below.
const HOUSE = `Non-negotiable:
- No heredocs in Bash (\`<<EOF\`, e.g. \`cat > f <<EOF\`, \`git commit -F - <<EOF\`, \`python3 - <<EOF\`): they trigger permission prompts that stall the run. Write files with the Write/Edit tools, pass commit messages with \`git commit -F <file>\` or \`-m\`, pass MR/issue text with \`-d\` (short) or write it to a file first, and run multi-line scripts from a file.`

const DECOMP = { type: 'object', required: ['blocks', 'questions'], properties: {
  blocks: { type: 'array', items: { type: 'object', required: ['id', 'title', 'goal', 'files', 'depends_on'], properties: {
    id: { type: 'string' }, title: { type: 'string' }, goal: { type: 'string' }, files: { type: 'array', items: { type: 'string' } },
    depends_on: { type: 'array', items: { type: 'string' } }, issue_refs: { type: 'array', items: { type: 'string' } },
    // 'high' = touches generated contracts, security, data integrity, concurrency, a new subsystem/schema, or an RE-worthy decision.
    // Only 'high' blocks get the full plan ceremony (grounding fan-out + codex opinion); everything else gets one planner call.
    risk: { type: 'string', enum: ['high', 'low'] } } } },
  questions: { type: 'array', items: { type: 'object', required: ['id', 'question', 'type', 'options', 'recommendation'], properties: {
    id: { type: 'string' }, question: { type: 'string' }, type: { type: 'string' },
    options: { type: 'array', items: { type: 'object', required: ['label', 'eli20', 'pros', 'cons'], properties: {
      label: { type: 'string' }, eli20: { type: 'string' }, pros: { type: 'string' }, cons: { type: 'string' } } } },
    recommendation: { type: 'string' } } } } } }
const RESEARCH = { type: 'object', required: ['determinate', 'answer', 'option_support', 'citations'], properties: {
  determinate: { type: 'boolean' }, answer: { type: 'string' },
  option_support: { type: 'array', items: { type: 'object', required: ['label', 'stance'], properties: {
    label: { type: 'string' }, stance: { type: 'string', enum: ['supported', 'contradicted', 'neutral'] } } } },
  citations: { type: 'array', items: { type: 'object', required: ['id', 'where', 'quote', 'supports'], properties: {
    id: { type: 'string' }, where: { type: 'string' }, quote: { type: 'string' }, supports: { type: 'string' } } } } } }
const VERIFY = { type: 'object', required: ['checked'], properties: { checked: { type: 'array', items: {
  type: 'object', required: ['id', 'holds'], properties: { id: { type: 'string' }, holds: { type: 'boolean' }, note: { type: 'string' } } } } } }

phase('Decompose')
const d = await agent(
  `Scope: ${JSON.stringify(args.scope)}\n` +
  'Break this into blocks that can be delivered in parallel on separate branches. Declare each block\'s files precisely; ' +
  'blocks in the same wave must have disjoint files (prove it with git ls-files/grep, do not assume). Put generated-contract changes ' +
  '(anything a generator produces, plus its source) in ONE block or serialize them via depends_on. Be opinionated about the cut.\n' +
  `Then list candidate strategy questions for the owner. A question is allowed ONLY if it has no technically correct answer: its type must be one of ${TYPES.join(', ')}. ` +
  'Each option needs an ELI20 explanation, pros, cons; give one recommendation. Do not ask anything you believe docs, RE or ADRs settle: the gate below will check.' +
  `\n\n${HOUSE}`,
  { phase: 'Decompose', label: 'decompose', model: 'sonnet', effort: 'high', schema: DECOMP })
if (!d) return { error: 'decompose failed' }

const typeless = d.questions.filter(q => !TYPES.includes(q.type))
const gated = d.questions.filter(q => TYPES.includes(q.type))

phase('Evidence gate')
const verdicts = await pipeline(gated,
  q => parallel(LENSES.map(l => () => agent(
    `Try to answer this question from evidence ONLY, through the "${l.key}" lens: search ${l.how}.\n` +
    `Question: ${q.question}\nOptions: ${q.options.map(o => o.label).join(' | ')}\n` +
    'determinate=true only if the evidence settles it. Mark each option supported/contradicted/neutral. Quote the source verbatim with its path or URL. ' +
    'Do not infer; if the source does not say it, it is neutral.' +
    `\n\n${HOUSE}`,
    { phase: 'Evidence gate', label: `${l.key}:${q.id}`, effort: 'high', schema: RESEARCH }))).then(rs => rs.filter(Boolean)),
  (rs, q) => agent(
    'Adversarial verification. Re-open EVERY citation below at its location and check it literally says what the researcher claims it supports. ' +
    `holds=false if the quote is absent, out of context, superseded by a later ADR, or only precedent (what Litmus does) offered as a requirement.\n${JSON.stringify(rs.flatMap(r => r.citations))}` +
    `\n\n${HOUSE}`,
    { phase: 'Evidence gate', label: `verify:${q.id}`, model: 'sonnet', effort: 'high', schema: VERIFY })
    .then(v => ({ q, rs, held: (v ? v.checked : []).filter(c => c.holds).map(c => c.id) })))   // array, not Set: pipeline results are serialized and a Set arrives as {}

// Decision is plain code, not an agent's call.
const ledger = [], ask = []
for (const v of verdicts.filter(Boolean)) {
  const { q, rs, held } = v
  const solid = rs.filter(r => r.citations.length && r.citations.every(c => held.includes(c.id)))
  const det = solid.find(r => r.determinate)
  if (det) { ledger.push({ id: q.id, question: q.question, decided: det.answer, citations: det.citations }); continue }
  const dead = new Map()                                             // option label -> citations that kill it
  for (const r of solid) for (const s of r.option_support) if (s.stance === 'contradicted') dead.set(s.label, r.citations)
  const keep = q.options.filter(o => !dead.has(o.label))
  const pruned = q.options.filter(o => dead.has(o.label)).map(o => ({ label: o.label, killedBy: dead.get(o.label) }))
  if (keep.length <= 1) { ledger.push({ id: q.id, question: q.question, decided: keep[0] ? keep[0].label : 'no option survives: escalate', pruned }); continue }
  const rec = keep.some(o => o.label === q.recommendation) ? q.recommendation : keep[0].label
  ask.push({ ...q, options: keep, recommendation: rec, pruned, evidence: solid.map(r => ({ answer: r.answer, citations: r.citations })) })
}
for (const q of typeless) ledger.push({ id: q.id, question: q.question, decided: `planner decides (technical, type=${q.type}); default = ${q.recommendation}`, citations: [] })

return { blocks: d.blocks, questions: ask, ledger, unverifiedDropped: gated.length - verdicts.filter(Boolean).length }
