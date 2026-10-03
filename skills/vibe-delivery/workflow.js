export const meta = {
  name: 'vibe-delivery',
  description: 'Multi-scope delivery: vibe plans and writes code in worktrees behind thin Haiku wrappers; each package is reviewed once (Sonnet, or Fable for high-risk work), only blocking findings get one vibe fix round and a narrow re-check, deferrable findings ship as recorded follow-ups, and scripts decide branches, delivery and gate results mechanically.',
  whenToUse: 'Launched by the vibe-delivery skill with args built by prepare-args.sh; never with hand-written args',
  phases: [
    { title: 'Base', detail: 'scope-branch.sh creates the integration branch (build-on branch merged with the default branch) and lists its inherited commits (Haiku wrapper)', model: 'haiku' },
    { title: 'Plan', detail: 'vibe writes .vd-plan.json in a read-only worktree at the integration head; check-plan.sh validates it (Haiku wrapper)', model: 'haiku' },
    { title: 'Plan review', detail: 'approve, correct, or one re-plan; sets kind and high_risk', model: 'fable' },
    { title: 'Collision', detail: 'cross-scope overlaps and must_finish_before', model: 'fable' },
    { title: 'Setup', detail: 'scope-branch.sh records the plan-of-record entry and pushes (Haiku wrapper)', model: 'haiku' },
    { title: 'Deliver', detail: 'Haiku wrapper: worktree + vibe-run.sh with a workflow-built prompt; gates.sh' },
    { title: 'Review', detail: 'one review per package (Sonnet; Fable for high_risk); blocking findings only: one vibe fix round, gates, a narrow Sonnet re-check; deferrable findings become follow-ups' },
    { title: 'Integrate', detail: 'serial merge of shipped packages (Sonnet, or a script with Sonnet only on conflict); gates re-run unless the merge tree equals the gated package tree' },
    { title: 'MR prep', detail: 'vibe merges the default branch, ticks bookkeeping, files every follow-up, pushes the branch (never opens an MR); full gates once, mechanically' },
    { title: 'MR merge', detail: 'mechanical merge gate, then the only stage that opens and merges the MR; always ships what was integrated', model: 'sonnet' },
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
  need(s.profile.bookkeeping && s.profile.bookkeeping.followup_file, 'scope ' + s.key + ' profile has no bookkeeping.followup_file')
}
// Integrator: 'sonnet' (default) merges with a Sonnet agent; 'script' merges with
// scope-branch.sh merge behind a Haiku wrapper and calls Sonnet only on a conflict.
const INTEGRATOR = A.integrator === 'script' ? 'script' : 'sonnet'
const MAX_RUNS = typeof A.max_vibe_runs === 'number' ? A.max_vibe_runs : 3
const MAX_TURNS = A.max_turns || 150
const SK = A.skill_dir
const RUN = A.rundir
const VR = 'bash ' + SK + '/vibe-run.sh'
const GT = 'bash ' + SK + '/gates.sh'
const WTS = 'bash ' + SK + '/wt.sh'
const SB = 'bash ' + SK + '/scope-branch.sh'
const CHECK_PLAN = 'bash ' + SK + '/check-plan.sh'
const VERIFY_NOTE = '.vd-verify.md'
const BLOCKED_NOTE = '.vd-blocked.md'

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
    status: { type: 'string', description: 'first line printed by the last wait/check/script command (DONE..., DIED..., FAILED, STILL_RUNNING) or START_FAILED: <output>' },
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
// The one review of a package. The workflow, not the verdict, decides the
// outcome: any blocking finding (or red gates) -> one fix round; none -> ship;
// reject -> not integrated.
const FINDING = {
  type: 'object',
  properties: {
    severity: { type: 'string', enum: ['blocking', 'deferrable'] },
    summary: STR,
    file: STR,
    line: { type: 'string', description: 'line or range in file, "" if not applicable' },
    required_fix: { type: 'string', description: 'what must change, concrete enough for a coder with no other context (file, behaviour, test)' },
  },
  required: ['severity', 'summary', 'file', 'line', 'required_fix'],
}
const REVIEW = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['ship', 'fix', 'reject'], description: 'ship: no blocking finding; fix: at least one blocking finding; reject: the approach itself is wrong' },
    findings: { type: 'array', items: FINDING },
    acceptance: { type: 'array', items: { type: 'object', properties: { item: STR, met: { type: 'boolean' }, evidence: STR }, required: ['item', 'met', 'evidence'] } },
    reject_reason: { type: 'string', description: 'for verdict reject: why the approach is wrong; "" otherwise' },
  },
  required: ['verdict', 'findings', 'acceptance'],
}
// The narrow re-check after the one fix round: only the listed blocking items.
const RECHECK = {
  type: 'object',
  properties: {
    items: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer', description: 'the item number as listed (1-based)' }, resolved: { type: 'boolean' }, evidence: STR }, required: ['index', 'resolved', 'evidence'] } },
  },
  required: ['items'],
}
const INTEG = {
  type: 'object',
  properties: { merged: { type: 'boolean' }, pre_merge_sha: STR, head: STR, conflicts: { type: 'boolean' }, notes: STR },
  required: ['merged', 'pre_merge_sha', 'head', 'conflicts', 'notes'],
}
const MERGE = {
  type: 'object',
  properties: {
    merged: { type: 'boolean' },
    merge_commit: STR,
    mr_url: STR,
    followups_check: { type: 'string', description: 'the output of the follow-up check command, copied exactly' },
    notes: STR,
  },
  required: ['merged', 'notes'],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
const slug = (b) => String(b).replace(/[^A-Za-z0-9._-]+/g, '-')
const isSha = (s) => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s)
const short = (s) => String(s || '').slice(0, 12)
// UTF-8 size of text without its trailing newlines: what vibe-run.sh and
// scope-branch.sh measure to catch a wrapper that did not copy a file verbatim.
function utf8Bytes(text) {
  const t = String(text).replace(/\n+$/, '')
  let n = 0
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++ }
    else n += 3
  }
  return n
}
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
  if (typeof g.ran === 'number') parts.push(g.ran + ' gate(s) ran')
  return (g.ok ? 'ok' : 'NOT ok') + (parts.length ? ': ' + parts.join('; ') : '') + ' (log ' + g.log + ')'
}
// Mechanical gate verdict: ok, and for a verify-only package at least one gate
// ran (its own tests are extra gates), so it cannot pass on nothing.
const gatesPassed = (g, verify) => !!(g && g.ok && (!verify || g.ran > 0))
// Red gates are always a blocking item, added by the workflow, not by a reviewer.
function gateFinding(g, verify) {
  return {
    severity: 'blocking', from_gates: true, file: '', line: '',
    summary: 'gates not ok: ' + gateSummary(g) + (verify && g && !g.ran ? ' (no gate ran at all)' : ''),
    required_fix: 'Make every gate pass (failures listed in the profile as known master failures are acceptable); the gate log names each failure.',
  }
}
const fixText = (f) => f.summary + (f.file ? ' [' + f.file + (f.line ? ':' + f.line : '') + ']' : '') + ' -> ' + f.required_fix
const allPackages = (plan) => plan.waves.flatMap((w) => w.packages)
const isVerify = (pkg) => pkg.kind === 'verify_only'

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
  '- Never use `vibe --worktree`, `git worktree`, `git reset --hard`, `git clean`, `git branch -D`, `git checkout -- .` or `git commit --amend`/rebase on existing commits. Stay inside your working directory and its repository.',
  '- Never open, approve or merge a merge request (no `glab mr create`, `glab mr merge`, `gh pr ...` or API calls) and never push to the default branch. Only push when this prompt explicitly tells you to, and only the branch it names. Doing otherwise fails the run automatically.',
  '- Run long commands in the foreground; you have no shell time limit. For the repo gates use `' + GT + ' run ...` when told to.',
  '- To stage only part of a file non-interactively: `printf "y\\nn\\n" | git add -p FILE` (one answer per hunk), then check `git diff --cached`.',
].join('\n')

// The integration branch's inherited commits, for planner, reviewer and vibe prompts.
function inheritedNote(s, base, forWhom) {
  if (!base) return ''
  const p = s.profile
  if (!base.inherited) return forWhom === 'vibe' ? '' : 'The integration branch ' + s.integration_branch + ' holds no commits beyond ' + p.base_ref + ' (' + short(base.base_sha) + ') yet: everything in this scope is new work.'
  return [
    'ALREADY DONE: the integration branch ' + s.integration_branch + ' (head ' + short(base.head) + ') already contains ' + base.inherited + ' commit(s) beyond ' + p.base_ref + ' (' + short(base.base_sha) + ')' + (s.build_on_branch ? ', merged in from the build-on branch ' + s.build_on_branch : '') + '. Every package forks from that head, so this work is present in every package\'s tree.',
    '- ' + base.inherited_file + ' lists each of these commits (full sha and subject) with the files it touches; ' + base.diff_file + ' is `git diff --name-status` of the whole branch against the base. ' + (forWhom === 'vibe' ? 'Read them if the spec refers to this work.' : 'Read both before planning.'),
    forWhom === 'vibe'
      ? '- Never cherry-pick, re-apply, recreate or revert this work. If your spec asks for something that is already present, that is a false premise: write ' + BLOCKED_NOTE + ' (see below) instead of inventing a commit.'
      : '- Plan AROUND this work: verification (kind verify_only: may end with zero commits; delivered by its tests passing as gates plus a verification note), bookkeeping, and any genuinely missing follow-up (kind change). NEVER plan a package that cherry-picks, re-applies, re-lands or recreates an inherited commit: it would have nothing to commit (check-plan.sh --inherited rejects such a spec).',
  ].join('\n')
}

// Run a Haiku agent that only executes commands and copies their output.
function mechPrompt(steps, tail) {
  return 'You are a mechanical runner. Run exactly these shell commands with the Bash tool, in order, and nothing else. Do not edit files except where a step says so. Do not investigate, fix or interpret anything. Never use run_in_background and never sleep.\n\n' +
    steps.map((x, i) => (i + 1) + '. ' + x).join('\n') + (tail ? '\n\n' + tail : '')
}

const WAIT_STEP = (cmd) => 'Run `' + cmd + '`. Repeat this exact command until the first line it prints starts with DONE or DIED. Each call can block for up to 9 minutes; that is expected. STILL_RUNNING with exit code 75 is normal, not an error: just run the same command again.'
const RETURN_RAW = 'Return through the schema: status = the first line printed by the last wait/check command; raw = the second line it printed (a JSON object), copied character for character, or "" if there was none.'
const WRITE_STEP = (path, marker) => 'Use the Write tool to write the text between the BEGIN-' + marker + ' and END-' + marker + ' lines at the end of this message, exactly as given, character for character (without those two marker lines), to ' + path + '.'

// vibe through the Haiku wrapper. Returns the parsed result.json, or a stub
// with start_failed set.
async function vibeRun(o) {
  need(o.base, 'vibeRun ' + o.label + ' without a base')
  const steps = (o.setup || []).slice()
  if (o.promptText) steps.push(WRITE_STEP(o.promptFile, 'PROMPT'))
  const start = [VR, 'start', '--wt', q(o.wt), '--prompt', q(o.promptFile), '--out', q(o.out), '--base', q(o.base), '--max-turns', String(o.maxTurns || MAX_TURNS)]
  if (o.promptText) start.push('--prompt-bytes', String(utf8Bytes(o.promptText)))
  if (o.since) start.push('--commits-since', q(o.since))
  for (const g of o.allow || []) start.push('--allow', q(g))
  if (o.expectFile) start.push('--expect-file', q(o.expectFile))
  if (o.blockedFile) start.push('--blocked-file', q(o.blockedFile))
  if (o.expectCommits) start.push('--expect-commits', o.expectCommits)
  if (o.lock) start.push('--lock', q(o.lock))
  for (const g of o.guardRefs || []) start.push('--guard-ref', q(g))
  if (o.mrCheckCmd) start.push('--mr-check-cmd', q(o.mrCheckCmd))
  steps.push('Run `' + start.join(' ') + '`. If it says a run is already in progress or already finished in that out dir, go on to the next step. If it fails for any other reason (including PROMPT_MISMATCH), stop and return status "START_FAILED: " followed by its output, and raw "".')
  steps.push(WAIT_STEP(VR + ' wait --out ' + q(o.out)))
  steps.push('If the last wait printed DIED, run `' + VR + ' check --out ' + q(o.out) + '` and use its output instead.')
  const pc = o.planCheck ? CHECK_PLAN + ' ' + q(o.out + '/' + o.expectFile) + (o.inheritedFile ? ' --inherited ' + q(o.inheritedFile) : '') : ''
  if (pc) steps.push('Run `' + pc + '` and put its full output in plan_check.')
  const tail = RETURN_RAW + (o.promptText ? '\n\nBEGIN-PROMPT\n' + o.promptText + '\nEND-PROMPT' : '')
  let r = await agent(mechPrompt(steps, tail), { label: o.label, phase: o.phase, model: 'haiku', effort: 'low', schema: RAW })
  let res = parseRaw(r)
  const startFailed = r && /^START_FAILED/.test(r.status || '')
  if (!res && !startFailed) {
    // The wrapper died or garbled the copy: collect from the out dir. Never start a second run here.
    log(o.label + ': wrapper returned no parseable result; collecting from ' + o.out)
    const c = [WAIT_STEP(VR + ' wait --out ' + q(o.out)), 'If the last wait printed DIED, run `' + VR + ' check --out ' + q(o.out) + '` and use its output instead.']
    if (pc) c.push('Run `' + pc + '` and put its full output in plan_check.')
    r = await agent(mechPrompt(c, RETURN_RAW), { label: o.label + ':collect', phase: o.phase, model: 'haiku', effort: 'low', schema: RAW })
    res = parseRaw(r)
  }
  if (!res) return { delivered: false, start_failed: startFailed ? r.status : '', reasons: ['no result: ' + (r ? r.status : 'wrapper died')], commits: [], out_of_scope: [], out_dir: o.out }
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

// gates.sh through the Haiku wrapper. Returns the parsed summary or null.
async function gatesRun(o) {
  const start = [GT, 'start', '--profile', q(o.profileJson), '--wt', q(o.wt), '--base', q(o.base), '--out', q(o.out), '--level', o.level]
  for (const g of o.allow || []) start.push('--allow', q(g))
  if (o.allowFile) start.push('--allow-file', q(o.allowFile))
  for (const g of o.verifyPaths || []) start.push('--verify-paths', q(g))
  for (const c of o.extraCmds || []) start.push('--extra-cmd', q(c))
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

// A script that prints DONE/FAILED and one JSON line (scope-branch.sh).
async function scriptRun(label, phase, steps) {
  const r = await agent(mechPrompt(steps, 'If a command fails, stop there. Return through the schema: status = the first line printed by the LAST command you ran (DONE or FAILED, or START_FAILED: <output> if it printed neither); raw = the line after it (a JSON object), copied character for character, or "".'), { label, phase, model: 'haiku', effort: 'low', schema: RAW })
  return parseRaw(r) || { ok: false, reason: 'no parseable result: ' + (r ? r.status : 'wrapper died') }
}

async function mech(label, phase, steps, stopOnFailure) {
  const tail = (stopOnFailure ? 'If a command exits non-zero, stop there and run nothing after it. ' : '') + 'Return ok = true only if every command ran and exited 0, and output = the last lines printed.'
  return agent(mechPrompt(steps, tail), { label, phase, model: 'haiku', effort: 'low', schema: MECH })
}

// ---------------------------------------------------------------------------
// BASE -> PLAN -> PLAN REVIEW (pipelined per scope)
// The integration branch exists before planning: the planner and the plan
// reviewer read the exact tree every package forks from, and its inherited
// commits are listed from git, not predicted.
// ---------------------------------------------------------------------------
function planPrompt(s, base, feedback) {
  const p = s.profile
  return [
    'You are the PLANNER for scope "' + s.key + '" in the repository at your working directory (a read-only, detached checkout of the integration branch ' + s.integration_branch + ' at ' + base.head + '). Today is ' + A.today + '.',
    'Read the repository AGENTS.md / CLAUDE.md first; its rules bind the plan.',
    '',
    'SCOPE BRIEF:',
    s.brief,
    '',
    inheritedNote(s, base, 'planner'),
    '',
    s.followups && s.followups.length ? 'FOLLOW-UPS FROM AN EARLIER RUN (part of this scope: plan a package for each, or say in user_decisions_needed why one is dropped; for a package that was not integrated, its branch holds the earlier work and the evidence names its run dir):\n' + JSON.stringify(s.followups) + '\n' : '',
    houseRules(s),
    '',
    'Produce a highly detailed delivery plan and write it as JSON to the file `.vd-plan.json` at the root of your working directory. Do not modify, create or commit anything else: this checkout is read-only and any other change fails the run.',
    'The JSON must match the schema in ' + SK + '/plan.schema.json. Validate it yourself with `' + CHECK_PLAN + ' .vd-plan.json' + (base.inherited ? ' --inherited ' + q(base.inherited_file) : '') + '` and fix every error it prints before you finish.',
    '- scope = "' + s.key + '", repo_path = "' + s.repo_path + '", integration_branch = "' + s.integration_branch + '". Package branches are <integration_branch>-<id>.',
    '- Investigate the code, git history, bookkeeping files (' + p.bookkeeping.files.join(', ') + ') and docs first. Ground every architectural decision in official documentation and authoritative sources (URL + fetch date)' + (p.re_corpus ? ' and, where the prior-art rule applies, the corpus at ' + p.re_corpus.path : '') + '. Record them in re_and_sources and decisions.',
    '- Split the work into packages a coding agent with about ' + MAX_TURNS + ' turns can each finish alone. Group them into waves: packages in one wave run in parallel and must have disjoint `files`. A package that needs another package\'s output (code, a memo, an RCA, an ADR) goes in a later wave and lists it in depends_on: it starts only after that package is integrated, and is blocked (not run) if that package is dropped.',
    '- kind: "change" for new work (it must end with at least one commit); "verify_only" for checking work that is already on the branch (it may end with zero commits; its `tests` run mechanically as gates, so give it at least one test command that fails when the verification fails).',
    '- Every package is work in this repository: its repo_path is "' + s.repo_path + '". Work that belongs in another repository is out of this scope; list it in user_decisions_needed instead of planning it.',
    '- `files` is enforced mechanically: a package that changes any other path fails. List every file, directory (trailing /) or glob it needs, including tests and docs. For a verify_only package, list the paths it verifies (its gates run over them).',
    '- Each spec must be precise enough for a coder with no other context: exact files, functions, behaviour, edge cases, tests to add, and the commands that prove it (tests). The spec is the coder\'s whole brief: nobody re-checks it before the coder starts.',
    '- Include packages for docs/ADR amendments and anything else the brief requires. The plan-of-record entry goes in bookkeeping_entry (it is added to ' + p.bookkeeping.plan_entry_file + ' before any code); ticking it at the end is done by MR prep, so no package needs to edit ' + p.bookkeeping.files.join(' or ') + ' unless the brief is about them.',
    '- needs_vm = true only for steps that need ' + (p.vm ? 'the VM ' + p.vm.ssh : 'a shared VM (this repo has none, so false)') + '.',
    '- Put only genuine owner-level strategic questions in user_decisions_needed; otherwise decide and document the decision.',
    feedback ? '\n' + feedback : '',
    '',
    VIBE_RULES,
  ].join('\n')
}

async function makeBase(s) {
  const p = s.profile
  const intWt = p.worktree_root + '/' + slug(s.integration_branch)
  const cmd = [SB, 'create', '--repo', q(s.repo_path), '--path', q(intWt), '--branch', q(s.integration_branch), '--base-ref', q(p.base_ref), '--out', q(RUN + '/' + s.key + '/base')]
  if (s.build_on_branch) cmd.push('--build-on', q(s.build_on_branch))
  if (p.remote) cmd.push('--remote', q(p.remote))
  const b = await scriptRun('base:' + s.key, 'Base', ['Run `' + cmd.join(' ') + '`.'])
  if (!b.ok || !isSha(b.head) || !isSha(b.base_sha)) return { failed: 'base: ' + (b.reason || 'scope-branch.sh returned no head'), intWt }
  return Object.assign({ intWt }, b)
}

async function planScope(s, base) {
  const p = s.profile
  const planWt = p.worktree_root + '/vd-plan-' + s.key + '-' + A.run_tag
  const st = { s, base, planWt, attempts: 0, file: null, res: null }
  let feedback = ''
  for (let i = 0; i < 2; i++) {
    st.attempts++
    const out = RUN + '/' + s.key + '/plan/run' + st.attempts
    const setup = st.attempts === 1 ? [
      'Run `' + WTS + ' create --repo ' + q(s.repo_path) + ' --path ' + q(planWt) + ' --detach ' + q(base.head) + '`. If it prints EXISTS, stop and return status "START_FAILED: " plus its output, raw "".',
    ] : []
    const res = await vibeRun({ label: 'plan:' + s.key + ':' + st.attempts, phase: 'Plan', setup, wt: planWt, base: base.head, promptFile: out + '/prompt.md', promptText: planPrompt(s, base, feedback), out, allow: [], expectFile: '.vd-plan.json', expectCommits: 'no', planCheck: true, inheritedFile: base.inherited ? base.inherited_file : '' })
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
  const reviewed = st.file.replace(/\.vd-plan\.json$/, 'reviewed-plan.json')
  return agent([
    'You are the senior PLAN REVIEWER for scope "' + s.key + '" (repo ' + s.repo_path + ', today ' + A.today + '). You may read code, docs and the web; do not edit the repository.',
    'The planner\'s plan (validated against the schema) is at ' + st.file + '. Read it in full. The code to check it against is the integration branch ' + s.integration_branch + ' at ' + st.base.head + ' (worktree ' + st.base.worktree + ', read only).',
    '',
    'SCOPE BRIEF:',
    s.brief,
    '',
    inheritedNote(s, st.base, 'reviewer'),
    '',
    s.followups && s.followups.length ? 'This scope also carries follow-ups from an earlier run; the plan must cover each one or say why not: ' + JSON.stringify(s.followups.map((f) => ({ package: f.package, kind: f.kind, branch: f.branch, summary: f.summary }))) + '\n' : '',
    houseRules(s),
    '',
    'Your review is the only ground-truthing before code is written: no agent re-checks a package\'s spec before vibe starts on it. Verify every premise of every spec against the code (files, symbols, line references, commands, test names) and correct what has drifted.',
    'Make opinionated decisions grounded in gold-standard practice, official documentation and authoritative sources: verify the cited sources and add better ones' + (s.profile.re_corpus ? ', and check the prior-art corpus where its rule applies' : '') + '. Fix wrong root-cause assumptions, missing edge cases, missing or non-discriminating tests, under-specified specs, `files` lists that are too narrow (the scope is enforced mechanically) or too wide, unsafe wave splits (same-wave packages must have disjoint files), missing depends_on (every package that needs another package\'s output, including a memo, an ADR or an RCA, must list it; it will not run until that package is integrated), and missing docs or bookkeeping. Flag and fix any package whose spec actually targets a different repository than ' + s.repo_path + ' (its repo_path must be ' + s.repo_path + '; cross-repo work is another scope, so drop it and say so in review_notes). Resolve user_decisions_needed yourself when best practice decides them; leave only true owner questions.',
    'Package kinds: any package that would recreate inherited work must become verify_only (or be dropped). A verify_only package needs test commands that fail when the verification fails; they run mechanically as gates.',
    'Set high_risk: true on every package doing concurrency, security or data-integrity work (locking, leases, ordering, auth, secrets, crypto, persistence, migrations, hash chains). Every package gets exactly one code review: a high-risk package gets it from the senior reviewer instead of the standard one. A package with no blocking finding ships on that review; small issues become recorded follow-ups.',
    'Verdict:',
    '- approve: the plan is good as written. Return it unchanged in `plan`.',
    '- correct: return the full corrected plan in `plan`, with review_notes saying what changed and why.',
    replanned ? '- (A re-plan already happened; replan is no longer available. Choose approve, correct or reject.)' : '- replan: the plan is wrong at the root and cheaper to redo than to correct. Put precise instructions in replan_instructions. Allowed once.',
    '- reject: the scope cannot be delivered as briefed; say why in notes.',
    'If you return a plan, write it to ' + reviewed + ' and run `' + CHECK_PLAN + ' ' + q(reviewed) + (st.base.inherited ? ' --inherited ' + q(st.base.inherited_file) : '') + '` until it prints OK. Keep scope, repo_path and integration_branch as they are.',
  ].join('\n'), { label: 'plan-review:' + s.key + (replanned ? ':2' : ''), phase: 'Plan review', model: 'fable', effort: 'high', schema: PLAN_REVIEW })
}

async function planAndReview(s) {
  const base = await makeBase(s)
  if (base.failed) return { s, failed: base.failed, cleanup: [] }
  let st = await planScope(s, base)
  const fail = (why) => ({ s, base, planWt: st.planWt, failed: why })
  if (!st.file) return fail('planner did not produce a valid plan after ' + st.attempts + ' attempts: ' + JSON.stringify(st.res && st.res.reasons) + ' ' + ((st.res && st.res.plan_check) || ''))
  let rev = await reviewPlan(st, false)
  if (rev && rev.verdict === 'replan') {
    log(s.key + ': plan reviewer asked for a re-plan')
    const st2 = await planScopeAgain(s, st, rev.replan_instructions || rev.notes)
    if (!st2.file) return fail('re-plan did not produce a valid plan: ' + ((st2.res && st2.res.plan_check) || JSON.stringify(st2.res && st2.res.reasons)))
    st = st2
    rev = await reviewPlan(st, true)
  }
  if (!rev) return fail('plan reviewer died')
  if (rev.verdict === 'reject' || rev.verdict === 'replan') return fail('plan rejected by the reviewer: ' + rev.notes)
  if (!rev.plan || !Array.isArray(rev.plan.waves)) return fail('plan reviewer returned no plan')
  const plan = Object.assign({}, rev.plan, { scope: s.key, repo_path: s.repo_path, integration_branch: s.integration_branch })
  for (const k of allPackages(plan)) if (k.kind !== 'verify_only') k.kind = 'change'
  const crossRepo = allPackages(plan).filter((k) => k.repo_path !== s.repo_path)
  if (crossRepo.length) return fail('reviewed plan still has packages for another repository: ' + crossRepo.map((k) => k.id + ' -> ' + k.repo_path).join(', '))
  const noTests = allPackages(plan).filter((k) => isVerify(k) && !(k.tests || []).some((t) => /\S/.test(t)))
  if (noTests.length) return fail('reviewed plan has verify_only packages without test commands: ' + noTests.map((k) => k.id).join(', '))
  return { s, base, planWt: st.planWt, plan, review: { verdict: rev.verdict, notes: rev.notes } }
}

async function planScopeAgain(s, prev, instructions) {
  const out = RUN + '/' + s.key + '/plan/run' + (prev.attempts + 1)
  const fb = 'RE-PLAN. The plan reviewer rejected your previous plan (' + prev.file + ') and asks for a new one. Instructions:\n' + instructions
  const res = await vibeRun({ label: 'plan:' + s.key + ':replan', phase: 'Plan', wt: prev.planWt, base: prev.base.head, promptFile: out + '/prompt.md', promptText: planPrompt(s, prev.base, fb), out, allow: [], expectFile: '.vd-plan.json', expectCommits: 'no', planCheck: true, inheritedFile: prev.base.inherited ? prev.base.inherited_file : '' })
  return { s, base: prev.base, planWt: prev.planWt, attempts: prev.attempts + 1, res, file: res.delivered && res.plan_check === 'OK' ? out + '/.vd-plan.json' : null }
}

phase('Plan')
const planned = await pipeline(A.scopes, (s) => planAndReview(s))
const plans = planned.filter((x) => x && x.plan)
const planFailures = planned.map((x, i) => x && x.plan ? null : {
  scope: A.scopes[i].key,
  status: 'plan_failed',
  blockers: [x ? x.failed : 'planning crashed'],
  plan_worktree: x ? x.planWt || null : null,
  integration_worktree: x && x.base ? x.base.intWt : null,
}).filter(Boolean)
for (const f of planFailures) log(f.scope + ': NOT delivered, ' + f.blockers[0])

// ---------------------------------------------------------------------------
// COLLISION (barrier: needs every plan)
// ---------------------------------------------------------------------------
phase('Collision')
let collision = { overlaps: [], must_finish_before: [] }
if (plans.length > 1) {
  collision = (await agent(
    'Several delivery plans will run concurrently against these repos and one shared local dev stack. Find file or package overlaps between DIFFERENT scopes, and shared-state collisions (dev-stack services, message streams, databases). Shared-VM work is already serialized by a lock, so flag it only if ordering matters for correctness. Also report, as an overlap with risk "cross-repo", any package whose files or id suggest it really targets a different repository than its scope\'s. Emit must_finish_before only where concurrent work would genuinely conflict; scope keys: ' + plans.map((p) => p.s.key).join(', ') + '.\n\n' +
    plans.map((p) => 'SCOPE ' + p.s.key + ' (repo ' + p.s.repo_path + '):\n' + JSON.stringify(p.plan.waves.map((w) => ({ wave: w.wave, packages: w.packages.map((k) => ({ id: k.id, kind: k.kind, title: k.title, files: k.files, needs_vm: k.needs_vm, depends_on: k.depends_on })) })))).join('\n\n'),
    { label: 'collision', phase: 'Collision', model: 'fable', effort: 'medium', schema: COLLISION }
  )) || collision
}
const ORDER = (collision.must_finish_before || []).filter((o) => plans.some((p) => p.s.key === o.first) && plans.some((p) => p.s.key === o.then) && o.first !== o.then)
if (ORDER.length) log('Sequencing: ' + ORDER.map((o) => o.first + ' before ' + o.then + ' (' + o.reason + ')').join('; '))
for (const p of plans) {
  if (p.plan.user_decisions_needed && p.plan.user_decisions_needed.length) log(p.s.key + ': owner questions (proceeding with the reviewed plan): ' + p.plan.user_decisions_needed.join(' | '))
}

// ---------------------------------------------------------------------------
// Per package: vibe (thin wrapper) -> gates -> one review. No blocking finding:
// ship. Blocking findings: one fix round straight back to vibe with those items
// only -> gates -> a narrow re-check of those items; anything still open is not
// integrated and is filed as a follow-up.
// ---------------------------------------------------------------------------

// The vibe prompt for a package, built here from the reviewed plan; no agent
// rewrites it. mode: initial | continue | fix; a continuation inside a fix
// round carries both blocks.
function packagePrompt(c) {
  const { s, plan, base, pkg, wt, forkSha, mode, last, fixes, gates } = c
  const p = s.profile
  const verify = isVerify(pkg)
  const L = [
    'You are implementing work package "' + pkg.id + '" (' + pkg.title + ') of scope "' + s.key + '". Your working directory ' + wt + ' is a git worktree of ' + s.repo_path + ' on branch ' + pkg.branch + ', forked from ' + forkSha + ' (the integration branch ' + s.integration_branch + '). Today is ' + A.today + '.',
    'KIND: ' + (verify ? 'verify_only' : 'change'),
    '',
    inheritedNote(s, base, 'vibe'),
    '',
    'SCOPE SUMMARY: ' + plan.summary,
    'KEY DECISIONS: ' + JSON.stringify((plan.decisions || []).map((d) => d.decision)),
    '',
    'PACKAGE SPEC:',
    pkg.spec,
    '',
    'ACCEPTANCE CRITERIA:',
    ...(pkg.acceptance || []).map((a) => '- ' + a),
    '',
    'TEST COMMANDS (run them; they must pass' + (verify ? '; they also run mechanically as gates after you finish' : '') + '):',
    ...((pkg.tests || []).length ? pkg.tests.map((t) => '- `' + t + '`') : ['- (none listed: add and run the tests the spec asks for)']),
    '',
    'ALLOWED PATHS (enforced mechanically: changing, creating or deleting anything else fails the run): ' + JSON.stringify(pkg.files),
    'Commit with conventional-commit messages ending in "(' + s.key + ' ' + pkg.id + ')". Do not push. End with a clean working tree: commit or delete every file you create.',
  ]
  if (verify) {
    L.push('This is a verify_only package: the work is expected to be on your branch already. Check it against the spec and the acceptance criteria and run the test commands. Then write a short verification note to `' + VERIFY_NOTE + '` at the repository root (do not commit it; it is collected automatically): what you checked, each command you ran with its result, and your conclusion. Zero commits is a valid outcome. Commit only a small in-scope correction the spec calls for.')
  } else {
    L.push('This is a change package: it is delivered only if it ends with at least one new commit.')
  }
  L.push('BLOCKED: if the spec\'s premise is false (what it asks for is already present, a file or symbol it names does not exist, or it cannot be done within the allowed paths), do not invent work and do not touch other paths: write the reason, with the evidence (commands and output), to `' + BLOCKED_NOTE + '` at the repository root, do not commit it, and stop. The workflow then stops this package and reports it.')
  if (mode === 'continue') {
    L.push('',
      'CONTINUATION. A previous vibe run on this branch ended without delivering. Its result: ' + JSON.stringify({ reasons: (last && last.reasons) || [], commits: (last && last.commits) || [], status_short: (last && last.status_short) || [], out_of_scope: (last && last.out_of_scope) || [] }) + '. Its log: ' + ((last && last.out_dir) || '(unknown)') + '/vibe.log.',
      'Start with `git status` and `git log --oneline ' + forkSha + '..HEAD`. Keep what is done; finish what remains. Commit in-scope leftovers. Undo out-of-scope changes: `git restore` for uncommitted edits, a revert commit for committed ones (never reset --hard or rewrite history).')
  }
  // Additive with CONTINUATION: a fix round that ends mid-way keeps its fixes.
  if (fixes && fixes.length) {
    L.push('',
      'FIX ROUND. Your branch was reviewed. Fix exactly these blocking findings, as new commits on top (never amend or rewrite the earlier ones). Nothing else: the reviewer\'s other findings are recorded as follow-ups and must not be addressed in this round.',
      ...(fixes || []).map((f, i) => (i + 1) + '. ' + f),
      'Gate results for the reviewed head: ' + gateSummary(gates) + '.',
      verify ? 'Write a fresh `' + VERIFY_NOTE + '` covering the fixes.' : 'The round is delivered only if it adds at least one new commit.')
  }
  if (pkg.needs_vm && p.vm) L.push('', 'This package needs the VM ' + p.vm.ssh + '. This run holds the lock ' + p.vm.lock + ' for its whole duration, so you are the only VM user while it runs. Leave the VM clean: tear down everything you created.')
  L.push('', houseRules(s), '', VIBE_RULES)
  return L.join('\n')
}

async function deliverPackage(s, plan, setup, pkg, forkSha) {
  const p = s.profile
  const key = s.key
  const pdir = RUN + '/' + key + '/' + pkg.id
  const wt = p.worktree_root + '/' + slug(pkg.branch)
  const lock = pkg.needs_vm && p.vm ? p.vm.lock : null
  const verify = isVerify(pkg)
  const rec = { id: pkg.id, kind: pkg.kind, high_risk: !!pkg.high_risk, title: pkg.title, branch: pkg.branch, worktree: wt, fork_sha: forkSha, runs: [], rounds: [], final: null, reason: '', head: null, integrated: false, verification_note: null, deferred: [], open_items: [] }
  let runNo = 0
  let gates = null
  const packageGates = (round) => gatesRun({
    label: 'gates:' + key + ':' + pkg.id + ':r' + round, phase: 'Review', wt, base: forkSha, out: pdir + '/gates-r' + round, level: 'package', profileJson: s.profile_json, allow: pkg.files,
    verifyPaths: verify ? pkg.files : [], extraCmds: verify ? pkg.tests : [],
  })

  // Up to MAX_RUNS vibe runs: the first in `mode`, the rest continuations.
  async function drive(mode, fixes, since) {
    let last = null
    let m = mode
    for (let i = 0; i < MAX_RUNS; i++) {
      runNo++
      const out = pdir + '/run' + runNo
      const G = guards(s)
      const setupSteps = ['Run `' + WTS + ' create --repo ' + q(s.repo_path) + ' --path ' + q(wt) + ' --branch ' + q(pkg.branch) + ' --from ' + forkSha + ' --reuse`. If it prints EXISTS, stop and return status "START_FAILED: " plus its output, raw "".']
      const res = await vibeRun({
        label: 'vibe:' + key + ':' + pkg.id + ':' + runNo, phase: 'Deliver', setup: setupSteps, wt, base: forkSha, since,
        promptFile: out + '/prompt.md', promptText: packagePrompt({ s, plan, base: setup.base, pkg, wt, forkSha, mode: m, last, fixes, gates }),
        out, allow: pkg.files, lock, expectCommits: verify ? 'any' : 'yes', expectFile: verify ? VERIFY_NOTE : '', blockedFile: BLOCKED_NOTE,
        guardRefs: G.guardRefs, mrCheckCmd: G.mrCheckCmd,
      })
      rec.runs.push({ run: runNo, mode: m, delivered: !!res.delivered, reasons: res.reasons || [], head: res.head || null, new_commits: res.new_commits, commits: res.commits || [], out_of_scope: res.out_of_scope || [], blocked: !!res.blocked, policy_violations: res.policy_violations || [], policy_check_errors: res.policy_check_errors || [], start_failed: res.start_failed || '' })
      if (res.policy_violations && res.policy_violations.length) return { ok: false, policy: true, why: 'POLICY VIOLATION (the package is stopped, no further rounds): ' + res.policy_violations.join('; ') }
      if (res.policy_check_errors && res.policy_check_errors.length) log(key + ':' + pkg.id + ': policy check could not run: ' + res.policy_check_errors.join('; '))
      if (res.blocked) return { ok: false, blocked: true, why: 'vibe reported the package blocked (no continuation): ' + (res.blocked_text || '(see ' + out + '/' + BLOCKED_NOTE + ')') }
      if (res.start_failed && !/PROMPT_MISMATCH/.test(res.start_failed)) return { ok: false, why: 'run could not start: ' + res.start_failed }
      if (res.delivered) {
        if (verify) rec.verification_note = res.expect_file || out + '/' + VERIFY_NOTE
        return { ok: true, res }
      }
      log(key + ':' + pkg.id + ': run ' + runNo + ' not delivered: ' + JSON.stringify(res.reasons || []))
      // A prompt the wrapper did not copy verbatim is retried as-is; anything else continues.
      if (!res.start_failed) {
        last = res
        m = 'continue'
      }
    }
    return { ok: false, why: 'not delivered after ' + MAX_RUNS + ' runs; last reasons ' + JSON.stringify((last && last.reasons) || []) }
  }

  const d0 = await drive('initial', null, forkSha)
  if (!d0.ok) {
    rec.final = d0.policy ? 'policy_violation' : d0.blocked ? 'blocked' : 'failed'
    rec.reason = d0.why
    return rec
  }

  // ---- the one review (Sonnet; Fable for a high-risk package) ----
  gates = await packageGates(0)
  const gatesOk = gatesPassed(gates, verify)
  const reviewer = pkg.high_risk ? 'fable' : 'sonnet'
  const rev = await agent([
    'You are the REVIEWER for work package "' + pkg.id + '" (' + (verify ? 'verify_only' : 'change') + (pkg.high_risk ? ', HIGH RISK' : '') + ') of scope "' + key + '". vibe wrote the code on branch ' + pkg.branch + ' in worktree ' + wt + ', forked from ' + forkSha + '. This is the package\'s only review: nobody reviews it again, except for a narrow re-check of the blocking findings you list.',
    'PACKAGE (JSON): ' + JSON.stringify(pkg),
    inheritedNote(s, setup.base, 'reviewer').split('\n')[0],
    'Mechanical gate results (already run; do NOT re-run builds or tests): ' + gateSummary(gates) + '. Full gate log: ' + (gates ? gates.log : '(none)') + '; per-gate logs are listed in it.' + (verify ? ' Gates named extra-N are this package\'s own test commands.' : ''),
    verify ? 'This is a verify_only package: zero commits is legitimate. vibe\'s verification note is at ' + (rec.verification_note || '(missing)') + '; judge whether it, the gate logs and the code actually establish every acceptance criterion.' : '',
    houseRules(s),
    'Review the actual diff (`git -C ' + q(wt) + ' diff ' + forkSha + '..HEAD` and `git log`), not any report. For every acceptance criterion say whether it is met and cite the evidence (diff hunk or gate log line). Check correctness, concurrency, security, error handling, whether new tests would fail without the change (reason from the code and the base version), docs and ADR consistency, and scope creep. Do not edit anything.',
    'Classify EVERY finding:',
    '- blocking: a correctness, concurrency or data-integrity bug; a security problem; a false or fabricated claim in code comments, docs, commit messages or bookkeeping (for example "proof X ran" when it did not, or a test said to cover a case it does not); an acceptance criterion not met in a way that leaves the delivered behaviour wrong or a claim false.',
    '- deferrable: everything else: wording, line-number citations, style, naming, missing polish, extra tests that would be nice, follow-on improvements.',
    'How your findings are used: work ships as soon as it has no blocking finding (deferrable findings are recorded as follow-ups in the repository\'s bookkeeping and the MR description, not fixed now). If there are blocking findings, vibe gets exactly those, once, and a short re-check verifies only them. So an unmet acceptance criterion must also appear as a finding with its severity, not only in `acceptance`, and every blocking finding needs a required_fix concrete enough for a coder with no other context. Do not inflate severity to get polish done, and do not downgrade a real bug to keep work moving.',
    'Verdict: ship (no blocking finding), fix (at least one blocking finding) or reject (the approach itself is wrong, so fixing findings cannot save it; say why in reject_reason).',
  ].filter(Boolean).join('\n'), { label: 'review:' + key + ':' + pkg.id + ':r0', phase: 'Review', model: reviewer, effort: 'high', schema: REVIEW })

  if (!rev) {
    // Never ship on silence, and never invent a fix list for one.
    rec.rounds.push({ round: 0, gates: gateSummary(gates), reviewer, review: null })
    rec.final = 'review_failed'
    rec.reason = 'the ' + reviewer + ' reviewer returned nothing; not shipped without a review'
    return rec
  }
  const findings = (rev.findings || []).filter((f) => f && typeof f.summary === 'string')
  const blocking = findings.filter((f) => f.severity === 'blocking')
  rec.deferred = findings.filter((f) => f.severity !== 'blocking')
  if (!gatesOk) blocking.push(gateFinding(gates, verify))
  rec.rounds.push({ round: 0, gates: gateSummary(gates), reviewer, review: rev.verdict, blocking: blocking.length, deferrable: rec.deferred.length })

  if (rev.verdict === 'reject') {
    rec.final = 'rejected'
    rec.reason = 'reviewer rejected the approach: ' + (rev.reject_reason || '(no reason given)')
    rec.open_items = blocking
    return rec
  }
  if (!blocking.length) {
    rec.final = 'approved'
    rec.head = gates.head
    return rec
  }

  // ---- one vibe fix round with the blocking items only, gates, narrow re-check ----
  const reviewedHead = gates && isSha(gates.head) ? gates.head : forkSha
  log(key + ':' + pkg.id + ': fix round: ' + blocking.length + ' blocking finding(s); ' + rec.deferred.length + ' deferrable recorded as follow-ups')
  const d = await drive('fix', blocking.map(fixText), reviewedHead)
  if (!d.ok) {
    rec.final = d.policy ? 'policy_violation' : d.blocked ? 'blocked' : 'failed'
    rec.reason = 'fix round: ' + d.why
    rec.open_items = blocking
    return rec
  }
  gates = await packageGates(1)
  const fixedOk = gatesPassed(gates, verify)
  const reviewed = blocking.filter((f) => !f.from_gates)
  const open = []
  let rc = null
  if (reviewed.length) {
    rc = await agent([
      'You are the RE-CHECKER for work package "' + pkg.id + '" of scope "' + key + '" (branch ' + pkg.branch + ', worktree ' + wt + '). Its reviewer listed the blocking findings below; vibe then made one fix round. Check ONLY these items. This is not a review: do not look for anything else, and do not re-run builds or tests.',
      'BLOCKING ITEMS:',
      ...reviewed.map((f, i) => (i + 1) + '. ' + fixText(f)),
      'The fix round\'s diff: `git -C ' + q(wt) + ' diff ' + reviewedHead + '..HEAD` (the head the reviewer saw was ' + reviewedHead + '). Gate results after the fix (already run): ' + gateSummary(gates) + '.' + (verify ? ' Verification note: ' + (rec.verification_note || '(missing)') + '.' : ''),
      'For each item return its number, resolved (true only if the current code, not a report or a commit message, fixes it as required) and the evidence (a diff hunk, a file:line or a gate log line).',
    ].join('\n'), { label: 'recheck:' + key + ':' + pkg.id + ':r1', phase: 'Review', model: 'sonnet', effort: 'medium', schema: RECHECK })
    reviewed.forEach((f, i) => {
      const it = rc && Array.isArray(rc.items) ? rc.items.find((x) => x && x.index === i + 1) : null
      if (!(it && it.resolved === true)) open.push(Object.assign({}, f, { evidence: it ? it.evidence : rc ? 'the re-check did not report this item' : 'the re-check returned nothing' }))
    })
  }
  if (!fixedOk) open.push(gateFinding(gates, verify))
  rec.rounds.push({ round: 1, gates: gateSummary(gates), recheck: rc ? rc.items : reviewed.length ? null : 'not needed (gate items only)', open: open.length })
  if (open.length) {
    rec.final = 'blocking_open'
    rec.reason = open.length + ' blocking item(s) still open after the fix round: ' + open.map((f) => f.summary).join(' | ')
    rec.open_items = open
    rec.head = gates && isSha(gates.head) ? gates.head : null
    return rec
  }
  rec.final = 'approved'
  rec.head = gates.head
  return rec
}

// ---------------------------------------------------------------------------
// Integration: serial per scope
// ---------------------------------------------------------------------------
async function integrate(s, setup, rec) {
  const p = s.profile
  const key = s.key
  const idir = RUN + '/' + key + '/integrate-' + rec.id
  const wtq = q(setup.integration_worktree)
  const pushStep = p.no_remote ? null : 'Run `git -C ' + wtq + ' push ' + q(p.remote) + ' ' + q(setup.integration_branch) + '`.'
  const removeStep = 'Run `' + WTS + ' remove --repo ' + q(s.repo_path) + ' --path ' + q(rec.worktree) + '`.'

  // A verify-only package with no commits has nothing to merge: its gates ran on the fork tree.
  if (rec.head === rec.fork_sha) {
    const r = await mech('publish:' + key + ':' + rec.id, 'Integrate', [removeStep])
    rec.integrated = true
    rec.integration = { ok: true, head: setup.head, merged: false, note: 'verified with no commits; nothing to merge', verification_note: rec.verification_note, publish: r ? r.output : 'cleanup step died' }
    return true
  }

  // integrator "script": a mechanical merge; Sonnet only when it conflicts.
  let m = null
  let conflictNote = ''
  if (INTEGRATOR === 'script') {
    const r = await scriptRun('merge:' + key + ':' + rec.id, 'Integrate', ['Run `' + SB + ' merge --wt ' + wtq + ' --branch ' + q(rec.branch) + ' --pkg-head ' + rec.head + ' --fork ' + rec.fork_sha + ' --expect-head ' + setup.head + '`.'])
    if (r.ok && r.merged && isSha(r.head) && isSha(r.pre_merge_sha)) {
      m = { merged: true, pre_merge_sha: r.pre_merge_sha, head: r.head, conflicts: false, notes: 'merged by scope-branch.sh merge' + (r.tree_equal ? '; tree equals the gated package tree' : '') }
    } else if (r.conflicts) {
      conflictNote = ' The mechanical merge conflicted in ' + JSON.stringify(r.files || []) + ' and was aborted; HEAD is back at ' + r.pre_merge_sha + '.'
      log(key + ':' + rec.id + ': mechanical merge conflicts; handing it to the Sonnet integrator')
    } else {
      rec.final = 'integration_failed'
      rec.reason = 'integration (script): ' + (r.reason || 'no result')
      rec.integration = { ok: false, reason: rec.reason }
      return false
    }
  }
  if (!m) {
    m = await agent([
      'Merge the shipped work package "' + rec.id + '" (branch ' + rec.branch + ', head ' + rec.head + ') into the integration branch ' + setup.integration_branch + ' in worktree ' + setup.integration_worktree + ' (repo ' + s.repo_path + ').' + conflictNote,
      houseRules(s),
      'Steps: (1) record pre_merge_sha = `git -C <worktree> rev-parse HEAD`; the tree must be clean. (2) `git -C <worktree> merge --no-ff ' + rec.branch + '`. (3) On conflicts, resolve them preserving both sides\' intent and complete the merge; set conflicts=true and explain each resolution in notes. If you cannot resolve them safely, `git merge --abort` and return merged=false. (4) Do NOT push and do not run test suites (gates run next, mechanically). Return merged, pre_merge_sha, head (full sha after the merge), conflicts, notes.',
    ].join('\n'), { label: 'integrate:' + key + ':' + rec.id, phase: 'Integrate', model: 'sonnet', schema: INTEG })
  }
  if (!m || !m.merged || !isSha(m.head) || !isSha(m.pre_merge_sha)) {
    rec.final = 'integration_failed'
    rec.reason = 'integration: ' + (m ? m.notes : 'integrator died')
    rec.integration = { ok: false, reason: m ? m.notes : 'integrator died' }
    return false
  }

  // If the package forked from the pre-merge head, the merge's tree must equal
  // the package tree that already passed its gates: prove it, then skip the re-run.
  if (m.pre_merge_sha === rec.fork_sha) {
    const steps = ['Run `test "$(git -C ' + wtq + ' rev-parse HEAD)" = ' + m.head + ' && test "$(git -C ' + wtq + ' rev-parse HEAD^1)" = ' + rec.fork_sha + ' && test "$(git -C ' + wtq + ' rev-parse HEAD^{tree})" = "$(git -C ' + wtq + ' rev-parse ' + rec.head + '^{tree})" && echo TREE_EQUAL`.']
    if (pushStep) steps.push(pushStep)
    steps.push(removeStep)
    const r = await mech('publish:' + key + ':' + rec.id, 'Integrate', steps, true)
    if (r && r.ok) {
      rec.integrated = true
      setup.head = m.head
      rec.integration = { ok: true, head: m.head, conflicts: m.conflicts, gates: 'not re-run: the merge tree equals the gated package tree ' + short(rec.head), publish: r.output }
      return true
    }
    log(key + ':' + rec.id + ': tree-equality proof or publish failed (' + (r ? r.output : 'agent died') + '); running the integration gates')
  }

  const g = await gatesRun({ label: 'gates:' + key + ':integrate-' + rec.id, phase: 'Integrate', wt: setup.integration_worktree, base: setup.gates_base, out: idir + '/gates', level: 'package', profileJson: s.profile_json })
  if (g && g.ok && g.head === m.head) {
    const steps = []
    if (pushStep) steps.push(pushStep)
    steps.push(removeStep)
    const r = await mech('publish:' + key + ':' + rec.id + ':gated', 'Integrate', steps)
    rec.integrated = true
    setup.head = m.head
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
// Per scope: [refresh] -> setup -> waves -> integrate -> MR prep -> MR merge
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Follow-ups: every deferrable finding of a reviewed package and every package
// that was not integrated (with its open items, branch and evidence). They are
// returned as structured data (input for a next run), written by MR prep into
// the profile's bookkeeping.followup_file, and listed in the MR description.
// Each line carries a tag [vd:<scope>/<package>] the merge stage greps for.
// ---------------------------------------------------------------------------
const FOLLOWUP_HEADING = '## Deferred / follow-ups'
const followupTag = (scope, id) => 'vd:' + scope + '/' + id
function packageFollowups(s, r) {
  const base = { scope: s.key, repo: s.repo_path, integration_branch: s.integration_branch, package: r.id, title: r.title || '', branch: r.branch || '', final: r.final, date: A.today, run_tag: A.run_tag }
  const where = 'run dir ' + RUN + '/' + s.key + '/' + r.id + (r.worktree ? '; worktree ' + r.worktree : '') + (r.head ? '; head ' + r.head : '')
  const out = []
  const add = (kind, f, evidence) => out.push(Object.assign({}, base, { kind, severity: f.severity || '', summary: f.summary, file: f.file || '', line: f.line || '', required_fix: f.required_fix || '', evidence: evidence || '' }))
  if (!r.integrated) {
    const items = r.open_items || []
    if (items.length) for (const f of items) add('not_integrated', f, (f.evidence ? f.evidence + '; ' : '') + where)
    else add('not_integrated', { summary: r.final + ': ' + (r.reason || '(no reason recorded)') }, where)
  }
  for (const f of r.deferred || []) add('deferred', f, '')
  return out
}
function followupLine(f) {
  return '- [ ] ' + f.date + ' follow-up (' + (f.kind === 'deferred' ? 'deferred finding' : 'not integrated: ' + f.final) + ') from scope ' + f.scope + ', package ' + f.package + ', branch ' + (f.branch || '(none)') + ': ' + f.summary +
    (f.file ? ' (' + f.file + (f.line ? ':' + f.line : '') + ')' : '') +
    (f.required_fix ? '. Needed: ' + f.required_fix : '') +
    (f.kind !== 'deferred' && f.evidence ? '. Evidence: ' + f.evidence : '') +
    ' [' + followupTag(f.scope, f.package) + ']'
}
const followupBlock = (fus) => FOLLOWUP_HEADING + '\n\n' + (fus.length ? fus.map(followupLine).join('\n') : 'None.')

function mrPrompt(s, plan, setup, integrated, notIntegrated, followups, fixOf) {
  const p = s.profile
  const L = [
    'You are preparing the merge request for scope "' + s.key + '" in your working directory, which is the integration worktree of branch ' + setup.integration_branch + '. Today is ' + A.today + '.',
    houseRules(s),
    '',
  ]
  if (fixOf) {
    L.push(
      'FIX RUN. After MR prep, the full gates failed on this branch: ' + gateSummary(fixOf) + '. Read the gate logs listed in ' + fixOf.log + '.',
      'Fix only breakage this branch introduced (most likely through the merge of ' + p.base_ref + '). Failures that also occur on ' + p.base_ref + ' are not yours to fix. Commit the fixes, then push the integration branch, and only it: ' + (p.no_remote ? '(this repo has no remote: do not push).' : '`git push ' + p.remote + ' ' + setup.integration_branch + '`.') + ' Do not run the full gates yourself: they run again after you, mechanically.',
      'Do NOT open, approve or merge a merge request.'
    )
  } else {
    L.push(
      'Integrated packages: ' + JSON.stringify(integrated.map((r) => ({ id: r.id, kind: r.kind, title: r.title, verification_note: r.verification_note || undefined }))),
      'NOT integrated (their plan-of-record entries stay unticked; each is filed as a follow-up below): ' + JSON.stringify(notIntegrated.map((r) => ({ id: r.id, final: r.final, reason: r.reason }))),
      '',
      'Steps:',
      (p.remote ? '1. `git fetch ' + p.remote + '` then `git merge --no-edit ' + p.base_ref + '`.' : '1. `git merge --no-edit ' + p.base_ref + '`.') + ' Resolve conflicts preserving both sides\' intent; commit the merge. If you resolved conflicts in code, run the package-level gates on what you touched: `' + GT + ' run --profile ' + q(s.profile_json) + ' --wt . --base ' + q(p.base_ref) + ' --out ' + q(RUN + '/' + s.key + '/mr-prep/vibe-gates-N') + ' --level package` (N = 1, 2, ...: a new out dir each time). Do not run the full gates: they run once after you, mechanically.',
      '2. Bookkeeping in ' + p.bookkeeping.files.join(', ') + ': tick the entries this scope completed, with completion notes (' + p.bookkeeping.convention + '). Leave the entries of packages that were not integrated unticked. Stage only your own hunks. Commit.',
      followups.length
        ? '3. Follow-ups (mandatory: none may be left out). Add every line between BEGIN-FOLLOWUPS and END-FOLLOWUPS below to ' + p.bookkeeping.followup_file + ', where that file\'s convention puts new open items (' + p.bookkeeping.convention + '). You may adapt each line\'s form to the convention, but every entry must keep its date, scope, package, branch, finding and its trailing [vd:...] tag, which is checked mechanically. Stage only your own hunks. Commit.\nBEGIN-FOLLOWUPS\n' + followups.map(followupLine).join('\n') + '\nEND-FOLLOWUPS'
        : '3. There are no follow-ups to file.',
      p.no_remote ? '4. This repo has no remote: do not push.' : '4. Push the integration branch, and only it: `git push -u ' + p.remote + ' ' + setup.integration_branch + '`.',
      '5. Write the merge request description to ' + RUN + '/' + s.key + '/mr-prep/description.md (outside the repository): what changed, the packages (integrated, verified without changes, and not integrated), and anything not done. Then a "' + FOLLOWUP_HEADING + '" section holding exactly the follow-up lines above (or "None."). Leave a final "## Gates" heading empty: the mechanical full-gate results are appended after you. Every claim must be checkable against the diff; write nothing you have not verified. Starting point: ' + JSON.stringify(plan.mr_description),
      'Do NOT open, approve or merge a merge request: a later stage does that after every check.'
    )
  }
  L.push('', VIBE_RULES)
  return L.join('\n')
}

const done = {}
async function runScope(pl) {
  const s = pl.s
  const p = s.profile
  const key = s.key
  const plan = pl.plan
  const out = { scope: key, repo: s.repo_path, integration_branch: s.integration_branch, status: null, blockers: [], packages: [], plan_review: pl.review, owner_questions: plan.user_decisions_needed || [], inherited_commits: pl.base.inherited }
  const setup = { integration_worktree: pl.base.worktree, integration_branch: s.integration_branch, base_sha: pl.base.base_sha, head: pl.base.head, base: pl.base }
  out.integration_worktree = setup.integration_worktree

  let waited = false
  for (const o of ORDER.filter((x) => x.then === key)) {
    if (done[o.first]) {
      log(key + ': waiting for ' + o.first + ' (' + o.reason + ')')
      await done[o.first]
      waited = true
    }
  }
  if (waited) {
    // The branch was created before planning; bring in what the earlier scope merged.
    const rf = await scriptRun('refresh:' + key, 'Setup', ['Run `' + SB + ' refresh --wt ' + q(setup.integration_worktree) + ' --base-ref ' + q(p.base_ref) + (p.remote ? ' --remote ' + q(p.remote) : '') + '`.'])
    if (!rf.ok || !isSha(rf.head)) {
      out.status = 'needs_owner_decision'
      out.blockers.push('could not merge ' + p.base_ref + ' into the integration branch after waiting for the scopes it must follow: ' + (rf.reason || 'no head'))
      out.cleanup = [pl.planWt]
      return out
    }
    setup.head = rf.head
  }

  // SETUP: plan-of-record commit (and push), planner worktree removed. Mechanical.
  const entryFile = RUN + '/' + key + '/setup/plan-entry.md'
  const rec0 = [SB, 'record', '--wt', q(setup.integration_worktree), '--file', q(p.bookkeeping.plan_entry_file), '--entry', q(entryFile), '--entry-bytes', String(utf8Bytes(plan.bookkeeping_entry)), '--message', q('docs: plan of record for ' + key)]
  if (p.remote) rec0.push('--remote', q(p.remote), '--branch', q(s.integration_branch))
  const sr = await agent(mechPrompt([
    WRITE_STEP(entryFile, 'ENTRY'),
    'Run `' + rec0.join(' ') + '`. If its first line is FAILED and it mentions ENTRY_MISMATCH, rewrite the file exactly once more and run it again.',
    'Run `' + WTS + ' remove --repo ' + q(s.repo_path) + ' --path ' + q(pl.planWt) + '`.',
  ], 'Return through the schema: status = the first line step 2 printed the last time it ran (DONE or FAILED); raw = the line after it, copied character for character.\n\nBEGIN-ENTRY\n' + plan.bookkeeping_entry + '\nEND-ENTRY'), { label: 'setup:' + key, phase: 'Setup', model: 'haiku', effort: 'low', schema: RAW })
  const srr = parseRaw(sr)
  if (!srr || !srr.ok || !isSha(srr.head)) {
    out.status = 'failed'
    out.blockers.push('setup failed: ' + (srr ? srr.reason : (sr ? sr.status : 'agent died')))
    out.cleanup = [pl.planWt]
    return out
  }
  setup.head = srr.head
  // Integration gates cover what packages merged, not the inherited work or the plan entry.
  setup.gates_base = srr.head

  const recs = []
  const integratedIds = new Set()
  const waves = plan.waves.slice().sort((a, b) => a.wave - b.wave)
  for (const w of waves) {
    const runnable = []
    for (const pkg of w.packages) {
      const missing = (pkg.depends_on || []).filter((d) => !integratedIds.has(d))
      if (missing.length) {
        recs.push({ id: pkg.id, kind: pkg.kind, title: pkg.title, branch: pkg.branch, final: 'blocked_dependency', reason: 'blocked, not run: depends on ' + missing.join(', ') + ', which was not integrated', integrated: false })
        log(key + ':' + pkg.id + ': BLOCKED (not run), dependency not integrated: ' + missing.join(', '))
      } else {
        runnable.push(pkg)
      }
    }
    if (!runnable.length) continue
    // Every package of the wave forks from the same, workflow-known head.
    const forkSha = setup.head
    log(key + ': wave ' + w.wave + ': ' + runnable.length + ' package(s), fork ' + short(forkSha))
    // pipeline: each package goes vibe->review on its own; integration stays serial below.
    const delivered = await pipeline(runnable, (pkg) => deliverPackage(s, plan, setup, pkg, forkSha))
    for (let i = 0; i < runnable.length; i++) {
      const r = delivered[i] || { id: runnable[i].id, kind: runnable[i].kind, title: runnable[i].title, branch: runnable[i].branch, final: 'failed', reason: 'package pipeline crashed', integrated: false }
      recs.push(r)
      if (r.final !== 'approved') {
        log(key + ':' + r.id + ': NOT integrated (' + r.final + '): ' + r.reason)
        continue
      }
      if (setup.broken) {
        r.final = 'blocked_integration'
        r.reason = 'shipped by review but not merged: ' + setup.broken
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
    for (const w of waves) for (const pkg of w.packages) if (!seen.has(pkg.id)) recs.push({ id: pkg.id, kind: pkg.kind, title: pkg.title, branch: pkg.branch, final: 'blocked_integration', reason: 'not run: ' + setup.broken, integrated: false })
    out.blockers.push('integration branch unusable: ' + setup.broken)
  }
  out.packages = recs.map((r) => ({ id: r.id, kind: r.kind, high_risk: !!r.high_risk, final: r.final, reason: r.reason || '', integrated: !!r.integrated, branch: r.branch, worktree: r.worktree || null, verification_note: r.verification_note || null, deferred: r.deferred || [], open_items: r.open_items || [], runs: r.runs || [], rounds: r.rounds || [], integration: r.integration || null }))
  const integrated = recs.filter((r) => r.integrated)
  const notIntegrated = recs.filter((r) => !r.integrated)
  out.dropped = notIntegrated.map((r) => ({ id: r.id, final: r.final, reason: r.reason || '' }))
  // Every deferred finding and every package not integrated, built before any stop.
  const followups = [].concat(...recs.map((r) => packageFollowups(s, r)))
  out.followups = followups
  out.followups_recorded = null
  const policyHits = recs.filter((r) => r.final === 'policy_violation')
  if (policyHits.length) log(key + ': POLICY VIOLATION in ' + policyHits.map((r) => r.id + ' (' + r.reason + ')').join('; '))
  if (setup.broken) {
    out.status = 'needs_owner_decision'
    return out
  }
  if (!integrated.length) {
    out.status = 'needs_owner_decision'
    out.blockers.push('no package was integrated, so there is nothing to ship; every package is filed in followups')
    return out
  }

  // ---- MR PREP (vibe), then the full gates once, mechanically; one fix run if they fail ----
  const mdir = RUN + '/' + key + '/mr-prep'
  const allowed = [].concat(...integrated.map((r) => (allPackages(plan).find((k) => k.id === r.id) || { files: [] }).files), p.bookkeeping.files, [p.bookkeeping.plan_entry_file, p.bookkeeping.followup_file])
  // The full gates diff the branch against the base ref: inherited work is allowed by file.
  const inheritedAllow = setup.base.inherited && setup.base.files_file ? setup.base.files_file : ''
  const G = guards(s)
  let mr = await vibeRun({ label: 'mr-prep:' + key + ':1', phase: 'MR prep', wt: setup.integration_worktree, base: setup.head, promptFile: mdir + '/run1/prompt.md', promptText: mrPrompt(s, plan, setup, integrated, notIntegrated, followups, null), out: mdir + '/run1', allow: ['*'], expectCommits: 'yes', guardRefs: G.guardRefs, mrCheckCmd: G.mrCheckCmd })
  let full = mr.delivered ? await gatesRun({ label: 'gates:' + key + ':full:1', phase: 'MR prep', wt: setup.integration_worktree, base: p.base_ref, out: mdir + '/gates-full-1', level: 'full', profileJson: s.profile_json, allow: allowed, allowFile: inheritedAllow }) : null
  const mrRuns = [mr]
  if (mr.delivered && full && !full.ok && !(mr.policy_violations || []).length) {
    log(key + ': full gates not ok after MR prep (' + gateSummary(full) + '); one vibe fix run')
    const fix = await vibeRun({ label: 'mr-prep:' + key + ':2', phase: 'MR prep', wt: setup.integration_worktree, base: setup.head, since: mr.head, promptFile: mdir + '/run2/prompt.md', promptText: mrPrompt(s, plan, setup, integrated, notIntegrated, followups, full), out: mdir + '/run2', allow: ['*'], expectCommits: 'yes', guardRefs: G.guardRefs, mrCheckCmd: G.mrCheckCmd })
    mrRuns.push(fix)
    if (fix.delivered) {
      mr = fix
      full = await gatesRun({ label: 'gates:' + key + ':full:2', phase: 'MR prep', wt: setup.integration_worktree, base: p.base_ref, out: mdir + '/gates-full-2', level: 'full', profileJson: s.profile_json, allow: allowed, allowFile: inheritedAllow })
    }
  }
  const mrPolicy = [].concat(...mrRuns.map((r) => r.policy_violations || []))
  const mrPolicyErr = [].concat(...mrRuns.map((r) => r.policy_check_errors || []))
  out.mr_prep = { runs: mrRuns.length, delivered: !!mr.delivered, reasons: mr.reasons || [], head: mr.head || null, policy_violations: mrPolicy, policy_check_errors: mrPolicyErr }
  out.gates_full = full ? { ok: full.ok, clean: full.clean, head: full.head, summary: gateSummary(full) } : null

  // ---- MR MERGE gate (mechanical); only this stage opens or merges an MR ----
  const B = out.blockers
  // Packages not integrated do not stop the merge: they are filed as follow-ups.
  // The merge stops only on the conditions below.
  if (policyHits.length) B.push('POLICY VIOLATION in ' + policyHits.map((r) => r.id + ' (' + r.reason + ')').join('; ') + '; the owner must review what happened before anything ships')
  if (mrPolicy.length) B.push('POLICY VIOLATION in MR prep: ' + mrPolicy.join('; '))
  if (mrPolicyErr.length) B.push('policy could not be verified for MR prep (the stage that pushes): ' + mrPolicyErr.join('; '))
  if (!mr.delivered) B.push('MR prep did not deliver, so the full gates did not run: ' + JSON.stringify(mr.reasons || []))
  if (!full) B.push('full gates produced no result')
  else if (full.out_of_scope && full.out_of_scope.length) B.push('POLICY VIOLATION: the integration branch changes files outside every shipped package, the bookkeeping and the inherited work: ' + full.out_of_scope.join(', ') + ' (' + gateSummary(full) + ')')
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
  // Follow-ups must be visible but never stop the merge: the check is reported, not gated.
  const tags = [...new Set(followups.map((f) => followupTag(f.scope, f.package)))]
  const fuCheck = tags.length ? 'for t in ' + tags.map(q).join(' ') + '; do git -C ' + q(setup.integration_worktree) + ' diff ' + setup.gates_base + ' ' + full.head + ' -- ' + q(p.bookkeeping.followup_file) + ' | grep \'^+\' | grep -qF -- "$t" || echo "MISSING $t"; done; echo FOLLOWUPS_CHECKED' : ''
  const merged = await agent([
    'You are the MR MERGE stage for scope "' + key + '": the only stage allowed to open and merge a merge request. Every gate has been checked mechanically; do not change code, bookkeeping or branches. Work from ' + setup.integration_worktree + '.',
    '1. `git ls-remote ' + q(p.remote) + ' refs/heads/' + s.integration_branch + '` must print ' + full.head + '. If not, stop: merged=false.',
    p.merge.mr_exists_command ? '2. `' + p.merge.mr_exists_command.replace(/\{branch\}/g, s.integration_branch) + '` must print 0 (no MR exists yet). If it prints anything else, stop: merged=false, and say which MR exists.' : '2. (no MR-existence check configured)',
    '3. If ' + mdir + '/description.md is missing, write one from the plan (' + JSON.stringify(plan.mr_description) + '). Make its "' + FOLLOWUP_HEADING + '" section (add it before "## Gates" if missing) hold exactly the text between BEGIN-FOLLOWUPS and END-FOLLOWUPS at the end of this message, replacing whatever that section held. Then make its "## Gates" section (add the heading if missing) say exactly: ' + JSON.stringify(gateSummary(full)) + ', and name each gate that hit only known ' + p.base_ref + ' failures.' +
      (fuCheck ? ' Then run `' + fuCheck + '` and copy its whole output into followups_check (this only reports; whatever it prints, go on).' : ''),
    '4. Open the MR: `' + openCmd + '`. Note its number (iid) and URL.',
    '5. Merge it: `' + mergeCmd + '` with {iid} replaced by that number. ' + (p.merge.notes || ''),
    'The sha ' + full.head + ' is the gated head: never merge any other.',
    '6. Confirm the MR shows as merged. Return merged, merge_commit, mr_url, followups_check, notes.',
    '',
    'BEGIN-FOLLOWUPS',
    followupBlock(followups).split('\n').slice(2).join('\n'),
    'END-FOLLOWUPS',
  ].join('\n'), { label: 'mr-merge:' + key, phase: 'MR merge', model: 'sonnet', schema: MERGE })
  out.mr = merged || null
  if (!tags.length) out.followups_recorded = true
  else if (merged && typeof merged.followups_check === 'string' && /FOLLOWUPS_CHECKED/.test(merged.followups_check)) {
    const missing = (merged.followups_check.match(/MISSING \S+/g) || []).map((x) => x.slice(8))
    out.followups_recorded = !missing.length
    if (missing.length) {
      out.followups_missing = missing
      log(key + ': follow-ups not found in ' + p.bookkeeping.followup_file + ': ' + missing.join(', ') + ' (file them by hand from the result)')
    }
  }
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
  if (o.status === 'plan_failed' && o.integration_worktree) worktrees.push({ path: o.integration_worktree, why: 'integration branch created before planning; the scope never ran (remove, and delete the local branch if unwanted)' })
  for (const pk of o.packages || []) if (!pk.integrated && pk.worktree) worktrees.push({ path: pk.worktree, why: 'package ' + pk.id + ' ' + pk.final + ': inspect, then remove' })
}
// Structured follow-ups for the whole run: a next run takes them as input
// (a scope request's `followups`). A scope that stopped before its packages ran
// is one entry of its own.
const followups = []
for (const o of all) {
  if (o.followups) followups.push(...o.followups)
  else if (o.status !== 'merged') {
    const sc = A.scopes.find((x) => x.key === o.scope) || {}
    followups.push({ scope: o.scope, repo: sc.repo_path || '', integration_branch: sc.integration_branch || '', package: '', title: '', branch: sc.integration_branch || '', final: o.status, kind: 'scope_not_delivered', severity: '', summary: (o.blockers || []).join(' | ') || o.status, file: '', line: '', required_fix: '', evidence: RUN + '/' + o.scope, date: A.today, run_tag: A.run_tag })
  }
}
return {
  run_tag: A.run_tag,
  rundir: RUN,
  summary: all.map((o) => o.scope + ': ' + o.status + (o.dropped && o.dropped.length ? ' (not integrated: ' + o.dropped.map((d) => d.id + '=' + d.final).join(', ') + ')' : '') + (o.followups && o.followups.length ? ' (' + o.followups.length + ' follow-up(s)' + (o.followups_recorded === false ? ', NOT all recorded in the bookkeeping' : '') + ')' : '')),
  scopes: all,
  followups,
  collision,
  worktrees_to_clean: worktrees,
}
