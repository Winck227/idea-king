import { getQuickJS } from "quickjs-emscripten";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

const maxBytes = 4 * 1024 * 1024;
const maxFiles = 128;
const timeoutMs = 5000;
export type RunResult = { exitCode: number; text: string; elapsedMs: number };

/** Capture a bounded regular-file tree. Never follow links into the host. */
export async function captureFiles(root: string): Promise<Record<string, string>> {
  const base = await realpath(root);
  const files: Record<string, string> = Object.create(null);
  let size = 0;
  async function walk(dir: string): Promise<void> {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (["snapshots", "executions"].includes(item.name)) continue;
      const full = path.join(dir, item.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new Error("sandbox_link_rejected");
      const real = await realpath(full);
      const rel = path.relative(base, real);
      if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("sandbox_path_rejected");
      if (info.isDirectory()) await walk(full);
      else if (info.isFile()) {
        size += info.size;
        if (size > maxBytes || Object.keys(files).length >= maxFiles) throw new Error("sandbox_input_limit");
        files[rel.replaceAll("\\", "/")] = await readFile(full, "utf8");
      }
    }
  }
  await walk(base);
  return files;
}

/** Guest JS runs inside a bounded WASM heap, with no Node objects or network bindings. */
export async function executeProduct(
  script: string, cwd: string, outWrite: string, args: string[] = [],
  captured?: Record<string, string>,
): Promise<RunResult> {
  const started = Date.now();
  const files = captured ?? await captureFiles(cwd);
  const entry = path.relative(cwd, script).replaceAll("\\", "/");
  if (!files[entry] || entry.startsWith("../")) return { exitCode: 1, text: "sandbox: missing entry", elapsedMs: 0 };
  const QuickJS = await getQuickJS();
  const vm = QuickJS.newContext();
  vm.runtime.setMemoryLimit(64 * 1024 * 1024);
  vm.runtime.setMaxStackSize(512 * 1024);
  vm.runtime.setInterruptHandler(() => Date.now() - started > timeoutMs);
  const outputs = new Map<string, string>();
  let outputBytes = 0;
  let logs = "";
  let exitCode = 0;
  function host(name: string, fn: (...values: string[]) => string): void {
    const handle = vm.newFunction(name, (...values) => vm.newString(fn(...values.map(value => vm.getString(value)))));
    vm.setProp(vm.global, name, handle);
    handle.dispose();
  }
  host("__read", key => {
    if (outputs.has(key)) return outputs.get(key)!;
    if (!Object.hasOwn(files, key)) throw new Error("ENOENT: " + key);
    return files[key]!;
  });
  host("__write", (key, text) => {
    if (!key.startsWith("out/") || key.includes("..")) throw new Error("sandbox_write_denied");
    outputBytes += Buffer.byteLength(text, "utf8");
    if (outputBytes > maxBytes || outputs.size >= maxFiles) throw new Error("sandbox_output_limit");
    outputs.set(key, text);
    return "";
  });
  host("__keys", () => JSON.stringify([...new Set([...Object.keys(files), ...outputs.keys()])]));
  host("__log", text => { logs = (logs + text).slice(0, 16000); return ""; });
  const bootstrap = `
(() => {
  const normalize = raw => {
    raw = String(raw).replace(/\\\\/g,'/');
    if (/^[a-z]:/i.test(raw) || raw.includes('\\0')) throw Error('sandbox_path_denied');
    const p = raw.startsWith('/') ? raw : '/session/' + raw;
    const parts=[];
    for (const s of p.split('/')) { if(s==='..') { if(parts.length<=1) throw Error('sandbox_path_denied'); parts.pop(); } else if(s && s!=='.') parts.push(s); }
    if(parts[0]!=='session') throw Error('sandbox_path_denied');
    return parts.slice(1).join('/');
  };
  const keys=()=>JSON.parse(__keys());
  const exists=p=>{const k=normalize(p);return keys().some(x=>x===k||x.startsWith(k+'/'));};
  const fs={
    readFileSync:(p,encoding)=>{const s=__read(normalize(p));return s;},
    writeFileSync:(p,s)=>__write(normalize(p),String(s)),
    mkdirSync:p=>{const k=normalize(p);if(k!=='out'&&!k.startsWith('out/'))throw Error('sandbox_write_denied');},
    existsSync:exists,
    readdirSync:p=>{const k=normalize(p);const prefix=k?k+'/':'';return [...new Set(keys().filter(x=>x.startsWith(prefix)).map(x=>x.slice(prefix.length).split('/')[0]))];},
    statSync:p=>{const k=normalize(p),all=keys();if(!exists(p))throw Error('ENOENT');const file=all.includes(k);return {isFile:()=>file,isDirectory:()=>!file,size:file?__read(k).length:0};}
  };
  const path={join:(...xs)=>'/session/'+normalize(xs.join('/')),resolve:(...xs)=>'/session/'+normalize(xs.join('/')),dirname:p=>String(p).replace(/\\/[^/]*$/,''),basename:p=>String(p).split('/').pop(),extname:p=>{const b=String(p).split('/').pop();return b.includes('.')?'.'+b.split('.').pop():'';},sep:'/'};
  const cache=Object.create(null);
  const load=(name,parent)=>{
    if(name==='fs'||name==='node:fs')return fs;
    if(name==='path'||name==='node:path')return path;
    if(!name.startsWith('.'))throw Error('sandbox_module_denied: '+name);
    const dir=parent.includes('/')?parent.slice(0,parent.lastIndexOf('/')):'';
    let key=normalize('/session/'+dir+'/'+name);
    if(!keys().includes(key)){for(const ext of ['.cjs','.js','.json'])if(keys().includes(key+ext)){key+=ext;break;}}
    return run(key);
  };
  function run(key){
    if(cache[key])return cache[key].exports;
    const module={exports:{}};cache[key]=module;
    const source=__read(key);
    if(key.endsWith('.json'))module.exports=JSON.parse(source);
    else new Function('require','module','exports','__filename','__dirname',source)(n=>load(n,key),module,module.exports,'/session/'+key,'/session/'+(key.includes('/')?key.slice(0,key.lastIndexOf('/')):''));
    return module.exports;
  }
  globalThis.process={cwd:()=>'/session',env:Object.freeze({}),argv:['quickjs','/session/'+${JSON.stringify(entry)},...${JSON.stringify(args)}],exitCode:0,stdout:{write:s=>__log(String(s))},stderr:{write:s=>__log(String(s))},exit:n=>{process.exitCode=Number(n)||0;throw Error('__guest_exit__');}};
  globalThis.console={log:(...xs)=>__log(xs.map(String).join(' ')+'\\n'),error:(...xs)=>__log(xs.map(String).join(' ')+'\\n')};
  run(${JSON.stringify(entry)});
})();`;
  try {
    const result = vm.evalCode(bootstrap, "sandbox.cjs");
    if (result.error) {
      const error = vm.dump(result.error) as { message?: string };
      if (!String(error.message).includes("__guest_exit__")) { exitCode = 1; logs += `\nsandbox: ${String(error.message ?? error)}`; }
      result.error.dispose();
    } else result.value.dispose();
    const code = vm.getProp(vm.global, "process");
    const status = vm.getProp(code, "exitCode");
    exitCode = exitCode || Number(vm.dump(status)) || 0;
    status.dispose(); code.dispose();
    while (vm.runtime.hasPendingJob()) {
      const pending = vm.runtime.executePendingJobs(32);
      if (pending.error) { pending.error.dispose(); exitCode = 1; break; }
      if (Date.now() - started > timeoutMs) { exitCode = 1; break; }
    }
    if (exitCode === 0) {
      await mkdir(outWrite, { recursive: true });
      const realOut = await realpath(outWrite);
      for (const [key, text] of outputs) {
        const full = path.resolve(realOut, key.slice(4));
        if (!full.startsWith(realOut + path.sep)) throw new Error("sandbox_write_denied");
        await mkdir(path.dirname(full), { recursive: true });
        const parent = await realpath(path.dirname(full));
        if (parent !== realOut && !parent.startsWith(realOut + path.sep)) throw new Error("sandbox_link_rejected");
        try { if ((await lstat(full)).isSymbolicLink()) throw new Error("sandbox_link_rejected"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await writeFile(full, text, "utf8");
      }
    }
  } catch (error) { exitCode = 1; logs += `\nsandbox: ${String(error)}`; }
  finally { vm.dispose(); }
  return { exitCode, text: logs.slice(0,16000), elapsedMs: Date.now() - started };
}
