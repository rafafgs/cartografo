### t959 (integrating, unverified)

- Before t960, every full npm test run on this branch was red or was cut short by a timeout or a kill: the flow's gate rounds (test names truncated in the report), plus cli-watch AT1/AT2/AT5 and t678 AT3/AT4/AT8 in my own runs at load 55-200. Founder's answer: these were load-related and fixed by t960. I did not re-test those failures separately beyond the single green run after the merge.
- This branch adds no cli-watch or other test fix, as the founder instructed. The test gate passed on one full run after the merge, with no repeat runs, so it does not show how the suite behaves at the earlier load of 55-200.
