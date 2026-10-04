# Security review: stage runs and VIBES MODE against untrusted content

Scope, as the card gave it: whether prompt-injection text in a repo file or a
card field can steer a stage or the VIBES sweep into actions it should
refuse; whether the `canUseTool` denials (`runs/permissions.ts`) and the
`REEVE_DB` PreToolUse Bash hook can be worked around; whether
`.worktreeinclude` copying (`git/worktree.ts`) could pull secrets into a
worktree; how repo lifecycle commands reach `spawn(..., { shell: true })`
(`runs/shell.ts`); repo/worktree path handling; and the chained case where
injected Claude output reaches the web app's `innerHTML` render.

Every spike below seeds its own throwaway git repo under `/tmp` and a scratch
`REEVE_DB`; nothing here touched a real checkout or the live board. Each is
runnable on its own — see its own header for the command.

## Findings

### 1. The `REEVE_DB` guard can be stepped around with a `cd`

**Spike:** `live-db-relative-path-check.ts` (new).

`liveDatabaseGuard`'s `isLiveDatabase` resolves a relative `REEVE_DB` value
against the worktree path the stage started in — `resolve(worktreePath, db)`
— no matter what the command in front of it does. A command that `cd`s into
the live database's own directory and then sets `REEVE_DB` to a bare
filename is read by the real shell, after the `cd`, relative to that other
directory; the guard still reads it relative to the worktree, computes an
unrelated path, and says nothing:

```
cd /path/to/reeve/data && REEVE_DB=reeve.db npx tsx some-script.ts
```

confirmed with the spike, denied when the live path is written out in full
and absolute, allowed the moment a `cd` and a relative name do the same
thing. This is the one hand-rolled defence in the permission model — every
other test in `permission-check.ts`'s own bypass list (substitution,
`$HOME`, partial quoting, `env`/`export`/`bash -c`, a second assignment, a
re-cased path on a case-insensitive disk) is caught — and this is a real gap
in it, reachable by a stage whose prompt a malicious repo or card field
talked into running a `cd` first, not a contrived test of the test harness.
Worth a card of its own to teach the guard to track `cd` (or, more simply,
to resolve every relative `REEVE_DB` as "could resolve to the live path from
*some* reachable cwd" rather than only from the worktree root).

A smaller, opposite-direction observation from the same spike and from
`permission-check.ts`: the guard matches `REEVE_DB=` as text anywhere in the
command string, including inside an `echo`, a string a script is about to
write to a file, or (found firsthand, writing this review, inside this very
session, which runs under the same hook) a heredoc body that merely
*mentions* `REEVE_DB=/real/path` without assigning it. That is a false
*denial*, not a security hole, but it means the guard's "plainly readable"
rule is textual rather than semantic and can refuse commands that never
touch the variable at all.

### 2. `.worktreeinclude` really does pull whatever it names, byte for byte

**Spike:** existing `worktree-check.ts`, re-run and confirmed, not modified.

`.worktreeinclude` is a file the repo itself tracks, and a repo on a card's
board is exactly the untrusted content this review is about. The existing
spike already demonstrates the full chain: a `.worktreeinclude` naming
`.env` copies the main checkout's real `.env` into every fresh worktree that
repo gets, byte for byte, before the setup command runs — and the spike goes
on to show the setup command (`cat .env`, equally something the repo's own
config supplies) reading it straight back out. This is documented as
deliberate, mirroring Claude Code's own worktree behaviour, and the function
already refuses to do it for anything not both gitignored and listed. The
risk this review adds is about Reeve's specific trust boundary rather than
the mechanism: a repo whose `.worktreeinclude` and lifecycle commands are
both attacker-reachable (a compromised dependency's postinstall rewriting
it, an accepted PR that edits it, a repo the person cloned without reading
closely) can have Reeve copy real secrets sitting gitignored in the main
checkout into a worktree Claude then reads unattended, and nothing stops the
stage's own prompt-governed behaviour (committing a file, writing it into a
plan or summary) from then carrying that content out of the worktree. No
code changed; this is a risk to weigh, not a bug in the copy logic itself.

### 3. The classifier's own approvals are the real policy, and they are wide

**Spike:** existing `permission-check.ts`, re-run and confirmed, not
modified.

`canUseTool` and the PreToolUse hook are asked about what auto mode's
classifier escalates — not about everything a run does. The spike's own
"auto mode, for real" section already proves the shape of the gap: a
`python3 --version`, a piped `ls | head -1`, and a destructive
`rm -rf <directory outside the worktree>` all ran without ever reaching
`canUseTool`, because the classifier decided all three on its own. The
`rm -rf` is the one worth naming here: Reeve's own denial list never saw it,
and the comment in `runs/permissions.ts` ("what reaches this callback is
what the classifier escalated rather than decided") says plainly that this
is by design, the same as Claude Code's own auto mode. The consequence for
this review's scope is that prompt-injection text does not need to trick
`decideToolUse` into answering allow — it never has to ask. Anything the
classifier itself would wave through for a person typing it — reading a
file anywhere `additionalDirectories` or the worktree reaches, writing or
editing a tracked file, committing, an `rm` the classifier doesn't flag,
`curl`ing out to a URL that looks like an ordinary fetch — is available to
injected text the same as to the person's own brief. What stands between
that and e.g. a push, a PR, or a commit of `.reeve/` is the stage's prompt
text alone ("do not push", ".reeve/ must never be committed"), not an
enforced gate; a stage whose prompt a malicious repo file successfully
argued out of those instructions would not be stopped by anything in
`permissions.ts`. This is the single biggest structural fact this review
surfaced, and it is inherent to running auto mode unattended rather than a
defect introduced here — Reeve's `decideToolUse` already does everything a
host answering only "deny" can do with what it is asked about.

### 4. Markdown → `innerHTML` is clean

**Spike:** `markdown-injection-check.ts` (new).

The chained case the card named by name: Claude's output (a plan, a brief,
notes) is Markdown, and `RichText.tsx` puts a brief on the page with
`el.innerHTML = seed(initial)` rather than through React's own tree.
`Markdown.tsx` builds React elements rather than emitting HTML strings, and
restricts image `src` to `/api/assets/…` or `https:` and link `href` to
`https:`/`mailto:` — so `seed()`'s `renderToStaticMarkup` call is the one
point where that safety could leak, if React's own escaping ever let a
crafted payload's text or attribute content become live markup once
reparsed and reinserted.

It does not. A literal `<script>` typed into a brief or returned by a
poisoned run comes back HTML-escaped text; a `javascript:` link target is
refused by the allow-list and never becomes an anchor; an image `src` that
tries to break out of its attribute with a quote and add its own `onerror`
is defeated by React's own attribute escaping (`onerror=&quot;…`, not a live
attribute); a heading or list item whose text is itself a tag comes back
escaped; `data:` URLs are refused by both allow-lists. Ordinary Markdown
(bold, inline code, a real `https:` link) still renders as itself, so the
escaping above is not merely nothing matching. No finding here — the design
note at the top of `Markdown.tsx` ("nothing written here can smuggle markup
into the page") holds up against a deliberately hostile payload, including
through the one place that output reaches `innerHTML` directly.

### 5. VIBES MODE's ideas run has no policy of its own, for better and worse

Not a separate spike — `vibes/ideas.ts` calls the same `startClaudeRun` every
stage does, with the same `canUseTool`/`liveDatabaseGuard` wiring, so
findings #1 and #3 apply to it unchanged. Its prompt (`prompts/ideas.md`)
tells Claude to change nothing and feeds it finished-card titles and bodies
and the repo's own files — exactly the untrusted content this review is
about, read with nobody watching and, per the card's own description, no
human gate before the ideas it returns become new cards a later sweep pass
builds unattended. A repo or a finished card's body that successfully argued
the run into reading past "change nothing" would face the same wide,
classifier-decided surface as any stage (#3), not a narrower one built for
read-only advice; and whatever it returns is only as trustworthy as the
`suggested_tasks`/`ideas` schema validation already in place, which this
review did not find a way to bypass (`jsonSchemaFor`/`assertContractsConvertible`
run at boot, before any content reaches a run).

## What this review did not try

Actually inducing a real Claude session to attempt a prompt-injected
exfiltration or policy violation end to end (e.g. seeding a repo file with
injected instructions and watching a live run act on them) was judged too
costly for what it would add: `permission-check.ts`'s existing "auto mode,
for real" run already demonstrates, with a live session, exactly the
boundary that matters — what the classifier decides on its own versus what
it escalates — and findings #1 and #3 follow from that boundary by
inspection rather than needing a second live run to re-derive it.
