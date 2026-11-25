/** Ordinary build owner. Candidate data only; no installer or runtime authority. */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(packageRoot, '../..');
export function fileDigest(path, withHeader = false) {
  let fd;
  let primary;
  let result;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    require(before.isFile() && before.size <= 256 * 1024 * 1024, 'invalid build input');
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(65536);
    let total = 0;
    let header;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      if (header === undefined) header = Buffer.from(buffer.subarray(0, Math.min(count, 128)));
      total += count;
      require(total <= 256 * 1024 * 1024, 'build input too large');
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(fd);
    require(total === before.size &&
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs, 'build input changed while hashing');
    const sha256 = hash.digest('hex');
    result = withHeader ? { sha256, header: header ?? Buffer.alloc(0) } : sha256;
  } catch (error) {
    primary = error;
  }
  if (fd !== undefined) {
    const retired = fd;
    fd = undefined;
    try {
      closeSync(retired);
    } catch (error) {
      if (primary) throw new AggregateError([primary, error]);
      throw error;
    }
  }
  if (primary) throw primary;
  return result;
}
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const AI = [
  '@revealui/ai/orchestration/streaming-runtime',
  '@revealui/ai/llm/client',
  '@revealui/ai/memory/services',
];
function require(value, message) {
  if (!value) throw new Error(message);
}
function call(run, executable, args, cwd, environment) {
  const result = run(executable, args, {
    cwd,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
    env: environment ?? { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' },
  });
  require(!result.error &&
    result.status === 0, `runtime producer command failed: ${executable}: ${result.stderr ?? ''}`);
  return result.stdout;
}
export function namedImports(metadata, packageManifest) {
  require(metadata && typeof metadata.outputs === 'object', 'missing bundler output metadata');
  const names = new Set([...Object.keys(packageManifest.dependencies), ...AI]);
  for (const output of Object.values(metadata.outputs)) {
    require(Array.isArray(output.imports), 'malformed bundler imports');
    for (const item of output.imports) {
      require(typeof item.path === 'string', 'malformed bundler import');
      if (item.external && !builtins.has(item.path)) {
        const dependency = item.path.startsWith('@')
          ? item.path.split('/').slice(0, 2).join('/')
          : item.path.split('/')[0];
        require(Object.hasOwn(
          packageManifest.dependencies,
          dependency,
        ), `undeclared runtime dependency: ${item.path}`);
        names.add(item.path);
      }
    }
  }
  return [...names].sort();
}
// Uses Node's own ESM resolver. No target module is imported/executed.
const resolver = `import { realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const [parent,names]=process.argv.slice(1);
console.log(JSON.stringify(JSON.parse(names).map(name=>{
const url=import.meta.resolve(name,parent);
if(!url.startsWith('file:'))throw new Error('non-file import');
const path=realpathSync(fileURLToPath(url));
if(!statSync(path).isFile())throw new Error('missing named import');
return {name,path};})));`;

// This is a candidate build profile, not production activation authority.
export function assertNativeRuntime(runtime = process) {
  require(runtime.platform === 'linux' &&
    runtime.arch === 'x64' &&
    runtime.version === 'v26.13.1' &&
    runtime.versions.modules ===
      '147', 'unreviewed native Node ABI: requires Linux x64 Node 26.13.1 ABI 147');
}

// PNPM owns the declared graph; Node only confirms its edges without loading targets.
// These are ordinary compiler inputs, not a complete dynamic-loader/custody proof.
export function nativeBuildInputs({ workspace, node, pnpm, pnpmCall, inventory, profile }) {
  profile ??= {
    distributionHeaders: join(dirname(dirname(node)), 'include/node'),
    cachedHeaders: join(process.env.HOME, '.cache/node-gyp', process.versions.node, 'include/node'),
    installVersion: join(
      process.env.HOME,
      '.cache/node-gyp',
      process.versions.node,
      'installVersion',
    ),
    prefixHeaders: process.config.variables.use_prefix_to_find_headers
      ? join(process.config.variables.node_prefix, 'include/node')
      : null,
    tools: [
      'sh',
      'python3',
      'make',
      'g++',
      'gcc',
      'cc',
      'c++',
      'ld',
      'as',
      'ar',
      'sed',
      'readlink',
      'uname',
    ].map((name) => `/usr/bin/${name}`),
  };
  assertNativeRuntime();
  require(JSON.parse(pnpmCall(['config', 'get', 'strictDepBuilds', '--json'])) ===
    true, 'strict native build approval required');
  const approvals = JSON.parse(pnpmCall(['config', 'get', 'allowBuilds', '--json']));
  require(approvals &&
    Object.keys(approvals).length === 2 &&
    approvals['node-pty@1.1.0'] === true &&
    approvals['esbuild@0.28.1'] === false, 'unexpected native build approvals');
  for (const key of [
    'pnpmfile',
    'globalPnpmfile',
    'configDependencies',
    'remoteCache',
    'useNodeVersion',
    'nodeGyp',
    'extraBinPaths',
    'scriptShell',
    'shellEmulator',
    'executionEnv',
  ])
    require(JSON.parse(pnpmCall(['config', 'get', key, '--json'])) ===
      null, `unsupported native build configuration: ${key}`);
  for (const name of ['.pnpmfile.cjs', '.pnpmfile.mjs', 'pnpmfile.cjs', 'pnpmfile.mjs'])
    require(!existsSync(join(workspace, name)), 'executable package hook refused');
  const rootManifest = JSON.parse(readFileSync(join(workspace, 'package.json')));
  require(rootManifest.name === 'revdev' &&
    rootManifest.devDependencies?.['node-gyp'] === '12.4.0', 'locked workspace node-gyp required');
  for (const root of [
    workspace,
    join(workspace, 'packages/daemon'),
    join(workspace, 'packages/protocol'),
  ]) {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json')));
    for (const name of [
      'preinstall',
      'install',
      'postinstall',
      'prepare',
      'prepublish',
      'prepublishOnly',
    ])
      require(!Object.hasOwn(manifest.scripts ?? {}, name), 'workspace lifecycle hook refused');
  }
  require(!existsSync(
    join(dirname(pnpm), 'dist/node-gyp-bin/node-gyp'),
  ), 'unexpected bundled compiler runner');
  const graph = JSON.parse(
    pnpmCall(['--filter', 'revdev', 'list', '--depth', 'Infinity', '--json']),
  );
  require(Array.isArray(graph) &&
    graph.length === 1 &&
    graph[0].path === workspace, 'ambiguous compiler graph');
  const entry = graph[0].devDependencies?.['node-gyp'];
  require(entry?.version === '12.4.0', 'missing compiler graph');
  const store = realpathSync(join(workspace, 'node_modules/.pnpm'));
  const packages = {},
    edges = [];
  let entries = 0,
    bytes = 0;
  function visit(row, depth = 0) {
    require(depth <= 64 && row && typeof row.path === 'string', 'invalid compiler graph');
    const root = realpathSync(row.path);
    require(root === row.path &&
      relative(store, root) !== '' &&
      !relative(store, root).split(sep).includes('..'), 'external compiler package');
    if (Object.hasOwn(packages, root)) return;
    require(Object.keys(packages).length < 256, 'compiler graph exceeds policy');
    const manifest = JSON.parse(readFileSync(join(root, 'package.json')));
    require(manifest.version === row.version, 'compiler version drift');
    packages[root] = inventory(root);
    for (const file of Object.values(packages[root].files)) {
      entries++;
      bytes += file.size ?? 0;
      require(entries <= 20000 && bytes <= 2 * 1024 ** 3, 'compiler inputs exceed policy');
    }
    const dependencies = row.dependencies ?? {};
    for (const name of Object.keys(manifest.dependencies ?? {}))
      require(Object.hasOwn(dependencies, name), 'incomplete compiler graph');
    for (const [name, dependency] of Object.entries(dependencies)) {
      const target = realpathSync(dependency.path);
      const resolved = realpathSync(createRequire(join(root, 'package.json')).resolve(name));
      require(relative(target, resolved) !== '' &&
        !relative(target, resolved).split(sep).includes('..'), 'compiler dependency edge drift');
      edges.push({ from: root, name, target, resolved });
      visit(dependency, depth + 1);
    }
  }
  visit(entry);
  const gypRoot = realpathSync(entry.path);
  const gypManifest = JSON.parse(readFileSync(join(gypRoot, 'package.json')));
  require(gypManifest.installVersion === 11, 'unreviewed header install version');
  const bin = join(workspace, 'node_modules/.bin');
  const reserved = new Set([
    'node',
    'node.exe',
    'node-gyp',
    'pnpm',
    ...profile.tools.map((path) => path.split('/').at(-1)),
  ]);
  reserved.delete(process.execPath.split('/').at(-1));
  reserved.add('node');
  for (const name of [...reserved].filter((name) => name !== 'node-gyp')) {
    let present = false;
    try {
      lstatSync(join(bin, name));
      present = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    require(!present, 'workspace tool shadow refused');
  }
  const shim = join(bin, 'node-gyp'),
    shimBytes = readFileSync(shim, 'utf8');
  const shimMode = lstatSync(shim).mode;
  require(lstatSync(shim).isFile() &&
    shimMode & 0o111 &&
    !(shimMode & 0o7022), 'compiler shim must be executable');
  accessSync(shim, constants.X_OK);
  require(fileDigest(shim) ===
    '2f5ff9378824a7fb43cbd0b0b68177afdd0b4ea8addf412fdaddd0335d3a046e', 'unreviewed generated compiler shim');
  const target = shimBytes.match(/^# cmd-shim-target=(.+)$/m)?.[1];
  require(target &&
    realpathSync(resolve(bin, target)) ===
      join(gypRoot, 'bin/node-gyp.js'), 'compiler shim target drift');
  const execPath = JSON.parse(
    pnpmCall(['exec', node, '--eval', 'console.log(JSON.stringify(process.env.PATH))']),
  );
  require(typeof execPath === 'string', 'missing project execution path');
  for (const directory of execPath.split(':')) {
    require(isAbsolute(directory), 'relative project execution path');
    if ([dirname(node), dirname(pnpm), '/usr/bin', '/bin'].includes(directory)) continue;
    for (const name of reserved) {
      const path = join(directory, name);
      let present = false;
      try {
        lstatSync(path);
        present = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (present)
        require(name === 'node-gyp' && path === shim, 'project native tool shadow refused');
    }
  }
  const runtimeGraph = JSON.parse(
    pnpmCall(['--filter', '@revdev/daemon', 'list', '--prod', '--depth', 'Infinity', '--json']),
  );
  require(Array.isArray(runtimeGraph) &&
    runtimeGraph.length === 1 &&
    runtimeGraph[0].path === join(workspace, 'packages/daemon'), 'ambiguous runtime graph');
  const runtimeManifests = {},
    omittedOptionalRuntime = {};
  function runtimeBins(row, depth = 0, optional = false) {
    require(depth <= 64 && row && typeof row.path === 'string', 'invalid runtime graph');
    require(isAbsolute(row.path) &&
      (row.path === join(workspace, 'packages/protocol') ||
        (!relative(store, row.path).split(sep).includes('..') &&
          !isAbsolute(relative(store, row.path)))), 'external runtime graph path');
    let root;
    try {
      root = realpathSync(row.path);
    } catch (error) {
      if (optional && error.code === 'ENOENT') {
        omittedOptionalRuntime[row.path] = row.version;
        return;
      }
      throw error;
    }
    if (Object.hasOwn(runtimeManifests, root)) return;
    require(Object.keys(runtimeManifests).length < 512, 'runtime graph exceeds policy');
    require(root === join(workspace, 'packages/protocol') ||
      root === store ||
      (!relative(store, root).split(sep).includes('..') &&
        !isAbsolute(relative(store, root))), 'external runtime package');
    const manifest = JSON.parse(readFileSync(join(root, 'package.json')));
    require(manifest.version === row.version ||
      (root === join(workspace, 'packages/protocol') &&
        row.version === 'link:../protocol'), 'runtime package version drift');
    runtimeManifests[root] = fileDigest(join(root, 'package.json'));
    require(manifest.bin === undefined ||
      (typeof manifest.bin === 'string' && manifest.bin.length > 0) ||
      (manifest.bin &&
        typeof manifest.bin === 'object' &&
        !Array.isArray(manifest.bin) &&
        Object.entries(manifest.bin).every(
          ([name, target]) =>
            /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name) &&
            typeof target === 'string' &&
            target.length > 0,
        )), 'malformed runtime bins');
    const bins =
      typeof manifest.bin === 'string'
        ? [manifest.name.split('/').at(-1)]
        : Object.keys(manifest.bin ?? {});
    for (const name of bins) require(!reserved.has(name), 'runtime native tool shadow refused');
    for (const [name, dependency] of Object.entries(row.dependencies ?? {}))
      runtimeBins(dependency, depth + 1, Object.hasOwn(manifest.optionalDependencies ?? {}, name));
  }
  for (const group of ['dependencies', 'optionalDependencies'])
    for (const dependency of Object.values(runtimeGraph[0][group] ?? {}))
      runtimeBins(dependency, 0, group === 'optionalDependencies');
  const distributionHeaders = inventory(profile.distributionHeaders);
  const cachedHeaders = inventory(profile.cachedHeaders);
  require(JSON.stringify(distributionHeaders.files) === JSON.stringify(cachedHeaders.files) &&
    readFileSync(profile.installVersion, 'utf8').trim() === '11', 'incomplete native header cache');
  // Refuse an alternate compiled-prefix header selection rather than override node-gyp.
  if (profile.prefixHeaders && existsSync(join(profile.prefixHeaders, 'node_version.h')))
    require(realpathSync(profile.prefixHeaders) ===
      realpathSync(profile.distributionHeaders), 'unexpected compiled-prefix headers');
  const tools = Object.fromEntries(
    profile.tools.map((path) => {
      accessSync(path, constants.X_OK);
      const resolved = realpathSync(path),
        mode = lstatSync(resolved).mode;
      require(lstatSync(resolved).isFile() &&
        mode & 0o111 &&
        !(mode & 0o7022), 'native tool must be executable');
      return [path, { path: resolved, mode, sha256: fileDigest(resolved) }];
    }),
  );
  return {
    scope: 'declared-native-build-inputs-only',
    approvals,
    packages,
    edges,
    graph: entry,
    runtimeGraph,
    runtimeManifests,
    omittedOptionalRuntime,
    execPath,
    tools,
    distributionHeaders,
    cachedHeaders,
    shim: { path: shim, mode: shimMode, sha256: fileDigest(shim), target, source: shimBytes },
    nodeGypEntry: join(gypRoot, 'bin/node-gyp.js'),
    headerInstallVersion: fileDigest(profile.installVersion),
    loaderSearchLimit:
      'Generated PNPM shim NODE_PATH paths are recorded, not accepted as complete undeclared-import closure.',
  };
}

export function produceRuntimeArtifact(
  { output, broker, engineSha256, nodeSha256, pnpm, pnpmSha256 },
  run = spawnSync,
  context = { packageRoot, workspace },
) {
  const { packageRoot, workspace } = context;
  for (const key of Object.keys(process.env))
    require(!/^(NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|LD_PRELOAD|LD_LIBRARY_PATH|PYTHONPATH|PYTHONHOME|CC|CXX|CFLAGS|CXXFLAGS|LDFLAGS|npm_config_(?:node_gyp|target|arch|nodedir|devdir|dist_?url|tarball|python|ensure|script_shell|userconfig|globalconfig)|npm_package_config_node_gyp.*)$/i.test(
      key,
    ), 'ambient native build override refused');
  for (const value of [engineSha256, nodeSha256, pnpmSha256])
    require(/^[a-f0-9]{64}$/.test(value), 'invalid reviewed digest');
  require(isAbsolute(output) &&
    isAbsolute(broker) &&
    isAbsolute(pnpm), 'absolute explicit inputs required');
  require(!existsSync(output), 'output must be new; refusing replacement');
  assertNativeRuntime();
  const node = realpathSync(process.execPath);
  pnpm = realpathSync(pnpm);
  const pnpmInput = fileDigest(pnpm, true);
  require(fileDigest(node) === nodeSha256 &&
    pnpmInput.sha256 === pnpmSha256, 'build tool digest mismatch');
  const nativePnpm = pnpmInput.header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]));
  require(nativePnpm ||
    /^#!.*\bnode(?:\s|$)/.test(
      pnpmInput.header.toString('utf8').split('\n')[0],
    ), 'unsupported pnpm executable');
  const environment = {
    PATH: `${dirname(node)}:${dirname(pnpm)}:/usr/bin:/bin`,
    HOME: process.env.HOME,
    LANG: 'C.UTF-8',
  };
  const invoke = (executable, args, cwd = workspace) =>
    call(run, executable, args, cwd, environment);
  const pnpmArgs = (args) => (nativePnpm ? args : [pnpm, ...args]);
  const pnpmCall = (args) => invoke(nativePnpm ? pnpm : node, pnpmArgs(args));
  const captureInventory = (root) =>
    JSON.parse(invoke('/usr/bin/python3', ['-I', broker, 'artifact-plan', '--files', root]));
  const engine = JSON.parse(invoke('/usr/bin/python3', ['-I', broker, 'plan']));
  require(engine.sourceSha256 === engineSha256, 'broker source digest mismatch');
  const packageManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json')));
  require(packageManifest.dependencies['@revealui/ai'] ===
    '1.2.3', 'AI must be a direct pinned production dependency');
  const metadata = JSON.parse(readFileSync(join(packageRoot, 'dist/metafile-esm.json')));
  const names = namedImports(metadata, packageManifest);
  const pins = {};
  for (const name of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'packages/daemon/package.json',
    'packages/protocol/package.json',
    'packages/daemon/tsup.config.ts',
    'packages/daemon/runtime-artifact.mjs',
  ])
    pins[name] = fileDigest(join(workspace, name));
  for (const input of Object.keys(metadata.inputs ?? {})) {
    const path = resolve(packageRoot, input),
      name = relative(workspace, path);
    require(!isAbsolute(name) && !name.split(sep).includes('..'), 'build input escapes workspace');
    pins[name] = fileDigest(path);
  }
  pins['packages/daemon/dist/metafile-esm.json'] = fileDigest(
    join(packageRoot, 'dist/metafile-esm.json'),
  );
  const expectedPnpm = JSON.parse(readFileSync(join(workspace, 'package.json'))).packageManager;
  require(expectedPnpm ===
    `pnpm@${pnpmCall(['--version']).trim()}`, 'workspace pnpm version mismatch');
  const nativeInputs = nativeBuildInputs({
    workspace,
    node,
    pnpm,
    pnpmCall,
    inventory: captureInventory,
    profile: context.nativeProfile,
  });
  // Normal strict-policy deployment can restore cache or execute approved native lifecycle.
  // PNPM exec supplies the existing verified workspace compiler through its normal bin semantics.
  // A failure retains incomplete output without an acceptance manifest; never force/clean/retry.
  mkdirSync(output, { mode: 0o700 });
  const artifact = join(output, 'runtime');
  mkdirSync(artifact);
  const deployed = join(artifact, 'package');
  const deploymentOutput = pnpmCall([
    'exec',
    nativePnpm ? pnpm : node,
    ...(nativePnpm ? [] : [pnpm]),
    '--filter',
    '@revdev/daemon',
    'deploy',
    '--prod',
    '--offline',
    '--frozen-lockfile',
    '--frozen-store',
    deployed,
  ]);
  writeFileSync(join(output, 'deployment.log'), deploymentOutput, { flag: 'wx', mode: 0o600 });
  mkdirSync(join(artifact, 'bin'));
  copyFileSync(node, join(artifact, 'bin/node'));
  require(fileDigest(join(artifact, 'bin/node')) === nodeSha256, 'copied Node digest mismatch');
  require(lstatSync(join(deployed, 'dist/cli.js')).isFile(), 'missing deployed CLI');
  require(readFileSync(join(deployed, 'dist/metafile-esm.json')).equals(
    readFileSync(join(packageRoot, 'dist/metafile-esm.json')),
  ), 'deployed metadata drift');
  const resolutions = JSON.parse(
    call(
      run,
      join(artifact, 'bin/node'),
      [
        '--experimental-import-meta-resolve',
        '--input-type=module',
        '--eval',
        resolver,
        pathToFileURL(join(deployed, 'dist/cli.js')).href,
        JSON.stringify(names),
      ],
      deployed,
      environment,
    ),
  );
  require(Array.isArray(resolutions) &&
    resolutions.length === names.length, 'incomplete named-import diagnostics');
  const paths = resolutions.map((row, index) => {
    require(row.name === names[index] &&
      typeof row.path === 'string', 'wrong named-import diagnostic');
    const path = realpathSync(row.path),
      inside = relative(artifact, path);
    require(inside !== '' &&
      !isAbsolute(inside) &&
      !inside.split(sep).includes('..') &&
      lstatSync(path).isFile(), 'named import escapes deployment');
    return { name: row.name, path: inside };
  });
  const requiredAssets = [];
  for (const [name, suffixes] of [
    ['@electric-sql/pglite', ['pglite.wasm', 'pglite.data', 'initdb.wasm']],
    ['node-pty', ['../build/Release/pty.node']],
  ]) {
    require(Object.hasOwn(
      packageManifest.dependencies,
      name,
    ), 'missing required production dependency');
    const entry = paths.find((row) => row.name === name);
    require(entry, 'missing required native package resolution');
    for (const suffix of suffixes) {
      const path = realpathSync(resolve(dirname(join(artifact, entry.path)), suffix));
      const inside = relative(artifact, path);
      require(!isAbsolute(inside) &&
        !inside.split(sep).includes('..') &&
        lstatSync(path).isFile() &&
        lstatSync(path).size > 0, 'missing required package asset');
      if (name === 'node-pty')
        require(fileDigest(path, true)
          .header.subarray(0, 4)
          .equals(Buffer.from([127, 69, 76, 70])), 'native addon must be ELF');
      requiredAssets.push(inside);
    }
  }
  for (const [name, before] of Object.entries(pins))
    require(fileDigest(join(workspace, name)) === before, 'source changed during deployment');
  require(fileDigest(node) === nodeSha256 &&
    fileDigest(pnpm) === pnpmSha256, 'tool changed during deployment');
  const inventory = JSON.parse(
    invoke('/usr/bin/python3', ['-I', broker, 'artifact-plan', '--files', artifact]),
  );
  require(inventory.status === 'candidate-inventory-only' &&
    inventory.custodyAccepted === false, 'invalid candidate inventory');
  require(JSON.stringify(nativeInputs) ===
    JSON.stringify(
      nativeBuildInputs({
        workspace,
        node,
        pnpm,
        pnpmCall,
        inventory: captureInventory,
        profile: context.nativeProfile,
      }),
    ), 'native build inputs changed');
  const result = {
    nativeBuildInputs: nativeInputs,
    deploymentLogSha256: fileDigest(join(output, 'deployment.log')),
    nativeLifecycle: 'normal PNPM strict-policy deploy; approved scripts permitted',
    schema: 1,
    status: 'candidate-production-deployment',
    source: pins,
    tools: {
      pnpm: { version: expectedPnpm, sha256: pnpmSha256 },
      node: {
        sha256: nodeSha256,
        version: process.version,
        platform: process.platform,
        arch: process.arch,
        abi: process.versions.modules,
      },
      broker: { sourceSha256: engineSha256 },
    },
    inventory,
    namedImportDiagnostics: paths,
    requiredAssetsPresent: requiredAssets,
    completeRuntimeClosureAccepted: false,
    custodyAccepted: false,
    outstanding: [
      'transitive computed imports',
      'native ELF/ABI and assets execution',
      'race-safe immutable custody',
      'fixed launcher CAS and inverse',
      'host/service/database acceptance',
    ],
  };
  writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(result, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    require(args.length === 7 &&
      args[0] ===
        '--output', 'Usage: build:runtime --output NEW_DIRECTORY REVIEWED_BROKER_SOURCE ENGINE_SHA256 NODE_SHA256 PNPM_EXECUTABLE PNPM_SHA256');
    const result = produceRuntimeArtifact({
      output: args[1],
      broker: args[2],
      engineSha256: args[3],
      nodeSha256: args[4],
      pnpm: args[5],
      pnpmSha256: args[6],
    });
    console.log(
      JSON.stringify({
        status: result.status,
        completeRuntimeClosureAccepted: false,
        manifest: join(args[1], 'manifest.json'),
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
