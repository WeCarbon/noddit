/**
 * Builds app/public/demo/bench.json: two mock projects driven through the real
 * CLI, then `decs bench --json` over them. The window plays it back when it
 * runs in a plain browser (screenshots, design work). Mock data only.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const BIN = join(here, '../../bin/nod.ts')
const OUT = join(here, '../public/demo')
const SHOT = join(here, 'signin-preview.png')
const OLD_SHOT = join(here, 'signin-old.png')
const FAKE_HOME = '/Users/alice/Code'

const scratch = mkdtempSync(join(tmpdir(), 'decs-demo-'))
const home = join(scratch, 'home')
mkdirSync(home)

function decs(dir: string, author: string, args: string[], input = ''): string {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    input,
    encoding: 'utf8',
    env: { ...process.env, NODDIT_HOME: home, NODDIT_AUTHOR: author, NODDIT_LANG: 'en', NO_COLOR: '1', CLAUDECODE: '1' },
  })
}

function project(name: string, letter: string): string {
  const dir = join(scratch, name)
  mkdirSync(dir)
  decs(dir, 'setup', ['init', '--letter', letter, '--no-register'])
  return dir
}

const web = project('web', 'W')
const api = project('api', 'A')
decs(web, 'setup', ['config', 'name', 'Web app', '--dir', web])
const auth = 'lane-auth · sign-in flow'
const build = 'lane-build · bundler'
const docs = 'lane-docs · docs site'
const orders = 'lane-orders · pagination'

decs(web, auth, ['add', 'Ship the new sign-in flow', '--task'])
decs(web, auth, ['start', '1'])
decs(web, auth, ['steps', '1', 'Design review', 'Session store', 'Rate limiting', 'Rollout'])
decs(web, auth, ['step', '1', '2'])
decs(web, auth, ['progress', '55', '--node', '1', '--msg', 'passkey screen done, wiring sessions'])

decs(web, auth, [
  'add', 'Which session store?', '--parent', '1', '--urgency', 'high',
  '-o', 'default:1=Keep signed cookies', '2=Move sessions to Redis',
  '--if-no-answer', 'keep cookies and ship on Thursday', '--reversible', 'yes',

], `**What** The new sign-in screen is done (screenshot below). Before rollout I need to know where sessions live.

**Why now** Rate limiting (W3) and the rollout both depend on it.

- Cookies: no new infrastructure, sessions can't be revoked one by one
- Redis: instant revoke and "sign out everywhere", one more service to run

### 1 · Keep signed cookies
Zero new infra. Revoking means rotating the signing key — everyone signs out.

### 2 · Move sessions to Redis
About a day of work plus a small Redis instance. Per-device sign-out comes for free.
`)
decs(web, auth, ['attach', '2', '--label', 'Before', OLD_SHOT, '--label', 'After', SHOT])
decs(web, auth, ['add', 'Rate-limit the login endpoint', '--task', '--parent', '1', '--after', 'W2'])
decs(web, auth, ['add', 'Write the user-table migration', '--task', '--parent', '1'])
decs(web, auth, ['start', '4'])
decs(web, 'owner', ['note', '4', 'Run the backfill on a copy of production first, please.', '--human'])
decs(web, auth, ['done', '4', '--note', 'migration merged, backfill ran in 40s'])

decs(web, build, ['add', 'Upgrade the bundler', '--task'])
decs(web, build, ['start', '5'])
decs(web, build, ['progress', '30', '--node', '5', '--msg', 'build passes, tests 30%'])
decs(web, build, ['add', 'Drop the legacy browser build?', '--after', 'W5', '-o', 'default:1=Drop it', '2=Keep it one more release', '--body', '**What** The legacy build adds 40s to every CI run and 2% of visits use it.'])

decs(web, docs, ['add', 'Pick a font for the docs site', '-o', '1=Inter', 'default:2=System font stack', '--body', 'Both read well; Inter costs 90 KB.'])
decs(web, docs, ['pin', '6', 'top'])
decs(web, docs, ['push', '7', '2', '--note', 'system stack, keep it light', '--human'])
decs(web, docs, ['add', 'Publish the API reference', '--task'])
decs(web, docs, ['start', '8'])
decs(web, docs, ['hold', '8', '--on', 'Carol to send the staging keys once the vendor security review (ticket SEC-4471) signs off on the new API scopes'])
decs(web, docs, ['attach', '8', '--label', 'reference-landing-page-desktop', OLD_SHOT, '--label', 'reference-landing-page-tablet', SHOT, '--label', 'reference-search-results-with-a-very-long-file-name', OLD_SHOT])
decs(web, docs, ['add', 'Clean up old feature flags', '--task'])
decs(web, docs, ['defer', '9', '--human'])
decs(web, docs, ['add', 'Release notes are ready', '--body', 'Drafted from the merged PRs; 6 items, nothing breaking.'])
decs(web, auth, ['note', '1', 'Passkey screen merged behind a flag; cookies stay the default until W2 is answered.', '--agent'])
decs(web, 'lane-auth-session-store-migration-and-rollout · long-running', ['note', '1', '会话存储迁移进行到一半：旧的签名 cookie 还在读，新会话已经双写到 Redis 测试实例。压测在 2000 并发下 p99 是 41 毫秒，比现在慢 6 毫秒，主要花在序列化上，换成 MessagePack 之后应该能追回来。回滚开关放在 SESSION_BACKEND 环境变量里，默认还是 cookie，W2 答复之前不会切。', '--agent'])
decs(web, 'owner', ['note', '7', 'Redis 那边先别动，等 Carol 确认预算之后再说；如果周四之前没消息就按默认走。', '--human'], '')

// The owner's own words, filed for an AI to pick up (what ⌘K in the window does).
execFileSync(process.execPath, [BIN, 'add', 'Export orders as CSV for finance', '--brief', '--dir', web], {
  env: { ...process.env, NODDIT_HOME: home, NODDIT_LANG: 'en', NO_COLOR: '1', CLAUDECODE: '', NODDIT_ROLE: '' },
  stdio: 'ignore',
})

decs(api, orders, ['add', 'Migrate the billing webhooks', '--task'])
decs(api, orders, ['start', '1'])
decs(api, orders, ['hold', '1', '--on', '财务确认新的发票模板和税号；供应商说下周三之前给答复，在那之前不能切换回调地址'])
decs(api, orders, ['add', 'Pagination for /orders', '--task'])
decs(api, orders, ['start', '2'])
decs(api, orders, ['progress', '20', '--node', '2'])
decs(api, orders, [
  'add', 'How should /orders page?', '--parent', '2',
  '--question', 'Q1', 'Paging style', '-o', 'Q1:A=Cursor', 'Q1:B=Offset', '--default', 'Q1:A',
  '--question', 'Q2', 'Default page size', '-o', 'Q2:1=50', 'Q2:2=100', '--default', 'Q2:1',
  '--body', 'Clients today fetch everything; the largest account has 180k orders.',
])

mkdirSync(OUT, { recursive: true })
for (const lang of ['en', 'zh-Hans', 'zh-Hant', 'fr', 'ar']) {
  const json = execFileSync(process.execPath, [BIN, 'bench', '--json', web, api], {
    encoding: 'utf8',
    env: { ...process.env, NODDIT_HOME: home, NODDIT_LANG: lang, NO_COLOR: '1' },
  })
  writeFileSync(join(OUT, lang === 'en' ? 'bench.json' : `bench.${lang}.json`), json.split(realpathSync(scratch)).join(FAKE_HOME).split(scratch).join(FAKE_HOME))
}
// Every attached file, under the name the window asks for (its basename).
for (const dir of [web, api]) {
  const root = join(dir, 'decisions', 'attachments')
  for (const node of existsSync(root) ? readdirSync(root) : []) for (const f of readdirSync(join(root, node))) copyFileSync(join(root, node, f), join(OUT, f))
}
rmSync(scratch, { recursive: true, force: true })
console.log(`wrote ${join(OUT, 'bench.json')}`)
