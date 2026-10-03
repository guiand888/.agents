export const meta = {
  name: 'vibe-delivery',
  description: 'Multi-scope delivery: vibe plans and writes code in worktrees, Fable reviews plans and adjudicates, Sonnet drives, reviews, integrates and merges, and scripts decide delivery and gate results mechanically.',
  whenToUse: 'Launched by the vibe-delivery skill with args built by prepare-args.sh; never with hand-written args',
  phases: [
    { title: 'Plan', detail: 'vibe writes plan.json in a read-only worktree, check-plan.sh validates it (Haiku wrapper)', model: 'haiku' },
    { title: 'Plan review', detail: 'approve, correct, or one re-plan', model: 'fable' },
    { title: 'Collision', detail: 'cross-scope overlaps and must_finish_before', model: 'fable' },
    { title: 'Setup', detail: 'integration branch, worktree, plan-of-record entry', model: 'sonnet' },
    { title: 'Deliver', detail: 'driver writes the vibe prompt; vibe-run.sh runs vibe; gates.sh runs the gates' },
    { title: 'Review', detail: 'reviewer reads diff and gate log; adjudication; up to N fix rounds' },
    { title: 'Integrate', detail: 'serial merge of approved packages, package gates after each merge', model: 'sonnet' },
    { title: 'MR prep', detail: 'vibe merges the default branch, ticks bookkeeping, pushes the branch (never opens an MR); full gates' },
    { title: 'MR merge', detail: 'mechanical merge gate, then the only stage that opens and merges the MR', model: 'sonnet' },
  ],
}

// ---------------------------------------------------------------------------
// Args (built by prepare-args.sh; this script has no filesystem access)
// ---------------------------------------------------------------------------
const A = args
function need(cond, msg) {
  if (!cond) throw new Error('vibe-delivery: bad args: ' + msg + ' (build them with prepare-args.sh)')
}
need(A && typeof A === 'object', 'args missing')
need(Array.isArray(A.scopes) && A.scopes.length > 0, 'scopes missing')
for (const k of ['run_tag', 'today', 'jobdir', 'rundir', 'skill_dir']) need(typeof A[k] === 'string' && A[k].length > 0, k + ' missing')
need(A.plan_schema && A.plan_schema.type === 'object', 'plan_schema missing')
for (const s of A.scopes) {
  need(s.key && s.repo_path && s.brief && s.integration_branch, 'scope needs key, repo_path, brief, integration_branch')
  need(s.profile && s.profile.base_ref && s.profile.worktree_root && Array.isArray(s.profile.gates), 'scope ' + s.key + ' has no resolved profile')
  need(typeof s.profile_json === 'string', 'scope ' + s.key + ' has no profile_json path')
}
const SHIP_PARTIAL = A.ship_partial || []
const MAX_FIX = typeof A.max_fix_rounds === 'number' ? A.max_fix_rounds : 2
const MAX_RUNS = typeof A.max_vibe_runs === 'number' ? A.max_vibe_runs : 3
const MAX_TURNS = A.max_turns || 150
const SK = A.skill_dir
const RUN = A.rundir
const VR = 'bash ' + SK + '/vibe-run.sh'
const GT = 'bash ' + SK + '/gates.sh'
const WTS = 'bash ' + SK + '/wt.sh'
const CHECK_PLAN = 'bash ' + SK + '/check-plan.sh'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const STR = { type: 'string' }
const STRS = { type: 'array', items: STR }
const PLAN = A.plan_schema
// What a Haiku wrapper returns: the script's own output, copied, not interpreted.
const RAW = {
  type: 'object',
  properties: {
    status: { type: 'string', description: 'first line printed by the last wait/check command (DONE..., DIED..., STILL_RUNNING) or START_FAILED: <output>' },
    raw: { type: 'string', description: 'the second line printed by that command, copied exactly; empty if none' },
    plan_check: { type: 'string', description: 'full output of check-plan.sh, when asked' },
  },
  required: ['status', 'raw'],
}
const MECH = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, output: { type: 'string', description: 'last lines of output, copied' } },
  required: ['ok', 'output'],
}
const PLAN_REVIEW = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'correct', 'replan', 'reject'] },
    plan: PLAN,
    replan_instructions: STR,
    notes: STR,
  },
  required: ['verdict', 'notes'],
}
const COLLISION = {
  type: 'object',
  properties: {
    overlaps: { type: 'array', items: { type: 'object', properties: { scopes: STRS, files: STRS, risk: STR }, required: ['scopes', 'files', 'risk'] } },
    must_finish_before: { type: 'array', items: { type: 'object', properties: { first: STR, then: STR, reason: STR }, required: ['first', 'then', 'reason'] } },
  },
  required: ['overlaps', 'must_finish_before'],
}
const SETUP = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, integration_worktree: STR, integration_branch: STR, base_sha: { type: 'string', description: 'full sha of the integration branch after the plan-of-record commit' }, plan_worktree_removed: { type: 'boolean' }, notes: STR },
  required: ['ok', 'integration_worktree', 'integration_branch', 'base_sha', 'notes'],
}
const PREP = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['run_vibe', 'settled', 'abort'] },
    fork_sha: { type: 'string', description: 'full sha the package branch was created from' },
    prompt_file: STR,
    max_turns: { type: 'integer' },
    notes: STR,
  },
  required: ['action', 'fork_sha', 'notes'],
}
const REVIEW = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'fix', 'reject'] },
    findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, file: STR, issue: STR, fix: STR }, required: ['severity', 'issue', 'fix'] } },
    acceptance: { type: 'array', items: { type: 'object', properties: { item: STR, met: { type: 'boolean' }, evidence: STR }, required: ['item', 'met', 'evidence'] } },
  },
  required: ['verdict', 'findings', 'acceptance'],
}
const ADJ = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['approve', 'fix', 'reject'] }, required_fixes: STRS, rationale: STR },
  required: ['verdict', 'required_fixes', 'rationale'],
}
const INTEG = {
  type: 'object',
  properties: { merged: { type: 'boolean' }, pre_merge_sha: STR, head: STR, conflicts: { type: 'boolean' }, notes: STR },
  required: ['merged', 'pre_merge_sha', 'head', 'conflicts', 'notes'],
}
const MERGE = {
  type: 'object',
  properties: { merged: { type: 'boolean' }, merge_commit: STR, mr_url: STR, notes: STR },
  required: ['merged', 'notes'],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
const slug = (b) => String(b).replace(/[^A-Za-z0-9._-]+/g, '-')
const isSha = (s) => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s)
function parseRaw(r) {
  if (!r || typeof r.raw !== 'string' || !r.raw.trim()) return null
  try {
    const o = JSON.parse(r.raw.trim())
    return o && typeof o === 'object' ? o : null
  } catch (e) {
    return null
  }
}
function gateSummary(g) {
  if (!g) return 'gates did not run (no result)'
  const bad = (g.gates || []).filter((x) => x.status !== 'pass' && x.status !== 'skipped')
  const parts = bad.map((x) => x.name + '=' + x.status + (x.unknown_failure_ids && x.unknown_failure_ids.length ? ' [' + x.unknown_failure_ids.slice(0, 8).join(', ') + ']' : ''))
  if (g.dirty) parts.push('tree dirty')
  if (g.out_of_scope && g.out_of_scope.length) parts.push('out of scope: ' + g.out_of_scope.join(', '))
  return (g.ok ? 'ok' : 'NOT ok') + (parts.length ? ': ' + parts.join('; ') : '') + ' (log ' + g.log + ')'
}

function houseRules(s) {
  const p = s.profile
  const L = ['Repo rules for ' + p.repo + ' (from its vibe-delivery profile ' + s.profile_path + '):']
  if (p.vm) {
    L.push('- Test suites run on this machine. Only ' + (p.vm.use_for || ['cluster work']).join(', ') + ' runs on the VM ' + p.vm.ssh + ', one user at a time: only a vibe run started with --lock ' + p.vm.lock + ' may use it.' + (p.vm.notes ? ' ' + p.vm.notes : ''))
  } else {
    L.push('- Test suites run on this machine. There is no shared VM.')
  }
  for (const r of p.dev_stack_rules || []) L.push('- ' + r)
  L.push('- Shared bookkeeping files (' + p.bookkeeping.files.join(', ') + '): stage only your own hunks (feed git add -p with printf, check git diff --cached, then a bare git commit; never git commit -- <path>). ' + p.bookkeeping.convention)
  L.push('- Go build/lint caches and temp dirs are fresh per run under ' + RUN + ', never /tmp, and are deleted afterwards; the scripts in ' + SK + ' do this. If you run a build yourself, set GOCACHE/GOLANGCI_LINT_CACHE/TMPDIR under your own run dir and delete them (chmod -R u+w first).')
  L.push('- Worktrees: unique paths under ' + p.worktree_root + ', created only with `' + WTS + ' create` (it refuses collisions). Never touch the working tree of the main checkout ' + s.repo_path + '.')
  L.push('- No destructive git outside your own worktree. Never push to ' + p.default_branch + ' and never open, approve or merge a merge request (no `glab mr create`/`glab mr merge`, no API or web equivalent): only the workflow\'s MR merge stage does that, after every check. Runs that do it anyway are failed mechanically (vibe-run.sh checks the branch\'s MRs and whether ' + p.default_branch + ' gained this run\'s commits).')
  L.push('- Everything in this scope happens in ' + s.repo_path + '. If the work turns out to need changes in another repository, stop and report it; that is another scope.')
  if (p.no_remote) L.push('- This repo has NO remote: never push, never open an MR, never merge into ' + p.default_branch + '.')
  if (p.re_corpus) L.push('- Prior art: ' + p.re_corpus.rule + ' Corpus: ' + p.re_corpus.path + '.')
  for (const r of p.house_rules || []) L.push('- ' + r)
  return L.join('\n')
}

const VIBE_RULES = [
  'Rules for this vibe session (non-negotiable):',
  '- Prefix every nix command with `env -u LD_LIBRARY_PATH` (vibe leaks its own LD_LIBRARY_PATH; the system nix then dies on a GLIBCXX mismatch). Same for anything you start with nohup. A `nix` shim on PATH already does this, but do it explicitly too.',
  '- Never end a turn with text only. Every turn makes a tool call until the whole task is done; in this mode a text-only turn ends the session for good. Your final message comes only when you are finished.',
  '- Never use `vibe --worktree`, `git worktree`, `git reset --hard`, `git clean`, `git branch -D` or `git checkout -- .`. Stay inside your working directory and its repository.',
  '- Never open, approve or merge a merge request (no `glab mr create`, `glab mr merge`, `gh pr ...` or API calls) and never push to the default branch. Only push when this prompt explicitly tells you to, and only the branch it names. Doing otherwise fails the run automatically.',
  '- Run long commands in the foreground; you have no shell time limit. For the repo gates use `' + GT + ' run ...` when told to.',
  '- To stage only part of a file non-interactively: `printf "y\\nn\\n" | git add -p FILE` (one answer per hunk), then check `git diff --cached`.',
].join('\n')

// Run a Haiku agent that only executes commands and copies their output.
function mechPrompt(steps, tail) {
  return 'You are a mechanical runner. Run exactly these shell commands with the Bash tool, in order, and nothing else. Do not edit files except where a step says so. Do not investigate, fix or interpret anything. Never use run_in_background and never sleep.\n\n' +
    steps.map((x, i) => (i + 1) + '. ' + x).join('\n') + (tail ? '\n\n' + tail : '')
}

const WAIT_STEP = (cmd) => 'Run `' + cmd + '`. Repeat this exact command until the first line it prints starts with DONE or DIED. Each call can block for up to 9 minutes; that is expected. STILL_RUNNING with exit code 75 is normal, not an error: just run the same command again.'
const RETURN_RAW = 'Return through the schema: status = the first line printed by the last wait/check command; raw = the second line it printed (a JSON object), copied character for character, or "" if there was none.'

// vibe through the Haiku wrapper. Returns the parsed result.json (or a stub).
async function vibeRun(o) {
  const steps = (o.setup || []).slice()
  if (o.promptText) steps.push('Use the Write tool to write the text between the BEGIN-PROMPT and END-PROMPT lines at the end of this message, exactly as given (without those two marker lines), to ' + o.promptFile + '.')
  const start = [VR, 'start', '--wt', q(o.wt), '--prompt', q(o.promptFile), '--out', q(o.out), '--max-turns', String(o.maxTurns || MAX_TURNS)]
  if (o.base) start.push('--base', q(o.base))
  for (const g of o.allow || []) start.push('--allow', q(g))
  if (o.expectFile) start.push('--expect-file', q(o.expectFile))
  if (o.expectCommits) start.push('--expect-commits', o.expectCommits)
  if (o.lock) start.push('--lock', q(o.lock))
  for (const g of o.guardRefs || []) start.push('--guard-ref', q(g))
  if (o.mrCheckCmd) start.push('--mr-check-cmd', q(o.mrCheckCmd))
  steps.push('Run `' + start.join(' ') + '`. If it says a run is already in progress or already finished in that out dir, go on to the next step. If it fails for any other reason, stop and return status "START_FAILED: " followed by its output, and raw "".')
  steps.push(WAIT_STEP(VR + ' wait --out ' + q(o.out)))
  steps.push('If the last wait printed DIED, run `' + VR + ' check --out ' + q(o.out) + '` and use its output instead.')
  if (o.planCheck) steps.push('Run `' + CHECK_PLAN + ' ' + q(o.out + '/' + o.expectFile) + '` and put its full output in plan_check.')
  const tail = RETURN_RAW + (o.promptText ? '\n\nBEGIN-PROMPT\n' + o.promptText + '\nEND-PROMPT' : '')
  let r = await agent(mechPrompt(steps, tail), { label: o.label, phase: o.phase, model: 'haiku', effort: 'low', schema: RAW })
  let res = parseRaw(r)
  if (!res && !(r && /^START_FAILED/.test(r.status || ''))) {
    // The wrapper died or garbled the copy: collect from the out dir. Never start a second run here.
    log(o.label + ': wrapper returned no parseable result; collecting from ' + o.out)
    const c = [WAIT_STEP(VR + ' wait --out ' + q(o.out)), 'If the last wait printed DIED, run `' + VR + ' check --out ' + q(o.out) + '` and use its output instead.']
    if (o.planCheck) c.push('Run `' + CHECK_PLAN + ' ' + q(o.out + '/' + o.expectFile) + '` and put its full output in plan_check.')
    r = await agent(mechPrompt(c, RETURN_RAW), { label: o.label + ':collect', phase: o.phase, model: 'haiku', effort: 'low', schema: RAW })
    res = parseRaw(r)
  }
  if (!res) return { delivered: false, reasons: ['no result: ' + (r ? r.status : 'wrapper died')], commits: [], out_of_scope: [], out_dir: o.out }
  if (o.planCheck) res.plan_check = r && typeof r.plan_check === 'string' ? r.plan_check.trim() : ''
  return res
}

// Guards for every vibe run that may touch a branch: the default branch must
// not gain the run's commits, and no MR may exist for the run's branch.
function guards(s) {
  const p = s.profile
  const refs = [p.default_branch]
  if (p.remote) refs.unshift(p.base_ref)
  return { guardRefs: refs, mrCheckCmd: (p.merge && p.merge.mr_exists_command) || '' }
}

// `vibe-run.sh check` without running vibe (after a driver settled the tree by hand).
async function checkRun(o) {
  const cmd = [VR, 'check', '--wt', q(o.wt), '--out', q(o.out), '--base', q(o.base)]
  for (const g of o.allow || []) cmd.push('--allow', q(g))
  if (o.mrCheckCmd) cmd.push('--mr-check-cmd', q(o.mrCheckCmd))
  const r = await agent(mechPrompt(['Run `' + cmd.join(' ') + '`.'], 'Return through the schema: status = the first line it printed; raw = the second line, copied character for character.'), { label: o.label, phase: o.phase, model: 'haiku', effort: 'low', schema: RAW })
  return parseRaw(r) || { delivered: false, reasons: ['check returned nothing parseable'], commits: [], out_of_scope: [], out_dir: o.out }
}

// gates.sh through the Haiku wrapper. Returns the parsed summary or null.
async function gatesRun(o) {
  const start = [GT, 'start', '--profile', q(o.profileJson), '--wt', q(o.wt), '--base', q(o.base), '--out', q(o.out), '--level', o.level]
  for (const g of o.allow || []) start.push('--allow', q(g))
  const steps = [
    'Run `' + start.join(' ') + '`. If it says a run is already in progress or finished in that out dir, go on. If it fails otherwise, stop and return status "START_FAILED: " plus its output, raw "".',
    WAIT_STEP(GT + ' wait --out ' + q(o.out)),
  ]
  let r = await agent(mechPrompt(steps, RETURN_RAW), { label: o.label, phase: o.phase, model: 'haiku', effort: 'low', schema: RAW })
  let g = parseRaw(r)
  if (!g && !(r && /^START_FAILED/.test(r.status || ''))) {
    r = await agent(mechPrompt([WAIT_STEP(GT + ' wait --out ' + q(o.out))], RETURN_RAW), { label: o.label + ':collect', phase: o.phase, model: 'haiku', effort: 'low', schema: RAW })
    g = parseRaw(r)
  }
  if (!g) log(o.label + ': gates produced no result (' + (r ? r.status : 'wrapper died') + ')')
  return g
}

async function mech(label, phase, steps) {
  return agent(mechPrompt(steps, 'Return ok = true only if every command exited 0, and output = the last lines printed.'), { label, phase, model: 'haiku', effort: 'low', schema: MECH })
}

// ---------------------------------------------------------------------------
// PLAN -> PLAN REVIEW (pipelined per scope)
// ---------------------------------------------------------------------------
function planPrompt(s, feedback) {
  const p = s.profile
  return [
    'You are the PLANNER for scope "' + s.key + '" in the repository at your working directory (a read-only, detached checkout of ' + p.base_ref + '). Today is ' + A.today + '.',
    'Read the repository AGENTS.md / CLAUDE.md first; its rules bind the plan.',
    '',
    'SCOPE BRIEF:',
    s.brief,
    '',
    houseRules(s),
    '',
    'Produce a highly detailed delivery plan and write it as JSON to the file `.vd-plan.json` at the root of your working directory. Do not modify, create or commit anything else: this checkout is read-only and any other change fails the run.',
    'The JSON must match the schema in ' + SK + '/plan.schema.json. Validate it yourself with `' + CHECK_PLAN + ' .vd-plan.json` and fix every error it prints before you finish.',
    '- scope = "' + s.key + '", repo_path = "' + s.repo_path + '", integration_branch = "' + s.integration_branch + '"' + (s.build_on_branch ? ' (it builds on the existing branch ' + s.build_on_branch + ')' : '') + '. Package branches are <integration_branch>-<id>.',
    '- Investigate the code, git history, bookkeeping files (' + p.bookkeeping.files.join(', ') + ') and docs first. Ground every architectural decision in official documentation and authoritative sources (URL + fetch date)' + (p.re_corpus ? ' and, where the prior-art rule applies, the corpus at ' + p.re_corpus.path : '') + '. Record them in re_and_sources and decisions.',
    '- Split the work into packages a coding agent with about ' + MAX_TURNS + ' turns can each finish alone. Group them into waves: packages in one wave run in parallel and must have disjoint `files`. A package that needs another package\'s output (code, a memo, an RCA, an ADR) goes in a later wave and lists it in depends_on: it starts only after that package is integrated, and is blocked (not run) if that package is dropped.',
    '- Every package is work in this repository: its repo_path is "' + s.repo_path + '". Work that belongs in another repository is out of this scope; list it in user_decisions_needed instead of planning it.',
    '- `files` is enforced mechanically: a package that changes any other path fails. List every file, directory (trailing /) or glob it needs, including tests and docs.',
    '- Each spec must be precise enough for a coder with no other context: exact files, functions, behaviour, edge cases, tests to add, and the commands that prove it (tests).',
    '- Include packages for docs/ADR amendments and anything else the brief requires. The plan-of-record entry goes in bookkeeping_entry (it is added to ' + p.bookkeeping.plan_entry_file + ' before any code); ticking it at the end is done by MR prep, so no package needs to edit ' + p.bookkeeping.files.join(' or ') + ' unless the brief is about them.',
    '- needs_vm = true only for steps that need ' + (p.vm ? 'the VM ' + p.vm.ssh : 'a shared VM (this repo has none, so false)') + '.',
    '- Put only genuine owner-level strategic questions in user_decisions_needed; otherwise decide and document the decision.',
    feedback ? '\n' + feedback : '',
    '',
    VIBE_RULES,
  ].join('\n')
}

async function planScope(s) {
  const p = s.profile
  const planWt = p.worktree_root + '/vd-plan-' + s.key + '-' + A.run_tag
  const st = { s, planWt, attempts: 0, file: null, res: null }
  let feedback = ''
  for (let i = 0; i < 2; i++) {
    st.attempts++
    const out = RUN + '/' + s.key + '/plan/run' + st.attempts
    const setup = st.attempts === 1 ? [
      'Run `' + (p.remote ? 'git -C ' + q(s.repo_path) + ' fetch ' + q(p.remote) + ' --prune' : 'true') + '`.',
      'Run `' + WTS + ' create --repo ' + q(s.repo_path) + ' --path ' + q(planWt) + ' --detach ' + q(p.base_ref) + '`. If it prints EXISTS, stop and return status "START_FAILED: " plus its output, raw "".',
    ] : []
    const res = await vibeRun({ label: 'plan:' + s.key + ':' + st.attempts, phase: 'Plan', setup, wt: planWt, promptFile: out + '/prompt.md', promptText: planPrompt(s, feedback), out, allow: [], expectFile: '.vd-plan.json', expectCommits: 'no', planCheck: true })
    st.res = res
    if (res.delivered && res.plan_check === 'OK') {
      st.file = out + '/.vd-plan.json'
      return st
    }
    feedback = 'A previous attempt was rejected. Runner reasons: ' + JSON.stringify(res.reasons || []) + '. check-plan.sh said: ' + (res.plan_check || '(not run)') + '. Your earlier file, if any, is at ' + out + '/.vd-plan.json: start from it and fix it.'
    log(s.key + ': plan attempt ' + st.attempts + ' rejected: ' + JSON.stringify(res.reasons || []) + ' ' + (res.plan_check || ''))
  }
  return st
}

async function reviewPlan(st, replanned) {
  const s = st.s
  return agent([
    'You are the senior PLAN REVIEWER for scope "' + s.key + '" (repo ' + s.repo_path + ', today ' + A.today + '). You may read code, docs and the web; do not edit the repository.',
    'The planner\'s plan (validated against the schema) is at ' + st.file + '. Read it in full.',
    '',
    'SCOPE BRIEF:',
    s.brief,
    '',
    houseRules(s),
    '',
    'Make opinionated decisions grounded in gold-standard practice, official documentation and authoritative sources: verify the cited sources and add better ones' + (s.profile.re_corpus ? ', and check the prior-art corpus where its rule applies' : '') + '. Fix wrong root-cause assumptions, missing edge cases, missing or non-discriminating tests, under-specified specs, `files` lists that are too narrow (the scope is enforced mechanically) or too wide, unsafe wave splits (same-wave packages must have disjoint files), missing depends_on (every package that needs another package\'s output, including a memo, an ADR or an RCA, must list it; it will not run until that package is integrated), and missing docs or bookkeeping. Flag and fix any package whose spec actually targets a different repository than ' + s.repo_path + ' (its repo_path must be ' + s.repo_path + '; cross-repo work is another scope, so drop it and say so in review_notes). Resolve user_decisions_needed yourself when best practice decides them; leave only true owner questions.',
    'Verdict:',
    '- approve: the plan is good as written. Return it unchanged in `plan`.',
    '- correct: return the full corrected plan in `plan`, with review_notes saying what changed and why.',
    replanned ? '- (A re-plan already happened; replan is no longer available. Choose approve, correct or reject.)' : '- replan: the plan is wrong at the root and cheaper to redo than to correct. Put precise instructions in replan_instructions. Allowed once.',
    '- reject: the scope cannot be delivered as briefed; say why in notes.',
    'If you return a plan, write it to ' + st.file.replace(/\.vd-plan\.json$/, 'reviewed-plan.json') + ' and run `' + CHECK_PLAN + ' <that file>` until it prints OK. Keep scope, repo_path and integration_branch as they are.',
  ].join('\n'), { label: 'plan-review:' + s.key + (replanned ? ':2' : ''), phase: 'Plan review', model: 'fable', effort: 'high', schema: PLAN_REVIEW })
}

async function planAndReview(s) {
  let st = await planScope(s)
  if (!st.file) return { s, planWt: st.planWt, failed: 'planner did not produce a valid plan after ' + st.attempts + ' attempts: ' + JSON.stringify(st.res && st.res.reasons) + ' ' + ((st.res && st.res.plan_check) || '') }
  let rev = await reviewPlan(st, false)
  if (rev && rev.verdict === 'replan') {
    log(s.key + ': plan reviewer asked for a re-plan')
    const st2 = await planScopeAgain(s, st, rev.replan_instructions || rev.notes)
    if (!st2.file) return { s, planWt: st.planWt, failed: 're-plan did not produce a valid plan: ' + ((st2.res && st2.res.plan_check) || JSON.stringify(st2.res && st2.res.reasons)) }
    st = st2
    rev = await reviewPlan(st, true)
  }
  if (!rev) return { s, planWt: st.planWt, failed: 'plan reviewer died' }
  if (rev.verdict === 'reject' || rev.verdict === 'replan') return { s, planWt: st.planWt, failed: 'plan rejected by the reviewer: ' + rev.notes }
  if (!rev.plan || !Array.isArray(rev.plan.waves)) return { s, planWt: st.planWt, failed: 'plan reviewer returned no plan' }
  const plan = Object.assign({}, rev.plan, { scope: s.key, repo_path: s.repo_path, integration_branch: s.integration_branch })
  const crossRepo = plan.waves.flatMap((w) => w.packages).filter((k) => k.repo_path !== s.repo_path)
  if (crossRepo.length) return { s, planWt: st.planWt, failed: 'reviewed plan still has packages for another repository: ' + crossRepo.map((k) => k.id + ' -> ' + k.repo_path).join(', ') }
  return { s, planWt: st.planWt, plan, review: { verdict: rev.verdict, notes: rev.notes } }
}

async function planScopeAgain(s, prev, instructions) {
  const out = RUN + '/' + s.key + '/plan/run' + (prev.attempts + 1)
  const fb = 'RE-PLAN. The plan reviewer rejected your previous plan (' + prev.file + ') and asks for a new one. Instructions:\n' + instructions
  const res = await vibeRun({ label: 'plan:' + s.key + ':replan', phase: 'Plan', wt: prev.planWt, promptFile: out + '/prompt.md', promptText: planPrompt(s, fb), out, allow: [], expectFile: '.vd-plan.json', expectCommits: 'no', planCheck: true })
  return { s, planWt: prev.planWt, attempts: prev.attempts + 1, res, file: res.delivered && res.plan_check === 'OK' ? out + '/.vd-plan.json' : null }
}

phase('Plan')
const planned = await pipeline(A.scopes, (s) => planAndReview(s))
const plans = planned.filter((x) => x && x.plan)
const planFailures = planned.map((x, i) => x && x.plan ? null : { scope: A.scopes[i].key, status: 'plan_failed', blockers: [x ? x.failed : 'planning crashed'], plan_worktree: x ? x.planWt : null }).filter(Boolean)
for (const f of planFailures) log(f.scope + ': NOT delivered, ' + f.blockers[0])

// ---------------------------------------------------------------------------
// COLLISION (barrier: needs every plan)
// ---------------------------------------------------------------------------
phase('Collision')
let collision = { overlaps: [], must_finish_before: [] }
if (plans.length > 1) {
  collision = (await agent(
    'Several delivery plans will run concurrently against these repos and one shared local dev stack. Find file or package overlaps between DIFFERENT scopes, and shared-state collisions (dev-stack services, message streams, databases). Shared-VM work is already serialized by a lock, so flag it only if ordering matters for correctness. Also report, as an overlap with risk "cross-repo", any package whose files or id suggest it really targets a different repository than its scope\'s. Emit must_finish_before only where concurrent work would genuinely conflict; scope keys: ' + plans.map((p) => p.s.key).join(', ') + '.\n\n' +
    plans.map((p) => 'SCOPE ' + p.s.key + ' (repo ' + p.s.repo_path + '):\n' + JSON.stringify(p.plan.waves.map((w) => ({ wave: w.wave, packages: w.packages.map((k) => ({ id: k.id, title: k.title, files: k.files, needs_vm: k.needs_vm, depends_on: k.depends_on })) })))).join('\n\n'),
    { label: 'collision', phase: 'Collision', model: 'fable', effort: 'medium', schema: COLLISION }
  )) || collision
}
const ORDER = (collision.must_finish_before || []).filter((o) => plans.some((p) => p.s.key === o.first) && plans.some((p) => p.s.key === o.then) && o.first !== o.then)
if (ORDER.length) log('Sequencing: ' + ORDER.map((o) => o.first + ' before ' + o.then + ' (' + o.reason + ')').join('; '))
for (const p of plans) {
  if (p.plan.user_decisions_needed && p.plan.user_decisions_needed.length) log(p.s.key + ': owner questions (proceeding with the reviewed plan): ' + p.plan.user_decisions_needed.join(' | '))
}

// ---------------------------------------------------------------------------
// Per package: drive -> gates -> review -> adjudicate -> up to MAX_FIX fix rounds
// ---------------------------------------------------------------------------
function driverPrompt(c) {
  const { s, plan, setup, pkg, wt, out, mode, fixes, last, forkSha } = c
  const p = s.profile
  const L = [
    'You are the DRIVER for work package "' + pkg.id + '" (' + pkg.title + ') of scope "' + s.key + '" in ' + s.repo_path + '. vibe writes the code, not you. Your job: ground truth, the vibe prompt, and settling the tree between runs. Today is ' + A.today + '.',
    '',
    'PACKAGE (JSON): ' + JSON.stringify(pkg),
    'SCOPE SUMMARY: ' + plan.summary,
    'KEY DECISIONS: ' + JSON.stringify(plan.decisions),
    'Integration branch ' + setup.integration_branch + ' (worktree ' + setup.integration_worktree + '). Your worktree: ' + wt + ' on branch ' + pkg.branch + '.',
    '',
    houseRules(s),
    '',
    'MODE: ' + mode,
  ]
  if (mode === 'initial') {
    L.push(
      '1. Create your worktree: `' + WTS + ' create --repo ' + q(s.repo_path) + ' --path ' + q(wt) + ' --branch ' + q(pkg.branch) + ' --from ' + q(setup.integration_branch) + ' --reuse`. The sha it prints is fork_sha (if it says REUSED, fork_sha is `git -C ' + q(wt) + ' merge-base ' + q(setup.integration_branch) + ' HEAD`). If it prints EXISTS, return action=abort.',
      '2. Ground truth: check every premise of the spec against the code in your worktree (files, symbols, line references, commands, test names). Where the code has drifted from the spec, correct the vibe prompt and say so in notes. If the spec cannot work, return action=abort with the reason.',
      '3. Write the vibe prompt to ' + out + '/prompt.md (create the dir; keep it under 100 KB; point at files rather than pasting them). It must contain: the spec, the acceptance criteria, the test commands, the exact list of allowed paths ' + JSON.stringify(pkg.files) + ' with the warning that touching anything else fails the run, "commit with conventional-commit messages ending in (' + s.key + ' ' + pkg.id + '); do not push", and the vibe rules below, verbatim.',
      '4. Ask the advisor tool (if you have one) to check the prompt before you return.',
      '5. Return action=run_vibe, fork_sha, prompt_file, max_turns (default ' + MAX_TURNS + ').'
    )
  } else if (mode === 'continue' || mode === 'fix-continue') {
    L.push(
      'The previous vibe run did not deliver. Its result: ' + JSON.stringify(last || {}) + '. Its log is ' + ((last && last.out_dir) || '(unknown)') + '/vibe.log.',
      'Inspect the worktree (git status, git log ' + (forkSha || setup.base_sha) + '..HEAD, the log). Then exactly one of:',
      '- settled: the work is complete but the tree is unsettled. Commit in-scope leftovers yourself with a proper message, undo out-of-scope edits (git restore for uncommitted ones, a revert commit for committed ones; never reset --hard), and return action=settled.',
      '- run_vibe: work remains. Write a continuation prompt to ' + out + '/prompt.md: what is done (diff summary), what remains, "continue from here", the allowed paths, the rules below verbatim' + (mode === 'fix-continue' ? ', and the outstanding required fixes: ' + JSON.stringify(fixes || []) : '') + '.',
      '- abort: it cannot be finished; say why.',
      'Return fork_sha = ' + (forkSha || '(the fork sha)') + '.'
    )
  } else {
    L.push(
      'FIX ROUND. Your worktree and branch already exist; reuse them, do not recreate them. Required fixes (from adjudication): ' + JSON.stringify(fixes || []),
      'Gate results for the current head: ' + (c.gates ? c.gates.log : '(none)') + ' (summary: ' + gateSummary(c.gates) + ').',
      'Write a vibe prompt to ' + out + '/prompt.md listing exactly these fixes with enough context to do them (files, lines, expected behaviour), the allowed paths ' + JSON.stringify(pkg.files) + ', the commit-message suffix (' + s.key + ' ' + pkg.id + '), and the rules below verbatim. Return action=run_vibe and fork_sha = ' + forkSha + '. If a fix is impossible within the allowed paths, return action=abort and explain.'
    )
  }
  L.push('', 'Do not run vibe yourself and do not run long test suites: vibe-run.sh and gates.sh run after you, mechanically. Do not push.', '', 'VIBE RULES (copy into every vibe prompt):', VIBE_RULES)
  if (pkg.needs_vm && p.vm) L.push('', 'This package needs the VM ' + p.vm.ssh + '. Its vibe runs hold the lock ' + p.vm.lock + ' for their whole duration; tell vibe it is the only VM user while it runs and must leave the VM clean (tear down what it created).')
  return L.join('\n')
}

async function deliverPackage(s, plan, setup, pkg) {
  const p = s.profile
  const key = s.key
  const pdir = RUN + '/' + key + '/' + pkg.id
  const wt = p.worktree_root + '/' + slug(pkg.branch)
  const lock = pkg.needs_vm && p.vm ? p.vm.lock : null
  const rec = { id: pkg.id, title: pkg.title, branch: pkg.branch, worktree: wt, fork_sha: null, runs: [], rounds: [], final: null, reason: '', head: null, integrated: false }
  let runNo = 0
  let gates = null

  async function drive(mode, fixes) {
    let last = null
    for (let i = 0; i < MAX_RUNS; i++) {
      runNo++
      const out = pdir + '/run' + runNo
      const prep = await agent(driverPrompt({ s, plan, setup, pkg, wt, out, mode, fixes, last, forkSha: rec.fork_sha, gates }), { label: 'drive:' + key + ':' + pkg.id + ':' + runNo, phase: 'Deliver', model: 'sonnet', schema: PREP })
      if (!prep) return { ok: false, why: 'driver agent died' }
      if (!rec.fork_sha && isSha(prep.fork_sha)) rec.fork_sha = prep.fork_sha
      if (prep.action === 'abort') return { ok: false, why: 'driver aborted: ' + prep.notes }
      if (!rec.fork_sha) return { ok: false, why: 'driver returned no valid fork_sha (' + prep.fork_sha + ')' }
      let res
      const G = guards(s)
      if (prep.action === 'run_vibe') {
        res = await vibeRun({ label: 'vibe:' + key + ':' + pkg.id + ':' + runNo, phase: 'Deliver', wt, promptFile: out + '/prompt.md', out, allow: pkg.files, lock, maxTurns: prep.max_turns || MAX_TURNS, expectCommits: 'yes', guardRefs: G.guardRefs, mrCheckCmd: G.mrCheckCmd })
      } else {
        res = await checkRun({ label: 'check:' + key + ':' + pkg.id + ':' + runNo, phase: 'Deliver', wt, out: out + '-check', base: (last && last.base_sha) || rec.fork_sha, allow: pkg.files, mrCheckCmd: G.mrCheckCmd })
      }
      rec.runs.push({ run: runNo, mode, action: prep.action, delivered: !!res.delivered, reasons: res.reasons || [], head: res.head || null, commits: res.commits || [], out_of_scope: res.out_of_scope || [], policy_violations: res.policy_violations || [], policy_check_errors: res.policy_check_errors || [], driver_notes: prep.notes })
      if (res.policy_violations && res.policy_violations.length) return { ok: false, policy: true, why: 'POLICY VIOLATION (the package is stopped, no further rounds): ' + res.policy_violations.join('; ') }
      if (res.policy_check_errors && res.policy_check_errors.length) log(key + ':' + pkg.id + ': policy check could not run: ' + res.policy_check_errors.join('; '))
      if (res.delivered) return { ok: true, res }
      log(key + ':' + pkg.id + ': run ' + runNo + ' not delivered: ' + JSON.stringify(res.reasons || []))
      last = res
      mode = mode === 'fix' || mode === 'fix-continue' ? 'fix-continue' : 'continue'
    }
    return { ok: false, why: 'not delivered after ' + MAX_RUNS + ' runs; last reasons ' + JSON.stringify((last && last.reasons) || []) }
  }

  const d0 = await drive('initial', null)
  if (!d0.ok) {
    rec.final = d0.policy ? 'policy_violation' : 'failed'
    rec.reason = d0.why
    return rec
  }

  for (let round = 0; ; round++) {
    gates = await gatesRun({ label: 'gates:' + key + ':' + pkg.id + ':r' + round, phase: 'Review', wt, base: rec.fork_sha, out: pdir + '/gates-r' + round, level: 'package', profileJson: s.profile_json, allow: pkg.files })
    const rev = await agent([
      'You are the REVIEWER for work package "' + pkg.id + '" of scope "' + key + '" (round ' + round + '). vibe wrote the code on branch ' + pkg.branch + ' in worktree ' + wt + ', forked from ' + rec.fork_sha + '.',
      'PACKAGE (JSON): ' + JSON.stringify(pkg),
      'Mechanical gate results (already run; do NOT re-run builds or tests): ' + gateSummary(gates) + '. Full gate log: ' + (gates ? gates.log : '(none)') + '; per-gate logs are listed in it.',
      houseRules(s),
      'Review the actual diff (`git -C ' + q(wt) + ' diff ' + rec.fork_sha + '..HEAD` and `git log`), not any report. For every acceptance criterion say whether it is met and cite the evidence (diff hunk or gate log line). Check correctness, concurrency, security, error handling, whether new tests would fail without the change (reason from the code and the base version), docs and ADR consistency, and scope creep. Do not edit anything. Verdict approve only if it is merge-ready.',
    ].join('\n'), { label: 'review:' + key + ':' + pkg.id + ':r' + round, phase: 'Review', model: 'sonnet', effort: 'high', schema: REVIEW })
    const adj = await agent([
      'You are the senior ADJUDICATOR for work package "' + pkg.id + '" (scope "' + key + '"), branch ' + pkg.branch + ' in ' + wt + ', forked from ' + rec.fork_sha + '. Round ' + round + ' of at most ' + (MAX_FIX + 1) + '.',
      'PACKAGE: ' + JSON.stringify(pkg),
      'REVIEW: ' + JSON.stringify(rev),
      'GATES: ' + gateSummary(gates),
      'Read the diff yourself. Decide: approve (merge-ready; requires gates ok), fix (list the exact required fixes, concrete enough for a coder with no context; drop nits not worth a round), or reject (wrong approach). Ground disputed points in official docs or best practice.',
    ].join('\n'), { label: 'adjudicate:' + key + ':' + pkg.id + ':r' + round, phase: 'Review', model: 'fable', effort: 'high', schema: ADJ })

    let verdict = adj ? adj.verdict : 'fix'
    let fixes = adj ? adj.required_fixes.slice() : ['The adjudicator returned nothing; address the review findings: ' + JSON.stringify(rev ? rev.findings : [])]
    if (!adj && !rev) {
      verdict = 'reject'
      fixes = []
    }
    if (verdict === 'approve' && !(gates && gates.ok)) {
      verdict = 'fix'
      fixes.push('Gates are not ok: ' + gateSummary(gates) + '. Make every gate pass (failures listed in the profile as known master failures are acceptable).')
    }
    rec.rounds.push({ round, gates: gateSummary(gates), review: rev ? rev.verdict : null, verdict, fixes, rationale: adj ? adj.rationale : 'adjudicator died' })
    if (verdict === 'approve') {
      rec.final = 'approved'
      rec.head = gates.head
      return rec
    }
    if (verdict === 'reject') {
      rec.final = 'rejected'
      rec.reason = adj ? adj.rationale : 'reviewer and adjudicator both died'
      return rec
    }
    if (round >= MAX_FIX) {
      rec.final = 'unapproved'
      rec.reason = 'still needs fixes after ' + MAX_FIX + ' fix rounds: ' + JSON.stringify(fixes)
      return rec
    }
    log(key + ':' + pkg.id + ': fix round ' + (round + 1) + ': ' + fixes.length + ' required fix(es)')
    const d = await drive('fix', fixes)
    if (!d.ok) {
      rec.final = d.policy ? 'policy_violation' : 'failed'
      rec.reason = 'fix round ' + (round + 1) + ': ' + d.why
      return rec
    }
  }
}

// ---------------------------------------------------------------------------
// Integration: serial per scope, package gates after each merge
// ---------------------------------------------------------------------------
async function integrate(s, setup, rec) {
  const p = s.profile
  const key = s.key
  const idir = RUN + '/' + key + '/integrate-' + rec.id
  const m = await agent([
    'Merge approved work package "' + rec.id + '" (branch ' + rec.branch + ', head ' + rec.head + ') into the integration branch ' + setup.integration_branch + ' in worktree ' + setup.integration_worktree + ' (repo ' + s.repo_path + ').',
    houseRules(s),
    'Steps: (1) record pre_merge_sha = `git -C <worktree> rev-parse HEAD`; the tree must be clean. (2) `git -C <worktree> merge --no-ff ' + rec.branch + '`. (3) On conflicts, resolve them preserving both sides\' intent and complete the merge; set conflicts=true and explain each resolution in notes. If you cannot resolve them safely, `git merge --abort` and return merged=false. (4) Do NOT push and do not run test suites (gates run next, mechanically). Return merged, pre_merge_sha, head (full sha after the merge), conflicts, notes.',
  ].join('\n'), { label: 'integrate:' + key + ':' + rec.id, phase: 'Integrate', model: 'sonnet', schema: INTEG })
  if (!m || !m.merged || !isSha(m.head) || !isSha(m.pre_merge_sha)) {
    rec.final = 'integration_failed'
    rec.reason = 'integration: ' + (m ? m.notes : 'integrator died')
    rec.integration = { ok: false, reason: m ? m.notes : 'integrator died' }
    return false
  }
  const g = await gatesRun({ label: 'gates:' + key + ':integrate-' + rec.id, phase: 'Integrate', wt: setup.integration_worktree, base: setup.base_sha, out: idir + '/gates', level: 'package', profileJson: s.profile_json })
  const wtq = q(setup.integration_worktree)
  if (g && g.ok && g.head === m.head) {
    const steps = []
    if (!p.no_remote) steps.push('Run `git -C ' + wtq + ' push ' + q(p.remote) + ' ' + q(setup.integration_branch) + '`.')
    steps.push('Run `' + WTS + ' remove --repo ' + q(s.repo_path) + ' --path ' + q(rec.worktree) + '`.')
    const r = await mech('publish:' + key + ':' + rec.id, 'Integrate', steps)
    rec.integrated = true
    rec.integration = { ok: true, head: m.head, conflicts: m.conflicts, gates: gateSummary(g), publish: r ? r.output : 'publish step died' }
    if (!r || !r.ok) log(key + ':' + rec.id + ': integrated, but push/cleanup reported a problem: ' + (r ? r.output : 'agent died'))
    return true
  }
  // Undo the merge: only if HEAD is still exactly the merge we made.
  const un = await mech('unmerge:' + key + ':' + rec.id, 'Integrate', ['Run `test "$(git -C ' + wtq + ' rev-parse HEAD)" = ' + m.head + ' && git -C ' + wtq + ' reset --keep ' + m.pre_merge_sha + '`.'])
  rec.final = 'integration_gates_failed'
  rec.reason = 'gates failed after merging into the integration branch: ' + gateSummary(g)
  rec.integration = { ok: false, reason: rec.reason }
  if (!un || !un.ok) {
    // The failed merge may still be in the integration branch: nothing more can be built on it.
    setup.broken = 'could not undo the merge of ' + rec.id + ' (' + (un ? un.output : 'agent died') + '); the integration branch ' + setup.integration_branch + ' may contain it'
    log(key + ': ' + setup.broken)
  } else {
    log(key + ':' + rec.id + ': merge undone, gates failed after integration: ' + gateSummary(g))
  }
  return false
}

// ---------------------------------------------------------------------------
// Per scope: setup -> waves -> integrate -> MR prep -> MR merge
// ---------------------------------------------------------------------------
function mrPrompt(s, plan, setup, integrated, notIntegrated) {
  const p = s.profile
  const L = [
    'You are preparing the merge request for scope "' + s.key + '" in your working directory, which is the integration worktree of branch ' + setup.integration_branch + '. Today is ' + A.today + '.',
    houseRules(s),
    '',
    'Integrated packages: ' + JSON.stringify(integrated.map((r) => ({ id: r.id, title: r.title }))),
    'NOT integrated (they must stay open in the bookkeeping, with a dated note saying why): ' + JSON.stringify(notIntegrated.map((r) => ({ id: r.id, final: r.final, reason: r.reason }))),
    '',
    'Steps:',
    (p.remote ? '1. `git fetch ' + p.remote + '` then `git merge --no-edit ' + p.base_ref + '`.' : '1. `git merge --no-edit ' + p.base_ref + '`.') + ' Resolve conflicts preserving both sides\' intent; commit the merge.',
    '2. Run the full gates: `' + GT + ' run --profile ' + q(s.profile_json) + ' --wt . --base ' + q(p.base_ref) + ' --out ' + q(RUN + '/' + s.key + '/mr-prep/vibe-gates-N') + ' --level full` (N = 1, 2, ...: a new out dir for every gates run). Fix only breakage the merge introduced; failures that also occur on ' + p.base_ref + ' are not yours to fix (the profile lists the known ones).',
    '3. Bookkeeping in ' + p.bookkeeping.files.join(', ') + ': tick the entries this scope completed, with completion notes (' + p.bookkeeping.convention + '). Stage only your own hunks. Commit.',
  ]
  L.push(
    p.no_remote ? '4. This repo has no remote: do not push.' : '4. Push the integration branch, and only it: `git push -u ' + p.remote + ' ' + setup.integration_branch + '`.',
    '5. Write the merge request description to ' + RUN + '/' + s.key + '/mr-prep/description.md (outside the repository): what changed, the packages (integrated and not), the gates run and their results (say plainly which failures are known ' + p.base_ref + ' failures, by name), and anything not done. Every claim must be checkable against the diff or the gate logs; write nothing you have not verified. Starting point: ' + JSON.stringify(plan.mr_description),
    'Do NOT open, approve or merge a merge request: a later stage does that after every check.'
  )
  L.push('', VIBE_RULES)
  return L.join('\n')
}

const done = {}
async function runScope(pl) {
  const s = pl.s
  const p = s.profile
  const key = s.key
  const plan = pl.plan
  for (const o of ORDER.filter((x) => x.then === key)) {
    if (done[o.first]) {
      log(key + ': waiting for ' + o.first + ' (' + o.reason + ')')
      await done[o.first]
    }
  }
  const out = { scope: key, repo: s.repo_path, integration_branch: s.integration_branch, status: null, blockers: [], packages: [], plan_review: pl.review, owner_questions: plan.user_decisions_needed || [] }

  const intWt = p.worktree_root + '/' + slug(s.integration_branch)
  const setup = await agent([
    'Set up scope "' + key + '" for delivery in ' + s.repo_path + '. Today ' + A.today + '.',
    houseRules(s),
    'Steps:',
    '1. ' + (p.remote ? '`git -C ' + q(s.repo_path) + ' fetch ' + q(p.remote) + ' --prune`.' : 'No remote; nothing to fetch.'),
    '2. `' + WTS + ' create --repo ' + q(s.repo_path) + ' --path ' + q(intWt) + ' --branch ' + q(s.integration_branch) + ' --from ' + q(s.build_on_branch || p.base_ref) + ' --reuse`.' + (s.build_on_branch ? ' Then merge ' + p.base_ref + ' into it (resolve conflicts preserving both sides).' : '') + ' If it prints EXISTS, inspect: reuse only a branch that is clearly this scope\'s own earlier attempt, otherwise return ok=false.',
    '3. Add this plan-of-record entry to ' + p.bookkeeping.plan_entry_file + ' (' + p.bookkeeping.convention + '), as unchecked tasks with acceptance criteria. Stage only your own hunk and commit "docs: plan of record for ' + key + '".\nENTRY:\n' + plan.bookkeeping_entry,
    '4. ' + (p.remote ? '`git -C ' + q(intWt) + ' push -u ' + q(p.remote) + ' ' + q(s.integration_branch) + '`.' : 'No remote: do not push.'),
    '5. Remove the planner\'s worktree: `' + WTS + ' remove --repo ' + q(s.repo_path) + ' --path ' + q(pl.planWt) + '`.',
    'Do not write product code. Return ok, integration_worktree, integration_branch, base_sha (full sha of HEAD after step 3), plan_worktree_removed, notes.',
  ].join('\n'), { label: 'setup:' + key, phase: 'Setup', model: 'sonnet', schema: SETUP })
  if (!setup || !setup.ok || !isSha(setup.base_sha)) {
    out.status = 'failed'
    out.blockers.push('setup failed: ' + (setup ? setup.notes : 'agent died'))
    out.cleanup = [pl.planWt]
    return out
  }
  out.integration_worktree = setup.integration_worktree
  if (!setup.plan_worktree_removed) out.cleanup = [pl.planWt]

  const recs = []
  const integratedIds = new Set()
  const waves = plan.waves.slice().sort((a, b) => a.wave - b.wave)
  for (const w of waves) {
    const runnable = []
    for (const pkg of w.packages) {
      const missing = (pkg.depends_on || []).filter((d) => !integratedIds.has(d))
      if (missing.length) {
        recs.push({ id: pkg.id, title: pkg.title, branch: pkg.branch, final: 'blocked_dependency', reason: 'blocked, not run: depends on ' + missing.join(', ') + ', which was not integrated', integrated: false })
        log(key + ':' + pkg.id + ': BLOCKED (not run), dependency not integrated: ' + missing.join(', '))
      } else {
        runnable.push(pkg)
      }
    }
    if (!runnable.length) continue
    log(key + ': wave ' + w.wave + ': ' + runnable.length + ' package(s)')
    // pipeline: each package goes drive->review on its own; integration stays serial below.
    const delivered = await pipeline(runnable, (pkg) => deliverPackage(s, plan, setup, pkg))
    for (let i = 0; i < runnable.length; i++) {
      const r = delivered[i] || { id: runnable[i].id, title: runnable[i].title, branch: runnable[i].branch, final: 'failed', reason: 'package pipeline crashed', integrated: false }
      recs.push(r)
      if (r.final !== 'approved') {
        log(key + ':' + r.id + ': NOT integrated (' + r.final + '): ' + r.reason)
        continue
      }
      if (setup.broken) {
        r.final = 'blocked_integration'
        r.reason = 'approved but not merged: ' + setup.broken
        continue
      }
      if (await integrate(s, setup, r)) {
        integratedIds.add(r.id)
        r.final = 'integrated'
      }
    }
    if (setup.broken) break
  }
  if (setup.broken) {
    // Later waves never ran; list them so nothing disappears.
    const seen = new Set(recs.map((r) => r.id))
    for (const w of waves) for (const pkg of w.packages) if (!seen.has(pkg.id)) recs.push({ id: pkg.id, title: pkg.title, branch: pkg.branch, final: 'blocked_integration', reason: 'not run: ' + setup.broken, integrated: false })
    out.blockers.push('integration branch unusable: ' + setup.broken)
  }
  out.packages = recs.map((r) => ({ id: r.id, final: r.final, reason: r.reason || '', integrated: !!r.integrated, branch: r.branch, worktree: r.worktree || null, runs: r.runs || [], rounds: r.rounds || [], integration: r.integration || null }))
  const integrated = recs.filter((r) => r.integrated)
  const notIntegrated = recs.filter((r) => !r.integrated)
  out.dropped = notIntegrated.map((r) => ({ id: r.id, final: r.final, reason: r.reason || '' }))
  if (setup.broken) {
    out.status = 'needs_owner_decision'
    return out
  }
  if (!integrated.length) {
    out.status = 'failed'
    out.blockers.push('no package was integrated')
    return out
  }

  // ---- MR PREP (vibe) ----
  const mdir = RUN + '/' + key + '/mr-prep'
  const allowed = [].concat(...integrated.map((r) => (plan.waves.flatMap((w) => w.packages).find((k) => k.id === r.id) || { files: [] }).files), p.bookkeeping.files, [p.bookkeeping.plan_entry_file])
  const G = guards(s)
  const mr = await vibeRun({ label: 'mr-prep:' + key, phase: 'MR prep', wt: setup.integration_worktree, promptFile: mdir + '/run1/prompt.md', promptText: mrPrompt(s, plan, setup, integrated, notIntegrated), out: mdir + '/run1', allow: ['*'], expectCommits: 'yes', guardRefs: G.guardRefs, mrCheckCmd: G.mrCheckCmd })
  const full = await gatesRun({ label: 'gates:' + key + ':full', phase: 'MR prep', wt: setup.integration_worktree, base: p.base_ref, out: mdir + '/gates-full', level: 'full', profileJson: s.profile_json, allow: allowed })
  out.mr_prep = { delivered: !!mr.delivered, reasons: mr.reasons || [], head: mr.head || null, policy_violations: mr.policy_violations || [], policy_check_errors: mr.policy_check_errors || [] }
  out.gates_full = full ? { ok: full.ok, clean: full.clean, head: full.head, summary: gateSummary(full) } : null

  // ---- MR MERGE gate (mechanical); only this stage opens or merges an MR ----
  const B = out.blockers
  const policyHits = recs.filter((r) => r.final === 'policy_violation').map((r) => r.id)
  if (policyHits.length) B.push('policy violation in ' + policyHits.join(', ') + ' (an MR was opened or the default branch gained package commits outside this stage); the owner must review what happened before anything ships')
  if (notIntegrated.length && SHIP_PARTIAL.indexOf(key) < 0) B.push('partial ship: ' + notIntegrated.map((r) => r.id + ' (' + r.final + ')').join(', ') + ' not integrated; the owner must allow a partial ship (ship_partial) or finish them')
  if (!mr.delivered) B.push('MR prep did not deliver: ' + JSON.stringify(mr.reasons || []))
  if ((mr.policy_check_errors || []).length) B.push('MR prep policy check could not run: ' + mr.policy_check_errors.join('; '))
  if (!full) B.push('full gates produced no result')
  else if (!full.ok) B.push('full gates not ok (beyond known master failures): ' + gateSummary(full))
  if (full && mr.head && full.head !== mr.head) B.push('gated head ' + full.head + ' differs from the head MR prep ended on (' + mr.head + ')')
  if (p.no_remote) B.push('the repo has no remote: branch ' + s.integration_branch + ' is ready at ' + (full ? full.head : '?') + ' in ' + setup.integration_worktree + ' for the owner to merge locally')
  if (!p.no_remote && !(p.merge && p.merge.open_command && p.merge.command)) B.push('the profile lacks merge.open_command or merge.command')
  if (B.length) {
    out.status = 'needs_owner_decision'
    out.ready = { branch: s.integration_branch, head: full ? full.head : null, worktree: setup.integration_worktree, description: mdir + '/description.md', mr_opened: false }
    log(key + ': needs owner decision (no MR opened): ' + B.join(' | '))
    return out
  }
  const openCmd = p.merge.open_command.replace(/\{source\}/g, q(s.integration_branch)).replace(/\{target\}/g, q(p.default_branch)).replace(/\{title\}/g, q(plan.mr_title)).replace(/\{description_file\}/g, q(mdir + '/description.md'))
  const mergeCmd = p.merge.command.replace(/\{sha\}/g, full.head)
  const merged = await agent([
    'You are the MR MERGE stage for scope "' + key + '": the only stage allowed to open and merge a merge request. Every gate has been checked mechanically; do not change code, bookkeeping or branches. Work from ' + setup.integration_worktree + '.',
    '1. `git ls-remote ' + q(p.remote) + ' refs/heads/' + s.integration_branch + '` must print ' + full.head + '. If not, stop: merged=false.',
    p.merge.mr_exists_command ? '2. `' + p.merge.mr_exists_command.replace(/\{branch\}/g, s.integration_branch) + '` must print 0 (no MR exists yet). If it prints anything else, stop: merged=false, and say which MR exists.' : '2. (no MR-existence check configured)',
    '3. If ' + mdir + '/description.md is missing, write one from the plan (' + JSON.stringify(plan.mr_description) + ') and these gate results: ' + gateSummary(full) + '.',
    '4. Open the MR: `' + openCmd + '`. Note its number (iid) and URL.',
    '5. Merge it: `' + mergeCmd + '` with {iid} replaced by that number. ' + (p.merge.notes || ''),
    'The sha ' + full.head + ' is the gated head: never merge any other.',
    '6. Confirm the MR shows as merged. Return merged, merge_commit, mr_url, notes.',
  ].join('\n'), { label: 'mr-merge:' + key, phase: 'MR merge', model: 'sonnet', schema: MERGE })
  out.mr = merged || null
  out.status = merged && merged.merged ? 'merged' : 'needs_owner_decision'
  if (!(merged && merged.merged)) B.push('MR merge stage did not merge: ' + (merged ? merged.notes : 'agent died'))
  else out.cleanup = (out.cleanup || []).concat([setup.integration_worktree])
  return out
}

const outcomes = await parallel(plans.map((pl) => () => {
  const pr = runScope(pl).catch((e) => ({ scope: pl.s.key, status: 'failed', blockers: ['crashed: ' + String(e && e.message ? e.message : e)] }))
  done[pl.s.key] = pr
  return pr
}))

const all = planFailures.concat(outcomes.filter(Boolean))
const worktrees = []
for (const o of all) {
  for (const w of o.cleanup || []) worktrees.push({ path: w, why: 'finished' })
  if (o.plan_worktree) worktrees.push({ path: o.plan_worktree, why: 'plan worktree' })
  for (const pk of o.packages || []) if (!pk.integrated && pk.worktree) worktrees.push({ path: pk.worktree, why: 'package ' + pk.id + ' ' + pk.final + ': inspect, then remove' })
}
return {
  run_tag: A.run_tag,
  rundir: RUN,
  summary: all.map((o) => o.scope + ': ' + o.status + (o.dropped && o.dropped.length ? ' (dropped: ' + o.dropped.map((d) => d.id + '=' + d.final).join(', ') + ')' : '')),
  scopes: all,
  collision,
  worktrees_to_clean: worktrees,
}
