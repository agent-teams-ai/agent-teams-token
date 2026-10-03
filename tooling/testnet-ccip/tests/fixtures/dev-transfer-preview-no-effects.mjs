// TEST guard: a hidden HTTP/RPC factory, fee lookup, listener or subprocess effect fails the real CLI run.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const forbidden = () => { throw new Error('Unexpected offline preview effect capability'); };
globalThis.fetch = forbidden;
for (const module of [http, https]) {
  module.request = forbidden; module.get = forbidden; module.createServer = forbidden;
}
net.connect = forbidden; net.createConnection = forbidden; net.createServer = forbidden;
tls.connect = forbidden; tls.createServer = forbidden;
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {childProcess[name] = forbidden;}
syncBuiltinESMExports();
