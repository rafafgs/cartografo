### t465 (developing, unverified)

- The throttle's clock is baselined at bindSession, not at zero: 'since the last attempt' read literally would fire a draft on the very first line of a session. Baselining at bind gives the same posture the page's poll has (first tick one interval later) and is what the runner test's 'the first onOutput past the interval' means.
