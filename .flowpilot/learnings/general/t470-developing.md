### t470 (developing, unverified)

- A whole-document past-tense sweep is the wrong rule and I rejected it: §10's own bullet reads 'The two stylesheets are one.', which is correct present-tense prose about a resolved state. The sweep is scoped to the preamble (everything above '## 1. The foundation') for that reason, and it asserts the tree's single-stylesheet fact separately so the prose rule fails loudly if a second stylesheet ever legitimately returns.
- Sentence splitting on /(?<=\.)\s+/ is safe over this document: style.css, pages.ts and §10. are never followed by whitespace, and markdown's line wrapping is undone with a whitespace collapse before the split.
