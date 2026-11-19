### t1314 (developing, unverified)

- A first draft of AT4 had a bug: `route.replace(/\d+/, 'N')` replaced the '1' in '/v1/', so the route comparison failed for the wrong reason. It now anchors on '/sessions/\d+'.
