export interface ProcessResult { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean }
export interface ProcessPort { run(command: string, args: readonly string[], timeoutMs: number): Promise<ProcessResult> }
