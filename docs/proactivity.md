# Proactive reviews

Pi reviews the conversation when the owner is idle and can raise a concrete follow-up, risk,
suggestion or reminder. Proactivity is enabled by default. A review considers recent conversation,
the owner's standing preferences and accepted profile, open goal requirements, and earlier notes.
Staying quiet is a normal result.

The default delay is two minutes, with at least three new owner turns between reviews and at most
four reviews per session. Each review permits two model responses, up to two notes and an estimated
spending limit of $0.05. Configure these settings through `/proactivity` or the Proactivity settings
group. The model-facing preferences tool requires confirmation on the owner's screen before a change.

## Checking current evidence

A review can make up to three read attempts using the subset of `read`, `grep`, `find`, `ls`,
`repo_read`, `memory_read`, `zoom` and `date` that its foreground session and current policy permit.
Malformed and refused read requests consume this allowance. The review cannot read again after
raising a note. It normally uses its first response to request evidence and its second to decide
whether a note is useful.

Each read result is limited to 8 KiB of text, including its evidence label. All tool results share a
16 KiB allowance. Read work and its reserved source revalidation share an absolute deadline starting
with the first read; a later model response does not extend it. Filesystem reads also have separate
limits for bytes, files, directory entries, metadata operations and native processes. Installed
decoders and matchers may be used; a review never provisions them.

Repository inspection has a distinct process budget. Git's internal object and index I/O is not
metered as filesystem source bytes. Recursive repository paths require authority for the entire
subtree, including historical and deleted paths. A directory containing a denied descendant is not
an authorized recursive target; explicitly authorized file targets remain available.

Private harness files remain unavailable through filesystem tools. Memory is accessed through a
read-only broker, with bounded native sources and without extension callbacks. Continuous-chat
navigation keeps image descriptions but does not read image bodies for a proactive review.

## Delivery and source lifetime

Read results carry host-issued evidence IDs. A note produced after investigation must cite evidence
that was already included in a model request. The host checks the exact delivered text and retains
its source references and digests with the note. These references establish provenance; they do not
prove that the model's interpretation is correct. Partial results cannot establish absence.

Before delivery, Pi revalidates the sources within their original read allowance. Owner activity,
branch changes, policy changes, changed memory or expired read authority can discard the review.
Filesystem validation is an optimistic observation, not an atomic snapshot against unrelated writers.
The final admission check runs again before the parent session accepts the note.

Provider usage belongs to the original session even if cancellation precedes the physical response.
Review endings are announced as raised, quiet or failed. Delivery uses the normal durable parent-input
path; accepting a note and consuming it in a parent response are distinct states.
