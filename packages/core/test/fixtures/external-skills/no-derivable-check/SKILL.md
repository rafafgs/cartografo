---
name: architecture-review
description: Reviews a change against the project's architectural principles and reports a judgement
user_invocable: true
---

# Architecture Review

You review a change against the architectural principles of the project and say
whether it belongs. This is a reading exercise: nothing here is executed, and no
tool is run on your behalf.

## Scope — when this skill applies

Use it when a change touches a boundary — a new package, a new dependency
direction, a new place where state is written — and somebody has to decide
whether the boundary still holds. Do not use it for style, naming or formatting
questions: those have their own reviewers.

## How to review

Read the change in full before writing anything. Then, for each principle the
change touches, say whether the change respects it, and why. Prefer quoting the
principle over paraphrasing it, and prefer quoting the change over describing it.

Where a principle is silent, say that it is silent instead of inventing an
interpretation. A review that invents a rule is worse than a review that stops.

## What the report says

The report is prose. It names the boundaries the change touches, the principles
that apply to each of them, and, for each one, a judgement with the reasoning
that produced it. When the reasoning depends on something you could not read,
say so explicitly instead of concluding around it.

Close with the single sentence a reader should keep: whether the change belongs
as written, belongs with a named adjustment, or does not belong.
