// Mock harness for workflow.js: runs the real workflow script with agent(),
// pipeline() and parallel() stubbed, scripts each package's outcome per case,
// asserts on outcomes and prompts, and counts Claude agents per package.
//
//   node harness.mjs [WORKFLOW.js]        (default: ../workflow.js)
//   CASES=clean,reject node harness.mjs   (run a subset)
//
// No real agent, vibe, git or network call is made. Exit status 1 on any
// assertion failure.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const wfPath = process.argv[2] || path.join(here, '..', 'workflow.js')
const src = fs.readFileSync(wfPath, 'utf8').replace(/^export const meta/m, 'const meta')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const workflow = new AsyncFunction('args', 'agent', 'pipeline', 'parallel', 'phase', 'log', 'budget', src)
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"

function mockArgs(integrator) {
  return {
    run_tag: 'mock1', today: '2026-01-02', jobdir: '/jobs/demo', rundir: '/jobs/demo/vd/mock1', skill_dir: '/SK',
    max_vibe_runs: 3, max_turns: 150, integrator, plan_schema: { type: 'object' },
    scopes: [{
      key: 'demo', repo_path: '/repo/demo', brief: 'b', integration_branch: 'fix/demo', build_on_branch: 'old/branch',
      profile_json: '/jobs/demo/profiles/demo.json', profile_path: '/repo/demo/.claude/vibe-delivery.yaml',
      profile: {
        version: 1, repo: 'demo', default_branch: 'main', remote: 'origin', no_remote: false, base_ref: 'origin/main', worktree_root: '/wt',
        bookkeeping: { files: ['TODO.md', 'BACKLOG.md'], plan_entry_file: 'TODO.md', followup_file: 'BACKLOG.md', convention: 'c' },
        merge: { open_command: 'forge mr create {source}', command: 'forge mr merge {iid} --sha {sha}', mr_exists_command: 'count {branch}' },
        vm: { ssh: 'u@vm', lock: 'vmlock' }, gates: [{ name: 't', cmd: 'true' }],
      },
    }],
  }
}

// Package scripts. review: ship | deferrable | blocking | reject | null.
// recheck: true (resolved) | false. Other flags: high_risk, wave, deps, policy,
// conflict (script integrator), fixGatesRed.
const CASES = {
  clean: { pkgs: { 'wp1': { review: 'ship' } } },
  deferrable: { pkgs: { 'wp1': { review: 'deferrable' } } },
  'blocking-fixed': { pkgs: { 'wp1': { review: 'blocking', recheck: true } } },
  'blocking-open': { pkgs: { 'wp1': { review: 'blocking', recheck: false }, 'wp2': { review: 'ship' } } },
  'fix-gates-red': { pkgs: { 'wp1': { review: 'blocking', recheck: true, fixGatesRed: true }, 'wp2': { review: 'ship' } } },
  reject: { pkgs: { 'wp1': { review: 'reject' }, 'wp2': { review: 'ship' } } },
  policy: { pkgs: { 'wp1': { policy: true }, 'wp2': { review: 'ship' } } },
  'high-risk': { pkgs: { 'wp1': { review: 'ship', high_risk: true } } },
  'zero-integrated': { pkgs: { 'wp1': { review: 'reject' } } },
  'dep-blocked': { pkgs: { 'wp1': { review: 'blocking', recheck: false }, 'wp2': { review: 'ship' }, 'wp3': { review: 'ship', wave: 2, deps: ['wp1'] } } },
  'review-died': { pkgs: { 'wp1': { review: null }, 'wp2': { review: 'ship' } } },
  'script-clean': { integrator: 'script', pkgs: { 'wp1': { review: 'ship' } } },
  'script-conflict': { integrator: 'script', pkgs: { 'wp1': { review: 'ship', conflict: true } } },
  'followups-missing': { missingTag: true, pkgs: { 'wp1': { review: 'deferrable' } } },
}

async function runCase(name, C) {
  const args = mockArgs(C.integrator || 'sonnet')
  const scope = args.scopes[0]
  const ids = Object.keys(C.pkgs)
  const fails = []
  const check = (cond, msg) => { if (!cond) fails.push(msg) }
  let shaN = 100
  const sha = () => String(shaN++).padStart(40, '0')
  const raw = (o, extra) => Object.assign({ status: 'DONE', raw: JSON.stringify(o) }, extra || {})
  const calls = []
  const prompts = {}
  const H = {}
  const pkgHead = {}
  const forkOf = {}
  let mrHead = null
  const plan = () => ({
    scope: scope.key, repo_path: scope.repo_path, integration_branch: scope.integration_branch, summary: 's', re_and_sources: [], decisions: [], user_decisions_needed: [],
    bookkeeping_entry: '- [ ] entry ü', mr_title: 't', mr_description: 'd',
    waves: [1, 2].map((w) => ({
      wave: w,
      packages: ids.filter((id) => (C.pkgs[id].wave || 1) === w).map((id) => {
        const x = C.pkgs[id]
        const k = { id, kind: 'change', repo_path: scope.repo_path, title: id, branch: scope.integration_branch + '-' + id, files: ['src/' + id + '/'], spec: 'spec ' + id, acceptance: ['a'], tests: ['make test-' + id], needs_vm: false, depends_on: x.deps || [] }
        if (x.high_risk) k.high_risk = true
        return k
      }),
    })).filter((w) => w.packages.length),
  })

  async function agent(prompt, opts) {
    const l = opts.label
    calls.push({ label: l, model: opts.model })
    prompts[l] = prompt
    const parts = l.split(':')
    const key = parts[1] || ''
    const id = parts[2]
    const S = C.pkgs[id] || {}
    check(!/^adjudicate/.test(l), 'an adjudicator ran: ' + l)
    if (l.startsWith('base:')) { H[key] = sha(); return raw({ ok: true, worktree: '/wt/int', branch: scope.integration_branch, head: H[key], base_sha: sha(), inherited: 1, inherited_file: '/run/base/inherited.txt', diff_file: '/run/base/inherited-diff.txt', files_file: '/run/base/inherited-files.txt', reused: false }) }
    if (l.startsWith('plan:')) return raw({ delivered: true, reasons: [], commits: [], out_of_scope: [] }, { plan_check: 'OK' })
    if (l.startsWith('plan-review:')) {
      check(!/adjudicat/i.test(prompt), 'plan review prompt still mentions adjudication')
      return { verdict: 'approve', notes: 'ok', plan: plan() }
    }
    if (l === 'collision') return { overlaps: [], must_finish_before: [] }
    if (l.startsWith('setup:')) { H[key] = sha(); return raw({ ok: true, head: H[key] }) }
    if (l.startsWith('vibe:')) {
      const kid = key + '/' + id
      const m = prompt.match(/--from (\w+)/)
      if (!forkOf[kid]) forkOf[kid] = m && m[1]
      check(prompt.includes('--base ' + q(forkOf[kid])), l + ': --base is not the fork sha')
      check(/--prompt-bytes \d+/.test(prompt) && prompt.includes('--guard-ref') && prompt.includes('--mr-check-cmd'), l + ': missing --prompt-bytes or policy guards')
      if (/FIX ROUND/.test(prompt)) {
        check(prompt.includes('--commits-since ' + q(pkgHead[kid])), l + ': fix round without --commits-since <reviewed head>')
        check(prompt.includes('BLOCKING-' + id), l + ': fix prompt lacks the blocking finding')
        check(!prompt.includes('DEFERRABLE-' + id), l + ': fix prompt carries a deferrable finding')
      }
      if (S.policy) return raw({ delivered: false, reasons: ['policy'], commits: ['c'], out_of_scope: [], policy_violations: ['an MR exists for the branch'] })
      pkgHead[kid] = sha()
      return raw({ delivered: true, reasons: [], commits: ['c'], new_commits: 1, out_of_scope: [], head: pkgHead[kid] })
    }
    if (l.startsWith('gates:')) {
      if (id === 'full') return raw({ ok: true, clean: true, head: mrHead, gates: [], out_of_scope: [], log: '/l', ran: 3 })
      if (id.startsWith('integrate-')) return raw({ ok: true, clean: true, head: H[key], gates: [], log: '/l', ran: 1 })
      const red = S.fixGatesRed && parts[3] === 'r1'
      return raw({ ok: !red, clean: !red, head: pkgHead[key + '/' + id], gates: red ? [{ name: 't', status: 'fail' }] : [], log: '/l', ran: 1 })
    }
    if (l.startsWith('review:')) {
      check(opts.model === (S.high_risk ? 'fable' : 'sonnet'), l + ': reviewer model ' + opts.model)
      const v = S.review
      if (v === null) return null
      const def = { severity: 'deferrable', summary: 'DEFERRABLE-' + id + ' wording', file: 'src/' + id + '/a.go', line: '3', required_fix: 'reword' }
      const blk = { severity: 'blocking', summary: 'BLOCKING-' + id + ' race', file: 'src/' + id + '/b.go', line: '9', required_fix: 'lock it' }
      if (v === 'ship') return { verdict: 'ship', findings: [], acceptance: [] }
      if (v === 'deferrable') return { verdict: 'fix', findings: [def], acceptance: [] }
      if (v === 'blocking') return { verdict: 'fix', findings: [blk, def], acceptance: [] }
      if (v === 'reject') return { verdict: 'reject', findings: [], acceptance: [], reject_reason: 'wrong layer' }
    }
    if (l.startsWith('recheck:')) {
      check(prompt.includes('BLOCKING-' + id) && !prompt.includes('DEFERRABLE-' + id), l + ': recheck prompt is not limited to the blocking items')
      return { items: [{ index: 1, resolved: !!S.recheck, evidence: 'e' }] }
    }
    if (l.startsWith('mr-merge:')) {
      check(prompt.includes('--sha ' + mrHead), 'merge without the gated sha')
      const fu = calls.length && runFollowupTags()
      for (const t of fu) check(prompt.includes(t), 'mr-merge prompt lacks follow-up ' + t)
      if (fu.length) check(prompt.includes('BEGIN-FOLLOWUPS') && prompt.includes('Deferred / follow-ups') && prompt.includes('FOLLOWUPS_CHECKED'), 'mr-merge prompt lacks the follow-up block or check')
      const check_out = (C.missingTag ? fu.map((t) => 'MISSING ' + t.slice(1, -1) + '\n').join('') : '') + 'FOLLOWUPS_CHECKED'
      return { merged: true, merge_commit: 'mc', mr_url: 'u', followups_check: check_out, notes: '' }
    }
    if (l.startsWith('merge:')) {
      const pre = H[key]
      if (S.conflict) return { status: 'FAILED', raw: JSON.stringify({ ok: false, merged: false, conflicts: true, files: ['src/x'], pre_merge_sha: pre, head: pre }) }
      check(prompt.includes('scope-branch.sh merge') && prompt.includes('--expect-head ' + pre), l + ': mechanical merge without --expect-head')
      H[key] = sha()
      return raw({ ok: true, merged: true, conflicts: false, pre_merge_sha: pre, head: H[key], tree_equal: true })
    }
    if (l.startsWith('integrate:')) { const pre = H[key]; H[key] = sha(); return { merged: true, pre_merge_sha: pre, head: H[key], conflicts: false, notes: '' } }
    if (l.startsWith('publish:') || l.startsWith('unmerge:')) return { ok: true, output: 'TREE_EQUAL' }
    if (l.startsWith('mr-prep:')) { mrHead = sha(); return raw({ delivered: true, reasons: [], commits: ['m'], out_of_scope: [], head: mrHead, policy_violations: [], policy_check_errors: [] }) }
    throw new Error('unexpected agent label ' + l)
  }
  // Tags of every follow-up the workflow should have built, from the case script.
  function runFollowupTags() {
    const t = new Set()
    for (const id of ids) {
      const S = C.pkgs[id]
      if (S.review === 'deferrable' || S.review === 'blocking' || S.review === 'reject' || S.review === null || S.policy || S.deps) t.add('[vd:' + scope.key + '/' + id + ']')
    }
    return [...t]
  }
  const pipeline = (items, ...stages) => Promise.all(items.map(async (it, i) => { let r = it; try { for (const s of stages) r = await s(r, it, i); return r } catch (e) { fails.push('stage threw: ' + e.stack); return null } }))
  const parallel = (th) => Promise.all(th.map((t) => t().catch((e) => { fails.push('thunk threw: ' + e.stack); return null })))
  const res = await workflow(args, agent, pipeline, parallel, () => {}, () => {}, { total: null })
  const sc = res.scopes[0]
  const pk = Object.fromEntries((sc.packages || []).map((p) => [p.id, p]))
  const labels = calls.map((c) => c.label)
  const has = (re) => labels.some((x) => re.test(x))
  const fu = res.followups || []
  const fuOf = (id) => fu.filter((f) => f.package === id)

  // Shared assertions: follow-ups visible everywhere they must be.
  const tags = runFollowupTags()
  if (has(/^mr-prep:/)) {
    const mp = prompts['mr-prep:demo:1']
    if (tags.length) check(mp.includes('BEGIN-FOLLOWUPS') && mp.includes('BACKLOG.md') && mp.includes('Deferred / follow-ups') && tags.every((t) => mp.includes(t)), 'mr-prep prompt lacks the follow-up block, file, heading or a tag')
    else check(mp.includes('no follow-ups to file'), 'mr-prep prompt does not say there are no follow-ups')
  }
  for (const t of tags) check(fu.some((f) => '[vd:' + f.scope + '/' + f.package + ']' === t), 'result.followups lacks ' + t)

  const E = {
    clean: () => { check(sc.status === 'merged' && pk.wp1.final === 'integrated' && !fu.length && !has(/^recheck:/), 'clean: not shipped cleanly') },
    deferrable: () => {
      check(sc.status === 'merged' && pk.wp1.final === 'integrated', 'deferrable: not shipped')
      check(!has(/^vibe:demo:wp1:2/) && !has(/^recheck:/), 'deferrable: a fix round ran')
      check(fuOf('wp1').length === 1 && fuOf('wp1')[0].kind === 'deferred' && sc.followups_recorded === true, 'deferrable: follow-up not recorded as deferred')
    },
    'blocking-fixed': () => {
      check(sc.status === 'merged' && pk.wp1.final === 'integrated', 'blocking-fixed: not shipped')
      check(labels.filter((x) => /^recheck:/.test(x)).length === 1 && labels.filter((x) => /^review:/.test(x)).length === 1, 'blocking-fixed: not exactly one review and one recheck')
      check(fuOf('wp1').every((f) => f.kind === 'deferred') && fuOf('wp1').length === 1, 'blocking-fixed: the deferrable finding is not a follow-up')
    },
    'blocking-open': () => {
      check(sc.status === 'merged', 'blocking-open: the rest of the scope did not ship: ' + sc.status + ' ' + sc.blockers)
      check(pk.wp1.final === 'blocking_open' && !pk.wp1.integrated && pk.wp2.final === 'integrated', 'blocking-open: wrong finals')
      check(fuOf('wp1').some((f) => f.kind === 'not_integrated' && /BLOCKING-wp1/.test(f.summary) && f.branch === 'fix/demo-wp1' && /run dir/.test(f.evidence)), 'blocking-open: not filed with branch and evidence')
    },
    'fix-gates-red': () => { check(pk.wp1.final === 'blocking_open' && pk.wp2.final === 'integrated' && sc.status === 'merged', 'fix-gates-red: red gates after the fix did not keep it open') },
    reject: () => { check(pk.wp1.final === 'rejected' && !has(/^vibe:demo:wp1:2/) && sc.status === 'merged' && fuOf('wp1').some((f) => /wrong layer/.test(f.summary)), 'reject: wrong outcome') },
    policy: () => { check(pk.wp1.final === 'policy_violation' && sc.status === 'needs_owner_decision' && !has(/^mr-merge:/) && /POLICY VIOLATION/.test(sc.blockers.join(' ')), 'policy: the MR was not stopped') },
    'high-risk': () => { check(calls.filter((c) => /^review:/.test(c.label)).length === 1 && calls.find((c) => /^review:/.test(c.label)).model === 'fable' && sc.status === 'merged', 'high-risk: not a single Fable review') },
    'zero-integrated': () => { check(sc.status === 'needs_owner_decision' && !has(/^mr-prep:/) && fu.length > 0, 'zero-integrated: did not stop with follow-ups') },
    'dep-blocked': () => { check(pk.wp3.final === 'blocked_dependency' && fuOf('wp3').length === 1 && !has(/^vibe:demo:wp3/) && sc.status === 'merged', 'dep-blocked: wrong outcome') },
    'review-died': () => { check(pk.wp1.final === 'review_failed' && !has(/^vibe:demo:wp1:2/) && pk.wp2.final === 'integrated' && sc.status === 'merged', 'review-died: shipped or fixed on silence') },
    'script-clean': () => { check(has(/^merge:demo:wp1/) && !has(/^integrate:/) && sc.status === 'merged', 'script-clean: Sonnet integrator ran') },
    'script-conflict': () => { check(has(/^merge:demo:wp1/) && has(/^integrate:demo:wp1/) && /conflicted/.test(prompts['integrate:demo:wp1']) && sc.status === 'merged', 'script-conflict: no Sonnet fallback') },
    'followups-missing': () => { check(sc.status === 'merged' && sc.followups_recorded === false && (sc.followups_missing || []).length === 1 && /NOT all recorded/.test(res.summary[0]), 'followups-missing: not reported') },
  }
  E[name]()

  const byPkg = {}
  for (const c of calls) {
    const id = c.label.split(':')[2] || ''
    const k = ids.find((x) => id === x || id === 'integrate-' + x) || '(scope)'
    const b = byPkg[k] = byPkg[k] || { total: 0, haiku: 0, sonnet: 0, fable: 0, labels: [] }
    b.total++
    b[c.model] = (b[c.model] || 0) + 1
    b.labels.push(c.label.split(':')[0])
  }
  console.log('== ' + name + ' [' + (C.integrator || 'sonnet') + ']: ' + res.summary.join(' | '))
  for (const [k, v] of Object.entries(byPkg)) console.log('   agents ' + k.padEnd(8) + ' total=' + v.total + ' haiku=' + v.haiku + ' sonnet=' + v.sonnet + ' fable=' + v.fable + '  ' + v.labels.join(' '))
  console.log('   ' + (fails.length ? 'FAIL:\n     ' + fails.join('\n     ') : 'ok'))
  return fails.length
}

const only = process.env.CASES ? process.env.CASES.split(',') : Object.keys(CASES)
let bad = 0
for (const n of only) bad += await runCase(n, CASES[n])
console.log(bad ? 'HARNESS: ' + bad + ' assertion failure(s)' : 'HARNESS: all cases passed')
process.exit(bad ? 1 : 0)
