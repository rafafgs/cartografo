### t741 (developing, unverified)

- AT3 seeds a registry that holds every manifest but one by POSTing manifests and then the bumped graph straight to /v1/skills and /v1/graphs. POST /v1/graphs accepts a graph whose pin points at a manifest the registry lacks, so that route does not check pins.
