/**
 * Which mode the Copilot spike runs in (t684).
 *
 * `--stub` on the command line wins; otherwise `COPILOT_SPIKE_MODE` (trimmed,
 * still honoured so an existing habit keeps working); otherwise `github`. The
 * npm scripts pass the flag instead of a `NAME=value` prefix, which PowerShell
 * and `cmd` reject.
 *
 * @param {readonly string[]} argv The arguments after the script name.
 * @param {Record<string, string | undefined>} env The environment to read.
 * @returns {'stub' | 'github'}
 */
export function resolveSpikeMode(argv, env) {
  if (argv.includes('--stub')) return 'stub';
  const mode = (env.COPILOT_SPIKE_MODE ?? 'github').trim();
  if (mode !== 'stub' && mode !== 'github') {
    throw new Error(`COPILOT_SPIKE_MODE must be "stub" or "github", got "${mode}"`);
  }
  return mode;
}
