// close-scope workflow B (delivery). Workflow A (scope-decompose) + the inline interview run first; their output arrives as `args`.
// DRY-RUN STATUS: not yet run end to end. See SKILL.md.
//
// args = { runTag, repo, worktreeRoot, baseRef?: "origin/master", scope: {title, brief, acceptance[]}, epic: "#NNN",
//          branchPrefix: "mvp/<slug>", blocks: [{id,title,goal,files[],depends_on[],risk}], answers: {...}, ledger: [...],
//          mergeTiming?: "as-ready"|"end", lanes?: 5, maxReviewRounds?: 3, maxDiscoveryRounds?: 3 }
export const meta = {
  name: 'close-scope',
  description: 'Per block: planned by cross-model consensus, implemented, adversarially reviewed, MR, serial merge; then loop on discovered production bugs until the scope is dry',
  phases: [
    { title: 'Plan', detail: 'draft, ground, align, codex opinion, vibe tie-break' },
    { title: 'Implement', detail: 'sonnet high in its own worktree, mechanical gates' },
    { title: 'Review', detail: 'codex adversarial review, evaluate, tie-break, fix loop' },
    { title: 'Merge', detail: 'serial lane: sync master, gates, glab merge --sha' },
    { title: 'Triage', detail: 'dedupe, classify, promote only production-meaningful+tied' },
    { title: 'Close-out', detail: 'completeness critic against the original scope' },
  ],
}

const CODEX = '$HOME/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs'
const MODEL = 'gpt-6.1-sol'
const MIMO = 'openrouter/xiaomi/mimo-v2.6-pro'

// Tool-level lessons only. Repo rules (generated files, gates, labels, ADR process) come from the repo's CLAUDE.md, which every
// subagent already receives; do not restate them here. Keep byte-stable (resume cache).
const HOUSE = `Non-negotiable:
- Never spawn your own subagents or forks. You are a leaf.
- No heredocs in Bash (\`<<EOF\`, e.g. \`cat > f <<EOF\`, \`git commit -F - <<EOF\`, \`python3 - <<EOF\`): they trigger permission prompts that stall the run. Write files with the Write/Edit tools, pass commit messages with \`git commit -F <file>\` or \`-m\`, pass MR/issue text with \`-d\` (short) or write it to a file first, and run multi-line scripts from a file.
- Check disk (df -h on the worktree and home) before heavy runs; stop if over 85% used.
- vibe: always \`env -u LD_LIBRARY_PATH vibe -p ... < /dev/null\`; read-only use needs no --trust/--yolo; check \`git status --short\` after.
- glab: always pipe \`glab api\` through a jq select of the fields you need (raw output leaks tokens).
- Before filing any issue, search existing issues and reuse a match.
- Stage only your own hunks in shared files. Never bare \`git stash\`. Never touch other projects' files.
- Report facts you observed with the command that produced them. A self-report is not evidence.`

const PLAN = { type: 'object', required: ['summary', 'steps', 'files', 'acceptance', 'grounding'], properties: {
  summary: { type: 'string' }, needs_decision: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } },
  files: { type: 'array', items: { type: 'string' } }, acceptance: { type: 'array', items: { type: 'string' } },
  grounding: { type: 'array', items: { type: 'object', required: ['kind', 'question'], properties: {
    kind: { type: 'string', enum: ['docs', 'practice', 're'] }, question: { type: 'string' } } } } } }
const GROUND = { type: 'object', required: ['answer', 'sources', 'refused'], properties: {
  answer: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } }, refused: { type: 'boolean' } } }
const RESOLVE = { type: 'object', required: ['adopted', 'disputed', 'revised_plan_needed'], properties: {
  adopted: { type: 'array', items: { type: 'string' } },
  disputed: { type: 'array', items: { type: 'object', required: ['id', 'my_position', 'their_position'], properties: {
    id: { type: 'string' }, my_position: { type: 'string' }, their_position: { type: 'string' } } } },
  revised_plan_needed: { type: 'boolean' } } }
const VERDICTS = { type: 'object', required: ['verdicts'], properties: { verdicts: { type: 'array', items: {
  type: 'object', required: ['id', 'upheld', 'reason'], properties: {
    id: { type: 'string' }, upheld: { type: 'boolean' }, reason: { type: 'string' } } } } } }
const GATE = { type: 'object', required: ['ok', 'failing', 'out_of_scope'], properties: {
  ok: { type: 'boolean' }, failing: { type: 'array', items: { type: 'string' } },
  out_of_scope: { type: 'array', items: { type: 'string' } }, head: { type: 'string' } } }
const MR = { type: 'object', required: ['iid', 'sha', 'url'], properties: { iid: { type: 'number' }, sha: { type: 'string' }, url: { type: 'string' } } }
const MERGED = { type: 'object', required: ['merged', 'reason'], properties: { merged: { type: 'boolean' }, reason: { type: 'string' }, master_sha: { type: 'string' } } }
const TRIAGE = { type: 'object', required: ['promote', 'filed'], properties: {
  promote: { type: 'array', items: { type: 'object', required: ['id', 'title', 'goal', 'files'], properties: {
    id: { type: 'string' }, title: { type: 'string' }, goal: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } } } },
  filed: { type: 'array', items: { type: 'string' } } } }
const DONE = { type: 'object', required: ['done', 'gaps'], properties: { done: { type: 'boolean' }, gaps: { type: 'array', items: {
  type: 'object', required: ['id', 'title', 'goal', 'files'], properties: {
    id: { type: 'string' }, title: { type: 'string' }, goal: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } } } } } }

// ---- plain-JS plumbing (no agents) -----------------------------------------------------------
function limiter(n) {
  let active = 0; const q = []
  const next = () => { if (active < n && q.length) { active++; const t = q.shift(); t.fn().then(t.res, t.rej).finally(() => { active--; next() }) } }
  return fn => new Promise((res, rej) => { q.push({ fn, res, rej }); next() })
}
let mergeTail = Promise.resolve()
const serial = fn => { const r = mergeTail.then(fn); mergeTail = r.catch(() => {}); return r }

// ---- relays: cheap agents that only forward to an external CLI and fill a schema --------------
const relay = (what, cli, schema, label, phase) => agent(
  `${HOUSE}\n\nYou are a thin relay. Run exactly this and nothing else of substance, then fill the schema from its output ` +
  `(do not add your own opinions or findings):\n${cli}\n\nContext for the schema: ${what}`,
  { label, phase, effort: 'low', schema })

// Live-checked 2026-10-11: `codex task --model gpt-6.1-sol --effort high` answers (~2 min latency even for a trivial prompt, so it is
// called once per high-risk plan, never in a loop); `codex adversarial-review --model gpt-6.1-sol --base` works (~12 s) and has NO --effort
// flag (effort comes from ~/.codex/config.toml, already "high"); vibe -p reads files without --trust/--yolo (~12 s); opencode mimo-v2.6-pro works (~9 s).
// The codex plan opinion is folded into the resolver agent (no separate relay, no JSON round-trip).
const codexPlanCli = plan =>
  `node ${CODEX} task --model ${MODEL} --effort high "Challenge this implementation plan for this repo (read-only). ` +
  `These owner decisions are out of bounds unless you cite NEW contradicting evidence: ${JSON.stringify(args.answers).replace(/"/g, "'")}. ` +
  `Name every blocking objection with an id. Plan:\\n${JSON.stringify(plan).replace(/"/g, "'")}"`

// Read-only tie-break: no --trust, no --yolo (not needed for reads; CLAUDE.md requires explicit per-audit authorization for them).
const vibeTieBreak = (b, points, phase) => relay('vibe tie-break: for each disputed point decide upheld true/false with a one-line reason',
  `env -u LD_LIBRARY_PATH vibe -p "Decide each disputed point strictly on evidence in the repo at ${b.worktree || 'the block worktree'}: ` +
  `${JSON.stringify(points).replace(/"/g, "'")}" --workdir ${b.worktree || '.'} --max-turns 8 --time-limit 300 < /dev/null`, VERDICTS, `vibe-tie:${b.id}`, phase)

const reGround = async (b, q) => {
  const first = await agent(`${HOUSE}\n\nGround this in the RE corpus (${args.reCorpus || 'none configured: answer from the repo and say so'}): ${q}\n` +
    'Be opinionated. If you decline to do RE, set refused=true and nothing else.', { phase: 'Plan', label: `re:${b.id}`, effort: 'high', schema: GROUND })
  if (first && !first.refused) return first
  if (!args.reCorpus) return first || { answer: 'RE corpus not configured', sources: [], refused: true }   // nothing for vibe/opencode to search
  const viaVibe = await relay(`RE question: ${q}`, `env -u LD_LIBRARY_PATH vibe -p "RE question over ${args.reCorpus}: ${q.replace(/"/g, "'")}" --add-dir ${args.reCorpus} --max-turns 12 --time-limit 420 < /dev/null`, GROUND, `re-vibe:${b.id}`, 'Plan')
  if (viaVibe && !viaVibe.refused) return viaVibe
  return relay(`RE question: ${q}`, `opencode run --model ${MIMO} --variant high "RE question over ${args.reCorpus}: ${q.replace(/"/g, "'")}"`, GROUND, `re-mimo:${b.id}`, 'Plan')
}

// ---- one block: plan -> implement -> review -> MR (-> merge) ---------------------------------
async function planBlock(b) {
  const plan0 = await agent(`${HOUSE}\n\nPlan block ${b.id}: ${b.title}\nGoal: ${b.goal}\nDeclared files: ${b.files.join(', ')}\n` +
    `Scope brief: ${args.scope.brief}\nInterview answers (binding): ${JSON.stringify(args.answers)}\n` +
    `Decided-by-evidence ledger (binding): ${JSON.stringify(args.ledger)}\n` +
    'Answers and ledger may not be flipped by you, codex or vibe. If you find NEW verified evidence that contradicts one, ' +
    'do not plan around it: set needs_decision to the item id plus the citation.\n' +
    'Follow the planning rules in the repository CLAUDE.md (RE grounding, architectural correctness, ADR discipline). Be opinionated: pick one design, justify it. ' +
    (b.risk === 'high'
      ? 'List only grounding questions (docs / practice / re) that neither the repo nor the ledger above already answers.'
      : 'This is a low-risk block: ground yourself in the repo only and return an empty grounding list.'),
    { phase: 'Plan', label: `plan:${b.id}`, model: 'sonnet', effort: 'xhigh', schema: PLAN })
  if (!plan0) return null
  if (b.risk !== 'high' || plan0.needs_decision) return plan0                 // light tier: one planner call, review still gates the code

  // Full tier. Grounding fans out once; each answer is cited once and reused by the next two steps.
  const ground = (await parallel(plan0.grounding.slice(0, 4).map(g => () => g.kind === 're'
    ? reGround(b, g.question)
    : agent(`${HOUSE}\n\nAnswer from official docs / gold-standard practice, with cited sources, opinionated: ${g.question}`,
        { phase: 'Plan', label: `ground:${g.kind}:${b.id}`, effort: 'high', schema: GROUND })))).filter(Boolean)
  const aligned = ground.length
    ? await agent(`${HOUSE}\n\nRevise the plan for ${b.id} using this grounding, and fix any misalignment with the project's long-term ` +
        `direction (ADRs, feature matrix, PRD) in the same pass.\nPlan: ${JSON.stringify(plan0)}\nGrounding: ${JSON.stringify(ground)}`,
        { phase: 'Plan', label: `align:${b.id}`, model: 'sonnet', effort: 'xhigh', schema: PLAN })
    : plan0
  if (!aligned) return plan0
  if (aligned.needs_decision) return aligned

  // ONE codex opinion, resolved in the same agent that ran it (no relay, no re-serialization, no loop).
  const r = await agent(`${HOUSE}\n\nRun this once and read its output:\n${codexPlanCli(aligned)}\n` +
    'For each blocking objection either adopt it (fold it into revised_plan) or dispute it with evidence (list it in disputed). ' +
    `Return the revised plan.\nPlan: ${JSON.stringify(aligned)}`,
    { phase: 'Plan', label: `opinion+resolve:${b.id}`, model: 'sonnet', effort: 'xhigh',
      schema: { type: 'object', required: ['revised_plan', 'disputed'], properties: { revised_plan: PLAN, disputed: RESOLVE.properties.disputed } } })
  if (!r) return aligned
  if (!r.disputed.length) return r.revised_plan                                // consensus
  const tb = await vibeTieBreak(b, r.disputed, 'Plan')                         // third opinion, disputed points only, once
  const codexRight = (tb ? tb.verdicts : []).filter(v => v.upheld).map(v => v.id)
  if (!codexRight.length) return r.revised_plan                                // tie-break sided with the planner
  return await agent(`${HOUSE}\n\nAdopt these objections that the tie-break upheld, change nothing else: ${JSON.stringify(r.disputed.filter(d => codexRight.includes(d.id)))}\n` +
    `Plan: ${JSON.stringify(r.revised_plan)}`, { phase: 'Plan', label: `revise:${b.id}`, model: 'sonnet', effort: 'high', schema: PLAN }) || r.revised_plan
}

async function deliverBlock(b) {
  const plan = await planBlock(b)
  if (!plan) return { id: b.id, status: 'plan_failed', newIssues: [] }
  if (plan.needs_decision) return { id: b.id, status: 'parked', needs_decision: plan.needs_decision, newIssues: [] }  // reported in final batch, other blocks continue
  const branch = `${args.branchPrefix}/${b.id}`
  const base = b.base || args.baseRef || 'origin/master'
  b.worktree = `${args.worktreeRoot}/${args.runTag}-${b.id}`

  phase('Implement')
  await agent(`${HOUSE}\n\nImplement the approved plan for ${b.id} test-first, per the repo's CLAUDE.md, exactly within these files: ${plan.files.join(', ')}.\n` +
    `Create your tree with: git -C ${args.repo} worktree add -b ${branch} ${b.worktree} ${base}\n` +
    `Commit in small steps, conventional messages. Plan: ${JSON.stringify(plan)}`,
    { phase: 'Implement', label: `impl:${b.id}`, model: 'sonnet', effort: 'high' })

  // Mechanical facts, not the implementer's word: run the gates the repo's CLAUDE.md prescribes for the touched paths (package level,
  // not the full suite), and list files changed since the fork that are outside the plan's declared files.
  const gate = () => agent(`${HOUSE}\n\nIn ${b.worktree}: run the repo's gates for the paths touched since ${base} (package level, per CLAUDE.md), and ` +
    `list files changed since the fork (git diff --name-only ${base}..HEAD) that are outside ${JSON.stringify(plan.files)}. Return head=git rev-parse HEAD. Report only what the commands print.`,
    { phase: 'Implement', label: `gate:${b.id}`, effort: 'low', schema: GATE })

  // Review loop. Round 0 reviews the whole branch; later rounds review ONLY the fix diff and re-check ONLY the open blocking items.
  // A finding already seen (by id/point) is never re-litigated. Gates and review run concurrently (disjoint, both read-only).
  const EVAL = { type: 'object', required: ['findings'], properties: { findings: { type: 'array', items: { type: 'object',
    required: ['id', 'point', 'severity', 'tied_to_scope', 'verdict'], properties: {
      id: { type: 'string' }, point: { type: 'string' }, file: { type: 'string' },
      severity: { type: 'string', enum: ['production-critical', 'production-meaningful', 'polish'] },
      tied_to_scope: { type: 'boolean' }, verdict: { type: 'string', enum: ['accept', 'dispute'] }, evidence: { type: 'string' } } } } } }
  let blockedOpen = false, reviewedBase = base, open = []
  const deferred = [], seen = []
  for (let r = 0; r < args.maxReviewRounds; r++) {
    const [g, ev] = await parallel([
      () => gate(),
      () => agent(`${HOUSE}\n\nRun once and read its output:\nnode ${CODEX} adversarial-review --wait --model ${MODEL} --base ${reviewedBase} --cwd ${b.worktree} "Plan: ${plan.summary.replace(/"/g, "'")}"\n` +
        (r === 0 ? '' : `This is a re-review of a FIX diff only. Previously blocking items to re-check: ${JSON.stringify(open)}. Do not re-report anything in: ${JSON.stringify(seen)}.\n`) +
        'Then evaluate each finding on its merits against the code: verdict=accept, or dispute with concrete evidence. Classify severity and whether it is tied to this scope. ' +
        'Do not spawn anything else.', { phase: 'Review', label: `review:${b.id}:${r}`, model: 'sonnet', effort: 'high', schema: EVAL }),
    ])
    reviewedBase = g && g.head ? g.head : reviewedBase
    const fs = ev ? ev.findings : []
    fs.forEach(f => seen.push({ id: f.id, point: f.point }))
    const disputed = fs.filter(f => f.verdict === 'dispute').map(f => ({ id: f.id, my_position: f.evidence || '', their_position: f.point }))
    let codexRight = []
    if (disputed.length) {
      const tb = await vibeTieBreak(b, disputed, 'Review')
      codexRight = (tb ? tb.verdicts : []).filter(v => v.upheld).map(v => v.id)
    }
    const must = fs.filter(f => f.severity !== 'polish' && f.tied_to_scope && (f.verdict === 'accept' || codexRight.includes(f.id)))
    fs.filter(f => !must.includes(f)).forEach(f => deferred.push(f))
    if ((!g || g.ok) && must.length === 0 && (!g || g.out_of_scope.length === 0)) { blockedOpen = false; break }
    blockedOpen = true; open = must
    await agent(`${HOUSE}\n\nFix exactly these blocking items in ${b.worktree}, nothing else, then commit:\n${JSON.stringify({ must, gates: g })}`,
      { phase: 'Review', label: `fix:${b.id}:${r}`, model: 'sonnet', effort: 'high' })
  }
  if (blockedOpen) return { id: b.id, status: 'blocking_open', branch, newIssues: deferred }

  phase('Merge')
  const mr = await agent(`${HOUSE}\n\nPush ${branch} from ${b.worktree} and open the MR to the default branch using the repo's documented procedure (CLAUDE.md, docs/how-to, or the profile). ` +
    `Title/description from the plan; epic ${args.epic}. Return iid and head sha.`, { phase: 'Merge', label: `mr:${b.id}`, model: 'sonnet', effort: 'high', schema: MR })
  if (!mr) return { id: b.id, status: 'mr_failed', branch, newIssues: deferred }
  const out = { id: b.id, status: 'mr_open', branch, mr, newIssues: deferred, worktree: b.worktree }
  if (args.mergeTiming === 'as-ready') out.merge = await mergeOne(out)
  return out
}

// Serial merge lane: one MR at a time, always validated against CURRENT master.
const mergeOne = o => serial(() => agent(`${HOUSE}\n\nMerge MR !${o.mr.iid} (${o.branch}) in ${o.worktree}: fetch, merge origin/master into the branch ` +
  '(regenerate generated files instead of hand-merging them). If master has not moved since this branch was gated (merge-base == origin/master), ' +
  'run NOTHING again. Otherwise run the repo\'s whole-project static check plus only the package gates for files the merge changed. ' +
  `Then push and merge with the repo's documented merge command, pinned to the head sha (GitLab needs --sha). If anything fails, merged=false with the reason; never force. Then remove the worktree only if merged.`,
  { phase: 'Merge', label: `merge:${o.id}`, model: 'sonnet', effort: 'high', schema: MERGED }))

// ---- orchestration: rounds of blocks until dry -----------------------------------------------
const lane = limiter(args.lanes || 5)
const results = []
let queue = args.blocks.map(b => ({ ...b }))
for (let round = 1; round <= args.maxDiscoveryRounds && queue.length; round++) {
  log(`round ${round}: ${queue.length} block(s): ${queue.map(b => b.id).join(', ')}`)
  const donePromises = {}
  const roundResults = await parallel(queue.map(b => () => lane(async () => {
    await Promise.all((b.depends_on || []).map(d => donePromises[d]).filter(Boolean))   // dependency order inside the round
    const p = deliverBlock(b); donePromises[b.id] = p.catch(() => null); return p
  })))
  const ok = roundResults.filter(Boolean); results.push(...ok)

  if (args.mergeTiming === 'end') for (const o of ok.filter(x => x.status === 'mr_open')) o.merge = await mergeOne(o)

  phase('Triage')
  const tri = await agent(`${HOUSE}\n\nTriage the discovered findings below. Rubric: we are CLOSING production bugs toward MVP, not polishing. ` +
    `promote ONLY production-critical/production-meaningful findings tied to scope "${args.scope.title}" that no open or merged work already covers. ` +
    'File everything else as at most one consolidated backlog issue per theme (no workflow:: label), after searching existing issues. ' +
    `Return promoted items as new blocks.\nFindings: ${JSON.stringify(ok.flatMap(r => r.newIssues || []))}\nOpen blocking_open branches: ${JSON.stringify(ok.filter(r => r.status === 'blocking_open').map(r => r.branch))}`,
    { phase: 'Triage', label: `triage:${round}`, model: 'sonnet', effort: 'high', schema: TRIAGE })
  queue = tri ? tri.promote.map(p => ({ ...p, depends_on: [], issue_refs: [] })) : []
}

phase('Close-out')
// The critic works from this run's own ledger (merged shas, gate results, plan acceptance lists), not by re-reading the code.
const ledgerOut = results.map(r => ({ id: r.id, status: r.status, mr: r.mr && r.mr.iid, merged: r.merge && r.merge.merged, sha: r.merge && r.merge.master_sha }))
const final = await agent(`${HOUSE}\n\nCompleteness critic. Scope: ${JSON.stringify(args.scope)}. Run ledger: ${JSON.stringify(ledgerOut)}. ` +
  'Map each acceptance criterion to a merged block in the ledger and confirm with ONE targeted check each (the named test exists on master). ' +
  `List open GitLab issues under epic ${args.epic} that are production-critical/meaningful (jq-select fields only). Return done=true only if every ` +
  'criterion is evidenced, every MR of this run is merged, and no such issue is open; otherwise list gaps as blocks.',
  { phase: 'Close-out', label: 'critic', model: 'sonnet', effort: 'high', schema: DONE })
return { done: !!(final && final.done && !queue.length), gaps: final ? final.gaps : null, unpromoted: queue, results }
