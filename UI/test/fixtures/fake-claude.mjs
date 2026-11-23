// Stands in for `claude -p ... --output-format stream-json` in tests. It prints a short stream-json session.
// A prompt containing "slow" keeps running until killed; "fail" ends with an error result and exit code 1.
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// Health checks: `--version` and `auth status` (FAKE_LOGGED_IN=0 reports signed out).
if (args[0] === '--version') { console.log('9.9.9 (Fake Claude)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') { console.log(JSON.stringify({ loggedIn: process.env.FAKE_LOGGED_IN !== '0' })); process.exit(0); }
if (/nologin/.test(prompt)) {
  process.stderr.write('\u001b[31mIgnoring 3 permissions.allow entries from .claude/settings.json: this workspace has not been trusted.\u001b[0m\n');
  emit({ type: 'result', subtype: 'success', is_error: true, num_turns: 1, result: 'Not logged in · Please run /login' });
  process.exit(1);
}

// --resume <id> continues that session (same id); otherwise a fixed new one.
const resumed = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
emit({ type: 'system', subtype: 'init', session_id: resumed || '00000000-0000-4000-8000-000000000001', model: 'fake', permissionMode: args[args.indexOf('--permission-mode') + 1], tools: ['Read'] });
// "mkplan" in the prompt: act like /plan-new creating plan "detected-plan".
const command = /mkplan/.test(prompt) ? 'node .claude/workflow/plan.mjs new detected-plan --title "Detected"' : 'node .claude/workflow/plan.mjs status';
emit({ type: 'assistant', message: { content: [{ type: 'text', text: `Working on **${prompt}**${resumed ? ` (resumed ${resumed})` : ''}` }, { type: 'tool_use', name: 'Bash', input: { command } }] } });
emit({ type: 'user', message: { content: [{ type: 'tool_result', content: 'No active plans.' }] } });
process.stderr.write('fake stderr line\n');

if (/slow/.test(prompt)) setInterval(() => {}, 1000);
else {
  const fail = /fail/.test(prompt);
  // "denytest" in the prompt: report `dotnet test` refused from both shells, unless the run allows it.
  const allowed = args.includes('Bash(dotnet:*)');
  const denials = /denytest/.test(prompt) && !allowed ? ['Bash', 'PowerShell'].map((t, i) => ({ tool_name: t, tool_use_id: `t${i}`, tool_input: { command: 'dotnet test x.csproj' } })) : [];
  emit({ type: 'result', subtype: fail ? 'error_during_execution' : 'success', is_error: fail, num_turns: 2, total_cost_usd: 0.0123, duration_ms: 42, result: fail ? 'It failed.' : 'Done.', permission_denials: denials });
  process.exitCode = fail ? 1 : 0;
}
