### t1112 (developing, unverified)

- node:test `t.after` hooks run in registration order. In a top-level test that calls bootCore(t) itself, a cleanup hook registered later runs after the control plane is killed and fails with ECONNREFUSED. Put the plane in a parent test, or skip API cleanup on a private plane.
