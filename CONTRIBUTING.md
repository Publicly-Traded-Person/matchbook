# How this project changes

Matchbook is being designed in public, and the design document is the product
until there is code. Two rules keep it honest.

## Decisions are issues first

Any change that alters what the bot does is filed as an issue labelled
`decision` before it is written into the spec. The issue states the decision,
where in the spec it lands, why, the alternative that was not chosen, and what
would reverse it. The commit that folds it into `docs/design.md` references the
issue ("Folds in #12"), and does not close it: a folded decision is still an
arguable one. Decision issues close when the code implementing them lands, or
when a later decision supersedes them. Wording fixes and typos do not need any
of this; behavior does.

This exists because the spec's first day produced eleven internal
contradictions from eight edits that were each correct for the question that
prompted them. A patch scoped to one question does not see the sentences three
sections away it has just falsified. An issue names the decision separately
from the prose, and folding it in means re-reading every section it touches.

Decisions stay open while they are arguable. If you disagree with one, comment
on it. If you want a new one, open it.

Two more labels keep the spec free of things that drift. `question` is for
what is genuinely undecided and waits on evidence from real rounds. `verify` is
for an assumption about Discord the first build has to confirm. Neither lives
inline in the spec beyond a pointer to its issue.

## Full re-read after three

After roughly three decisions have been folded in, the next action on the spec
is a complete read of the whole document looking for contradictions, not another
patch. A read by someone or something that did not write the last three changes
is best, because the author remembers what they meant rather than reading what
they said.

## Everything else

Open an issue. The README lists the decisions most likely to be wrong; start
there if you want to be useful quickly.
