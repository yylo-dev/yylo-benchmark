import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { fixture, command } from '../snapshot/real-git.js';
import { runAttempt } from '../../src/v2/adapters.js';
import { invoke } from '../../src/v2/harness.js';
import { TreatmentSchema } from '../../src/v2/contracts.js';
const workflowSetup = { executable: 'python3', args: ['-c', "import os,sys,subprocess; os.mkdir('.juno_task'); subprocess.run([sys.executable,'-m','venv','--without-pip','.venv_juno'],check=True); open('.gitignore','a').write('\\n.venv_juno/\\n.juno_task/\\n')"] };
const roots: string[] = []; afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('native adapter boundaries', () => {
  it('passes literal prompt/model and private session arguments to YYLO and retains its envelope', async () => {
    const f = await fixture(); roots.push(f.root); const fake = path.join(f.root, 'fake-yy');
    await writeFile(fake, `#!/usr/bin/env node
const fs=require('fs');const args=process.argv.slice(2);fs.writeFileSync('observed.json',JSON.stringify({args,prompt:fs.readFileSync(args[args.indexOf('--prompt-file')+1],'utf8')}));
fs.writeSync(3,'{"verdict":"pass","findings":[]}');console.log(JSON.stringify({status:'success',model:'resolved',provider:'provider',session_id:'session-1',cost:{usd:0.2}}));`, { mode: 0o755 });
    const result = await runAttempt({ caseDirectory: f.caseDirectory, output: path.join(f.root, 'attempt'), treatment: TreatmentSchema.parse({ name: 'pi', model: ':alias', harness: 'yylo_pi', executable: fake, args: ['--thinking', 'medium'] }) });
    expect(result.execution.status).toBe('completed'); expect(result.execution.observed_model).toBe('provider/resolved'); expect(result.execution.cost_usd).toBe(0.2);
    const observed = JSON.parse(await readFile(path.join(f.root, 'attempt', 'output', 'observed.json'), 'utf8'));
    expect(observed.args.slice(0, 4)).toEqual(['--execution-envelope', 'pi', '--model', ':alias']);
    expect(observed.args).toContain('--additional-args'); expect(observed.prompt).toContain('Implement behavior');
  });
  it('does not infer native identity from response text or allow session/model override', async () => {
    const f = await fixture(); roots.push(f.root);
    const failed = await invoke({ treatment: { ...command(''), harness: 'yylo_pi', args: ['--continue'] }, prompt: 'p', workspace: f.source, control: path.join(f.root, 'control') });
    expect(failed.status).toBe('error'); expect(failed.diagnostic).toContain('override');
  });
  const runner = path.resolve('../.juno_task/scripts/workflow_runner.sh');
  it.skipIf(!existsSync(runner))('executes the existing Workflow Runner prefix independently for two model variants', async () => {
    const workflow = stringify({ id: 'benchmark-native-prefix', name: 'Synthetic local prefix', vars: { candidate_model: 'placeholder' }, steps: [
      { id: 'first', command: 'printf "{{ candidate_model }}" > first.txt', fail_on_error: true },
      { id: 'second', command: 'cat first.txt > second.txt', fail_on_error: true },
      { id: 'third', command: 'touch forbidden-third.txt', fail_on_error: true },
    ] });
    const f = await fixture(workflow); roots.push(f.root);
    for (const model of ['model-a', 'model-b']) {
      const output = path.join(f.root, model);
      const result = await runAttempt({ caseDirectory: f.caseDirectory, output, treatment: TreatmentSchema.parse({ name: model, model, harness: 'workflow_runner',
        executable: 'python3', args: [runner], timeout_ms: 30_000, setup: workflowSetup, workflow: { model_variable: 'candidate_model', through: 'second' } }) });
      expect(result.execution.status, JSON.stringify(result.execution)).toBe('completed');
      expect(await readFile(path.join(output, 'output', 'second.txt'), 'utf8')).toBe(model);
      expect(existsSync(path.join(output, 'workspace', 'forbidden-third.txt'))).toBe(false);
      expect(await readFile(path.join(output, 'execution', 'workflow.yaml'), 'utf8')).not.toContain('forbidden-third');
    }
  });
  it.skipIf(!existsSync(runner))('records native workflow semantic failure even if its process exits zero', async () => {
    const f = await fixture(stringify({ id: 'benchmark-failure', steps: [{ id: 'fails', command: 'exit 7' }] })); roots.push(f.root);
    const result = await runAttempt({ caseDirectory: f.caseDirectory, output: path.join(f.root, 'attempt'), treatment: TreatmentSchema.parse({ name: 'workflow', model: 'm', harness: 'workflow_runner',
      executable: 'python3', args: [runner], timeout_ms: 30_000, setup: workflowSetup, workflow: { model_variable: 'model' } }) });
    expect(result.execution.status, JSON.stringify(result.execution)).toBe('failed');
  });
  it('passes the same prefix to a custom workflow harness without session translation', async () => {
    const f = await fixture('id: w\nsteps:\n  - id: first\n    command: echo first\n  - id: second\n    command: echo second\n  - id: third\n    command: echo third\n'); roots.push(f.root);
    const output = path.join(f.root, 'custom');
    const result = await runAttempt({ caseDirectory: f.caseDirectory, output, treatment: TreatmentSchema.parse({ ...command(`
      const fs=require('fs');const request=JSON.parse(process.env.YYLO_BENCHMARK_REQUEST_JSON);
      const yaml=fs.readFileSync(request.workflow.path,'utf8');
      if(yaml.includes('third')||!yaml.includes('second')||request.workflow.variables.model!=='test/model')process.exit(4);
      fs.writeFileSync('prefix.txt',yaml);`), workflow: { model_variable: 'model', through: 'second' } }) });
    expect(result.execution.status).toBe('completed');
    expect(JSON.parse(await readFile(path.join(output, 'attempt.json'), 'utf8')).scope).toBe('workflow_prefix');
  });
  it('unknown stop step is an error without running downstream commands', async () => {
    const f = await fixture('id: w\nsteps: [{id: one, command: echo one}]\n'); roots.push(f.root);
    const result = await runAttempt({ caseDirectory: f.caseDirectory, output: path.join(f.root, 'attempt'), treatment: TreatmentSchema.parse({ name: 'w', model: 'm', harness: 'workflow_runner', executable: '/should/not/run', workflow: { model_variable: 'model', through: 'missing' } }) });
    expect(result.execution.status).toBe('error'); expect(result.execution.diagnostic).toContain('unknown workflow step');
  });
});
