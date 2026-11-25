import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  assertNativeRuntime,
  fileDigest,
  namedImports,
  produceRuntimeArtifact,
} from './runtime-artifact.mjs';

const broker = '/reviewed/broker.py';
// No production deploy/package installation. Real tiny files and Node resolver; cross-owner broker intake is modeled.
function fixture(t) {
  const workspace = mkdtempSync(join(tmpdir(), 'revealfleet-deployment-test-'));
  t.after(() => rmSync(workspace, { recursive: true }));
  const packageRoot = join(workspace, 'packages/daemon');
  function write(path, data) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  }
  const manifest = {
    name: '@revdev/daemon',
    type: 'module',
    dependencies: { '@revealui/ai': '1.2.3', '@electric-sql/pglite': '0.5.4', 'node-pty': '1.1.0' },
  };
  write(
    join(workspace, 'package.json'),
    JSON.stringify({
      name: 'revdev',
      packageManager: 'pnpm@12.12.1',
      devDependencies: { 'node-gyp': '12.4.0' },
    }),
  );
  for (const name of [
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'packages/daemon/tsup.config.ts',
    'packages/daemon/runtime-artifact.mjs',
    'packages/daemon/src/index.ts',
  ])
    write(join(workspace, name), 'fixture');
  write(join(packageRoot, 'package.json'), JSON.stringify(manifest));
  write(
    join(workspace, 'packages/protocol/package.json'),
    JSON.stringify({ name: '@revdev/protocol', version: '0.2.0' }),
  );
  const gypRoot = join(workspace, 'node_modules/.pnpm/node-gyp@12.4.0/node_modules/node-gyp');
  write(
    join(gypRoot, 'package.json'),
    JSON.stringify({
      name: 'node-gyp',
      version: '12.4.0',
      installVersion: 11,
      dependencies: { 'native-fixture-dep': '1.0.0' },
    }),
  );
  const depRoot = join(
    workspace,
    'node_modules/.pnpm/native-fixture-dep@1.0.0/node_modules/native-fixture-dep',
  );
  write(
    join(depRoot, 'package.json'),
    JSON.stringify({ name: 'native-fixture-dep', version: '1.0.0', main: 'index.js' }),
  );
  write(join(depRoot, 'index.js'), 'throw new Error("dependency must never execute");');
  symlinkSync(
    '../../native-fixture-dep@1.0.0/node_modules/native-fixture-dep',
    join(dirname(gypRoot), 'native-fixture-dep'),
  );
  write(
    join(gypRoot, 'bin/node-gyp.js'),
    'throw new Error("compiler must not execute in unit fixture");',
  );
  write(
    join(workspace, 'node_modules/.bin/node-gyp'),
    readFileSync(new URL('../../node_modules/.bin/node-gyp', import.meta.url)),
  );
  chmodSync(join(workspace, 'node_modules/.bin/node-gyp'), 0o755);
  const nativeProfile = {
    distributionHeaders: join(workspace, 'headers/root'),
    cachedHeaders: join(workspace, 'headers/cache'),
    installVersion: join(workspace, 'headers/installVersion'),
    prefixHeaders: null,
    tools: [process.execPath],
  };
  for (const root of [nativeProfile.distributionHeaders, nativeProfile.cachedHeaders])
    write(join(root, 'node_version.h'), 'reviewed fixture headers');
  write(nativeProfile.installVersion, '11\n');
  const policy = {
    strictDepBuilds: true,
    allowBuilds: { 'node-pty@1.1.0': true, 'esbuild@0.28.1': false },
  };
  const graph = [
    {
      path: workspace,
      devDependencies: {
        'node-gyp': {
          path: gypRoot,
          version: '12.4.0',
          dependencies: { 'native-fixture-dep': { path: depRoot, version: '1.0.0' } },
        },
      },
    },
  ];
  const runtimeGraph = [
    {
      path: packageRoot,
      dependencies: {
        '@revdev/protocol': {
          path: join(workspace, 'packages/protocol'),
          version: 'link:../protocol',
        },
        'native-fixture-dep': { path: depRoot, version: '1.0.0' },
      },
    },
  ];
  function inventory(root) {
    const files = {};
    function visit(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const path = join(dir, entry.name),
          name = path.slice(root.length + 1);
        if (entry.isDirectory()) {
          files[name] = { directory: true };
          visit(path);
        } else if (entry.isFile()) files[name] = { sha256: fileDigest(path) };
        else throw new Error('unexpected fixture alias');
      }
    }
    visit(root);
    return { files };
  }

  write(join(packageRoot, 'dist/cli.js'), 'throw new Error("CLI must not execute");');
  write(
    join(packageRoot, 'dist/metafile-esm.json'),
    JSON.stringify({
      inputs: { 'src/index.ts': {} },
      outputs: {
        'dist/cli.js': {
          imports: [
            { path: 'node:fs', external: true },
            { path: '@revealui/ai/llm/client', external: true },
          ],
        },
      },
    }),
  );
  const pnpm = join(workspace, 'pnpm');
  write(pnpm, '#!/usr/bin/env node\nfixture pnpm bytes');
  const options = {
    output: join(workspace, 'output'),
    broker,
    engineSha256: 'a'.repeat(64),
    nodeSha256: fileDigest(process.execPath),
    pnpm,
    pnpmSha256: fileDigest(pnpm),
  };
  const calls = [];
  let mutate;
  function run(executable, args, config) {
    calls.push([executable, args]);
    if (args[0] === pnpm) args = args.slice(1);
    if (args.includes('plan'))
      return { status: 0, stdout: JSON.stringify({ sourceSha256: options.engineSha256 }) };
    if (args.includes('config') && args.includes('get'))
      return { status: 0, stdout: JSON.stringify(policy[args[args.indexOf('get') + 1]] ?? null) };
    if (args.includes('list'))
      return {
        status: 0,
        stdout: JSON.stringify(args.includes('--prod') ? runtimeGraph : graph),
      };
    if (args.includes('exec') && !args.includes('deploy'))
      return {
        status: 0,
        stdout: JSON.stringify(`${join(workspace, 'node_modules/.bin')}:/usr/bin:/bin`),
      };
    if (args.includes('artifact-plan') && args.at(-1) !== join(options.output, 'runtime'))
      return { status: 0, stdout: JSON.stringify(inventory(args.at(-1))) };
    if (args.includes('artifact-plan'))
      return {
        status: 0,
        stdout: JSON.stringify({
          status: 'candidate-inventory-only',
          custodyAccepted: false,
          files: { 'bin/node': { sha256: options.nodeSha256 } },
        }),
      };
    if (args[0] === '--version') return { status: 0, stdout: '12.12.1\n' };
    if (args.includes('deploy')) {
      const deployed = args.at(-1);
      mkdirSync(deployed, { recursive: true });
      cpSync(join(packageRoot, 'dist'), join(deployed, 'dist'), { recursive: true });
      write(join(deployed, 'package.json'), JSON.stringify(manifest));
      const ai = join(deployed, 'node_modules/.pnpm/ai/node_modules/@revealui/ai');
      write(
        join(ai, 'package.json'),
        JSON.stringify({
          type: 'module',
          exports: {
            '.': './index.js',
            './llm/client': './client.js',
            './memory/services': './services.js',
            './orchestration/streaming-runtime': './runtime.js',
          },
        }),
      );
      for (const name of ['index.js', 'client.js', 'services.js', 'runtime.js'])
        write(join(ai, name), 'throw new Error("target import must not execute");');
      mkdirSync(join(deployed, 'node_modules/@revealui'), { recursive: true });
      symlinkSync(
        '../.pnpm/ai/node_modules/@revealui/ai',
        join(deployed, 'node_modules/@revealui/ai'),
      );
      for (const [name, entry, assets] of [
        [
          '@electric-sql/pglite',
          'dist/index.js',
          ['dist/pglite.wasm', 'dist/pglite.data', 'dist/initdb.wasm'],
        ],
        ['node-pty', 'lib/index.js', ['build/Release/pty.node']],
      ]) {
        const path = join(deployed, 'node_modules', name);
        write(
          join(path, 'package.json'),
          JSON.stringify({ type: 'module', exports: { '.': `./${entry}` } }),
        );
        for (const file of [entry, ...assets])
          write(
            join(path, file),
            file.endsWith('.node') ? Buffer.from([127, 69, 76, 70]) : 'fixture, never executed',
          );
      }
      if (mutate) mutate(deployed);
      return { status: 0, stdout: '' };
    }
    return spawnSync(executable, args, config);
  }
  return {
    workspace,
    packageRoot,
    options,
    run,
    calls,
    runtimeGraph,
    depRoot,
    nativeProfile,
    policy,
    graph,
    gypRoot,
    inventory,
    context: { workspace, packageRoot, nativeProfile },
    setMutate(value) {
      mutate = value;
    },
  };
}
test('production candidate uses strict deployment and actual named resolver without target execution', (t) => {
  const f = fixture(t),
    result = produceRuntimeArtifact(f.options, f.run, f.context);
  assert.equal(result.status, 'candidate-production-deployment');
  assert.equal(result.completeRuntimeClosureAccepted, false);
  assert.equal(result.custodyAccepted, false);
  assert.equal(result.namedImportDiagnostics.length, 6);
  assert.ok(result.inventory.files['bin/node']);
  assert.ok(result.source['packages/daemon/src/index.ts']);
  const command = f.calls.find(([, args]) => args.includes('deploy'))[1];
  for (const flag of ['--prod', '--offline', '--frozen-lockfile', '--frozen-store'])
    assert.ok(command.includes(flag));
  assert.ok(command.includes('exec'));
  for (const flag of ['--ignore-scripts', '--legacy', '--force'])
    assert.ok(!command.includes(flag));
  assert.ok(existsSync(join(f.options.output, 'manifest.json')));
  assert.throws(() => produceRuntimeArtifact(f.options, f.run, f.context), /must be new/);
});
test('missing deployed subpath leaves incomplete output without acceptance manifest', (t) => {
  const f = fixture(t);
  f.setMutate((root) => rmSync(join(root, 'node_modules/@revealui/ai/client.js')));
  assert.throws(() => produceRuntimeArtifact(f.options, f.run, f.context), /command failed/);
  assert.ok(!existsSync(join(f.options.output, 'manifest.json')));
});
test('source edits during deployment are rejected before manifest publication', (t) => {
  const f = fixture(t);
  f.setMutate(() => writeFileSync(join(f.packageRoot, 'src/index.ts'), 'active source edit'));
  assert.throws(() => produceRuntimeArtifact(f.options, f.run, f.context), /source changed/);
  assert.ok(!existsSync(join(f.options.output, 'manifest.json')));
});
test('tool and engine digest mismatches refuse before output creation', (t) => {
  const f = fixture(t);
  assert.throws(
    () => produceRuntimeArtifact({ ...f.options, nodeSha256: '0'.repeat(64) }, f.run, f.context),
    /tool digest/,
  );
  assert.throws(
    () =>
      produceRuntimeArtifact(
        { ...f.options, engineSha256: '0'.repeat(64) },
        (exe, args, config) =>
          args.includes('plan')
            ? { status: 0, stdout: '{"sourceSha256":"bad"}' }
            : f.run(exe, args, config),
        f.context,
      ),
    /broker source/,
  );
  assert.ok(!existsSync(f.options.output));
});
test('bundler metadata refuses undeclared external imports', () => {
  assert.throws(
    () =>
      namedImports(
        { outputs: { cli: { imports: [{ path: 'foreign/runtime', external: true }] } } },
        { dependencies: {} },
      ),
    /undeclared/,
  );
});

test('missing deployed native output blocks despite permitted approved lifecycle', (t) => {
  const f = fixture(t);
  f.setMutate((root) => rmSync(join(root, 'node_modules/node-pty/build/Release/pty.node')));
  assert.throws(() => produceRuntimeArtifact(f.options, f.run, f.context));
  assert.ok(!existsSync(join(f.options.output, 'manifest.json')));
});

test('named resolution into mutable outside tree refuses before manifest', (t) => {
  const f = fixture(t);
  f.setMutate((root) => {
    const outside = join(f.workspace, 'outside.js');
    writeFileSync(outside, 'must never execute');
    const client = join(root, 'node_modules/@revealui/ai/client.js');
    rmSync(client);
    symlinkSync(outside, client);
  });
  assert.throws(() => produceRuntimeArtifact(f.options, f.run, f.context), /escapes deployment/);
  assert.ok(!existsSync(join(f.options.output, 'manifest.json')));
});

test('native prerequisite failures refuse before creating output or deploying', (t) => {
  const cases = [
    [
      'missing strict policy',
      (f) => {
        delete f.policy.strictDepBuilds;
      },
    ],
    [
      'false strict policy',
      (f) => {
        f.policy.strictDepBuilds = false;
      },
    ],
    [
      'extra approval',
      (f) => {
        f.policy.allowBuilds.foreign = true;
      },
    ],
    [
      'denied esbuild changed',
      (f) => {
        f.policy.allowBuilds['esbuild@0.28.1'] = true;
      },
    ],
    [
      'node-pty approval absent',
      (f) => {
        delete f.policy.allowBuilds['node-pty@1.1.0'];
      },
    ],
    [
      'remote cache',
      (f) => {
        f.policy.remoteCache = { publish: true };
      },
    ],
    [
      'package hook',
      (f) => {
        writeFileSync(join(f.workspace, '.pnpmfile.cjs'), 'throw 1');
      },
    ],
    [
      'headers differ',
      (f) => {
        writeFileSync(join(f.nativeProfile.cachedHeaders, 'node_version.h'), 'bad');
      },
    ],
    [
      'stale header stamp',
      (f) => {
        writeFileSync(f.nativeProfile.installVersion, '10');
      },
    ],
    [
      'missing runner',
      (f) => {
        rmSync(join(f.workspace, 'node_modules/.bin/node-gyp'));
      },
    ],
    [
      'runner shadow',
      (f) => {
        writeFileSync(join(f.workspace, 'node_modules/.bin/node'), 'shadow');
      },
    ],
    [
      'missing compiler graph',
      (f) => {
        delete f.graph[0].devDependencies['node-gyp'];
      },
    ],
    [
      'missing compiler tool',
      (f) => {
        f.nativeProfile.tools = [join(f.workspace, 'missing')];
      },
    ],
    [
      'missing declared edge',
      (f) => {
        writeFileSync(
          join(f.gypRoot, 'package.json'),
          JSON.stringify({
            version: '12.4.0',
            installVersion: 11,
            dependencies: { foreign: '1.0.0' },
          }),
        );
      },
    ],
    [
      'alternate runner',
      (f) => {
        f.policy.nodeGyp = '/outside/node-gyp';
      },
    ],
    [
      'wrong compiler version',
      (f) => {
        f.graph[0].devDependencies['node-gyp'].version = '1.0.0';
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    const f = fixture(t);
    mutate(f);
    assert.throws(() => produceRuntimeArtifact(f.options, f.run, f.context), undefined, name);
    assert.equal(existsSync(f.options.output), false, name);
    assert.equal(
      f.calls.some(([, args]) => args.includes('deploy')),
      false,
      name,
    );
  }
});

test('ambient native execution overrides refuse before command execution', (t) => {
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'npm_config_nodedir', 'CC']) {
    const f = fixture(t),
      previous = process.env[name];
    process.env[name] = 'unreviewed';
    try {
      assert.throws(() => produceRuntimeArtifact(f.options, f.run, f.context), /override/);
      assert.equal(f.calls.length, 0);
      assert.equal(existsSync(f.options.output), false);
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }
});

test('native header drift during deployment leaves no acceptance manifest', (t) => {
  const f = fixture(t);
  f.setMutate(() =>
    writeFileSync(join(f.nativeProfile.cachedHeaders, 'node_version.h'), 'changed'),
  );
  assert.throws(() => produceRuntimeArtifact(f.options, f.run, f.context), /header/);
  assert.equal(existsSync(join(f.options.output, 'manifest.json')), false);
});

test('production dependency bin shadows and malformed declarations refuse before output', (t) => {
  for (const bin of [{ 'node-gyp': 'index.js' }, { node: 'index.js' }, 'index.js', 3, { bad: 3 }]) {
    const f = fixture(t);
    const manifest = {
      name: typeof bin === 'string' ? 'node-gyp' : 'native-fixture-dep',
      version: '1.0.0',
      main: 'index.js',
      bin,
    };
    writeFileSync(join(f.depRoot, 'package.json'), JSON.stringify(manifest));
    assert.throws(() => produceRuntimeArtifact(f.options, f.run, f.context), /shadow|bins/);
    assert.equal(existsSync(f.options.output), false);
  }
});

test('compiler package mutation during deployment prevents acceptance', (t) => {
  const f = fixture(t);
  f.setMutate(() => writeFileSync(join(f.depRoot, 'index.js'), 'changed compiler bytes'));
  assert.throws(
    () => produceRuntimeArtifact(f.options, f.run, f.context),
    /native build inputs changed/,
  );
  assert.equal(existsSync(join(f.options.output, 'manifest.json')), false);
});

test('only declared optional absent runtime edges are recorded; required edges still fail', (t) => {
  for (const optional of [true, false]) {
    const f = fixture(t),
      protocol = join(f.workspace, 'packages/protocol');
    const missing = join(
      f.workspace,
      'node_modules/.pnpm/optional-fixture/node_modules/optional-fixture',
    );
    writeFileSync(
      join(protocol, 'package.json'),
      JSON.stringify({
        name: '@revdev/protocol',
        version: '0.2.0',
        [optional ? 'optionalDependencies' : 'dependencies']: { 'optional-fixture': '1.0.0' },
      }),
    );
    f.runtimeGraph[0].dependencies['@revdev/protocol'].dependencies = {
      'optional-fixture': { path: missing, version: '1.0.0' },
    };
    if (optional) {
      const result = produceRuntimeArtifact(f.options, f.run, f.context);
      assert.equal(result.nativeBuildInputs.omittedOptionalRuntime[missing], '1.0.0');
    } else {
      assert.throws(() => produceRuntimeArtifact(f.options, f.run, f.context), { code: 'ENOENT' });
      assert.equal(existsSync(f.options.output), false);
    }
  }
});

test('optional omission drift during deployment prevents manifest publication', (t) => {
  const f = fixture(t),
    protocol = join(f.workspace, 'packages/protocol');
  const missing = join(
    f.workspace,
    'node_modules/.pnpm/optional-fixture/node_modules/optional-fixture',
  );
  writeFileSync(
    join(protocol, 'package.json'),
    JSON.stringify({
      name: '@revdev/protocol',
      version: '0.2.0',
      optionalDependencies: { 'optional-fixture': '1.0.0' },
    }),
  );
  f.runtimeGraph[0].dependencies['@revdev/protocol'].dependencies = {
    'optional-fixture': { path: missing, version: '1.0.0' },
  };
  f.setMutate(() => {
    mkdirSync(missing, { recursive: true });
    writeFileSync(
      join(missing, 'package.json'),
      JSON.stringify({ name: 'optional-fixture', version: '1.0.0' }),
    );
  });
  assert.throws(
    () => produceRuntimeArtifact(f.options, f.run, f.context),
    /native build inputs changed/,
  );
  assert.equal(existsSync(join(f.options.output, 'manifest.json')), false);
});

test('nonexecutable compiler shim cannot fall through to an ambient runner', (t) => {
  const f = fixture(t);
  chmodSync(join(f.workspace, 'node_modules/.bin/node-gyp'), 0o644);
  assert.throws(() => produceRuntimeArtifact(f.options, f.run, f.context), /must be executable/);
  assert.equal(existsSync(f.options.output), false);
});

test('other-only execute bit does not authorize the compiler shim for its owner', (t) => {
  const f = fixture(t);
  chmodSync(join(f.workspace, 'node_modules/.bin/node-gyp'), 0o401);
  assert.throws(() => produceRuntimeArtifact(f.options, f.run, f.context), { code: 'EACCES' });
  assert.equal(existsSync(f.options.output), false);
});

test('native profile accepts only reviewed Linux x64 Node 26.13.1 ABI 147', () => {
  const reviewed = {
    platform: 'linux',
    arch: 'x64',
    version: 'v26.13.1',
    versions: { modules: '147' },
  };
  assert.doesNotThrow(() => assertNativeRuntime(reviewed));
  for (const delta of [
    { version: 'v24.21.0', versions: { modules: '137' } },
    { versions: { modules: '137' } },
    { version: 'v26.13.0' },
    { platform: 'darwin' },
    { arch: 'arm64' },
  ])
    assert.throws(
      () => assertNativeRuntime({ ...reviewed, ...delta }),
      /unreviewed native Node ABI/,
    );
});
