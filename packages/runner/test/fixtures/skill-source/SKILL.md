---
name: code review
description: Reads a diff and reports what is wrong with it, one finding per line.
---

# Code review

Read the diff, then say what is wrong with it. One finding per line, and every
finding names the file it is about.

Before reporting, run the suite:

```
npm test
```

Nothing here is executed by the interview: this file is read, derived into a
draft manifest and shown to a session as a starting point (D4).
