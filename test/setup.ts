import { tmpdir } from 'node:os'
import { join } from 'node:path'
// The suite's expectations are written in English; tests about language pick their own.
process.env.DECS_LANG ||= 'en'
// Run as the lead even inside a teammate session, where the monitor would otherwise filter to that teammate.
process.env.DECS_TEAMMATE = ''
// A string printed with a placeholder left unfilled fails the test that printed it.
process.env.DECS_STRICT_I18N = '1'
// node --test sets FORCE_COLOR when run in a terminal; children would then colour plain output like console.log(2).
delete process.env.FORCE_COLOR
// ink stops redrawing when it detects CI; the bench tests read its frames.
process.env.CI = 'false'
process.env.CONTINUOUS_INTEGRATION = 'false'
// Note headings carry local wall-clock time; fixtures are written in +08:00.
process.env.TZ = 'Asia/Shanghai'
// No test may open a terminal window: `nod session start` records its plan here instead.
process.env.NODDIT_LAUNCH_RECORD ||= join(tmpdir(), `nod-launch-${process.pid}.jsonl`)
// Never the user's own tabs: a test that edits views points this at a file of its own.
process.env.NODDIT_VIEWS ||= join(tmpdir(), `nod-views-${process.pid}-absent.json`)
// Which node each session is on is per user; the suite keeps its own, and never keys it by the session running the suite.
process.env.NODDIT_SESSION_NODES ||= join(tmpdir(), `nod-session-nodes-${process.pid}.json`)
delete process.env.CLAUDE_CODE_SESSION_ID
