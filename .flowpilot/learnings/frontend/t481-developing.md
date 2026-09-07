### t481 (developing, unverified)

- style.css already owns a GLOBAL `.field` class (the graph editor's card fields, line ~891). The ticket's Design section suggested `.pergunta .field` / `.interview .field`, which would have inherited that rule silently — the new selectors are `.question-field` instead.
