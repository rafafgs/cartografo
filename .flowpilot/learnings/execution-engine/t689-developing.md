### t689 (developing, unverified)

- An agent skill that names {{input_file.<path>}} in instructions gets a path outside its write scope. Whether the engine's read tools can open it depends on that engine's permission mapping (Copilot with escrita: [] has no tools at all). The feature is aimed at shell skills.
