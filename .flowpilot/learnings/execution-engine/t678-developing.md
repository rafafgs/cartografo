### t678 (developing, unverified)

- All three old adapters called environmentBuilder(spec) INSIDE the spawn try, so a throwing builder became SessionStartError('could not start "<cmd>"'). Building env in the adapter before handing it over silently changes that; the helper therefore takes `environment: () => env`.
- ProcessLifecycle.getStatus/cancel are synchronous and throw UnknownSessionError; the adapters' async wrappers turn that into the rejected promise the EngineAdapter contract expects. Don't make the adapter methods non-async or the throw becomes synchronous for callers.
